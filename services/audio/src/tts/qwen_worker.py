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

import numpy as np


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
            BASE_MODEL_PATH,
            BASE_MODEL_SHA256,
            DEVICE,
            MODEL_PATH,
            MODEL_SHA256,
            PRECISION,
            FasterQwenBaseCloneBackend,
            FasterQwenTorchBackend,
            _audio_values,
            _packet,
            _to_device_prompt,
            _verify_base_assets,
            _verify_qwen_assets,
            _verify_runtime_distribution,
        )

    backend: Any = None
    clone_backend: Any = None
    clone_prepared = False
    clone_prompts: dict[str, dict[str, Any]] = {}
    next_prompt_id = 0
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

            if operation == "prepareClone":
                if not prepared or backend is None:
                    raise RuntimeError("Qwen worker custom voice model is not prepared")
                if clone_prepared:
                    raise RuntimeError("Qwen worker clone model is already prepared")
                model_path = Path(str(command.get("modelPath", ""))).resolve()
                with contextlib.redirect_stdout(sys.stderr):
                    _verify_base_assets(model_path, BASE_MODEL_PATH, BASE_MODEL_SHA256, "clone model")
                    clone_backend = FasterQwenBaseCloneBackend()
                    clone_backend.prepare(str(model_path), DEVICE, PRECISION, ATTENTION)
                clone_prepared = True
                _send({"type": "readyClone"})
                continue

            if operation == "clonePrompt":
                if not clone_prepared or clone_backend is None:
                    raise RuntimeError("Qwen worker clone model is not prepared")
                sample_rate = int(command.get("sampleRate", 0))
                payload = base64.b64decode(str(command.get("pcm16", "")), validate=True)
                if sample_rate <= 0 or len(payload) == 0 or len(payload) % 2:
                    raise ValueError("invalid Qwen clone reference audio")
                with contextlib.redirect_stdout(sys.stderr):
                    audio = np.frombuffer(payload, dtype="<i2").astype(np.float32) / 32768.0
                    model = clone_backend.model.model
                    prompt_items = model.create_voice_clone_prompt(
                        ref_audio=(audio, sample_rate),
                        ref_text="",
                        x_vector_only_mode=True,
                    )
                    prompt = model._prompt_items_to_voice_clone_prompt(prompt_items)
                next_prompt_id += 1
                prompt_id = f"prompt-{next_prompt_id}"
                clone_prompts[prompt_id] = prompt
                _send({"type": "clonePrompt", "promptId": prompt_id})
                continue

            if operation == "cloneStream":
                if not clone_prepared or clone_backend is None:
                    raise RuntimeError("Qwen worker clone model is not prepared")
                prompt_id = str(command.get("promptId", ""))
                prompt = clone_prompts.get(prompt_id)
                if prompt is None:
                    raise ValueError("Qwen clone prompt is unavailable")
                text = str(command.get("text", ""))
                language = str(command.get("language", ""))
                tone_prompt = command.get("tonePrompt")
                if tone_prompt is not None and not isinstance(tone_prompt, str):
                    raise ValueError("Qwen tone prompt must be a string")
                with contextlib.redirect_stdout(sys.stderr):
                    import torch
                    stream = clone_backend.create_stream(
                        text,
                        _to_device_prompt(prompt, torch, DEVICE),
                        language,
                        tone_prompt=tone_prompt,
                    )
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
                    if clone_backend is not None:
                        clone_backend.reset()
                _send({"type": "ok"})
                continue

            if operation == "close":
                with contextlib.redirect_stdout(sys.stderr):
                    if clone_backend is not None:
                        clone_backend.close()
                    if backend is not None:
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
