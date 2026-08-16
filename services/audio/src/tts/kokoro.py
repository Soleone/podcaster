from __future__ import annotations

import asyncio
from concurrent.futures import ThreadPoolExecutor
import hashlib
import importlib.metadata
import json
from pathlib import Path
import queue
import threading
import time
from collections.abc import AsyncIterator, Callable, Iterator
from dataclasses import dataclass, field
from typing import Any, Protocol

from .base import AudioCallback, AudioChunk, Cancellation, SynthesisResult, speed_capability

MODEL_ID = "hexgrad/Kokoro-82M"
MODEL_REVISION = "f3ff3571791e39611d31c381e3a41a3af07b4987"
ONNX_RELEASE_REVISION = "6843c53fc280ab130b7a8d206ebd3407e094efdc"
RUNTIME_REVISION = "98ea02a5692534c2ba496708e2f19de25028412b"
RUNTIME_VERSION = "0.5.0"
SAMPLE_RATE = 24_000
VOICE = "af_heart"
LANGUAGE = "en-us"
CPU_PROVIDER = "CPUExecutionProvider"
CUDA_PROVIDER = "CUDAExecutionProvider"
# The model files are identical for both execution providers. Keep the CUDA
# contract as the production default, while retaining a separately attested CPU
# contract for matched benchmark comparisons.
PROVIDER = CUDA_PROVIDER
PRECISION = "float32"
OUTPUT_FORMAT = "pcm_s16le_mono"
MAX_TEXT_CHARACTERS = 4_000
MODEL_SHA256 = "7d5df8ecf7d4b1878015a32686053fd0eebe2bc377234608764cc0ef3636a6c5"
VOICES_SHA256 = "bca610b8308e8d99f32e6fe4197e7ec01679264efed0cac9140fe9c29f1fbf7d"
ROOT = Path(__file__).resolve().parents[4]
MODEL_PATH = (ROOT / "models/kokoro-82m-onnx/kokoro-v1.0.onnx").resolve()
VOICES_PATH = (ROOT / "models/kokoro-82m-onnx/voices-v1.0.bin").resolve()
OWNED_THREAD_PREFIXES = ("kokoro-inference", "kokoro-output", "kokoro-runtime-executor")
# Stable identity for the voice catalog's runtimeConfigId, aligned with the
# readiness tts id without importing runtime (avoids a circular import).
TTS_CONFIG_ID = "kokoro-82m-onnx-fp32-af-heart-cuda-v1"
CPU_TTS_CONFIG_ID = "kokoro-82m-onnx-fp32-af-heart-cpu-v1"

CPU_RUNTIME_CONTRACT = (
    "kokoro-onnx==0.5.0; git=98ea02a5692534c2ba496708e2f19de25028412b; "
    "onnxruntime==1.22.1"
)
# onnxruntime-gpu 1.22.0 (cu12). onnxruntime 1.22.1 has no GPU wheel; the proxy
# wheel vendor/onnxruntime-1.22.0-py3-none-any.whl satisfies the onnxruntime
# requirement with the GPU build only (see scripts/build-ort-proxy-wheel.py).
CUDA_RUNTIME_CONTRACT = (
    "kokoro-onnx==0.5.0; git=98ea02a5692534c2ba496708e2f19de25028412b; "
    "onnxruntime-gpu==1.22.0 (cu12; onnxruntime proxy wheel)"
)
RUNTIME_CONTRACT = CUDA_RUNTIME_CONTRACT

# Ordered so each library's own DT_NEEDED dependencies load first.
_NVIDIA_CUDA12_PACKAGES = (
    "nvidia-cuda-runtime-cu12",  # libcudart.so.12
    "nvidia-nvjitlink-cu12",  # cublas 12.1 depends on it
    "nvidia-cublas-cu12",  # libcublas.so.12, libcublasLt.so.12
    "nvidia-cufft-cu12",  # libcufft.so.11
    "nvidia-curand-cu12",  # libcurand.so.10
    "nvidia-cuda-nvrtc-cu12",  # libnvrtc.so.12
    "nvidia-cudnn-cu12",  # libcudnn.so.9 (last: needs cublas/cublasLt/cudart)
)


def preload_cuda_runtime() -> None:
    """Load pip-installed CUDA 12 runtime libraries into the global scope.

    onnxruntime-gpu wheels ship libonnxruntime_providers_cuda.so with DT_NEEDED
    entries for libcublas/libcublasLt/libcudnn/libcudart/... but no RPATH, and
    the pip nvidia packages are not on LD_LIBRARY_PATH. Preloading them with
    RTLD_GLOBAL lets the provider library resolve its dependencies. Failures are
    tolerated here; the provider check in prepare() enforces the outcome.
    """
    import ctypes
    import importlib.metadata

    for dist_name in _NVIDIA_CUDA12_PACKAGES:
        try:
            dist = importlib.metadata.distribution(dist_name)
        except importlib.metadata.PackageNotFoundError:
            continue
        short = dist_name[len("nvidia-") :].split("-cu12", 1)[0].replace("-", "_")
        lib_dir = dist.locate_file("") / "nvidia" / short / "lib"
        if not lib_dir.is_dir():
            continue
        for so in sorted(lib_dir.glob("*.so*")):
            try:
                ctypes.CDLL(str(so), mode=ctypes.RTLD_GLOBAL)
            except OSError:
                continue


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _verify_asset(path: Path, expected_path: Path, expected_sha256: str, label: str) -> None:
    try:
        resolved = path.resolve(strict=True)
    except OSError as error:
        raise ValueError(f"pinned Kokoro {label} path is missing") from error
    if resolved != expected_path.resolve(strict=True):
        raise ValueError(f"Kokoro {label} path does not match the pinned exact path")
    if not resolved.is_file() or _sha256_file(resolved) != expected_sha256:
        raise ValueError(f"Kokoro {label} bytes do not match the pinned SHA-256")


def _verify_runtime_distribution(provider: str = PROVIDER) -> None:
    if provider not in {CPU_PROVIDER, CUDA_PROVIDER}:
        raise RuntimeError("unsupported Kokoro execution provider")
    kokoro = importlib.metadata.distribution("kokoro-onnx")
    if kokoro.version != RUNTIME_VERSION:
        raise RuntimeError("kokoro-onnx runtime version does not match the pinned contract")
    direct_url_text = kokoro.read_text("direct_url.json")
    if not direct_url_text:
        raise RuntimeError("kokoro-onnx lacks verifiable direct-url origin metadata")
    direct_url = json.loads(direct_url_text)
    vcs = direct_url.get("vcs_info", {})
    if (
        direct_url.get("url") != "https://github.com/thewh1teagle/kokoro-onnx.git"
        or vcs.get("vcs") != "git"
        or vcs.get("commit_id") != RUNTIME_REVISION
        or vcs.get("requested_revision") != RUNTIME_REVISION
    ):
        raise RuntimeError("kokoro-onnx origin/revision does not match the pinned contract")
    if provider == CPU_PROVIDER:
        if importlib.metadata.version("onnxruntime") != "1.22.1":
            raise RuntimeError("onnxruntime CPU version does not match the pinned contract")
        return
    gpu = importlib.metadata.distribution("onnxruntime-gpu")
    if gpu.version != "1.22.0":
        raise RuntimeError("onnxruntime-gpu version does not match the pinned contract")
    proxy = importlib.metadata.distribution("onnxruntime")
    if proxy.version != "1.22.0":
        raise RuntimeError("onnxruntime proxy version does not match the pinned contract")


class KokoroBackend(Protocol):
    poisoned: bool

    def prepare(self, model_path: str, voices_path: str, provider: str) -> None: ...

    def get_voices(self) -> list[str]: ...

    def create_stream(
        self, text: str, voice: str, speed: float, language: str
    ) -> AsyncIterator[tuple[Any, int]]: ...

    def reset(self) -> None: ...

    def close(self) -> None: ...


@dataclass
class KokoroOnnxBackend:
    """Pinned kokoro-onnx runtime using one explicit ONNX Runtime provider."""

    engine: Any = None
    session: Any = None
    poisoned: bool = False
    voices: list[str] = field(default_factory=list)

    runtime_verifier: Callable[[str], None] = _verify_runtime_distribution

    def prepare(self, model_path: str, voices_path: str, provider: str) -> None:
        from kokoro_onnx import Kokoro
        import onnxruntime as ort

        if provider == CUDA_PROVIDER:
            preload_cuda_runtime()
        self.runtime_verifier(provider)
        if provider not in ort.get_available_providers():
            raise RuntimeError("configured ONNX provider is unavailable")
        session_options = ort.SessionOptions()
        # Silence ORT's one-time session warnings (Memcpy/scatter/EP notes) so the
        # sidecar's captured stderr stays clean; failures still surface as errors.
        session_options.log_severity_level = 3
        self.session = ort.InferenceSession(
            model_path, providers=[provider], sess_options=session_options
        )
        active = self.session.get_providers()
        if not active or active[0] != provider:
            raise RuntimeError("ONNX Runtime did not honor the exact configured provider")
        self.engine = Kokoro.from_session(self.session, voices_path)
        voices = list(self.engine.get_voices())
        if not voices:
            raise RuntimeError("verified voices file exposed no voices")
        if VOICE not in voices:
            raise RuntimeError("pinned Kokoro voice is absent from the verified voices file")
        self.voices = voices

    def get_voices(self) -> list[str]:
        if not self.voices:
            raise RuntimeError("Kokoro backend is not prepared")
        return list(self.voices)

    def create_stream(
        self, text: str, voice: str, speed: float, language: str
    ) -> AsyncIterator[tuple[Any, int]]:
        if self.engine is None:
            raise RuntimeError("Kokoro backend is not prepared")
        return self.engine.create_stream(text, voice=voice, speed=speed, lang=language)

    def reset(self) -> None:
        if self.poisoned:
            raise RuntimeError("cannot reset a poisoned Kokoro backend")

    def close(self) -> None:
        self.engine = None
        self.session = None


def validate_text(text: str, max_characters: int = MAX_TEXT_CHARACTERS) -> str:
    if not isinstance(text, str):
        raise TypeError("TTS text must be a string")
    if not text or not text.strip():
        raise ValueError("TTS text must not be empty")
    if len(text) > max_characters:
        raise ValueError(f"TTS text exceeds {max_characters} characters")
    if any(0xD800 <= ord(character) <= 0xDFFF for character in text):
        raise ValueError("TTS text contains an unpaired surrogate")
    if any(ord(character) < 32 and character not in "\n\r\t" for character in text):
        raise ValueError("TTS text contains a disallowed control character")
    return text


def segment_text(text: str, max_characters: int = 350) -> tuple[str, ...]:
    """Split deterministically while preserving every exact source character."""
    validate_text(text)
    if max_characters < 32:
        raise ValueError("segment size is too small")
    segments: list[str] = []
    start = 0
    while len(text) - start > max_characters:
        limit = start + max_characters
        boundary = -1
        # Prefer splitting after punctuation, then after any whitespace. The source
        # whitespace belongs to exactly one segment and is never normalized.
        for index in range(limit, start, -1):
            if text[index - 1] in ".!?;:\n\r":
                boundary = index
                break
        if boundary < 0:
            for index in range(limit, start, -1):
                if text[index - 1].isspace():
                    boundary = index
                    break
        if boundary <= start:
            raise ValueError("one TTS token exceeds the segment limit")
        segments.append(text[start:boundary])
        start = boundary
    if start < len(text):
        segments.append(text[start:])
    if not segments or not any(segment.strip() for segment in segments):
        raise ValueError("TTS text did not contain synthesizable content")
    if "".join(segments) != text or any(len(segment) > max_characters for segment in segments):
        raise RuntimeError("text segmentation changed exact source text")
    return tuple(segments)


def _pcm16(samples: Any, gain: float) -> bytes:
    import numpy as np

    values = np.asarray(samples, dtype=np.float32).reshape(-1)
    if not values.size:
        return b""
    if not np.isfinite(values).all():
        raise ValueError("Kokoro produced non-finite audio")
    scaled = values * gain
    if float(np.max(np.abs(scaled))) > 1.0:
        raise ValueError("Kokoro output would clip under the pinned gain policy")
    scaled = np.clip(scaled, -1.0, 32767.0 / 32768.0)
    return np.rint(scaled * 32768.0).astype("<i2").tobytes()


@dataclass
class KokoroStreamingAdapter:
    backend_factory: Callable[[], KokoroBackend] = KokoroOnnxBackend
    asset_verifier: Callable[[Path, Path, str, str], None] = _verify_asset
    expected_model_path: Path = MODEL_PATH
    expected_voices_path: Path = VOICES_PATH
    backend: KokoroBackend | None = None
    prepared: bool = False
    closed: bool = False
    generation: int = 0
    voice: str = VOICE
    speed: float = 1.0
    language: str = LANGUAGE
    gain: float = 0.9
    chunk_samples: int = 480
    max_text_characters: int = MAX_TEXT_CHARACTERS
    worker_timeout_seconds: float = 10.0
    _active: bool = False
    _poisoned: bool = False
    _voices: tuple[str, ...] = ()
    provider: str = PROVIDER
    config_id: str = TTS_CONFIG_ID
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
            if not isinstance(candidate, dict) or candidate.get("id") != "kokoro":
                raise ValueError("Kokoro candidate config is required")
            provider = candidate.get("provider")
            runtime_contract = {
                CPU_PROVIDER: CPU_RUNTIME_CONTRACT,
                CUDA_PROVIDER: CUDA_RUNTIME_CONTRACT,
            }.get(provider)
            if runtime_contract is None:
                raise ValueError("Kokoro candidate provider is unsupported")
            expected = {
                "modelId": MODEL_ID,
                "revision": MODEL_REVISION,
                "onnxReleaseRevision": ONNX_RELEASE_REVISION,
                "runtimeRevision": RUNTIME_REVISION,
                "runtime": runtime_contract,
                "modelSha256": MODEL_SHA256,
                "voicesSha256": VOICES_SHA256,
                "voice": VOICE,
                "provider": provider,
                "precision": PRECISION,
            }
            for key, value in expected.items():
                if candidate.get(key) != value:
                    raise ValueError(f"Kokoro candidate {key} does not match the pinned contract")
            top_level = {
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
            }
            for key, value in top_level.items():
                if config.get(key) != value:
                    raise ValueError(f"Kokoro {key} does not match the pinned contract")
            model_path = str(config.get("modelPath", ""))
            voices_path = str(config.get("voicesPath", ""))
            if not model_path or not voices_path:
                raise ValueError("verified modelPath and voicesPath are required")
            self.asset_verifier(
                Path(model_path), self.expected_model_path, MODEL_SHA256, "model"
            )
            self.asset_verifier(
                Path(voices_path), self.expected_voices_path, VOICES_SHA256, "voices"
            )
            backend = self.backend_factory()
            try:
                backend.prepare(model_path, voices_path, str(provider))
            except BaseException:
                try:
                    backend.close()
                finally:
                    raise
            self.backend = backend
            self.provider = str(provider)
            self.config_id = str(config.get("id", TTS_CONFIG_ID))
            voices = tuple(sorted(set(backend.get_voices())))
            if not voices or VOICE not in voices:
                raise ValueError("verified voices file exposed no usable catalog")
            self._voices = voices
            self.voice = VOICE
            self.speed = 1.0
            self.language = LANGUAGE
            self.gain = 0.9
            self.chunk_samples = SAMPLE_RATE * 20 // 1000
            self.prepared = True

    def _register(self, thread: threading.Thread) -> None:
        with self._lock:
            self._workers.add(thread)

    def get_voices(self) -> list[dict[str, str]]:
        with self._lock:
            if not self.prepared or not self._voices:
                raise RuntimeError("voice catalog is unavailable until the adapter is prepared")
            return [{"id": voice, "label": voice} for voice in self._voices]

    def has_voice(self, voice_id: str) -> bool:
        with self._lock:
            return self.prepared and voice_id in self._voices

    def voice_catalog(self) -> dict[str, object]:
        with self._lock:
            if not self.prepared or not self._voices:
                raise RuntimeError("voice catalog is unavailable until the adapter is prepared")
            digest = hashlib.sha256()
            for part in ("kokoro", "kokoro-82m-onnx", self.config_id, self.provider, VOICES_SHA256):
                digest.update(part.encode("utf-8"))
            return {
                "catalogId": digest.hexdigest()[:16],
                "backendId": "kokoro",
                "modelId": "kokoro-82m-onnx",
                "runtimeConfigId": self.config_id,
                "revision": VOICES_SHA256[:12],
                "defaultVoiceId": VOICE,
                "speed": speed_capability(),
                "voices": [{"id": voice, "label": voice} for voice in self._voices],
            }

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

    def synthesize_stream(
        self,
        text: str,
        cancel: Cancellation,
        on_audio: AudioCallback | None = None,
        voice: str | None = None,
    ) -> SynthesisResult:
        text = validate_text(text, self.max_text_characters)
        cancel.raise_if_cancelled()
        with self._lock:
            if not self.prepared or self.closed or self.backend is None:
                raise RuntimeError("adapter is not prepared")
            if self._poisoned or bool(getattr(self.backend, "poisoned", False)):
                raise RuntimeError("Kokoro backend is poisoned")
            if self._active:
                raise RuntimeError("adapter synthesis is already active")
            selected_voice = self.voice if voice is None else voice
            if selected_voice not in self._voices:
                raise ValueError("requested voice is absent from the verified catalog")
            self._active = True
            backend = self.backend
        started = time.perf_counter()
        inference_queue: queue.Queue[bytes | BaseException | None] = queue.Queue(maxsize=2)
        output_queue: queue.Queue[bytes | BaseException | None] = queue.Queue(maxsize=2)
        stop = threading.Event()
        output_failure: list[BaseException] = []
        stats = {"samples": 0, "chunks": 0}
        digest = hashlib.sha256()

        def put_bounded(target: queue.Queue[bytes | BaseException | None], value: bytes | BaseException | None) -> bool:
            while not stop.is_set():
                if cancel.cancelled:
                    return False
                try:
                    target.put(value, timeout=0.02)
                    return True
                except queue.Full:
                    continue
            return False

        async def infer() -> None:
            pcm_buffer = bytearray()
            for segment in segment_text(text):
                cancel.raise_if_cancelled()
                async for samples, sample_rate in backend.create_stream(
                    segment, selected_voice, self.speed, self.language
                ):
                    cancel.raise_if_cancelled()
                    if sample_rate != SAMPLE_RATE:
                        raise RuntimeError("Kokoro emitted an unexpected sample rate")
                    pcm_buffer.extend(_pcm16(samples, self.gain))
                    frame_bytes = self.chunk_samples * 2
                    while len(pcm_buffer) >= frame_bytes:
                        chunk = bytes(pcm_buffer[:frame_bytes])
                        del pcm_buffer[:frame_bytes]
                        if not put_bounded(inference_queue, chunk):
                            return
            if pcm_buffer and not cancel.cancelled:
                put_bounded(inference_queue, bytes(pcm_buffer))

        def inference_worker() -> None:
            try:
                async def run_inference() -> None:
                    loop = asyncio.get_running_loop()
                    executor = ThreadPoolExecutor(
                        max_workers=1, thread_name_prefix="kokoro-runtime-executor"
                    )
                    loop.set_default_executor(executor)
                    try:
                        await infer()
                    finally:
                        executor.shutdown(wait=True, cancel_futures=True)

                asyncio.run(run_inference())
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
            target=inference_worker, name="kokoro-inference", daemon=True
        )
        output_thread = threading.Thread(target=output_worker, name="kokoro-output", daemon=True)
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
                        raise RuntimeError("Kokoro inference ended without a terminal record")
                    continue
                if value is None:
                    put_bounded(output_queue, None)
                    break
                if isinstance(value, BaseException):
                    raise value
                if not value or len(value) % 2:
                    raise RuntimeError("Kokoro emitted malformed PCM framing")
                if not put_bounded(output_queue, value):
                    cancel.raise_if_cancelled()
                    raise RuntimeError("Kokoro output queue stopped")
            inference_thread.join(timeout=self.worker_timeout_seconds)
            output_thread.join(timeout=self.worker_timeout_seconds)
            cancel.raise_if_cancelled()
            if output_failure:
                raise output_failure[0]
            if stats["samples"] <= 0:
                raise RuntimeError("Kokoro produced no audio")
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
            names = ", ".join(worker.name for worker in (inference_thread, output_thread) if worker.is_alive())
            raise RuntimeError(f"Kokoro workers did not stop; backend poisoned: {names}") from primary_error
        if primary_error is not None:
            if cancel.cancelled:
                # Preserve the caller token's cancellation exception type and message.
                cancel.raise_if_cancelled()
            raise RuntimeError(f"Kokoro synthesis failed: {type(primary_error).__name__}") from primary_error
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
                raise RuntimeError("cannot reset a poisoned Kokoro backend")
            self.backend.reset()
            self.generation += 1

    def close(self) -> None:
        with self._lock:
            if self.closed:
                return
            if self._active:
                raise RuntimeError("cannot close active synthesis")
            if self.worker_names:
                self._poisoned = True
                raise RuntimeError("cannot close while Kokoro workers survive")
            if self.backend is not None:
                self.backend.close()
            self.backend = None
            self.prepared = False
            self.closed = True
