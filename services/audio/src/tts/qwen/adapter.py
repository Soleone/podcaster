from __future__ import annotations

import hashlib
import queue
import threading
import time
from collections.abc import Callable, Iterator
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from ..base import AudioCallback, AudioChunk, Cancellation, MAX_VOICE_TONE_PROMPT_BYTES, SynthesisResult, speed_capability
from ..kokoro import segment_text, validate_text
from ...voice_enrollment import (
    CUSTOM_VOICE_SAMPLE_RATE,
    MAX_CUSTOM_VOICES,
    decode_reference,
    validate_name,
    validate_voice_id,
)
from .backends import (
    ATTENTION,
    BACKEND,
    BASE_MODEL_PATH,
    BASE_MODEL_SHA256,
    CANDIDATE_ID,
    CHUNK_SAMPLES,
    CHUNK_SIZE_CODEC_STEPS,
    DEVICE,
    DO_SAMPLE,
    FASTER_REPO_COMMIT,
    FASTER_RUNTIME_VERSION,
    FasterQwenBaseCloneBackend,
    FasterQwenTorchBackend,
    LANGUAGE,
    MODEL_ID,
    MODEL_PATH,
    MODEL_REVISION,
    MODEL_SHA256,
    MAX_NEW_TOKENS,
    MAX_TEXT_CHARACTERS,
    MANIFEST_DEVICE,
    MIN_NEW_TOKENS,
    OFFICIAL_RUNTIME_CONTRACT,
    OUTPUT_FORMAT,
    PRECISION,
    PROVIDER,
    QWEN_REQUIREMENTS_LOCK_SHA256,
    QWEN_SUPPORTED_LANGUAGES,
    REPETITION_PENALTY,
    RUNTIME_CONTRACT,
    SAMPLE_RATE,
    SPEAKER,
    TEMPERATURE,
    TOP_K,
    TOP_P,
    TTS_CONFIG_ID,
    OWNED_THREAD_PREFIXES,
    _CANONICAL_VOICE_LABELS,
    QwenBackend,
    _verify_base_assets,
    _verify_qwen_assets,
    _verify_runtime_distribution,
)

def _to_cpu_prompt(value: Any, torch_module: Any) -> Any:
    """Move a voice-clone prompt {dict,list,tuple,tensor} to CPU tensors."""
    if isinstance(value, dict):
        return {key: _to_cpu_prompt(item, torch_module) for key, item in value.items()}
    if isinstance(value, list):
        return [_to_cpu_prompt(item, torch_module) for item in value]
    if isinstance(value, tuple):
        return tuple(_to_cpu_prompt(item, torch_module) for item in value)
    if isinstance(value, torch_module.Tensor):
        return value.detach().cpu()
    return value


def _to_device_prompt(value: Any, torch_module: Any, device: str) -> Any:
    """Move a CPU voice-clone prompt to the pinned CUDA device per request."""
    if isinstance(value, dict):
        return {key: _to_device_prompt(item, torch_module, device) for key, item in value.items()}
    if isinstance(value, list):
        return [_to_device_prompt(item, torch_module, device) for item in value]
    if isinstance(value, tuple):
        return tuple(_to_device_prompt(item, torch_module, device) for item in value)
    if isinstance(value, torch_module.Tensor):
        return value.to(device)
    return value


def _audio_values(samples: Any) -> Any:
    import numpy as np

    value = samples
    if hasattr(value, "detach"):
        value = value.detach()
    if hasattr(value, "float"):
        value = value.float()
    if hasattr(value, "cpu"):
        value = value.cpu()
    if hasattr(value, "numpy"):
        value = value.numpy()
    array = np.asarray(value, dtype=np.float32)
    if array.ndim == 0 or array.ndim > 2 or (array.ndim == 2 and 1 not in array.shape):
        raise ValueError("Qwen emitted non-mono audio")
    values = array.reshape(-1)
    if not values.size:
        raise ValueError("Qwen produced an empty audio packet")
    if not np.isfinite(values).all():
        raise ValueError("Qwen produced non-finite audio")
    return values


def _pcm16(samples: Any, gain: float) -> bytes:
    import numpy as np

    values = _audio_values(samples)
    scaled = values * gain
    if float(np.max(np.abs(scaled))) > 1.0:
        raise ValueError("Qwen output would clip under the pinned gain policy")
    scaled = np.clip(scaled, -1.0, 32767.0 / 32768.0)
    return np.rint(scaled * 32768.0).astype("<i2").tobytes()


def _packet(value: Any) -> tuple[Any, int]:
    from numbers import Integral

    if not isinstance(value, tuple) or len(value) not in (2, 3):
        raise RuntimeError("Qwen emitted an unexpected streaming packet")
    samples, sample_rate = value[0], value[1]
    if isinstance(sample_rate, bool) or not isinstance(sample_rate, Integral):
        raise RuntimeError("Qwen emitted an invalid sample rate")
    return samples, int(sample_rate)


@dataclass
class Qwen3StreamingAdapter:
    backend_factory: Callable[[], QwenBackend] = FasterQwenTorchBackend
    asset_verifier: Callable[[Path, Path, str, str], None] = _verify_qwen_assets
    expected_model_path: Path = MODEL_PATH
    clone_backend_factory: Callable[[], QwenBackend] = FasterQwenBaseCloneBackend
    clone_asset_verifier: Callable[[Path, Path, str, str], None] = _verify_base_assets
    expected_clone_model_path: Path = BASE_MODEL_PATH
    runtime_verifier: Callable[[], None] = _verify_runtime_distribution
    backend: QwenBackend | None = None
    prepared: bool = False
    closed: bool = False
    generation: int = 0
    voice: str = SPEAKER
    language: str = LANGUAGE
    speed: float = 1.0
    gain: float = 0.9
    chunk_samples: int = CHUNK_SAMPLES
    max_text_characters: int = MAX_TEXT_CHARACTERS
    worker_timeout_seconds: float = 10.0
    _active: bool = False
    _poisoned: bool = False
    _voices: tuple[str, ...] = ()
    _native_voices: dict[str, str] = field(default_factory=dict)
    _clone_backend: QwenBackend | None = None
    _custom_voices: dict[str, dict[str, object]] = field(default_factory=dict)
    _lock: threading.RLock = field(default_factory=threading.RLock)
    _workers: set[threading.Thread] = field(default_factory=set)

    def prepare(self, config: dict[str, object]) -> None:
        with self._lock:
            if self.closed:
                raise RuntimeError("adapter is closed")
            if self._active:
                raise RuntimeError("cannot prepare during active synthesis")
            if self.prepared:
                raise RuntimeError("adapter is already prepared")

            candidate = config.get("candidate")
            if not isinstance(candidate, dict) or candidate.get("id") != CANDIDATE_ID:
                raise ValueError("Qwen candidate config is required")
            expected_candidate = {
                "modelId": MODEL_ID,
                "revision": MODEL_REVISION,
                "runtime": RUNTIME_CONTRACT,
                "runtimeRevision": FASTER_REPO_COMMIT,
                "runtimeLockSha256": QWEN_REQUIREMENTS_LOCK_SHA256,
                "modelSha256": MODEL_SHA256,
                "voice": SPEAKER,
                "provider": PROVIDER,
                "precision": PRECISION,
                "backend": BACKEND,
                "device": MANIFEST_DEVICE,
            }
            for key, value in expected_candidate.items():
                if candidate.get(key) != value:
                    raise ValueError(f"Qwen candidate {key} does not match the pinned contract")
            optional_candidate = {
                "fasterRuntimeRevision": FASTER_REPO_COMMIT,
                "fasterVersion": FASTER_RUNTIME_VERSION,
                "officialRuntime": OFFICIAL_RUNTIME_CONTRACT,
                "runtimeLock": "services/audio/qwen-requirements.lock",
            }
            for key, value in optional_candidate.items():
                if key in candidate and candidate.get(key) != value:
                    raise ValueError(f"Qwen candidate {key} does not match the pinned contract")

            expected_top_level = {
                "language": LANGUAGE,
                "nativeSampleRate": SAMPLE_RATE,
                "comparisonSampleRate": SAMPLE_RATE,
                "outputFormat": OUTPUT_FORMAT,
                "channels": 1,
                "sampleWidthBytes": 2,
                "chunkMs": 20,
                "gain": 0.9,
                "speed": 1.0,
                "resampler": "none",
                "timingMode": "harness-monotonic-request-first-audio-completion-v2",
                "timingBoundary": "harness-before-adapter-call-through-adapter-return-v1",
                "playbackBufferMs": 100,
                "rssScope": "synthesis-window-whole-process-rss-v1",
                "device": DEVICE,
                "dtype": PRECISION,
                "attnImplementation": ATTENTION,
                "backend": BACKEND,
                "chunkSizeCodecSteps": CHUNK_SIZE_CODEC_STEPS,
            }
            for key, value in expected_top_level.items():
                actual = config.get(key)
                if key == "attnImplementation" and key not in config:
                    actual = config.get("attn_implementation")
                if key == "chunkSizeCodecSteps" and key not in config:
                    actual = config.get("chunkSize")
                if actual != value:
                    raise ValueError(f"Qwen {key} does not match the pinned contract")
            optional_top_level = {
                "maxNewTokens": MAX_NEW_TOKENS,
                "minNewTokens": MIN_NEW_TOKENS,
                "temperature": TEMPERATURE,
                "topK": TOP_K,
                "topP": TOP_P,
                "doSample": DO_SAMPLE,
                "repetitionPenalty": REPETITION_PENALTY,
            }
            for key, value in optional_top_level.items():
                if key in config and config.get(key) != value:
                    raise ValueError(f"Qwen {key} does not match the pinned contract")

            model_path = str(config.get("modelPath", ""))
            if not model_path:
                raise ValueError("verified Qwen modelPath is required")

            # Verify the lock, package identities, source revision, and all model
            # assets before allowing the backend to import/load model weights.
            self.runtime_verifier()
            self.asset_verifier(Path(model_path), self.expected_model_path, MODEL_SHA256, "model")
            backend = self.backend_factory()
            try:
                backend.prepare(model_path, DEVICE, PRECISION, ATTENTION)
                native_voices = tuple(sorted(set(str(value) for value in backend.get_voices())))
                voice_map: dict[str, str] = {}
                for native in native_voices:
                    label = _CANONICAL_VOICE_LABELS.get(native.lower(), native)
                    if label in voice_map and voice_map[label] != native:
                        raise ValueError("verified Qwen model exposed ambiguous speaker IDs")
                    voice_map[label] = native
                voices = tuple(sorted(voice_map))
                if not voices or SPEAKER not in voices:
                    raise ValueError("verified Qwen model exposed no usable speaker catalog")
            except BaseException:
                try:
                    backend.close()
                finally:
                    raise
            self.backend = backend
            self._voices = voices
            self._native_voices = voice_map
            self.voice = SPEAKER
            self.language = LANGUAGE
            self.speed = 1.0
            self.gain = 0.9
            self.chunk_samples = CHUNK_SAMPLES
            self.prepared = True

    def _register(self, thread: threading.Thread) -> None:
        with self._lock:
            self._workers.add(thread)

    def _unregister_dead(self) -> None:
        with self._lock:
            self._workers = {worker for worker in self._workers if worker.is_alive()}

    @property
    def worker_names(self) -> tuple[str, ...]:
        self._unregister_dead()
        registered = {worker.name for worker in self._workers if worker.is_alive()}
        owned = {
            worker.name
            for worker in threading.enumerate()
            if worker.is_alive()
            and any(worker.name.startswith(prefix) for prefix in OWNED_THREAD_PREFIXES)
        }
        return tuple(sorted(registered | owned))

    def get_voices(self) -> list[dict[str, str]]:
        with self._lock:
            if not self.prepared or not self._voices:
                raise RuntimeError("voice catalog is unavailable until the adapter is prepared")
            voices = [{"id": voice, "label": voice} for voice in self._voices]
            voices.extend(
                {"id": voice_id, "label": str(entry["label"])}
                for voice_id, entry in sorted(self._custom_voices.items())
            )
            return voices

    def has_voice(self, voice_id: str) -> bool:
        with self._lock:
            return self.prepared and (voice_id in self._voices or voice_id in self._custom_voices)

    def custom_voices(self) -> list[dict[str, str]]:
        with self._lock:
            return [
                {"voiceId": voice_id, "label": str(entry["label"]), "refSha256": str(entry["refSha256"])}
                for voice_id, entry in sorted(self._custom_voices.items())
            ]

    def _prompt_to_cpu(self, prompt: dict[str, Any]) -> dict[str, Any]:
        import torch

        return _to_cpu_prompt(prompt, torch)

    def _prompt_to_device(self, prompt: dict[str, Any]) -> dict[str, Any]:
        import torch

        return _to_device_prompt(prompt, torch, DEVICE)

    def _extract_user_prompt(self, decoded) -> dict[str, Any]:
        """Extract a deterministic x-vector prompt from one validated reference.

        x-vector-only mode needs no transcript, so no speech content is ever
        transcribed or retained as text (decision 008). The prompt is moved to
        CPU tensors and kept only inside this adapter instance.
        """
        import numpy as np

        backend = self._clone_backend
        if backend is None or not getattr(backend, "model", None):
            raise RuntimeError("Qwen clone backend is not prepared")
        audio = np.frombuffer(decoded.pcm16, dtype="<i2").astype(np.float32) / 32768.0
        model = getattr(backend, "model", None)
        prompt_items = model.model.create_voice_clone_prompt(
            ref_audio=(audio, CUSTOM_VOICE_SAMPLE_RATE),
            ref_text="",
            x_vector_only_mode=True,
        )
        prompt = model.model._prompt_items_to_voice_clone_prompt(prompt_items)
        return self._prompt_to_cpu(prompt)

    def _ensure_clone_backend(self) -> None:
        if self._clone_backend is not None:
            return
        self.clone_asset_verifier(self.expected_clone_model_path, self.expected_clone_model_path, BASE_MODEL_SHA256, "clone model")
        backend = self.clone_backend_factory()
        try:
            backend.prepare(str(self.expected_clone_model_path), DEVICE, PRECISION, ATTENTION)
        except BaseException:
            try:
                backend.close()
            finally:
                raise
        self._clone_backend = backend

    def enroll_custom_voice(
        self, voice_id: str, name: str, ref_sha256: str, wav_bytes: bytes
    ) -> None:
        """Enroll one user reference and cache its deterministic clone prompt.

        The same reference bytes always yield the same voice id and the same
        prompt; a re-enroll with an unchanged hash only refreshes the label.
        Bounded: at most MAX_CUSTOM_VOICES prompts are retained, each a few KB
        of CPU tensors, and the raw reference is released after extraction.
        """
        validate_voice_id(voice_id, ref_sha256)
        if hashlib.sha256(wav_bytes).hexdigest() != ref_sha256:
            raise ValueError("reference digest does not match its bytes")
        normalized_name = validate_name(name)
        decoded = decode_reference(wav_bytes)
        with self._lock:
            if self.closed:
                raise RuntimeError("adapter is closed")
            if not self.prepared:
                raise RuntimeError("adapter is not prepared")
            if self._active:
                raise RuntimeError("cannot enroll during active synthesis")
            if self._poisoned or bool(getattr(self.backend, "poisoned", False)):
                raise RuntimeError("Qwen backend is poisoned")
            existing = self._custom_voices.get(voice_id)
            if existing is not None and existing.get("refSha256") == ref_sha256:
                existing["label"] = normalized_name
                return
            if existing is None and len(self._custom_voices) >= MAX_CUSTOM_VOICES:
                raise RuntimeError("custom voice limit reached")
            self._ensure_clone_backend()
            if self._poisoned or bool(getattr(self._clone_backend, "poisoned", False)):
                raise RuntimeError("Qwen clone backend is poisoned")
            prompt = self._extract_user_prompt(decoded)
            self._custom_voices[voice_id] = {
                "label": normalized_name,
                "refSha256": ref_sha256,
                "prompt": prompt,
                "durationMs": decoded.duration_ms,
            }

    def remove_custom_voice(self, voice_id: str) -> bool:
        with self._lock:
            existing = self._custom_voices.pop(voice_id, None)
            if existing is not None and not self._custom_voices and not self._active and self._clone_backend is not None:
                self._clone_backend.close()
                self._clone_backend = None
        return existing is not None

    def voice_catalog(self) -> dict[str, object]:
        with self._lock:
            if not self.prepared or not self._voices:
                raise RuntimeError("voice catalog is unavailable until the adapter is prepared")
            digest = hashlib.sha256()
            for part in (
                "qwen3",
                MODEL_ID,
                TTS_CONFIG_ID,
                MODEL_REVISION,
                FASTER_REPO_COMMIT,
                *self._voices,
            ):
                digest.update(part.encode("utf-8"))
            # User voices are appended after the stock catalog. The catalogId is
            # deliberately stock-derived: admission stays stable and a rename or
            # re-enrollment never invalidates an open stream (decision 008).
            voices = [{"id": voice, "label": voice} for voice in self._voices]
            for voice_id, entry in sorted(self._custom_voices.items()):
                voices.append({"id": voice_id, "label": str(entry["label"])})
            return {
                "catalogId": digest.hexdigest()[:16],
                "backendId": "qwen3",
                "modelId": MODEL_ID,
                "runtimeConfigId": TTS_CONFIG_ID,
                "revision": MODEL_REVISION,
                "defaultVoiceId": SPEAKER,
                # faster-qwen's CustomVoice generator has no playback-speed
                # parameter. Keep this explicit so a Kokoro speed is never
                # silently presented as a Qwen capability.
                "speed": speed_capability(supported=False, minimum=1.0, maximum=1.0, default=1.0),
                "voices": voices,
            }

    def synthesize_stream(
        self,
        text: str,
        cancel: Cancellation,
        on_audio: AudioCallback | None = None,
        voice: str | None = None,
        tone_prompt: str | None = None,
        language: str | None = None,
    ) -> SynthesisResult:
        text = validate_text(text, self.max_text_characters)
        if tone_prompt is not None:
            tone_prompt = tone_prompt.strip()
            if len(tone_prompt.encode("utf-8")) > MAX_VOICE_TONE_PROMPT_BYTES:
                raise ValueError("Qwen tone prompt exceeds the configured byte limit")
        cancel.raise_if_cancelled()
        with self._lock:
            if not self.prepared or self.closed or self.backend is None:
                raise RuntimeError("adapter is not prepared")
            if self._poisoned or bool(getattr(self.backend, "poisoned", False)):
                raise RuntimeError("Qwen backend is poisoned")
            if self._active:
                raise RuntimeError("adapter synthesis is already active")
            selected_voice = self.voice if voice is None else voice
            custom_voice = self._custom_voices.get(selected_voice)
            if selected_voice not in self._voices and custom_voice is None:
                raise ValueError("requested voice is absent from the verified catalog")
            native_voice = self._native_voices.get(selected_voice)
            if custom_voice is not None and self._clone_backend is None:
                raise RuntimeError("custom voice prompt is unavailable")
            self._active = True
            backend = self.backend
            clone_backend = self._clone_backend
            custom_prompt = custom_voice.get("prompt") if custom_voice is not None else None
            selected_language = self.language if language is None else language
            if selected_language not in QWEN_SUPPORTED_LANGUAGES:
                raise ValueError("requested Qwen language is not supported")

        started = time.perf_counter()
        inference_queue: queue.Queue[bytes | BaseException | None] = queue.Queue(maxsize=2)
        output_queue: queue.Queue[bytes | BaseException | None] = queue.Queue(maxsize=2)
        stop = threading.Event()
        output_failure: list[BaseException] = []
        stats = {"samples": 0, "chunks": 0}
        digest = hashlib.sha256()

        def put_bounded(
            target: queue.Queue[bytes | BaseException | None],
            value: bytes | BaseException | None,
        ) -> bool:
            while not stop.is_set():
                if cancel.cancelled:
                    return False
                try:
                    target.put(value, timeout=0.02)
                    return True
                except queue.Full:
                    continue
            return False

        def infer() -> None:
            try:
                pcm_buffer = bytearray()
                frame_bytes = self.chunk_samples * 2
                for segment in segment_text(text):
                    cancel.raise_if_cancelled()
                    if custom_prompt is not None:
                        if clone_backend is None:
                            raise RuntimeError("Qwen clone backend is unavailable")
                        if not isinstance(custom_prompt, dict):
                            raise RuntimeError("custom voice prompt is malformed")
                        stream = (clone_backend.create_stream(
                            segment,
                            self._prompt_to_device(custom_prompt),
                            selected_language,
                            tone_prompt=tone_prompt,
                        ) if tone_prompt is not None else clone_backend.create_stream(
                            segment,
                            self._prompt_to_device(custom_prompt),
                            self.language,
                        ))
                    else:
                        if native_voice is None:
                            raise RuntimeError("stock Qwen voice is unavailable")
                        stream = (backend.create_stream(segment, native_voice, selected_language, tone_prompt=tone_prompt)
                                  if tone_prompt is not None
                                  else backend.create_stream(segment, native_voice, selected_language))
                    try:
                        for native in stream:
                            cancel.raise_if_cancelled()
                            samples, sample_rate = _packet(native)
                            if sample_rate != SAMPLE_RATE:
                                raise RuntimeError("Qwen emitted an unexpected sample rate")
                            pcm_buffer.extend(_pcm16(samples, self.gain))
                            while len(pcm_buffer) >= frame_bytes:
                                chunk = bytes(pcm_buffer[:frame_bytes])
                                del pcm_buffer[:frame_bytes]
                                if not put_bounded(inference_queue, chunk):
                                    return
                    finally:
                        close = getattr(stream, "close", None)
                        if callable(close):
                            close()
                if pcm_buffer and not cancel.cancelled:
                    put_bounded(inference_queue, bytes(pcm_buffer))
            except BaseException as error:
                put_bounded(inference_queue, error)
            finally:
                put_bounded(inference_queue, None)

        def output_worker() -> None:
            sequence = 0
            sample_offset = 0
            while not stop.is_set():
                try:
                    value = output_queue.get(timeout=0.02)
                except queue.Empty:
                    continue
                if value is None:
                    return
                if isinstance(value, BaseException):
                    output_failure.append(value)
                    return
                try:
                    if not value or len(value) % 2:
                        raise RuntimeError("Qwen emitted malformed PCM framing")
                    chunk = AudioChunk(sequence, value, SAMPLE_RATE, sample_offset)

                    def accept() -> None:
                        if on_audio is not None:
                            on_audio(chunk)
                        digest.update(value)
                        stats["samples"] += chunk.samples
                        stats["chunks"] += 1

                    cancel.accept_unless_cancelled(accept)
                    sequence += 1
                    sample_offset += chunk.samples
                except BaseException as error:
                    output_failure.append(error)
                    stop.set()
                    return

        inference_thread = threading.Thread(
            target=infer, name="qwen-inference", daemon=True
        )
        output_thread = threading.Thread(
            target=output_worker, name="qwen-output", daemon=True
        )
        self._register(inference_thread)
        self._register(output_thread)
        inference_thread.start()
        output_thread.start()
        primary_error: BaseException | None = None
        try:
            while True:
                cancel.raise_if_cancelled()
                if output_failure:
                    raise output_failure[0]
                try:
                    value = inference_queue.get(timeout=0.02)
                except queue.Empty:
                    if not inference_thread.is_alive():
                        raise RuntimeError("Qwen inference ended without a terminal record")
                    continue
                if value is None:
                    put_bounded(output_queue, None)
                    break
                if isinstance(value, BaseException):
                    raise value
                if not put_bounded(output_queue, value):
                    cancel.raise_if_cancelled()
                    raise RuntimeError("Qwen output queue stopped")
            inference_thread.join(timeout=self.worker_timeout_seconds)
            output_thread.join(timeout=self.worker_timeout_seconds)
            cancel.raise_if_cancelled()
            if output_failure:
                raise output_failure[0]
            if stats["samples"] <= 0:
                raise RuntimeError("Qwen produced no audio")
        except BaseException as error:
            primary_error = error
            stop.set()
            while True:
                try:
                    inference_queue.get_nowait()
                except queue.Empty:
                    break
            while True:
                try:
                    output_queue.get_nowait()
                except queue.Empty:
                    break
            inference_thread.join(timeout=self.worker_timeout_seconds)
            output_thread.join(timeout=self.worker_timeout_seconds)
        finally:
            alive = [worker for worker in (inference_thread, output_thread) if worker.is_alive()]
            if alive:
                self._poisoned = True
                try:
                    backend.poisoned = True
                except AttributeError:
                    pass
            self._unregister_dead()
            with self._lock:
                self._active = False

        if inference_thread.is_alive() or output_thread.is_alive():
            names = ", ".join(
                worker.name
                for worker in (inference_thread, output_thread)
                if worker.is_alive()
            )
            raise RuntimeError(f"Qwen workers did not stop; backend poisoned: {names}") from primary_error
        if primary_error is not None:
            if cancel.cancelled:
                cancel.raise_if_cancelled()
            raise RuntimeError(f"Qwen synthesis failed: {type(primary_error).__name__}") from primary_error
        processing = time.perf_counter() - started
        return SynthesisResult(
            sample_rate=SAMPLE_RATE,
            total_samples=stats["samples"],
            audio_seconds=stats["samples"] / SAMPLE_RATE,
            processing_seconds=processing,
            sha256=digest.hexdigest(),
            chunk_count=stats["chunks"],
        )

    def synthesize(self, text: str, cancel: Cancellation) -> Iterator[bytes]:
        chunks: list[bytes] = []
        self.synthesize_stream(text, cancel, lambda chunk: chunks.append(chunk.pcm16))
        return iter(chunks)

    def reset(self) -> None:
        with self._lock:
            if self.closed or not self.prepared or self.backend is None:
                raise RuntimeError("adapter is closed or unprepared")
            if self._active:
                raise RuntimeError("cannot reset active synthesis")
            if self._poisoned or bool(getattr(self.backend, "poisoned", False)):
                raise RuntimeError("cannot reset a poisoned Qwen backend")
            if self._clone_backend is not None and bool(getattr(self._clone_backend, "poisoned", False)):
                raise RuntimeError("cannot reset a poisoned Qwen clone backend")
            self.backend.reset()
            if self._clone_backend is not None:
                self._clone_backend.reset()
            self.generation += 1

    def close(self) -> None:
        with self._lock:
            if self.closed:
                return
            if self._active:
                raise RuntimeError("cannot close active synthesis")
            if self.worker_names:
                self._poisoned = True
                raise RuntimeError("cannot close while Qwen workers survive")
            if self.backend is not None:
                self.backend.close()
            if self._clone_backend is not None:
                self._clone_backend.close()
            self.backend = None
            self._clone_backend = None
            self._custom_voices.clear()
            self._voices = ()
            self._native_voices = {}
            self.prepared = False
            self.closed = True


# Keep both spellings available while the candidate remains replaceable behind
# the shared StreamingTtsAdapter protocol.
QwenStreamingAdapter = Qwen3StreamingAdapter
