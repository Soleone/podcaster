"""Parent-side bridge to the isolated Qwen runtime."""

from __future__ import annotations

import base64
import json
import os
from pathlib import Path
import select
import subprocess
import threading
import time
from typing import Any, Iterator

import numpy as np

from .qwen3 import (
    ATTENTION,
    DEVICE,
    PRECISION,
    Qwen3StreamingAdapter,
    ROOT,
)

DEFAULT_QWEN_PYTHON = ROOT / ".venv-qwen/bin/python"


class IsolatedQwenBackend:
    """Implement the Qwen backend protocol without importing Qwen packages here."""

    def __init__(
        self,
        python: str | Path | None = None,
        *,
        prepare_timeout_seconds: float = 300.0,
        operation_timeout_seconds: float = 600.0,
    ) -> None:
        configured = python or os.environ.get("PODCASTER_QWEN_PYTHON")
        candidate = Path(configured or DEFAULT_QWEN_PYTHON).expanduser()
        # Do not call resolve() here. A venv's python is commonly a symlink to
        # the base interpreter, and resolving it would discard the venv's
        # site-packages before the child starts.
        self.python = candidate if candidate.is_absolute() else ROOT / candidate
        self.prepare_timeout_seconds = prepare_timeout_seconds
        self.operation_timeout_seconds = operation_timeout_seconds
        self.process: subprocess.Popen[str] | None = None
        self.voices: list[str] = []
        self.poisoned = False
        self._io_lock = threading.RLock()
        self._stderr_lock = threading.Lock()
        self._stderr_tail = ""
        self._stderr_thread: threading.Thread | None = None

    def _record_stderr(self, stream: Any) -> None:
        for chunk in iter(stream.readline, ""):
            with self._stderr_lock:
                self._stderr_tail = (self._stderr_tail + chunk)[-4_000:]

    def _spawn(self) -> None:
        if not self.python.is_file() or not os.access(self.python, os.X_OK):
            raise RuntimeError(
                f"Qwen isolated Python is unavailable: {self.python}. "
                "Install the pinned Qwen environment or set PODCASTER_QWEN_PYTHON."
            )
        environment = os.environ.copy()
        root_text = str(ROOT)
        existing_pythonpath = environment.get("PYTHONPATH")
        environment["PYTHONPATH"] = (
            root_text
            if not existing_pythonpath
            else root_text + os.pathsep + existing_pythonpath
        )
        self.process = subprocess.Popen(
            [str(self.python), "-m", "services.audio.src.tts.qwen_worker"],
            cwd=ROOT,
            env=environment,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            bufsize=1,
        )
        assert self.process.stderr is not None
        self._stderr_thread = threading.Thread(
            target=self._record_stderr,
            args=(self.process.stderr,),
            name="qwen-worker-stderr",
            daemon=True,
        )
        self._stderr_thread.start()

    def _failure_context(self) -> str:
        with self._stderr_lock:
            detail = self._stderr_tail.strip()
        if detail:
            return f"; worker stderr: {detail[-1_000:]}"
        return ""

    def _send(self, command: dict[str, Any]) -> None:
        process = self.process
        if process is None or process.stdin is None:
            raise RuntimeError("Qwen worker is not running")
        try:
            process.stdin.write(json.dumps(command, separators=(",", ":")) + "\n")
            process.stdin.flush()
        except (BrokenPipeError, OSError) as error:
            self.poisoned = True
            raise RuntimeError("Qwen worker input closed" + self._failure_context()) from error

    def _read(self, timeout_seconds: float) -> dict[str, Any]:
        process = self.process
        if process is None or process.stdout is None:
            raise RuntimeError("Qwen worker is not running")
        deadline = time.monotonic() + timeout_seconds
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                self.poisoned = True
                raise RuntimeError("Qwen worker response timed out" + self._failure_context())
            ready, _, _ = select.select([process.stdout], [], [], remaining)
            if not ready:
                self.poisoned = True
                raise RuntimeError("Qwen worker response timed out" + self._failure_context())
            line = process.stdout.readline()
            if not line:
                self.poisoned = True
                status = process.poll()
                suffix = f" (exit {status})" if status is not None else ""
                raise RuntimeError("Qwen worker exited" + suffix + self._failure_context())
            try:
                value = json.loads(line)
            except json.JSONDecodeError as error:
                self.poisoned = True
                raise RuntimeError("Qwen worker emitted malformed protocol data") from error
            if not isinstance(value, dict):
                self.poisoned = True
                raise RuntimeError("Qwen worker emitted a non-object protocol record")
            return value

    @staticmethod
    def _raise_worker_error(value: dict[str, Any]) -> None:
        error_type = str(value.get("errorType", "RuntimeError"))
        message = str(value.get("message", "Qwen worker failed"))
        raise RuntimeError(f"Qwen worker {error_type}: {message}")

    def _terminate(self) -> None:
        process = self.process
        self.process = None
        if process is None:
            return
        if process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)
        if self._stderr_thread is not None:
            self._stderr_thread.join(timeout=1)
        self._stderr_thread = None

    def prepare(
        self, model_path: str, device: str, dtype: str, attn_implementation: str
    ) -> None:
        if device != DEVICE or dtype != PRECISION or attn_implementation != ATTENTION:
            raise ValueError("isolated Qwen backend received an unmatched runtime contract")
        with self._io_lock:
            self._spawn()
            try:
                self._send({"op": "prepare", "modelPath": model_path})
                value = self._read(self.prepare_timeout_seconds)
                if value.get("type") == "error":
                    self._raise_worker_error(value)
                if value.get("type") != "ready" or not isinstance(value.get("voices"), list):
                    raise RuntimeError("Qwen worker did not return a voice catalog")
                self.voices = [str(voice) for voice in value["voices"]]
                if not self.voices:
                    raise RuntimeError("Qwen worker returned an empty voice catalog")
            except BaseException:
                self.poisoned = True
                self._terminate()
                raise

    def get_voices(self) -> list[str]:
        if self.process is None or not self.voices:
            raise RuntimeError("Qwen worker is not prepared")
        return list(self.voices)

    def create_stream(
        self, text: str, speaker: str, language: str
    ) -> Iterator[tuple[np.ndarray, int, dict[str, Any]]]:
        def packets() -> Iterator[tuple[np.ndarray, int, dict[str, Any]]]:
            with self._io_lock:
                self._send(
                    {
                        "op": "stream",
                        "text": text,
                        "speaker": speaker,
                        "language": language,
                    }
                )
                while True:
                    value = self._read(self.operation_timeout_seconds)
                    record_type = value.get("type")
                    if record_type == "error":
                        self.poisoned = True
                        self._raise_worker_error(value)
                    if record_type == "done":
                        return
                    if record_type != "chunk":
                        self.poisoned = True
                        raise RuntimeError("Qwen worker emitted an unexpected stream record")
                    try:
                        sample_rate = int(value["sampleRate"])
                        payload = base64.b64decode(str(value["samples"]), validate=True)
                    except (KeyError, ValueError, TypeError) as error:
                        self.poisoned = True
                        raise RuntimeError("Qwen worker emitted malformed audio data") from error
                    if len(payload) == 0 or len(payload) % 4:
                        self.poisoned = True
                        raise RuntimeError("Qwen worker emitted malformed float audio data")
                    yield np.frombuffer(payload, dtype="<f4").copy(), sample_rate, {}

        return packets()

    def reset(self) -> None:
        with self._io_lock:
            self._send({"op": "reset"})
            value = self._read(30.0)
            if value.get("type") == "error":
                self._raise_worker_error(value)
            if value.get("type") != "ok":
                raise RuntimeError("Qwen worker did not acknowledge reset")

    def close(self) -> None:
        with self._io_lock:
            if self.process is None:
                return
            try:
                if self.process.poll() is None:
                    self._send({"op": "close"})
                    value = self._read(10.0)
                    if value.get("type") == "error":
                        self._raise_worker_error(value)
            except BaseException:
                self.poisoned = True
            finally:
                self._terminate()
                self.voices = []


class IsolatedQwenAdapter(Qwen3StreamingAdapter):
    """Run the existing adapter contract over the isolated Qwen process."""

    def __init__(self, python: str | Path | None = None) -> None:
        super().__init__(
            backend_factory=lambda: IsolatedQwenBackend(python),
            # The helper performs the Qwen package and source verification in
            # its own interpreter. The parent still verifies model bytes.
            runtime_verifier=lambda: None,
        )


__all__ = ["DEFAULT_QWEN_PYTHON", "IsolatedQwenAdapter", "IsolatedQwenBackend"]
