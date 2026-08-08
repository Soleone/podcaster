"""Fixed selected Nemotron/Kokoro conversation runtime.

The runtime deliberately composes only the selected adapters.  It owns bounded per-stream
capture state and keeps STT utterance cancellation separate from TTS cancellation.
"""
from __future__ import annotations

import hashlib
import json
import secrets
import threading
from collections import deque
from collections.abc import Iterator
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable
from uuid import UUID

from .binary_framing import BinaryAudioFrame, encode_frame
from .stt.base import TranscriptUpdate
from .stt.nemotron import NemotronStreamingAdapter
from .tts.base import AudioChunk
from .tts.kokoro import KokoroStreamingAdapter
from .vad.endpointer import DeterministicEndpointer, EndpointerConfig

ROOT = Path(__file__).resolve().parents[3]
STT_CONFIG = ROOT / "benchmarks/configs/stt/nemotron-320ms.yaml"
TTS_CONFIG = ROOT / "benchmarks/configs/tts/kokoro.yaml"
MODEL_MANIFEST = ROOT / "docs/model-manifest.json"
STT_CONFIG_ID = "nemotron-3.5-transformers-fp32-320ms-paced-v1"
STT_CONFIG_SHA256 = "140151ebb3d74b09a25fd0ebb4016aee2392f93f9410d87f015378b548b8660e"
TTS_CONFIG_ID = "kokoro-82m-onnx-fp32-af-heart-cpu-v1"
TTS_CONFIG_SHA256 = "8ff4fe605bf40c92e7a28a2e7609293b1b82db6800c4402e98551d21a35637e4"
CAPTURE_BYTES = 320 * 2
STT_CHUNK_BYTES = 5_120 * 2
MAX_STT_CHUNKS = 64
MAX_PRE_ROLL_FRAMES = 10
MAX_BINARY_PAYLOAD = 64 * 1024 - 20


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _uuid7() -> str:
    # UUIDv7 layout without importing a candidate/unselected runtime.
    millis = int(__import__("time").time() * 1000) & ((1 << 48) - 1)
    raw = bytearray(millis.to_bytes(6, "big") + secrets.token_bytes(10))
    raw[6] = (raw[6] & 0x0F) | 0x70
    raw[8] = (raw[8] & 0x3F) | 0x80
    return str(UUID(bytes=bytes(raw)))


class CancellationToken:
    def __init__(self) -> None:
        self._event = threading.Event()
        self._lock = threading.RLock()

    @property
    def cancelled(self) -> bool:
        return self._event.is_set()

    def cancel(self) -> None:
        with self._lock:
            self._event.set()

    def raise_if_cancelled(self) -> None:
        if self.cancelled:
            raise RuntimeError("operation cancelled")

    def accept_unless_cancelled(self, callback):
        with self._lock:
            self.raise_if_cancelled()
            return callback()


@dataclass
class Utterance:
    utterance_id: str
    capture_start_sequence: int
    epoch: int | None = None
    ended: bool = False
    started_worker: bool = False
    captured_samples: int = 0
    pending_pcm: bytearray = field(default_factory=bytearray)
    chunks: deque[bytes] = field(default_factory=deque)
    condition: threading.Condition = field(default_factory=threading.Condition)
    token: CancellationToken = field(default_factory=CancellationToken)


@dataclass
class StreamState:
    stream_id: str
    capture_stream_id: int
    emit_json: Callable[[dict[str, object]], None]
    emit_binary: Callable[[bytes], None]
    expected_sequence: int = 0
    endpointer: DeterministicEndpointer = field(
        default_factory=lambda: DeterministicEndpointer(EndpointerConfig())
    )
    pre_roll: deque[tuple[int, bytes]] = field(
        default_factory=lambda: deque(maxlen=MAX_PRE_ROLL_FRAMES)
    )
    utterance: Utterance | None = None
    tts: dict[str, CancellationToken] = field(default_factory=dict)
    tts_done: dict[str, threading.Event] = field(default_factory=dict)
    used_output_stream_ids: set[int] = field(default_factory=set)
    closed: bool = False


class SelectedAudioRuntime:
    """One prepared selected STT and TTS composition with bounded stream ownership."""

    def __init__(
        self,
        stt=None,
        tts=None,
        *,
        root: Path = ROOT,
        stt_config_path: Path = STT_CONFIG,
        model_manifest_path: Path = MODEL_MANIFEST,
        expected_stt_config_sha256: str = STT_CONFIG_SHA256,
        tts_config_path: Path = TTS_CONFIG,
        expected_tts_config_sha256: str = TTS_CONFIG_SHA256,
    ) -> None:
        self.stt = stt if stt is not None else NemotronStreamingAdapter()
        self.tts = tts if tts is not None else KokoroStreamingAdapter()
        self.root = root
        self.stt_config_path = stt_config_path
        self.model_manifest_path = model_manifest_path
        self.expected_stt_config_sha256 = expected_stt_config_sha256
        self.tts_config_path = tts_config_path
        self.expected_tts_config_sha256 = expected_tts_config_sha256
        self.status = "starting"
        self._streams: dict[str, StreamState] = {}
        self._lock = threading.RLock()
        self._workers: set[threading.Thread] = set()
        self.last_stt_audio_samples = 0

    def prepare(self) -> None:
        try:
            stt_config = self._verified_stt_config()
            tts_config = self._verified_tts_config()
            self.stt.prepare(stt_config)
            self.tts.prepare(tts_config)
            self.status = "ready"
        except BaseException:
            self.status = "failed"
            for adapter in (self.tts, self.stt):
                if bool(getattr(adapter, "prepared", False)):
                    try:
                        adapter.close()
                    except BaseException:
                        pass
            raise

    def mark_ready_for_test(self) -> None:
        self.status = "ready"

    def readiness(self) -> dict[str, object]:
        return {
            "type": "readiness.snapshot",
            "payload": {"status": self.status, "stt": STT_CONFIG_ID, "tts": TTS_CONFIG_ID},
        }

    def open_stream(
        self,
        stream_id: str,
        capture_stream_id: int,
        emit_json: Callable[[dict[str, object]], None],
        emit_binary: Callable[[bytes], None],
    ) -> None:
        if self.status != "ready":
            raise RuntimeError("selected runtime is unavailable")
        with self._lock:
            if self._streams:
                raise RuntimeError("one active stream is allowed")
            self._streams[stream_id] = StreamState(
                stream_id, capture_stream_id, emit_json, emit_binary
            )
        emit_json({"type": "stream.opened", "payload": {"streamId": stream_id}})

    def accept_audio(self, stream_id: str, frame: BinaryAudioFrame) -> None:
        state = self._state(stream_id)
        with self._lock:
            if self.status != "ready" or state.closed or frame.channel != 1 or frame.stream_id != state.capture_stream_id:
                raise ValueError("invalid capture stream")
            if frame.sequence != state.expected_sequence:
                raise ValueError("capture sequence gap or duplicate")
            if len(frame.pcm16) != CAPTURE_BYTES:
                raise ValueError("capture frame must contain exactly 320 samples")
            state.expected_sequence += 1
            sequence = frame.sequence
            state.pre_roll.append((sequence, frame.pcm16))
            transition = state.endpointer.accept(frame.pcm16)
            if transition == "speech_start":
                if state.utterance is not None:
                    if not state.utterance.ended:
                        raise RuntimeError("prior utterance is still owned")
                    # A short noise burst can arrive while the prior STT worker is
                    # finalizing. It is not a malformed client frame and must not
                    # tear down the whole session. Ignore this overlapping start,
                    # reset VAD, and keep listening for a clean next utterance.
                    state.endpointer.reset()
                    state.pre_roll.clear()
                    return
                first_sequence = state.pre_roll[0][0]
                utterance = Utterance(_uuid7(), first_sequence)
                for _, pcm in state.pre_roll:
                    self._feed_stt(utterance, pcm)
                state.utterance = utterance
                state.emit_json(
                    {
                        "type": "vad.speech_start",
                        "payload": {
                            "streamId": stream_id,
                            "utteranceId": utterance.utterance_id,
                            "captureStartSequence": first_sequence,
                        },
                    }
                )
            elif state.utterance is not None and not state.utterance.ended:
                # The current frame is already present when speech_start fires.
                self._feed_stt(state.utterance, frame.pcm16)
            if transition == "speech_end" and state.utterance is not None:
                utterance = state.utterance
                state.emit_json(
                    {
                        "type": "vad.speech_end",
                        "payload": {
                            "streamId": stream_id,
                            "utteranceId": utterance.utterance_id,
                            "captureStartSequence": utterance.capture_start_sequence,
                        },
                    }
                )
                self._end_stt(utterance)
                self._maybe_start_stt(state, utterance)

    def bind_epoch(self, stream_id: str, utterance_id: str, epoch: int) -> None:
        state = self._state(stream_id)
        with self._lock:
            if self.status != "ready":
                raise RuntimeError("selected runtime requires restart")
            utterance = state.utterance
            if utterance is None or utterance.utterance_id != utterance_id or utterance.epoch is not None:
                raise ValueError("unknown, stale, or already-bound utterance")
            utterance.epoch = epoch
            self._maybe_start_stt(state, utterance)

    def request_tts(self, stream_id: str, response_id: str, epoch: int, text: str) -> None:
        state = self._state(stream_id)
        with self._lock:
            if self.status != "ready":
                raise RuntimeError("selected runtime requires restart")
            if state.closed:
                raise RuntimeError("audio stream is closing")
            if response_id in state.tts:
                raise ValueError("duplicate TTS response")
            if len(state.tts) >= 2:
                raise RuntimeError("TTS request queue exceeded bound")
            # One replacement may wait behind the currently terminalizing
            # adapter call. Register it immediately so cancel-before-start is
            # owned, but never enter the single-active Kokoro adapter early.
            prior_fences = tuple(state.tts_done.values())
            token = CancellationToken()
            done = threading.Event()
            state.tts[response_id] = token
            state.tts_done[response_id] = done
            playback_id = _uuid7()
            output_stream_id = secrets.randbelow(2**32)
            while output_stream_id in state.used_output_stream_ids:
                output_stream_id = secrets.randbelow(2**32)
            state.used_output_stream_ids.add(output_stream_id)

        def work() -> None:
            try:
                for fence in prior_fences:
                    if not fence.wait(timeout=10):
                        raise RuntimeError("prior TTS worker did not terminalize")
                token.raise_if_cancelled()
                with self._lock:
                    if self.status != "ready" or state.closed:
                        token.cancel()
                token.raise_if_cancelled()
                state.emit_json(
                    {
                        "type": "tts.started",
                        "payload": {
                            "streamId": stream_id,
                            "responseId": response_id,
                            "epoch": epoch,
                            "playbackId": playback_id,
                            "outputStreamId": output_stream_id,
                            "sampleRate": 24_000,
                        },
                    }
                )

                def audio(chunk: AudioChunk) -> None:
                    encoded = encode_frame(
                        BinaryAudioFrame(
                            2,
                            output_stream_id,
                            chunk.sequence,
                            max(0, int(__import__("time").monotonic_ns() // 1000)),
                            chunk.pcm16,
                        ),
                        MAX_BINARY_PAYLOAD,
                    )
                    token.accept_unless_cancelled(lambda: state.emit_binary(encoded))

                result = self.tts.synthesize_stream(text, token, audio)
                token.raise_if_cancelled()
                state.emit_json(
                    {
                        "type": "tts.ended",
                        "payload": {
                            "streamId": stream_id,
                            "responseId": response_id,
                            "epoch": epoch,
                            "playbackId": playback_id,
                            "generatedSamples": result.total_samples,
                        },
                    }
                )
            except BaseException:
                if token.cancelled:
                    state.emit_json(
                        {
                            "type": "tts.cancelled",
                            "payload": {"streamId": stream_id, "responseId": response_id, "epoch": epoch},
                        }
                    )
                else:
                    self._poison()
            finally:
                with self._lock:
                    state.tts.pop(response_id, None)
                    state.tts_done.pop(response_id, None)
                    done.set()
                self._drop_worker(threading.current_thread())

        self._spawn("selected-tts", work)

    def cancel_tts(self, stream_id: str, response_id: str) -> None:
        state = self._state(stream_id)
        with self._lock:
            token = state.tts.get(response_id)
            if token is not None:
                token.cancel()  # local no-more-audio cutoff precedes acknowledgement

    def reset_stream(self, stream_id: str) -> None:
        state = self._state(stream_id)
        with self._lock:
            if state.utterance is not None:
                self._cancel_utterance(state.utterance)
            state.utterance = None
            state.pre_roll.clear()
            state.endpointer.reset()

    def close_stream(self, stream_id: str) -> None:
        state = self._state(stream_id)
        with self._lock:
            if state.closed:
                return
            state.closed = True
            if state.utterance:
                self._cancel_utterance(state.utterance)
            for token in tuple(state.tts.values()):
                token.cancel()
            terminal_fences = tuple(state.tts_done.values())
        # Do not release the one-stream or one-Kokoro ownership boundary until
        # cancelled workers have exited their adapter calls.
        for fence in terminal_fences:
            if not fence.wait(timeout=10):
                self._poison()
                raise RuntimeError("TTS worker did not terminate during stream close")
        with self._lock:
            if self._streams.get(stream_id) is state:
                self._streams.pop(stream_id, None)
        state.emit_json({"type": "stream.closed", "payload": {"streamId": stream_id}})

    def close(self) -> None:
        for stream_id in tuple(self._streams):
            self.close_stream(stream_id)
        for worker in tuple(self._workers):
            worker.join(timeout=10)
        for adapter in (self.tts, self.stt):
            if bool(getattr(adapter, "prepared", False)) and not bool(getattr(adapter, "closed", False)):
                adapter.close()

    @property
    def worker_names(self) -> tuple[str, ...]:
        return tuple(sorted(worker.name for worker in self._workers if worker.is_alive()))

    def _maybe_start_stt(self, state: StreamState, utterance: Utterance) -> None:
        if utterance.epoch is None or utterance.started_worker:
            return
        utterance.started_worker = True

        def chunks() -> Iterator[bytes]:
            while True:
                with utterance.condition:
                    while not utterance.chunks and not utterance.ended and not utterance.token.cancelled:
                        utterance.condition.wait(timeout=0.25)
                    utterance.token.raise_if_cancelled()
                    if utterance.chunks:
                        chunk = utterance.chunks.popleft()
                        utterance.condition.notify_all()
                    elif utterance.ended:
                        return
                    else:
                        continue
                yield chunk

        def work() -> None:
            try:
                def partial(update: TranscriptUpdate) -> None:
                    with self._lock:
                        if (
                            utterance.token.cancelled
                            or utterance.epoch is None
                            or state.closed
                            or state.utterance is not utterance
                            or self.status != "ready"
                        ):
                            return
                        state.emit_json(
                            {
                                "type": "stt.partial",
                                "payload": {
                                    "streamId": state.stream_id,
                                    "utteranceId": utterance.utterance_id,
                                    "epoch": utterance.epoch,
                                    "sequence": update.sequence,
                                    "text": update.text,
                                    "replacedCharacters": update.replaced_characters,
                                },
                            }
                        )

                result = self.stt.transcribe_stream(chunks(), utterance.token, partial)
                utterance.token.raise_if_cancelled()
                with self._lock:
                    if not utterance.ended or state.closed or state.utterance is not utterance or self.status != "ready":
                        return
                    self.last_stt_audio_samples = utterance.captured_samples
                    state.emit_json(
                        {
                            "type": "stt.final",
                            "payload": {
                                "streamId": state.stream_id,
                                "utteranceId": utterance.utterance_id,
                                "epoch": utterance.epoch,
                                "text": result.text,
                                "endpointComplete": True,
                            },
                        }
                    )
                    state.utterance = None
            except BaseException:
                if not utterance.token.cancelled:
                    self._poison()
            finally:
                self._drop_worker(threading.current_thread())

        self._spawn("selected-stt", work)

    def _feed_stt(self, utterance: Utterance, pcm16: bytes) -> None:
        with utterance.condition:
            if utterance.ended or utterance.token.cancelled:
                raise RuntimeError("utterance is no longer accepting audio")
            utterance.captured_samples += len(pcm16) // 2
            utterance.pending_pcm.extend(pcm16)
            while len(utterance.pending_pcm) >= STT_CHUNK_BYTES:
                if len(utterance.chunks) >= MAX_STT_CHUNKS:
                    raise RuntimeError("STT input queue exceeded bound")
                utterance.chunks.append(bytes(utterance.pending_pcm[:STT_CHUNK_BYTES]))
                del utterance.pending_pcm[:STT_CHUNK_BYTES]
            utterance.condition.notify_all()

    def _end_stt(self, utterance: Utterance) -> None:
        with utterance.condition:
            if utterance.ended:
                return
            if utterance.pending_pcm:
                if len(utterance.chunks) >= MAX_STT_CHUNKS:
                    raise RuntimeError("STT input queue exceeded bound")
                padding = STT_CHUNK_BYTES - len(utterance.pending_pcm)
                utterance.chunks.append(bytes(utterance.pending_pcm) + bytes(padding))
                utterance.pending_pcm.clear()
            utterance.ended = True
            utterance.condition.notify_all()

    def _cancel_utterance(self, utterance: Utterance) -> None:
        utterance.token.cancel()
        with utterance.condition:
            utterance.condition.notify_all()

    def _verified_stt_config(self) -> dict[str, object]:
        config_bytes = self.stt_config_path.read_bytes()
        if hashlib.sha256(config_bytes).hexdigest() != self.expected_stt_config_sha256:
            raise RuntimeError("selected STT config checksum mismatch")
        config = json.loads(config_bytes)
        if config.get("id") != STT_CONFIG_ID or config.get("schemaVersion") != 1:
            raise RuntimeError("selected STT config identity mismatch")
        candidate = config.get("candidate")
        if not isinstance(candidate, dict):
            raise RuntimeError("selected STT candidate config is invalid")
        manifest = json.loads(self.model_manifest_path.read_text())
        models = manifest.get("models") if manifest.get("schemaVersion") == 1 else None
        if not isinstance(models, list):
            raise RuntimeError("selected model manifest is invalid")
        matches = [entry for entry in models if isinstance(entry, dict) and entry.get("id") == candidate.get("modelId")]
        if len(matches) != 1:
            raise RuntimeError("selected STT model manifest identity mismatch")
        model = matches[0]
        if model.get("revision") != candidate.get("revision") or model.get("sha256") != candidate.get("sha256"):
            raise RuntimeError("selected STT model manifest revision or digest mismatch")
        runtime_path = self._safe_model_path(str(model.get("runtimePath", "")))
        configured_path = self._safe_model_path(str(config.get("modelPath", "")))
        if runtime_path != configured_path:
            raise RuntimeError("selected STT configured path does not match manifest")
        files = model.get("files")
        if not isinstance(files, list) or not files:
            raise RuntimeError("selected STT model manifest has no files")
        for entry in files:
            if not isinstance(entry, dict) or not isinstance(entry.get("path"), str) or not isinstance(entry.get("sha256"), str):
                raise RuntimeError("selected STT model manifest file is invalid")
            path = self._safe_model_path(entry["path"])
            if not path.is_file() or _sha256_file(path) != entry["sha256"]:
                raise RuntimeError("selected STT model file checksum mismatch")
        config["modelPath"] = str(runtime_path)
        return config

    def _verified_tts_config(self) -> dict[str, object]:
        config_bytes = self.tts_config_path.read_bytes()
        if hashlib.sha256(config_bytes).hexdigest() != self.expected_tts_config_sha256:
            raise RuntimeError("selected TTS config checksum mismatch")
        config = json.loads(config_bytes)
        if config.get("id") != TTS_CONFIG_ID or config.get("schemaVersion") != 1:
            raise RuntimeError("selected TTS config identity mismatch")
        candidate = config.get("candidate")
        if not isinstance(candidate, dict):
            raise RuntimeError("selected TTS candidate config is invalid")
        manifest = json.loads(self.model_manifest_path.read_text())
        models = manifest.get("models") if manifest.get("schemaVersion") == 1 else None
        if not isinstance(models, list):
            raise RuntimeError("selected model manifest is invalid")
        matches = [entry for entry in models if isinstance(entry, dict) and entry.get("id") == candidate.get("modelId")]
        if len(matches) != 1:
            raise RuntimeError("selected TTS model manifest identity mismatch")
        model = matches[0]
        required_matches = {
            "revision": "revision",
            "onnxReleaseRevision": "onnxReleaseRevision",
            "runtimeRevision": "runtimeRevision",
            "runtime": "runtime",
            "voice": "voice",
            "provider": "provider",
            "precision": "precision",
            "sha256": "modelSha256",
        }
        for manifest_key, candidate_key in required_matches.items():
            if model.get(manifest_key) != candidate.get(candidate_key):
                raise RuntimeError("selected TTS manifest identity or digest mismatch")
        if model.get("language") != config.get("language") or model.get("nativeSampleRate") != config.get("nativeSampleRate"):
            raise RuntimeError("selected TTS language or sample rate mismatch")
        if config.get("nativeSampleRate") != 24_000 or config.get("comparisonSampleRate") != 24_000:
            raise RuntimeError("selected TTS runtime must produce 24 kHz audio")
        model_path = self._safe_model_path(str(config.get("modelPath", "")))
        voices_path = self._safe_model_path(str(config.get("voicesPath", "")))
        if model_path != self._safe_model_path(str(model.get("runtimePath", ""))) or voices_path != self._safe_model_path(str(model.get("voicesPath", ""))):
            raise RuntimeError("selected TTS configured paths do not match manifest")
        files = model.get("files")
        if not isinstance(files, list) or len(files) < 2:
            raise RuntimeError("selected TTS model manifest has incomplete files")
        verified_paths: set[Path] = set()
        for entry in files:
            if not isinstance(entry, dict) or not isinstance(entry.get("path"), str) or not isinstance(entry.get("sha256"), str):
                raise RuntimeError("selected TTS model manifest file is invalid")
            path = self._safe_model_path(entry["path"])
            if not path.is_file() or _sha256_file(path) != entry["sha256"]:
                raise RuntimeError("selected TTS model file checksum mismatch")
            verified_paths.add(path)
        if model_path not in verified_paths or voices_path not in verified_paths:
            raise RuntimeError("selected TTS files are not attested by manifest")
        if candidate.get("voicesSha256") != _sha256_file(voices_path):
            raise RuntimeError("selected TTS voices digest mismatch")
        config["modelPath"] = str(model_path)
        config["voicesPath"] = str(voices_path)
        return config

    def _safe_model_path(self, relative: str) -> Path:
        path = (self.root / relative).resolve()
        if self.root.resolve() not in path.parents:
            raise RuntimeError("selected model path is unsafe")
        return path

    def _poison(self) -> None:
        with self._lock:
            if self.status == "failed":
                return
            self.status = "failed"
            states = tuple(self._streams.values())
            for owned in states:
                if owned.utterance is not None:
                    self._cancel_utterance(owned.utterance)
                for token in owned.tts.values():
                    token.cancel()
        for owned in states:
            owned.emit_json(
                {"type": "sidecar.failure", "payload": {"code": "runtime_poisoned", "recoverable": False}}
            )

    def _state(self, stream_id: str) -> StreamState:
        with self._lock:
            state = self._streams.get(stream_id)
        if state is None:
            raise ValueError("unknown stream")
        return state

    def _spawn(self, name: str, target: Callable[[], None]) -> None:
        with self._lock:
            if len(self._workers) >= 4:
                raise RuntimeError("runtime worker queue exceeded bound")
            worker = threading.Thread(target=target, name=name, daemon=True)
            self._workers.add(worker)
            worker.start()

    def _drop_worker(self, worker: threading.Thread) -> None:
        with self._lock:
            self._workers.discard(worker)
