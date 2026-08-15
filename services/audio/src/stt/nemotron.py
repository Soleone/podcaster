from __future__ import annotations

import contextlib
import io
import queue
import sys
import threading
import time
from collections.abc import Callable, Iterable, Iterator
from dataclasses import dataclass
from typing import Any, Protocol

from .base import Cancellation, PartialCallback, TranscriptUpdate, TranscriptionResult

MODEL_ID = "nvidia/nemotron-3.5-asr-streaming-0.6b"
MODEL_REVISION = "1c8deaecc64b91f034d73e08dd8b64625eb3395d"
SAMPLE_RATE = 16_000
LOOKAHEAD_BY_CHUNK_MS = {80: 0, 160: 1, 320: 3, 560: 6, 1120: 13}


class NemotronBackend(Protocol):
    def prepare(self, model_path: str, chunk_ms: int, language: str, precision: str) -> None: ...

    def stream(
        self,
        chunks: Iterable[bytes],
        cancel: Cancellation,
        emit_text: Callable[[str], None],
    ) -> str: ...

    def reset(self) -> None: ...

    def close(self) -> None: ...


@contextlib.contextmanager
def _quiet_model_loading() -> Iterator[None]:
    """Hide library progress bars while loading model weights.

    Transformers renders a tqdm "Loading weights" bar straight to stderr and the
    hub can print local-file notices; none of that is diagnostic in the sidecar.
    Capture both streams and only replay them if loading actually fails so real
    errors keep their context.
    """
    stdout = io.StringIO()
    stderr = io.StringIO()
    try:
        with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            yield
    except BaseException:
        written = stdout.getvalue() + stderr.getvalue()
        if written:
            # The redirect context managers have already restored the real streams.
            sys.stdout.write(written)
            sys.stdout.flush()
        raise


@dataclass
class TransformersNemotronBackend:
    """Official Transformers cache-aware RNNT streaming implementation.

    One `model.generate` call consumes a lazy input-feature generator. Encoder attention and
    convolution caches therefore live inside that native generation call; audio is never
    repeatedly decoded as a growing whole-file prefix.
    """

    model: Any = None
    processor: Any = None
    device: str = "cuda"
    chunk_ms: int = 560
    language: str = "en-US"
    _active: threading.Thread | None = None
    _poisoned: bool = False

    def prepare(self, model_path: str, chunk_ms: int, language: str, precision: str) -> None:
        import torch
        from transformers import AutoModelForRNNT, AutoProcessor

        if not torch.cuda.is_available():
            raise RuntimeError("CUDA is unavailable")
        if chunk_ms not in LOOKAHEAD_BY_CHUNK_MS:
            raise ValueError("unsupported Nemotron streaming chunk size")
        if precision != "float32":
            raise ValueError("pinned Nemotron checkpoint is float32; unmatched precision rejected")
        self.chunk_ms = chunk_ms
        self.language = language
        with _quiet_model_loading():
            self.processor = AutoProcessor.from_pretrained(model_path, local_files_only=True)
            self.processor.set_num_lookahead_tokens(LOOKAHEAD_BY_CHUNK_MS[chunk_ms])
            if self.processor.streaming_latency_ms != chunk_ms:
                raise RuntimeError("processor streaming latency does not match config")
            self.model = AutoModelForRNNT.from_pretrained(
                model_path, local_files_only=True, dtype=torch.float32
            ).to(self.device)
            self.model.eval()

    @staticmethod
    def _pcm_array(chunk: bytes) -> Any:
        import numpy as np

        if len(chunk) % 2:
            raise ValueError("PCM16 chunk has an odd byte count")
        return np.frombuffer(chunk, dtype="<i2").astype(np.float32) / 32768.0

    def _feature_generator(self, chunks: Iterable[bytes], cancel: Cancellation) -> tuple[Any, Iterator[Any]]:
        import numpy as np

        if self.processor is None:
            raise RuntimeError("backend is not prepared")
        expected_bytes = SAMPLE_RATE * self.chunk_ms // 1000 * 2
        iterator = iter(chunks)
        audio = np.empty(0, dtype=np.float32)
        exhausted = False

        def ensure(sample_count: int) -> bool:
            nonlocal audio, exhausted
            while len(audio) < sample_count and not exhausted:
                cancel.raise_if_cancelled()
                try:
                    raw = next(iterator)
                except StopIteration:
                    exhausted = True
                    break
                if len(raw) != expected_bytes:
                    raise ValueError(
                        f"Nemotron input chunk must be exactly {expected_bytes} PCM16 bytes"
                    )
                audio = np.concatenate((audio, self._pcm_array(raw)))
            return len(audio) >= sample_count

        first_count = self.processor.num_samples_first_audio_chunk
        if not ensure(first_count):
            if not len(audio):
                raise ValueError("empty audio stream")
            audio = np.pad(audio, (0, first_count - len(audio)))
        first = self.processor(
            audio[:first_count],
            sampling_rate=SAMPLE_RATE,
            is_streaming=True,
            is_first_audio_chunk=True,
            language=self.language,
            return_tensors="pt",
        ).to(self.device, dtype=self.model.dtype)

        def features() -> Iterator[Any]:
            yield first.input_features[:, : self.processor.num_mel_frames_first_audio_chunk, :]
            mel_frame = self.processor.num_mel_frames_first_audio_chunk
            hop = self.processor.feature_extractor.hop_length
            n_fft = self.processor.feature_extractor.n_fft
            while True:
                cancel.raise_if_cancelled()
                start = mel_frame * hop - n_fft // 2
                end = start + self.processor.num_samples_per_audio_chunk
                if not ensure(end):
                    remaining = len(audio) - start
                    if remaining <= n_fft // 2:
                        break
                    audio_window = np.pad(audio[start:], (0, end - len(audio)))
                else:
                    audio_window = audio[start:end]
                inputs = self.processor(
                    audio_window,
                    sampling_rate=SAMPLE_RATE,
                    is_streaming=True,
                    is_first_audio_chunk=False,
                    language=self.language,
                    return_tensors="pt",
                ).to(self.device, dtype=self.model.dtype)
                yield inputs.input_features
                mel_frame += self.processor.num_mel_frames_per_audio_chunk
                if exhausted and end >= len(audio):
                    break

        return first, features()

    def stream(
        self,
        chunks: Iterable[bytes],
        cancel: Cancellation,
        emit_text: Callable[[str], None],
    ) -> str:
        import torch
        from transformers import StoppingCriteria, StoppingCriteriaList, TextIteratorStreamer

        if self.model is None or self.processor is None:
            raise RuntimeError("backend is not prepared")
        if self._poisoned:
            raise RuntimeError("Nemotron backend is poisoned after unresolved generation")
        if self._active is not None and self._active.is_alive():
            raise RuntimeError("a Nemotron stream is already active")
        first, features = self._feature_generator(chunks, cancel)
        streamer = TextIteratorStreamer(
            self.processor.tokenizer, skip_special_tokens=True, timeout=0.25
        )
        failure: list[BaseException] = []

        class CancelCriteria(StoppingCriteria):
            def __call__(self, input_ids: Any, scores: Any, **kwargs: Any) -> Any:
                return torch.full(
                    (input_ids.shape[0],), bool(cancel.cancelled), device=input_ids.device
                )

        kwargs = {
            **first,
            "input_features": features,
            "streamer": streamer,
            "stopping_criteria": StoppingCriteriaList([CancelCriteria()]),
            "max_new_tokens": 4096,
        }

        def generate() -> None:
            try:
                with torch.inference_mode():
                    self.model.generate(**kwargs)
            except BaseException as error:  # surfaced on the owning thread
                failure.append(error)
                try:
                    streamer.on_finalized_text("", stream_end=True)
                except Exception:
                    pass

        worker = threading.Thread(target=generate, name="nemotron-stream", daemon=True)
        self._active = worker
        worker.start()
        text = ""
        try:
            iterator = iter(streamer)
            while worker.is_alive() or not failure:
                cancel.raise_if_cancelled()
                try:
                    piece = next(iterator)
                except queue.Empty:
                    if not worker.is_alive():
                        break
                    continue
                except StopIteration:
                    break
                if piece:
                    text += piece
                    emit_text(text)
        finally:
            worker.join(timeout=10)
            if worker.is_alive():
                self._poisoned = True
            else:
                self._active = None
        if worker.is_alive():
            raise RuntimeError("Nemotron generation worker did not stop; backend poisoned")
        cancel.raise_if_cancelled()
        if failure:
            raise RuntimeError(f"Nemotron generation failed: {type(failure[0]).__name__}") from failure[0]
        return text.strip()

    def reset(self) -> None:
        if self._poisoned:
            raise RuntimeError("cannot reset a poisoned Nemotron backend")
        if self._active is not None and self._active.is_alive():
            raise RuntimeError("cannot reset an active Nemotron stream")

    def close(self) -> None:
        if self._active is not None and self._active.is_alive():
            raise RuntimeError("cannot close an active Nemotron stream")
        self.model = None
        self.processor = None
        try:
            import torch

            if torch.cuda.is_available():
                torch.cuda.empty_cache()
        except ImportError:
            pass


@dataclass
class NemotronStreamingAdapter:
    backend_factory: Callable[[], NemotronBackend] = TransformersNemotronBackend
    backend: NemotronBackend | None = None
    prepared: bool = False
    closed: bool = False
    generation: int = 0
    chunk_ms: int = 560
    _active: bool = False

    def prepare(self, config: dict[str, object]) -> None:
        if self.closed:
            raise RuntimeError("adapter is closed")
        candidate = config.get("candidate")
        if not isinstance(candidate, dict) or candidate.get("id") != "nemotron":
            raise ValueError("Nemotron candidate config is required")
        chunk_ms = int(config.get("chunkMs", 0))
        if chunk_ms not in LOOKAHEAD_BY_CHUNK_MS:
            raise ValueError("chunkMs must be one of 80, 160, 320, 560, 1120")
        language = str(config.get("language", ""))
        if language != "en-US":
            raise ValueError("T3.1 matched English benchmark requires language en-US")
        model_path = str(config.get("modelPath", ""))
        if not model_path:
            raise ValueError("pinned local modelPath is required")
        precision = str(candidate.get("precision", ""))
        backend = self.backend_factory()
        backend.prepare(model_path, chunk_ms, language, precision)
        self.backend = backend
        self.chunk_ms = chunk_ms
        self.prepared = True

    def transcribe_stream(
        self,
        stream: Iterable[bytes],
        cancel: Cancellation,
        on_partial: PartialCallback | None = None,
    ) -> TranscriptionResult:
        if not self.prepared or self.closed or self.backend is None:
            raise RuntimeError("adapter is not prepared")
        if self._active:
            raise RuntimeError("adapter stream is already active")
        self._active = True
        started = time.perf_counter()
        updates: list[TranscriptUpdate] = []
        prior = ""
        audio_bytes = 0

        def counted() -> Iterator[bytes]:
            nonlocal audio_bytes
            expected_bytes = SAMPLE_RATE * self.chunk_ms // 1000 * 2
            for chunk in stream:
                cancel.raise_if_cancelled()
                if len(chunk) != expected_bytes:
                    raise ValueError(
                        f"Nemotron input chunk must be exactly {expected_bytes} PCM16 bytes"
                    )
                audio_bytes += len(chunk)
                yield chunk

        def emit(text: str) -> None:
            nonlocal prior
            cancel.raise_if_cancelled()
            if prior and not text.startswith(prior):
                raise RuntimeError("append-only-rnnt-v1 partial contract violated")
            common = 0
            for left, right in zip(prior, text, strict=False):
                if left != right:
                    break
                common += 1
            update = TranscriptUpdate(
                sequence=len(updates),
                text=text,
                replaced_characters=len(prior) - common,
                monotonic_ms=(time.perf_counter() - started) * 1000,
            )
            updates.append(update)
            prior = text
            if on_partial is not None:
                on_partial(update)

        try:
            text = self.backend.stream(counted(), cancel, emit)
            cancel.raise_if_cancelled()
        finally:
            self._active = False
        ended = time.perf_counter()
        return TranscriptionResult(
            text=text,
            updates=tuple(updates),
            audio_seconds=audio_bytes / (SAMPLE_RATE * 2),
            processing_seconds=ended - started,
        )

    def transcribe(self, stream: Iterable[bytes], cancel: Cancellation) -> str:
        return self.transcribe_stream(stream, cancel).text

    def synthesize(self, text: str, cancel: Cancellation) -> Iterable[bytes]:
        raise NotImplementedError("Nemotron is an STT-only adapter")

    def reset(self) -> None:
        if self.closed or self.backend is None:
            raise RuntimeError("adapter is closed or unprepared")
        if self._active:
            raise RuntimeError("cannot reset an active stream")
        self.backend.reset()
        self.generation += 1

    def close(self) -> None:
        if self._active:
            raise RuntimeError("cannot close an active stream")
        if self.backend is not None:
            self.backend.close()
        self.backend = None
        self.closed = True
        self.prepared = False
