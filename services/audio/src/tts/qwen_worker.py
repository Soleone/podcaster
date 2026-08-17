"""Isolated worker for the Qwen TTS runtime.

The main audio sidecar uses Transformers 5.x for Nemotron. Qwen's pinned
runtime requires Transformers 4.57.3, so Qwen inference runs in this small
child process when the optional Qwen environment is installed.

The protocol is newline-delimited JSON. Audio packets are little-endian
float32 samples encoded as base64 so the parent adapter can retain its
existing PCM framing and cancellation behavior.
"""

from __future__ import annotations

import base64
import contextlib
import json
import sys
import traceback
from pathlib import Path
from typing import Any


_PROTOCOL_OUT = sys.stdout


def _send(value: dict[str, Any]) -> None:
    _PROTOCOL_OUT.write(json.dumps(value, separators=(",", ":")) + "\n")
    _PROTOCOL_OUT.flush()


def _error(error: BaseException) -> None:
    _send(
        {
            "type": "error",
            "errorType": type(error).__name__,
            "message": str(error) or type(error).__name__,
        }
    )
    traceback.print_exception(error, file=sys.stderr)


def _run() -> int:
    # Import the Qwen implementation only inside the isolated interpreter.
    # Redirect incidental library output away from the JSON protocol.
    with contextlib.redirect_stdout(sys.stderr):
        from .qwen3 import (
            ATTENTION,
            DEVICE,
            MODEL_PATH,
            MODEL_SHA256,
            PRECISION,
            FasterQwenTorchBackend,
            _audio_values,
            _packet,
            _verify_qwen_assets,
            _verify_runtime_distribution,
        )

    backend: Any = None
    prepared = False

    for raw in sys.stdin:
        operation: object = None
        try:
            command = json.loads(raw)
            if not isinstance(command, dict):
                raise ValueError("Qwen worker command must be an object")
            operation = command.get("op")

            if operation == "prepare":
                if prepared:
                    raise RuntimeError("Qwen worker is already prepared")
                model_path = Path(str(command.get("modelPath", ""))).resolve()
                with contextlib.redirect_stdout(sys.stderr):
                    _verify_runtime_distribution()
                    _verify_qwen_assets(model_path, MODEL_PATH, MODEL_SHA256, "model")
                    backend = FasterQwenTorchBackend()
                    backend.prepare(str(model_path), DEVICE, PRECISION, ATTENTION)
                    voices = backend.get_voices()
                prepared = True
                _send({"type": "ready", "voices": voices})
                continue

            if operation == "stream":
                if not prepared or backend is None:
                    raise RuntimeError("Qwen worker is not prepared")
                text = str(command.get("text", ""))
                speaker = str(command.get("speaker", ""))
                language = str(command.get("language", ""))
                tone_prompt = command.get("tonePrompt")
                if tone_prompt is not None and not isinstance(tone_prompt, str):
                    raise ValueError("Qwen tone prompt must be a string")
                with contextlib.redirect_stdout(sys.stderr):
                    stream = backend.create_stream(text, speaker, language, tone_prompt=tone_prompt)
                    try:
                        for value in stream:
                            samples, sample_rate = _packet(value)
                            encoded = base64.b64encode(
                                _audio_values(samples).astype("<f4", copy=False).tobytes()
                            ).decode("ascii")
                            _send(
                                {
                                    "type": "chunk",
                                    "sampleRate": sample_rate,
                                    "samples": encoded,
                                }
                            )
                    finally:
                        close = getattr(stream, "close", None)
                        if callable(close):
                            close()
                _send({"type": "done"})
                continue

            if operation == "reset":
                if not prepared or backend is None:
                    raise RuntimeError("Qwen worker is not prepared")
                with contextlib.redirect_stdout(sys.stderr):
                    backend.reset()
                _send({"type": "ok"})
                continue

            if operation == "close":
                if backend is not None:
                    with contextlib.redirect_stdout(sys.stderr):
                        backend.close()
                _send({"type": "ok"})
                return 0

            raise ValueError(f"unknown Qwen worker operation: {operation!r}")
        except BaseException as error:
            _error(error)
            # A failed prepare cannot be recovered without reloading the model.
            if operation == "prepare":
                return 1
            # Let the parent decide whether a synthesis failure is recoverable.
            # Keep the process alive long enough for it to read the error record.

    return 0


def main() -> None:
    raise SystemExit(_run())


if __name__ == "__main__":
    main()
