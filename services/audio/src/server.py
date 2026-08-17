"""Authenticated loopback-only selected audio WebSocket sidecar."""
from __future__ import annotations

import argparse
import asyncio
import hashlib
import hmac
import json
import logging
import os
import signal
import socket
import sys
import threading
from collections import deque
from http import HTTPStatus
from typing import NoReturn

from pydantic import ValidationError
from websockets.asyncio.server import ServerConnection, serve
from websockets.datastructures import Headers
from websockets.http11 import Request, Response

from .binary_framing import decode_frame
from .generated.contracts import SidecarMessage
from .runtime import MAX_BINARY_PAYLOAD, SelectedAudioRuntime
from .voice_enrollment import decode_reference, validate_name

MAX_BODY = 16 * 1024
MAX_QUEUE = 512


def _response(status: HTTPStatus, value: dict[str, object]) -> Response:
    body = json.dumps(value, separators=(",", ":")).encode()
    headers = Headers(
        [
            ("Content-Type", "application/json"),
            ("Content-Length", str(len(body))),
            ("Cache-Control", "no-store"),
            ("Connection", "close"),
        ]
    )
    return Response(status.value, status.phrase, headers, body)


class SidecarServer:
    """Compatibility wrapper used by production and focused security tests."""

    allow_reuse_address = False
    daemon_threads = True

    def __init__(
        self,
        address: tuple[str, int],
        secret: str,
        runtime: SelectedAudioRuntime | None = None,
    ) -> None:
        host, port = address
        if host != "127.0.0.1":
            raise ValueError("sidecar must bind exact IPv4 loopback")
        self.secret = secret
        self.runtime = runtime if runtime is not None else SelectedAudioRuntime()
        self._socket = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self._socket.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 0)
        self._socket.bind((host, port))
        self._socket.listen(128)
        self._socket.setblocking(False)
        self.server_address = self._socket.getsockname()
        self.server_port = self.server_address[1]
        self._shutdown = threading.Event()
        self._loop: asyncio.AbstractEventLoop | None = None
        self._server = None

    def _authorized(self, request: Request) -> Response | None:
        if "?" in request.path:
            return _response(HTTPStatus.BAD_REQUEST, {"error": "query_rejected"})
        if request.headers.get("Origin") is not None:
            return _response(HTTPStatus.FORBIDDEN, {"error": "browser_origin_rejected"})
        if request.headers.get("Host") != f"127.0.0.1:{self.server_port}":
            return _response(HTTPStatus.MISDIRECTED_REQUEST, {"error": "invalid_host"})
        expected = f"Bearer {self.secret}"
        if not hmac.compare_digest(request.headers.get("Authorization", ""), expected):
            return _response(HTTPStatus.UNAUTHORIZED, {"error": "unauthorized"})
        return None

    def _process_request(self, _connection: ServerConnection, request: Request) -> Response | None:
        denied = self._authorized(request)
        if denied is not None:
            return denied
        if request.path == "/health":
            payload = self.runtime.readiness()["payload"]
            assert isinstance(payload, dict)
            return _response(HTTPStatus.OK, payload)
        if request.path != "/stream":
            return _response(HTTPStatus.NOT_FOUND, {"error": "not_found"})
        if request.headers.get("Upgrade", "").lower() != "websocket":
            length = request.headers.get("Content-Length", "")
            if length.isdigit() and int(length) > MAX_BODY:
                return _response(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, {"error": "body_too_large"})
            if request.headers.get("Content-Type", "").split(";", 1)[0] != "application/json":
                return _response(HTTPStatus.UNSUPPORTED_MEDIA_TYPE, {"error": "json_required"})
            return _response(HTTPStatus.NOT_IMPLEMENTED, {"error": "websocket_required"})
        return None

    async def _handler(self, connection: ServerConnection) -> None:
        queue: asyncio.Queue[str | bytes | None] = asyncio.Queue(maxsize=MAX_QUEUE)
        loop = asyncio.get_running_loop()
        opened_stream: str | None = None
        pending_enrollment: dict[str, object] | None = None
        failed = False
        # Thread-safe bounded handoff so the TTS worker applies real backpressure
        # instead of overflowing a fixed async queue and killing the session.
        sync_queue: deque[str | bytes] = deque()
        sync_lock = threading.Condition()

        def enqueue(value: str | bytes) -> None:
            nonlocal failed
            if failed:
                return
            with sync_lock:
                while len(sync_queue) >= MAX_QUEUE and not failed:
                    sync_lock.wait()
                if failed:
                    return
                sync_queue.append(value)
                sync_lock.notify_all()
            loop.call_soon_threadsafe(pump)

        def pump() -> None:
            nonlocal failed
            if failed:
                return
            while True:
                with sync_lock:
                    if not sync_queue:
                        return
                    value = sync_queue.popleft()
                    sync_lock.notify_all()
                try:
                    queue.put_nowait(value)
                except asyncio.QueueFull:
                    with sync_lock:
                        sync_queue.appendleft(value)
                    return

        def emit_json(value: dict[str, object]) -> None:
            enqueue(json.dumps(value, separators=(",", ":")))

        async def sender() -> None:
            while True:
                value = await queue.get()
                if value is None:
                    return
                await connection.send(value)
                # Keep the pipeline moving: drain more from the sync handoff after
                # every send so a blocked producer unblocks promptly.
                pump()

        sender_task = asyncio.create_task(sender())
        emit_json(self.runtime.readiness())
        try:
            async for raw in connection:
                if isinstance(raw, bytes):
                    if pending_enrollment is not None:
                        data = pending_enrollment["bytes"]
                        assert isinstance(data, bytearray)
                        expected = int(pending_enrollment["byteLength"])
                        if len(data) + len(raw) > expected:
                            voice_id = str(pending_enrollment["voiceId"])
                            pending_enrollment = None
                            emit_json({"type": "voice.error", "payload": {"voiceId": voice_id, "code": "too_large", "message": "reference exceeded its declared byte length"}})
                            continue
                        data.extend(raw)
                        if len(data) == expected:
                            voice_id = str(pending_enrollment["voiceId"])
                            name = str(pending_enrollment["name"])
                            ref_sha256 = str(pending_enrollment["refSha256"])
                            duration_ms = int(pending_enrollment["durationMs"])
                            wav_bytes = bytes(data)
                            pending_enrollment = None
                            try:
                                if hashlib.sha256(wav_bytes).hexdigest() != ref_sha256:
                                    raise ValueError("reference digest does not match its bytes")
                                decoded = decode_reference(wav_bytes)
                                if decoded.duration_ms != duration_ms:
                                    raise ValueError("reference duration does not match its envelope")
                                validate_name(name)
                                self.runtime.enroll_custom_voice(voice_id, name, ref_sha256, wav_bytes)
                            except (ValueError, RuntimeError) as error:
                                emit_json({"type": "voice.error", "payload": {"voiceId": voice_id, "code": getattr(error, "code", "invalid_reference"), "message": str(error) or "reference was rejected"}})
                            else:
                                emit_json({"type": "voice.enrolled", "payload": {"voiceId": voice_id}})
                        continue
                    if opened_stream is None:
                        raise ValueError("binary before stream.open or voice.enroll")
                    frame = decode_frame(raw, MAX_BINARY_PAYLOAD)
                    self.runtime.accept_audio(opened_stream, frame)
                    continue
                if len(raw.encode()) > MAX_BODY:
                    raise ValueError("JSON message too large")
                try:
                    message = SidecarMessage.model_validate_json(raw).root
                except ValidationError as error:
                    raise ValueError("invalid sidecar message") from error
                message_type = message["type"]
                payload = message["payload"]
                if message_type == "voice.enroll":
                    if opened_stream is not None or pending_enrollment is not None:
                        raise ValueError("voice enrollment cannot overlap an active stream or enrollment")
                    envelope = payload.get("enrollment")
                    if not isinstance(envelope, dict):
                        raise ValueError("invalid voice enrollment envelope")
                    pending_enrollment = {
                        "voiceId": str(envelope["voiceId"]),
                        "name": str(envelope["name"]),
                        "refSha256": str(envelope["refSha256"]),
                        "sampleRate": int(envelope["sampleRate"]),
                        "durationMs": int(envelope["durationMs"]),
                        "byteLength": int(envelope["byteLength"]),
                        "bytes": bytearray(),
                    }
                elif message_type == "voice.remove":
                    if opened_stream is not None or pending_enrollment is not None:
                        raise ValueError("voice deletion cannot overlap an active stream or enrollment")
                    voice_id = str(payload["voiceId"])
                    try:
                        self.runtime.remove_custom_voice(voice_id)
                    except (ValueError, RuntimeError) as error:
                        emit_json({"type": "voice.error", "payload": {"voiceId": voice_id, "code": getattr(error, "code", "unavailable"), "message": str(error) or "voice deletion failed"}})
                    else:
                        emit_json({"type": "voice.removed", "payload": {"voiceId": voice_id}})
                elif message_type == "stream.open":
                    if opened_stream is not None:
                        raise ValueError("second stream.open")
                    opened_stream = str(payload["streamId"])
                    self.runtime.open_stream(
                        opened_stream,
                        int(payload["captureStreamId"]),
                        emit_json,
                        enqueue,
                        str(payload.get("streamMode", "capture")),
                        str(payload["backendId"]) if payload.get("backendId") is not None else None,
                        str(payload["modelId"]) if payload.get("modelId") is not None else None,
                        str(payload["catalogId"]) if payload.get("catalogId") is not None else None,
                    )
                elif opened_stream is None or payload.get("streamId") != opened_stream:
                    raise ValueError("unknown stream")
                elif message_type == "stt.bind_epoch":
                    self.runtime.bind_epoch(opened_stream, str(payload["utteranceId"]), int(payload["epoch"]))
                elif message_type == "tts.open":
                    self.runtime.open_tts(
                        opened_stream,
                        str(payload["responseId"]),
                        int(payload["epoch"]),
                        payload.get("partIndex"),
                        payload.get("partId"),
                        voice_id=str(payload["voiceId"]),
                        speed_modifier=payload.get("speedModifier"),
                        tone_prompt=payload.get("tonePrompt"),
                    )
                elif message_type == "tts.append":
                    self.runtime.append_tts(
                        opened_stream,
                        str(payload["responseId"]),
                        int(payload["epoch"]),
                        int(payload["sequence"]),
                        str(payload["text"]),
                        part_index=payload.get("partIndex"),
                        part_id=payload.get("partId"),
                    )
                elif message_type == "tts.commit":
                    self.runtime.commit_tts(
                        opened_stream,
                        str(payload["responseId"]),
                        int(payload["epoch"]),
                        int(payload["nextSequence"]),
                        str(payload["textSha256"]),
                        part_index=payload.get("partIndex"),
                        part_id=payload.get("partId"),
                    )
                elif message_type == "tts.request":
                    self.runtime.request_tts(opened_stream, str(payload["responseId"]), int(payload["epoch"]), str(payload["text"]), voice_id=str(payload["voiceId"]), speed_modifier=payload.get("speedModifier"), tone_prompt=payload.get("tonePrompt"))
                elif message_type == "tts.cancel":
                    self.runtime.cancel_tts(
                        opened_stream,
                        str(payload["responseId"]),
                        part_index=payload.get("partIndex"),
                    )
                elif message_type == "stream.reset":
                    self.runtime.reset_stream(opened_stream)
                elif message_type == "stream.close":
                    self.runtime.close_stream(opened_stream)
                    opened_stream = None
                else:
                    raise ValueError("unsupported sidecar command")
        except (ValueError, RuntimeError) as error:
            print(f"sidecar failure: {error!r}", file=sys.stderr)
            failed = True
            with sync_lock:
                sync_lock.notify_all()
            failure_message = json.dumps(
                {"type": "sidecar.failure", "payload": {"code": "invalid_message", "recoverable": False}},
                separators=(",", ":"),
            )
            try:
                queue.put_nowait(failure_message)
            except asyncio.QueueFull:
                pass
            await asyncio.sleep(0)
            await connection.close(1008, "invalid stream message")
        finally:
            failed = True
            with sync_lock:
                sync_lock.notify_all()
            if opened_stream is not None:
                self.runtime.close_stream(opened_stream)
            sender_task.cancel()
            await asyncio.gather(sender_task, return_exceptions=True)

    async def _serve(self) -> None:
        self._loop = asyncio.get_running_loop()
        server = await serve(
            self._handler,
            sock=self._socket,
            process_request=self._process_request,
            compression=None,
            max_size=64 * 1024,
            max_queue=MAX_QUEUE,
            server_header=None,
        )
        self._server = server
        while not self._shutdown.is_set():
            await asyncio.sleep(0.02)
        server.close(close_connections=False)
        await asyncio.sleep(0)

    def serve_forever(self) -> None:
        asyncio.run(self._serve())

    def shutdown(self) -> None:
        self._shutdown.set()

    def server_close(self) -> None:
        self._shutdown.set()
        if self._server is None:
            try:
                self._socket.close()
            except OSError:
                pass


def _silence_aborted_handshake_noise() -> None:
    """Drop websockets' traceback for TCP connections that die mid-handshake.

    A probe or health-checker can connect to the loopback port and close before
    completing the WebSocket handshake; websockets logs that benign condition
    as ERROR with a full exception chain. Genuine protocol failures still
    surface through the stream handler's own error path.
    """

    class _DropAbortedHandshake(logging.Filter):
        def filter(self, record: logging.LogRecord) -> bool:
            return record.getMessage() != "opening handshake failed"

    # The server's connection loggers emit this record on websockets.server
    # (not the package root), so the filter must be attached there.
    logging.getLogger("websockets.server").addFilter(_DropAbortedHandshake())


def run(host: str, port: int, secret: str) -> NoReturn:
    if host != "127.0.0.1" or port < 0:
        raise ValueError("sidecar must use 127.0.0.1 and an OS-assigned or valid port")
    # Library noise hygiene: onnxruntime's default logger is separate from the
    # per-session options, so the Kokoro session's log_severity_level=3 never
    # silences one-time default notices (e.g. the ScatterND atomic-reduction
    # fallback). Raise the default to ERROR so only genuine failures reach the
    # captured stderr, and stop websockets from logging aborted handshakes.
    import onnxruntime as ort

    ort.set_default_logger_severity(3)
    _silence_aborted_handshake_noise()
    runtime = SelectedAudioRuntime()
    server = SidecarServer((host, port), secret, runtime)
    signal.signal(signal.SIGTERM, lambda *_: server.shutdown())
    actual_host, actual_port = server.server_address
    print(json.dumps({"host": actual_host, "port": actual_port}), flush=True)

    def prepare() -> None:
        try:
            runtime.prepare()
        except BaseException:
            # Readiness reports only the sanitized failed state.
            pass

    prepare_thread = threading.Thread(target=prepare, name="selected-runtime-prepare", daemon=True)
    prepare_thread.start()
    server.serve_forever()
    server.server_close()
    prepare_thread.join(timeout=10)
    runtime.close()
    raise SystemExit(0)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=0)
    args = parser.parse_args()
    secret = os.environ.get("PODCASTER_SIDECAR_SECRET", "")
    if len(secret) < 32:
        raise SystemExit("PODCASTER_SIDECAR_SECRET must be at least 32 characters")
    run(args.host, args.port, secret)


if __name__ == "__main__":
    main()
