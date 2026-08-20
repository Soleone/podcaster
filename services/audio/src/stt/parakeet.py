from __future__ import annotations

import queue
import threading
import time
from collections.abc import Callable, Iterable, Iterator
from dataclasses import dataclass, field
from typing import Any, Protocol

from .base import Cancellation, PartialCallback, TranscriptUpdate, TranscriptionResult

MODEL_ID = "nvidia/parakeet-unified-en-0.6b"
MODEL_REVISION = "fe53cd885760c96b6a5f51a0bfd362cb4584a98b"
NEMO_REVISION = "58f3dd9250d4c9e0d3e865b78ccd5ea89dc420ba"
RUNTIME = f"nemo-git-{NEMO_REVISION}"
SAMPLE_RATE = 16_000
SUPPORTED_CONTEXTS_MS = {
    (80, 5600, 80),
    (80, 5600, 160),
    (80, 5600, 240),
    (160, 5600, 400),
    (560, 5600, 560),
    (1040, 5600, 1040),
}


class ParakeetBackend(Protocol):
    poisoned: bool

    def prepare(
        self,
        model_path: str,
        chunk_ms: int,
        capture_chunk_ms: int,
        left_context_ms: int,
        right_context_ms: int,
        language: str,
        precision: str,
        runtime_revision: str,
    ) -> None: ...

    def stream(
        self,
        chunks: Iterable[bytes],
        cancel: Cancellation,
        emit_text: Callable[[str], None],
    ) -> str: ...

    def reset(self) -> None: ...

    def close(self) -> None: ...


@dataclass
class NemoBufferedParakeetBackend:
    """Official NeMo stateful buffered RNNT algorithm.

    Encoder left context is recomputed for each chunk. Only the RNNT decoder state is
    retained. This intentionally mirrors NeMo's
    ``speech_to_text_streaming_infer_rnnt.py`` and is not cache-aware streaming.
    """

    model: Any = None
    device: str = "cuda"
    chunk_ms: int = 80
    capture_chunk_ms: int = 20
    left_context_ms: int = 5600
    right_context_ms: int = 240
    poisoned: bool = False
    _active: threading.Thread | None = None
    _lifecycle_lock: threading.Lock = field(default_factory=threading.Lock, repr=False)

    def prepare(
        self,
        model_path: str,
        chunk_ms: int,
        capture_chunk_ms: int,
        left_context_ms: int,
        right_context_ms: int,
        language: str,
        precision: str,
        runtime_revision: str,
    ) -> None:
        import nemo
        import torch
        from nemo.collections.asr.models import ASRModel

        if not torch.cuda.is_available():
            raise RuntimeError("CUDA is unavailable")
        if language != "en-US":
            raise ValueError("Parakeet Unified benchmark requires en-US")
        if precision != "float32":
            raise ValueError("matched Parakeet benchmark requires float32")
        if runtime_revision != NEMO_REVISION:
            raise ValueError("unverified NeMo runtime revision")
        if NEMO_REVISION[:10] not in str(nemo.__version__):
            raise RuntimeError("loaded NeMo runtime does not match the pinned Git revision")
        if (chunk_ms, left_context_ms, right_context_ms) not in SUPPORTED_CONTEXTS_MS:
            raise ValueError("unsupported official Parakeet buffered context preset")
        if capture_chunk_ms != 20 or chunk_ms % capture_chunk_ms:
            raise ValueError("Parakeet buffered runtime requires exact 20 ms capture packets")
        self.model = ASRModel.restore_from(model_path, map_location=self.device)
        if int(self.model.cfg.preprocessor.sample_rate) != SAMPLE_RATE:
            raise RuntimeError("pinned Parakeet model is not 16 kHz")
        if next(self.model.parameters()).dtype != torch.float32:
            raise RuntimeError("pinned Parakeet model did not load as float32")
        self.model.freeze()
        self.model.eval()
        self.model.to(torch.float32)
        self.model.preprocessor.featurizer.dither = 0.0
        self.model.preprocessor.featurizer.pad_to = 0
        self._configure_attention_context(self.model, chunk_ms, left_context_ms, right_context_ms)
        self.chunk_ms = chunk_ms
        self.capture_chunk_ms = capture_chunk_ms
        self.left_context_ms = left_context_ms
        self.right_context_ms = right_context_ms

    @staticmethod
    def _context_frames(
        model: Any, chunk_ms: int, left_ms: int, right_ms: int
    ) -> tuple[int, int, int]:
        feature_stride = float(model.cfg.preprocessor.window_stride)
        subsampling = int(model.encoder.subsampling_factor)
        features_per_second = 1.0 / feature_stride
        return (
            int(left_ms / 1000 * features_per_second / subsampling),
            int(chunk_ms / 1000 * features_per_second / subsampling),
            int(right_ms / 1000 * features_per_second / subsampling),
        )

    @classmethod
    def _configure_attention_context(
        cls, model: Any, chunk_ms: int, left_ms: int, right_ms: int
    ) -> tuple[int, int, int]:
        style = str(model.cfg.encoder.att_context_style)
        if style != "chunked_limited_with_rc":
            raise RuntimeError(f"unsupported Unified encoder attention style: {style}")
        contexts = cls._context_frames(model, chunk_ms, left_ms, right_ms)
        model.encoder.set_default_att_context_size(list(contexts))
        return contexts

    @staticmethod
    def _buffered_pcm_blocks(
        chunks: Iterable[bytes],
        cancel: Cancellation,
        capture_bytes: int,
        initial_bytes: int,
        step_bytes: int,
    ) -> Iterator[tuple[bytes, bool]]:
        """Reframe capture packets into exact initial (chunk+right) and chunk blocks."""
        iterator = iter(chunks)
        pending = bytearray()
        exhausted = False

        def take(size: int) -> bytes:
            nonlocal exhausted
            while len(pending) < size and not exhausted:
                cancel.raise_if_cancelled()
                try:
                    raw = next(iterator)
                except StopIteration:
                    exhausted = True
                    break
                if len(raw) != capture_bytes:
                    raise ValueError(
                        f"Parakeet input chunk must be exactly {capture_bytes} PCM16 bytes"
                    )
                pending.extend(raw)
            result = bytes(pending[:size])
            del pending[: len(result)]
            return result

        current = take(initial_bytes)
        if not current:
            raise ValueError("empty audio stream")
        if exhausted:
            yield current, True
            return

        # Yield a complete block without prefetching a future capture packet. EOF is
        # represented by a final partial or empty flush on the following iteration.
        yield current, False
        while True:
            current = take(step_bytes)
            if exhausted:
                yield current, True
                return
            yield current, False

    @staticmethod
    def _pcm_tensor(raw: bytes, device: str) -> Any:
        import numpy as np
        import torch

        if len(raw) % 2:
            raise ValueError("PCM16 chunk has an odd byte count")
        samples = np.frombuffer(raw, dtype="<i2").astype(np.float32) / 32768.0
        return torch.from_numpy(samples).to(device=device).unsqueeze(0)

    def _decode(
        self, chunks: Iterable[bytes], cancel: Cancellation, emit_text: Callable[[str], None]
    ) -> str:
        import torch
        from nemo.collections.asr.parts.submodules.transducer_decoding.label_looping_base import (
            GreedyBatchedLabelLoopingComputerBase,
        )
        from nemo.collections.asr.parts.utils.rnnt_utils import batched_hyps_to_hypotheses
        from nemo.collections.asr.parts.utils.streaming_utils import (
            ContextSize,
            StreamingBatchedAudioBuffer,
        )

        if self.model is None:
            raise RuntimeError("backend is not prepared")
        decoding_computer = self.model.decoding.decoding.decoding_computer
        if not isinstance(decoding_computer, GreedyBatchedLabelLoopingComputerBase):
            raise RuntimeError("pinned Parakeet runtime is not using label-looping greedy RNNT")

        feature_stride = float(self.model.cfg.preprocessor.window_stride)
        subsampling = int(self.model.encoder.subsampling_factor)
        feature_samples = int(SAMPLE_RATE * feature_stride)
        feature_samples -= feature_samples % subsampling
        encoder_frame_samples = feature_samples * subsampling
        frame_counts = self._context_frames(
            self.model, self.chunk_ms, self.left_context_ms, self.right_context_ms
        )
        contexts = ContextSize(*frame_counts)
        context_samples = ContextSize(
            left=contexts.left * encoder_frame_samples,
            chunk=contexts.chunk * encoder_frame_samples,
            right=contexts.right * encoder_frame_samples,
        )
        capture_bytes = SAMPLE_RATE * self.capture_chunk_ms // 1000 * 2
        step_bytes = context_samples.chunk * 2
        initial_bytes = (context_samples.chunk + context_samples.right) * 2
        if step_bytes % capture_bytes:
            raise RuntimeError("model chunk is not aligned to capture packets")

        buffer = StreamingBatchedAudioBuffer(1, context_samples, torch.float32, self.device)
        current_hypotheses = None
        decoder_state = None
        text = ""
        blocks = self._buffered_pcm_blocks(chunks, cancel, capture_bytes, initial_bytes, step_bytes)
        for incoming, is_last in blocks:
            cancel.raise_if_cancelled()
            audio = self._pcm_tensor(incoming, self.device)
            lengths = torch.tensor([audio.shape[1]], device=self.device, dtype=torch.long)
            buffer.add_audio_batch_(
                audio,
                lengths,
                is_last_chunk=is_last,
                is_last_chunk_batch=torch.tensor([is_last], device=self.device),
            )
            with torch.inference_mode():
                encoder_output, encoder_lengths = self.model(
                    input_signal=buffer.samples,
                    input_signal_length=buffer.context_size_batch.total(),
                )
                encoder_output = encoder_output.transpose(1, 2)
                encoder_context = buffer.context_size.subsample(encoder_frame_samples)
                encoder_context_batch = buffer.context_size_batch.subsample(encoder_frame_samples)
                encoder_output = encoder_output[:, encoder_context.left :]
                chunk_hypotheses, decoder_state = decoding_computer(
                    x=encoder_output,
                    out_len=encoder_lengths - encoder_context_batch.left
                    if is_last
                    else encoder_context_batch.chunk,
                    prev_batched_state=decoder_state,
                    multi_biasing_ids=None,
                )
            with torch.inference_mode():
                if current_hypotheses is None:
                    current_hypotheses = chunk_hypotheses
                else:
                    current_hypotheses.merge_(chunk_hypotheses)
                hypothesis = batched_hyps_to_hypotheses(current_hypotheses, batch_size=1)[0]
                text = self.model.tokenizer.ids_to_text(hypothesis.y_sequence.tolist())
            emit_text(text)
        return text.strip()

    def stream(
        self,
        chunks: Iterable[bytes],
        cancel: Cancellation,
        emit_text: Callable[[str], None],
    ) -> str:
        outputs: queue.Queue[tuple[str, str | BaseException | None]] = queue.Queue()

        def run() -> None:
            try:
                outputs.put(
                    (
                        "final",
                        self._decode(chunks, cancel, lambda text: outputs.put(("partial", text))),
                    )
                )
            except BaseException as error:
                outputs.put(("error", error))

        worker = threading.Thread(target=run, name="parakeet-stream", daemon=True)
        with self._lifecycle_lock:
            # Check and reserve lifecycle ownership atomically before execution.
            if self.model is None:
                raise RuntimeError("backend is not prepared")
            if self.poisoned:
                raise RuntimeError("Parakeet backend is poisoned after unresolved inference")
            if self._active is not None:
                raise RuntimeError("a Parakeet stream is already active")
            self._active = worker
            worker.start()
        final = ""
        error: BaseException | None = None
        try:
            while worker.is_alive() or not outputs.empty():
                cancel.raise_if_cancelled()
                try:
                    kind, value = outputs.get(timeout=0.05)
                except queue.Empty:
                    continue
                if kind == "partial":
                    emit_text(str(value))
                elif kind == "final":
                    final = str(value)
                else:
                    assert isinstance(value, BaseException)
                    error = value
        finally:
            worker.join(timeout=10)
            with self._lifecycle_lock:
                if worker.is_alive():
                    self.poisoned = True
                elif self._active is worker:
                    self._active = None
        if worker.is_alive():
            raise RuntimeError("Parakeet inference worker did not stop; backend poisoned")
        cancel.raise_if_cancelled()
        if error is not None:
            self.poisoned = True
            raise RuntimeError(
                f"Parakeet inference failed: {type(error).__name__}; backend poisoned"
            ) from error
        return final

    def reset(self) -> None:
        with self._lifecycle_lock:
            if self.poisoned:
                raise RuntimeError("cannot reset a poisoned Parakeet backend")
            if self._active is not None:
                raise RuntimeError("cannot reset an active Parakeet stream")

    def close(self) -> None:
        with self._lifecycle_lock:
            if self._active is not None:
                self.poisoned = True
                raise RuntimeError("cannot close an active Parakeet stream; backend poisoned")
            self.model = None
        try:
            import torch

            if torch.cuda.is_available():
                torch.cuda.empty_cache()
        except ImportError:
            pass


@dataclass
class ParakeetStreamingAdapter:
    backend_factory: Callable[[], ParakeetBackend] = NemoBufferedParakeetBackend
    backend: ParakeetBackend | None = None
    prepared: bool = False
    closed: bool = False
    generation: int = 0
    chunk_ms: int = 80
    capture_chunk_ms: int = 20
    _active: bool = False
    _preparing: bool = False
    _lifecycle_lock: threading.Lock = field(default_factory=threading.Lock, repr=False)

    def prepare(self, config: dict[str, object]) -> None:
        with self._lifecycle_lock:
            if self.closed:
                raise RuntimeError("adapter is closed")
            if self._active:
                raise RuntimeError("cannot prepare an active adapter")
            if self.prepared or self._preparing:
                raise RuntimeError("adapter is already prepared or preparing")
        candidate = config.get("candidate")
        if not isinstance(candidate, dict) or candidate.get("id") != "parakeet":
            raise ValueError("Parakeet candidate config is required")
        if candidate.get("modelId") != MODEL_ID or candidate.get("revision") != MODEL_REVISION:
            raise ValueError("unverified Parakeet model identity or revision")
        if candidate.get("runtime") != RUNTIME:
            raise ValueError("unverified Parakeet runtime")
        chunk_ms = int(config.get("chunkMs", 0))
        capture_chunk_ms = int(config.get("captureChunkMs", 0))
        left_ms = int(config.get("leftContextMs", -1))
        right_ms = int(config.get("rightContextMs", -1))
        if (chunk_ms, left_ms, right_ms) not in SUPPORTED_CONTEXTS_MS:
            raise ValueError("unsupported official Parakeet buffered context preset")
        if int(config.get("algorithmicLatencyMs", -1)) != chunk_ms + right_ms:
            raise ValueError("algorithmicLatencyMs must equal chunkMs + rightContextMs")
        if config.get("partialContract") != "append-only-rnnt-v1":
            raise ValueError("pinned NeMo RNNT merge requires append-only-rnnt-v1")
        language = str(config.get("language", ""))
        if language != "en-US":
            raise ValueError("Parakeet Unified benchmark requires language en-US")
        model_path = str(config.get("modelPath", ""))
        if not model_path:
            raise ValueError("pinned local modelPath is required")
        with self._lifecycle_lock:
            if self.closed or self._active:
                raise RuntimeError("adapter lifecycle changed before prepare")
            if self.prepared or self._preparing:
                raise RuntimeError("adapter is already prepared or preparing")
            self._preparing = True
        backend: ParakeetBackend | None = None
        try:
            backend = self.backend_factory()
            backend.prepare(
                model_path,
                chunk_ms,
                capture_chunk_ms,
                left_ms,
                right_ms,
                language,
                str(candidate.get("precision", "")),
                str(candidate.get("runtimeRevision", "")),
            )
            with self._lifecycle_lock:
                if self.closed or self._active:
                    raise RuntimeError("adapter lifecycle changed during prepare")
                self.backend = backend
                self.chunk_ms = chunk_ms
                self.capture_chunk_ms = capture_chunk_ms
                self.prepared = True
                self._preparing = False
                backend = None
        finally:
            if backend is not None:
                backend.close()
            self._finish_failed_prepare()

    def _finish_failed_prepare(self) -> None:
        with self._lifecycle_lock:
            self._preparing = False

    def transcribe_stream(
        self,
        stream: Iterable[bytes],
        cancel: Cancellation,
        on_partial: PartialCallback | None = None,
    ) -> TranscriptionResult:
        cancel.raise_if_cancelled()
        with self._lifecycle_lock:
            if not self.prepared or self.closed or self.backend is None:
                raise RuntimeError("adapter is not prepared")
            if self._active:
                raise RuntimeError("adapter stream is already active")
            self._active = True
            backend = self.backend
        started = time.perf_counter()
        updates: list[TranscriptUpdate] = []
        prior = ""
        audio_bytes = 0

        def counted() -> Iterator[bytes]:
            nonlocal audio_bytes
            expected = SAMPLE_RATE * self.capture_chunk_ms // 1000 * 2
            for chunk in stream:
                cancel.raise_if_cancelled()
                if len(chunk) != expected:
                    raise ValueError(f"Parakeet input chunk must be exactly {expected} PCM16 bytes")
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
            if text == prior:
                return
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
            text = backend.stream(counted(), cancel, emit)
            cancel.raise_if_cancelled()
        finally:
            with self._lifecycle_lock:
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

    def reset(self) -> None:
        with self._lifecycle_lock:
            if self.closed or self.backend is None:
                raise RuntimeError("adapter is closed or unprepared")
            if self._active:
                raise RuntimeError("cannot reset an active stream")
            self.backend.reset()
            self.generation += 1

    def close(self) -> None:
        with self._lifecycle_lock:
            if self._active:
                raise RuntimeError("cannot close an active stream")
            if self.backend is not None:
                self.backend.close()
            self.backend = None
            self.closed = True
            self.prepared = False
