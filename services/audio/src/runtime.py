"""Fixed selected Nemotron/Kokoro conversation runtime.

The runtime deliberately composes only the selected adapters.  It owns bounded per-stream
capture state and keeps STT utterance cancellation separate from TTS cancellation.
"""
from __future__ import annotations

import hashlib
import json
import math
import secrets
import threading
import time
from collections import deque
from collections.abc import Iterator
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable
from uuid import UUID

from .binary_framing import BinaryAudioFrame, encode_frame
from .stt.base import TranscriptUpdate
from .stt.nemotron import NemotronStreamingAdapter
from .tts.base import AudioChunk, DEFAULT_VOICE_SPEED_MODIFIER, MAX_VOICE_SPEED_MODIFIER, MIN_VOICE_SPEED_MODIFIER
from .tts.kokoro import KokoroStreamingAdapter
from .tts.qwen3 import Qwen3StreamingAdapter
from .vad.endpointer import DeterministicEndpointer, EndpointerConfig

ROOT = Path(__file__).resolve().parents[3]
STT_CONFIG = ROOT / "benchmarks/configs/stt/nemotron-320ms.yaml"
TTS_CONFIG = ROOT / "benchmarks/configs/tts/kokoro-cuda.yaml"
MODEL_MANIFEST = ROOT / "docs/model-manifest.json"
STT_CONFIG_ID = "nemotron-3.5-transformers-fp32-320ms-paced-v1"
STT_CONFIG_SHA256 = "140151ebb3d74b09a25fd0ebb4016aee2392f93f9410d87f015378b548b8660e"
TTS_CONFIG_ID = "kokoro-82m-onnx-fp32-af-heart-cuda-v1"
TTS_CONFIG_SHA256 = "64de64feba08bcb97efc4e148c30e342a800dae847768929f4c93d6c161af9a5"
QWEN_TTS_CONFIG = ROOT / "benchmarks/configs/tts/qwen3-0.6b.yaml"
QWEN_TTS_CONFIG_ID = "qwen3-tts-0.6b-customvoice-cuda-v1"
QWEN_TTS_CONFIG_SHA256 = "b240604744566bdf26cf04bf5c672ee7ae1ab88c7e767ff31ca11ce7b4c4421c"
KOKORO_BACKEND_ID = "kokoro"
KOKORO_MODEL_ID = "kokoro-82m-onnx"
QWEN_BACKEND_ID = "qwen3"
QWEN_MODEL_ID = "Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice"
CAPTURE_BYTES = 320 * 2
STT_CHUNK_BYTES = 5_120 * 2
MAX_STT_CHUNKS = 64
MAX_PRE_ROLL_FRAMES = 10
MAX_BINARY_PAYLOAD = 64 * 1024 - 20
TTS_TERMINALIZATION_TIMEOUT_SECONDS = 10.0


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


def _tts_key(response_id: str, part_index: int | None) -> tuple[str, int | None]:
    """Identify one TTS stream without collapsing multipart siblings."""
    return response_id, part_index


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
class TtsTextStream:
    response_id: str
    epoch: int
    token: CancellationToken
    condition: threading.Condition
    chunks: deque[str]
    next_sequence: int = 0
    total_characters: int = 0
    exact_text_hasher: object = field(default_factory=hashlib.sha256)
    committed: bool = False
    started: bool = False
    playback_id: str = ""
    output_stream_id: int = 0
    output_sequence: int = 0
    generated_samples: int = 0
    done: threading.Event = field(default_factory=threading.Event)
    part_index: int | None = None
    part_id: str | None = None
    voice_id: str = ""
    speed_modifier: float = DEFAULT_VOICE_SPEED_MODIFIER


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
    stream_mode: str = "capture"
    tts_adapter: object | None = None
    tts_catalog: dict[str, object] | None = None
    tts_model: dict[str, str] = field(default_factory=dict)
    fallback_model: dict[str, str] | None = None
    announce_model: bool = False
    expected_sequence: int = 0
    endpointer: DeterministicEndpointer = field(
        default_factory=lambda: DeterministicEndpointer(EndpointerConfig())
    )
    pre_roll: deque[tuple[int, bytes]] = field(
        default_factory=lambda: deque(maxlen=MAX_PRE_ROLL_FRAMES)
    )
    utterance: Utterance | None = None
    tts: dict[tuple[str, int | None], CancellationToken] = field(default_factory=dict)
    tts_done: dict[tuple[str, int | None], threading.Event] = field(default_factory=dict)
    tts_stream: TtsTextStream | None = None
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
        tts_adapters: dict[str, object] | None = None,
        qwen_config_path: Path = QWEN_TTS_CONFIG,
        expected_qwen_config_sha256: str = QWEN_TTS_CONFIG_SHA256,
    ) -> None:
        self.stt = stt if stt is not None else NemotronStreamingAdapter()
        self.tts = tts if tts is not None else KokoroStreamingAdapter()
        # The first adapter remains the production default. Optional adapters
        # are isolated so a missing Qwen runtime/model can never prevent Kokoro
        # from preparing or serving the application.
        self._tts_adapters: dict[str, object] = {
            f"{KOKORO_BACKEND_ID}:{KOKORO_MODEL_ID}": self.tts,
        }
        if tts_adapters:
            self._tts_adapters.update(tts_adapters)
        elif tts is None:
            self._tts_adapters[f"{QWEN_BACKEND_ID}:{QWEN_MODEL_ID}"] = Qwen3StreamingAdapter()
        self.root = root
        self.stt_config_path = stt_config_path
        self.model_manifest_path = model_manifest_path
        self.expected_stt_config_sha256 = expected_stt_config_sha256
        self.tts_config_path = tts_config_path
        self.expected_tts_config_sha256 = expected_tts_config_sha256
        self.qwen_config_path = qwen_config_path
        self.expected_qwen_config_sha256 = expected_qwen_config_sha256
        self.status = "starting"
        self._tts_catalogs: dict[str, dict[str, object]] = {}
        self._tts_errors: dict[str, str] = {}
        self._streams: dict[str, StreamState] = {}
        self._lock = threading.RLock()
        # Kokoro is a single-active synthesis adapter. Preview streams are
        # allowed to coexist with a session, but synthesis itself remains
        # serialized so a preview can wait for an in-flight response instead
        # of being rejected just because capture is open.
        self._tts_lock = threading.Lock()
        self._workers: set[threading.Thread] = set()
        self.last_stt_audio_samples = 0

    def _model_key(self, backend_id: str, model_id: str) -> str:
        return f"{backend_id}:{model_id}"

    def _catalog_model(self, catalog: dict[str, object]) -> dict[str, str]:
        return {
            "backendId": str(catalog.get("backendId", "")),
            "modelId": str(catalog.get("modelId", "")),
        }

    def _catalog_speed(self, catalog: dict[str, object]) -> dict[str, object]:
        value = catalog.get("speed")
        if isinstance(value, dict):
            supported = value.get("supported")
            minimum = value.get("min")
            maximum = value.get("max")
            default = value.get("default")
            if (
                isinstance(supported, bool)
                and isinstance(minimum, (int, float))
                and isinstance(maximum, (int, float))
                and isinstance(default, (int, float))
                and not isinstance(minimum, bool)
                and not isinstance(maximum, bool)
                and not isinstance(default, bool)
                and math.isfinite(float(minimum))
                and math.isfinite(float(maximum))
                and math.isfinite(float(default))
                and MIN_VOICE_SPEED_MODIFIER <= float(minimum) <= float(maximum) <= MAX_VOICE_SPEED_MODIFIER
                and float(minimum) <= float(default) <= float(maximum)
            ):
                return {"supported": supported, "min": float(minimum), "max": float(maximum), "default": float(default)}
        return {"supported": True, "min": MIN_VOICE_SPEED_MODIFIER, "max": MAX_VOICE_SPEED_MODIFIER, "default": DEFAULT_VOICE_SPEED_MODIFIER}

    def _register_tts_catalog(self, key: str, adapter: object) -> None:
        catalog_fn = getattr(adapter, "voice_catalog", None)
        if not callable(catalog_fn):
            raise RuntimeError("TTS adapter does not expose a verified voice catalog")
        catalog = catalog_fn()
        if not isinstance(catalog, dict):
            raise RuntimeError("TTS adapter returned an invalid voice catalog")
        model = self._catalog_model(catalog)
        if not model["backendId"] or not model["modelId"]:
            raise RuntimeError("TTS catalog is missing backend/model identity")
        # The adapter's catalog is authoritative, but it must still agree with
        # the slot it was asked to fill. Otherwise a bad optional adapter could
        # replace another model's catalog and leak its voice IDs.
        expected_backend, separator, expected_model = key.partition(":")
        actual_key = self._model_key(model["backendId"], model["modelId"])
        if separator and (model["backendId"] != expected_backend or model["modelId"] != expected_model):
            raise RuntimeError("TTS adapter catalog identity does not match its model slot")
        existing = self._tts_adapters.get(actual_key)
        if actual_key in self._tts_catalogs and existing is not None and existing is not adapter:
            raise RuntimeError("TTS model catalog identity collision")
        self._tts_adapters[actual_key] = adapter
        self._tts_catalogs[actual_key] = catalog
        if actual_key != key:
            self._tts_adapters.pop(key, None)

    def _model_descriptors(self) -> list[dict[str, object]]:
        descriptors: list[dict[str, object]] = []
        known = set(self._tts_adapters) | set(self._tts_catalogs) | set(self._tts_errors)
        # Always advertise the default even when a test adapter has not exposed
        # its catalog yet. A ready runtime will still fail closed below.
        known.add(self._model_key(KOKORO_BACKEND_ID, KOKORO_MODEL_ID))
        for key in sorted(known):
            backend_id, _, model_id = key.partition(":")
            catalog = self._tts_catalogs.get(key)
            if catalog is not None:
                descriptor: dict[str, object] = {
                    "backendId": backend_id,
                    "modelId": model_id,
                    "label": "Kokoro CUDA" if backend_id == KOKORO_BACKEND_ID else "faster-Qwen CUDA" if backend_id == QWEN_BACKEND_ID else f"{backend_id} · {model_id}",
                    "status": "ready",
                    "speed": self._catalog_speed(catalog),
                    "voiceCatalog": catalog,
                }
            else:
                descriptor = {
                    "backendId": backend_id,
                    "modelId": model_id,
                    "label": "Kokoro CUDA" if backend_id == KOKORO_BACKEND_ID else "faster-Qwen CUDA" if backend_id == QWEN_BACKEND_ID else f"{backend_id} · {model_id}",
                    "status": "unavailable",
                    "speed": {"supported": False, "min": 1.0, "max": 1.0, "default": 1.0},
                    "reason": self._tts_errors.get(key, "TTS model is not available on this device."),
                    "fallback": {"backendId": KOKORO_BACKEND_ID, "modelId": KOKORO_MODEL_ID},
                }
            descriptors.append(descriptor)
        return descriptors

    def prepare(self) -> None:
        try:
            stt_config = self._verified_stt_config()
            tts_config = self._verified_tts_config()
            self.stt.prepare(stt_config)
            self.tts.prepare(tts_config)
            self._register_tts_catalog(self._model_key(KOKORO_BACKEND_ID, KOKORO_MODEL_ID), self.tts)
            # Optional candidates are deliberately best-effort. Qwen's isolated
            # runtime, CUDA device, or model snapshot may be absent; none of
            # those conditions are allowed to gate the Kokoro production path.
            for key, adapter in tuple(self._tts_adapters.items()):
                if adapter is self.tts:
                    continue
                try:
                    config = self._verified_qwen_config()
                    prepare = getattr(adapter, "prepare")
                    prepare(config)
                    self._register_tts_catalog(key, adapter)
                except BaseException as error:
                    self._tts_errors[key] = f"Qwen is unavailable: {type(error).__name__}"
                    try:
                        if bool(getattr(adapter, "prepared", False)):
                            adapter.close()
                    except BaseException:
                        pass
            self.status = "ready"
        except BaseException:
            self.status = "failed"
            for adapter in (*self._tts_adapters.values(), self.stt):
                if bool(getattr(adapter, "prepared", False)):
                    try:
                        adapter.close()
                    except BaseException:
                        pass
            raise

    def mark_ready_for_test(self) -> None:
        # Test fakes often do not need prepare(). Register every catalog they
        # expose, while retaining the old single-Kokoro test shape.
        for key, adapter in tuple(self._tts_adapters.items()):
            try:
                self._register_tts_catalog(key, adapter)
            except BaseException as error:
                self._tts_errors[key] = str(error)
        self.status = "ready"

    def readiness(self) -> dict[str, object]:
        payload: dict[str, object] = {
            "status": self.status,
            "stt": STT_CONFIG_ID,
            "tts": TTS_CONFIG_ID,
        }
        if self.status == "ready":
            try:
                default_key = self._model_key(KOKORO_BACKEND_ID, KOKORO_MODEL_ID)
                catalog = self._tts_catalogs.get(default_key)
                if catalog is None:
                    self._register_tts_catalog(default_key, self.tts)
                    catalog = self._tts_catalogs.get(default_key)
                if catalog is None:
                    raise RuntimeError("default TTS catalog is unavailable")
                payload["voiceCatalog"] = catalog
                payload["activeTtsModel"] = {"backendId": KOKORO_BACKEND_ID, "modelId": KOKORO_MODEL_ID}
                payload["ttsModels"] = self._model_descriptors()
            except BaseException:
                # A ready runtime must advertise its verified default catalog;
                # optional model failures remain visible in ttsModels instead.
                self.status = "failed"
                payload["status"] = "failed"
                payload.pop("voiceCatalog", None)
        return {"type": "readiness.snapshot", "payload": payload}

    def _select_tts(self, backend_id: str | None, model_id: str | None) -> tuple[str, object, dict[str, object], dict[str, str] | None]:
        default_key = self._model_key(KOKORO_BACKEND_ID, KOKORO_MODEL_ID)
        requested_key = default_key if not backend_id and not model_id else self._model_key(str(backend_id or ""), str(model_id or ""))
        if requested_key not in self._tts_catalogs:
            reason = self._tts_errors.get(requested_key, "requested TTS model is unavailable")
            raise RuntimeError(f"{reason}; Kokoro remains available as the production fallback")
        adapter = self._tts_adapters.get(requested_key)
        catalog = self._tts_catalogs[requested_key]
        if adapter is None:
            raise RuntimeError("requested TTS adapter is unavailable")
        fallback = None if requested_key == default_key else {"backendId": KOKORO_BACKEND_ID, "modelId": KOKORO_MODEL_ID}
        return requested_key, adapter, catalog, fallback

    def open_stream(
        self,
        stream_id: str,
        capture_stream_id: int,
        emit_json: Callable[[dict[str, object]], None],
        emit_binary: Callable[[bytes], None],
        stream_mode: str = "capture",
        backend_id: str | None = None,
        model_id: str | None = None,
    ) -> None:
        if self.status != "ready":
            raise RuntimeError("selected runtime is unavailable")
        if stream_mode not in {"capture", "preview"}:
            raise ValueError("invalid stream mode")
        key, adapter, catalog, fallback = self._select_tts(backend_id, model_id)
        with self._lock:
            if any(state.stream_mode == stream_mode for state in self._streams.values()):
                raise RuntimeError(f"one active {stream_mode} stream is allowed")
            self._streams[stream_id] = StreamState(
                stream_id,
                capture_stream_id,
                emit_json,
                emit_binary,
                stream_mode,
                adapter,
                catalog,
                {"backendId": str(catalog["backendId"]), "modelId": str(catalog["modelId"])},
                fallback,
                backend_id is not None or model_id is not None,
            )
        payload: dict[str, object] = {
            "streamId": stream_id,
            "backendId": str(catalog["backendId"]),
            "modelId": str(catalog["modelId"]),
            "voiceCatalog": catalog,
        }
        if fallback is not None:
            payload["fallback"] = fallback
        emit_json({"type": "stream.opened", "payload": payload})

    def accept_audio(self, stream_id: str, frame: BinaryAudioFrame) -> None:
        state = self._state(stream_id)
        with self._lock:
            if self.status != "ready" or state.closed or state.stream_mode != "capture" or frame.channel != 1 or frame.stream_id != state.capture_stream_id:
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
                endpointer = state.endpointer.config
                state.emit_json(
                    {
                        "type": "vad.speech_end",
                        "payload": {
                            "streamId": stream_id,
                            "utteranceId": utterance.utterance_id,
                            "captureStartSequence": utterance.capture_start_sequence,
                            "captureEndSequence": max(
                                0, frame.sequence - (endpointer.speech_end_frames * endpointer.frame_ms) // 20
                            ),
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

    def request_tts(self, stream_id: str, response_id: str, epoch: int, text: str, *, voice_id: str | None = None, speed_modifier: object = None) -> None:
        """Compatibility wrapper: one-shot TTS through the progressive path."""
        self.open_tts(stream_id, response_id, epoch, voice_id=voice_id, speed_modifier=speed_modifier)
        self.append_tts(stream_id, response_id, epoch, 0, text)
        text_hash = hashlib.sha256(text.encode("utf-8")).hexdigest()
        try:
            self.commit_tts(stream_id, response_id, epoch, 1, text_hash)
        except (RuntimeError, ValueError):
            # The worker can poison the runtime immediately after the first
            # append. In that race the sidecar failure is already authoritative;
            # the one-shot compatibility wrapper must not surface a second,
            # timing-dependent commit exception to its caller.
            if self.status == "failed":
                return
            raise

    def open_tts(
        self,
        stream_id: str,
        response_id: str,
        epoch: int,
        part_index: int | None = None,
        part_id: str | None = None,
        *,
        voice_id: str | None = None,
        speed_modifier: object = None,
    ) -> None:
        state = self._state(stream_id)
        adapter = state.tts_adapter
        voice_catalog = state.tts_catalog
        if adapter is None or voice_catalog is None:
            raise RuntimeError("selected TTS model is not prepared")
        voices = {str(item["id"]): item for item in voice_catalog.get("voices", [])} if isinstance(voice_catalog.get("voices"), list) else {}
        if voice_id is None:
            voice_id = str(voice_catalog.get("defaultVoiceId", ""))
        if voice_id not in voices:
            raise ValueError("requested voice is absent from the selected model catalog")
        capability = self._catalog_speed(voice_catalog)
        minimum = float(capability["min"])
        maximum = float(capability["max"])
        default_speed = float(capability["default"])
        if speed_modifier is None:
            speed = default_speed
        elif isinstance(speed_modifier, bool) or not isinstance(speed_modifier, (int, float)):
            raise ValueError("invalid TTS speed modifier")
        else:
            speed = float(speed_modifier)
            if (
                not math.isfinite(speed)
                or speed < minimum
                or speed > maximum
                or (not bool(capability["supported"]) and speed != default_speed)
            ):
                raise ValueError("TTS speed is unsupported or outside the selected model range")
        tts_key = _tts_key(response_id, part_index)
        # Admission is deliberately bounded, but a replacement must not turn a
        # short terminalization race into a session-fatal protocol error. Wait
        # outside self._lock so the retiring worker can remove itself and signal
        # its fence. The deadline keeps an adapter stall fail-closed rather than
        # allowing an unbounded request to block the sidecar.
        deadline = time.monotonic() + TTS_TERMINALIZATION_TIMEOUT_SECONDS
        while True:
            with self._lock:
                if self.status != "ready":
                    raise RuntimeError("selected runtime requires restart")
                if state.closed:
                    raise RuntimeError("audio stream is closing")
                existing = state.tts_stream
                if existing is not None and not existing.token.cancelled:
                    raise RuntimeError("a progressive TTS stream is already open")
                if tts_key in state.tts:
                    raise ValueError("duplicate TTS response")
                if len(state.tts) < 2:
                    prior_fences = tuple(state.tts_done.values())
                    playback_id = _uuid7()
                    output_stream_id = secrets.randbelow(2**32)
                    while output_stream_id in state.used_output_stream_ids:
                        output_stream_id = secrets.randbelow(2**32)
                    state.used_output_stream_ids.add(output_stream_id)
                    token = CancellationToken()
                    done = threading.Event()
                    state.tts[tts_key] = token
                    state.tts_done[tts_key] = done
                    text_stream = TtsTextStream(
                        response_id=response_id,
                        epoch=epoch,
                        token=token,
                        condition=threading.Condition(),
                        chunks=deque(),
                        playback_id=playback_id,
                        output_stream_id=output_stream_id,
                        done=done,
                        part_index=part_index,
                        part_id=part_id,
                        voice_id=voice_id,
                        speed_modifier=speed,
                    )
                    state.tts_stream = text_stream
                    break
                # Dict insertion order is admission order, so the first fence is
                # the oldest nonterminal worker. The worker's finally block pops
                # its state before setting this event.
                oldest_fence = next(iter(state.tts_done.values()), None)

            remaining = deadline - time.monotonic()
            if oldest_fence is None or remaining <= 0 or not oldest_fence.wait(timeout=remaining):
                raise RuntimeError("TTS request queue exceeded bound: prior worker did not terminalize")

        def work() -> None:
            try:
                for fence in prior_fences:
                    if not fence.wait(timeout=10):
                        raise RuntimeError("prior TTS worker did not terminalize")
                text_stream.token.raise_if_cancelled()
                with self._lock:
                    if self.status != "ready" or state.closed:
                        text_stream.token.cancel()
                text_stream.token.raise_if_cancelled()

                # Wait for the first chunk or commit/cancellation
                with text_stream.condition:
                    while not text_stream.chunks and not text_stream.committed and not text_stream.token.cancelled:
                        text_stream.condition.wait(timeout=0.25)
                text_stream.token.raise_if_cancelled()

                if not text_stream.started and text_stream.chunks:
                    # Emit tts.started only when first nonempty chunk is ready
                    text_stream.started = True
                    started_payload: dict[str, object] = {
                        "streamId": stream_id,
                        "responseId": response_id,
                        "epoch": epoch,
                        "playbackId": text_stream.playback_id,
                        "outputStreamId": text_stream.output_stream_id,
                        "sampleRate": 24_000,
                        "voiceId": text_stream.voice_id,
                    }
                    if state.announce_model:
                        started_payload["backendId"] = state.tts_model.get("backendId", "")
                        started_payload["modelId"] = state.tts_model.get("modelId", "")
                    if text_stream.part_index is not None:
                        started_payload["partIndex"] = text_stream.part_index
                    if text_stream.part_id is not None:
                        started_payload["partId"] = text_stream.part_id
                    state.emit_json({"type": "tts.started", "payload": started_payload})

                # Synthesize chunks sequentially
                while True:
                    with text_stream.condition:
                        while not text_stream.chunks and not text_stream.committed and not text_stream.token.cancelled:
                            text_stream.condition.wait(timeout=0.25)
                        text_stream.token.raise_if_cancelled()
                        if text_stream.chunks:
                            chunk_text = text_stream.chunks.popleft()
                        elif text_stream.committed:
                            break
                        else:
                            continue

                    # Synthesize this chunk
                    local_sequence = 0

                    def audio(chunk: AudioChunk) -> None:
                        nonlocal local_sequence
                        encoded = encode_frame(
                            BinaryAudioFrame(
                                2,
                                text_stream.output_stream_id,
                                text_stream.output_sequence,
                                max(0, int(__import__("time").monotonic_ns() // 1000)),
                                chunk.pcm16,
                            ),
                            MAX_BINARY_PAYLOAD,
                        )
                        text_stream.token.accept_unless_cancelled(lambda: state.emit_binary(encoded))
                        text_stream.output_sequence += 1
                        text_stream.generated_samples += len(chunk.pcm16) // 2
                        local_sequence += 1

                    # A preview can be opened while a session is capturing.
                    # Wait for the adapter rather than failing with its
                    # single-active-synthesis guard.
                    while not self._tts_lock.acquire(timeout=0.05):
                        text_stream.token.raise_if_cancelled()
                    previous_speed = getattr(adapter, "speed", None)
                    if previous_speed is not None:
                        adapter.speed = text_stream.speed_modifier
                    try:
                        adapter.synthesize_stream(chunk_text, text_stream.token, audio, voice=text_stream.voice_id)
                    finally:
                        if previous_speed is not None:
                            adapter.speed = previous_speed
                        self._tts_lock.release()
                    text_stream.token.raise_if_cancelled()

                # All chunks synthesized, emit tts.ended
                text_stream.token.raise_if_cancelled()
                ended_payload: dict[str, object] = {
                    "streamId": stream_id,
                    "responseId": response_id,
                    "epoch": epoch,
                    "playbackId": text_stream.playback_id,
                    "generatedSamples": text_stream.generated_samples,
                }
                if text_stream.part_index is not None:
                    ended_payload["partIndex"] = text_stream.part_index
                if text_stream.part_id is not None:
                    ended_payload["partId"] = text_stream.part_id
                state.emit_json({"type": "tts.ended", "payload": ended_payload})
            except BaseException as error:
                if text_stream.token.cancelled:
                    cancelled_payload: dict[str, object] = {
                        "streamId": stream_id,
                        "responseId": response_id,
                        "epoch": epoch,
                    }
                    if text_stream.part_index is not None:
                        cancelled_payload["partIndex"] = text_stream.part_index
                    if text_stream.part_id is not None:
                        cancelled_payload["partId"] = text_stream.part_id
                    state.emit_json({"type": "tts.cancelled", "payload": cancelled_payload})
                else:
                    if state.tts_adapter is not self.tts and state.tts_model.get("backendId") != KOKORO_BACKEND_ID:
                        self._degrade_optional_tts(state, error)
                    else:
                        self._poison()
            finally:
                with self._lock:
                    state.tts.pop(tts_key, None)
                    state.tts_done.pop(tts_key, None)
                    if state.tts_stream is text_stream:
                        state.tts_stream = None
                    text_stream.done.set()
                self._drop_worker(threading.current_thread())

        self._spawn("selected-tts", work)

    def _progressive_stream(
        self,
        state: StreamState,
        response_id: str,
        epoch: int,
        part_index: int | None,
        part_id: str | None,
    ) -> TtsTextStream:
        text_stream = state.tts_stream
        if text_stream is None:
            raise ValueError("no progressive TTS stream is open")
        if (
            text_stream.response_id != response_id
            or text_stream.epoch != epoch
            or text_stream.part_index != part_index
            or (part_id is not None and text_stream.part_id != part_id)
        ):
            raise ValueError("response, epoch, or part identity mismatch")
        return text_stream

    def append_tts(
        self,
        stream_id: str,
        response_id: str,
        epoch: int,
        sequence: int,
        text: str,
        part_index: int | None = None,
        part_id: str | None = None,
    ) -> None:
        state = self._state(stream_id)
        with self._lock:
            if self.status != "ready":
                raise RuntimeError("selected runtime requires restart")
            if state.closed:
                raise RuntimeError("audio stream is closing")
            text_stream = self._progressive_stream(state, response_id, epoch, part_index, part_id)
            if text_stream.committed:
                raise ValueError("TTS stream is already committed")
            if sequence != text_stream.next_sequence:
                raise ValueError("append sequence gap or duplicate")
            if not text or not text.strip():
                raise ValueError("empty or whitespace-only append")
            total = text_stream.total_characters + len(text)
            if total > 4000:
                raise ValueError("TTS text exceeds 4000 characters")
            text_stream.next_sequence += 1
            text_stream.total_characters = total
            text_stream.exact_text_hasher.update(text.encode("utf-8"))
            text_stream.chunks.append(text)
            with text_stream.condition:
                text_stream.condition.notify_all()

    def commit_tts(
        self,
        stream_id: str,
        response_id: str,
        epoch: int,
        next_sequence: int,
        text_sha256: str,
        part_index: int | None = None,
        part_id: str | None = None,
    ) -> None:
        state = self._state(stream_id)
        with self._lock:
            if self.status != "ready":
                raise RuntimeError("selected runtime requires restart")
            text_stream = self._progressive_stream(state, response_id, epoch, part_index, part_id)
            if text_stream.committed:
                raise ValueError("TTS stream is already committed")
            if next_sequence != text_stream.next_sequence:
                raise ValueError("commit next_sequence does not match")
            expected_hash = text_stream.exact_text_hasher.hexdigest()
            if text_sha256 != expected_hash:
                raise ValueError("commit text SHA-256 mismatch")
            text_stream.committed = True
            # Detach the committed stream from the singleton progressive slot so a
            # prefetched successor can open while this worker finishes synthesis.
            # The committed stream stays in state.tts/tts_done until the worker
            # terminalizes; the successor's worker waits on its fence. This is the
            # decision-007 two-nonterminal-stream design; a further open waits on
            # the oldest fence before admitting another bounded stream.
            if state.tts_stream is text_stream:
                state.tts_stream = None
            with text_stream.condition:
                text_stream.condition.notify_all()

    def cancel_tts(
        self,
        stream_id: str,
        response_id: str,
        part_index: int | None = None,
    ) -> None:
        state = self._state(stream_id)
        with self._lock:
            if part_index is None:
                # A parent cancellation may arrive without a part selector. It
                # must cut off every admitted sibling, not just the legacy key.
                tokens = [token for (parent, _), token in state.tts.items() if parent == response_id]
            else:
                token = state.tts.get(_tts_key(response_id, part_index))
                tokens = [token] if token is not None else []
            for token in tokens:
                token.cancel()  # local no-more-audio cutoff precedes acknowledgement

    def reset_stream(self, stream_id: str) -> None:
        state = self._state(stream_id)
        with self._lock:
            if state.utterance is not None:
                self._cancel_utterance(state.utterance)
            # BrowserCapture creates a fresh AudioFramePacker whenever the
            # microphone is resumed, so its capture sequence starts at zero
            # again. A reset is the boundary between those capture lifetimes.
            state.expected_sequence = 0
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
            if state.tts_stream is not None:
                state.tts_stream.token.cancel()
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
        seen: set[int] = set()
        for adapter in (*self._tts_adapters.values(), self.stt):
            if id(adapter) in seen:
                continue
            seen.add(id(adapter))
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

    def _verified_qwen_config(self) -> dict[str, object]:
        config_bytes = self.qwen_config_path.read_bytes()
        if hashlib.sha256(config_bytes).hexdigest() != self.expected_qwen_config_sha256:
            raise RuntimeError("optional Qwen config checksum mismatch")
        config = json.loads(config_bytes)
        if config.get("id") != QWEN_TTS_CONFIG_ID or config.get("schemaVersion") != 1:
            raise RuntimeError("optional Qwen config identity mismatch")
        candidate = config.get("candidate")
        if not isinstance(candidate, dict):
            raise RuntimeError("optional Qwen candidate config is invalid")
        manifest = json.loads(self.model_manifest_path.read_text())
        models = manifest.get("models") if manifest.get("schemaVersion") == 1 else None
        if not isinstance(models, list):
            raise RuntimeError("selected model manifest is invalid")
        matches = [entry for entry in models if isinstance(entry, dict) and entry.get("id") == candidate.get("modelId")]
        if len(matches) != 1:
            raise RuntimeError("optional Qwen model manifest identity mismatch")
        model = matches[0]
        for candidate_key, manifest_key in (("revision", "revision"), ("modelSha256", "sha256"), ("runtimeRevision", "streamingRuntimeRevision")):
            if candidate.get(candidate_key) != model.get(manifest_key):
                raise RuntimeError("optional Qwen manifest identity or digest mismatch")
        configured_path = self._safe_model_path(str(config.get("modelPath", "")))
        runtime_path = self._safe_model_path(str(model.get("runtimePath", "")))
        if configured_path != runtime_path:
            raise RuntimeError("optional Qwen configured path does not match manifest")
        files = model.get("files")
        if not isinstance(files, list) or not files:
            raise RuntimeError("optional Qwen model manifest has no files")
        for entry in files:
            if not isinstance(entry, dict) or not isinstance(entry.get("path"), str) or not isinstance(entry.get("sha256"), str):
                raise RuntimeError("optional Qwen model manifest file is invalid")
            path = self._safe_model_path(entry["path"])
            if not path.is_file() or _sha256_file(path) != entry["sha256"]:
                raise RuntimeError("optional Qwen model file checksum mismatch")
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

    def _degrade_optional_tts(self, state: StreamState, error: BaseException) -> None:
        """Retire an optional model without taking Kokoro or capture down."""
        key = self._model_key(state.tts_model.get("backendId", ""), state.tts_model.get("modelId", ""))
        adapter = state.tts_adapter
        with self._lock:
            self._tts_catalogs.pop(key, None)
            self._tts_adapters.pop(key, None)
            self._tts_errors[key] = f"optional TTS model failed: {type(error).__name__}"
        try:
            if adapter is not None:
                adapter.close()
        except BaseException:
            pass
        state.emit_json({
            "type": "sidecar.failure",
            "payload": {"code": "runtime_unavailable", "recoverable": True},
        })

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
