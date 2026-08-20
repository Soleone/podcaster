from __future__ import annotations

import asyncio
import http.client
import json
import threading
from contextlib import contextmanager
from typing import Iterator

import pytest
from websockets.asyncio.client import connect

from services.audio.src.runtime import SelectedAudioRuntime
from services.audio.src.server import SidecarServer

SECRET = "s" * 43


@contextmanager
def running_server(runtime: object | None = None) -> Iterator[tuple[SidecarServer, int]]:
    if runtime is None:
        class _ReadyTts:
            def voice_catalog(self):
                return {
                    "catalogId": "catalog",
                    "backendId": "kokoro",
                    "modelId": "kokoro-82m-onnx",
                    "runtimeConfigId": "rc",
                    "revision": "rev",
                    "defaultVoiceId": "af_heart",
                    "voices": [{"id": "af_heart", "label": "af_heart"}],
                }

        runtime = SelectedAudioRuntime(object(), _ReadyTts())
        runtime.mark_ready_for_test()
    server = SidecarServer(("127.0.0.1", 0), SECRET, runtime)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    for _ in range(100):
        if server._server is not None:
            break
        threading.Event().wait(0.01)
    try:
        yield server, server.server_port
    finally:
        server.shutdown()
        server.server_close()
        thread.join()


def request(port: int, method: str = "GET", path: str = "/health", headers: dict[str, str] | None = None, body: bytes | None = None) -> tuple[int, bytes, dict[str, str]]:
    connection = http.client.HTTPConnection("127.0.0.1", port, timeout=2)
    connection.request(method, path, body=body, headers=headers or {})
    response = connection.getresponse()
    result = response.status, response.read(), dict(response.getheaders())
    connection.close()
    return result


def auth(port: int) -> dict[str, str]:
    return {"Host": f"127.0.0.1:{port}", "Authorization": f"Bearer {SECRET}"}


def _message(message_type: str, **payload: object) -> str:
    return json.dumps({"type": message_type, "payload": payload})


def test_binds_only_ipv4_loopback_with_os_assigned_port() -> None:
    with running_server() as (server, port):
        assert server.server_address == ("127.0.0.1", port)
        assert port > 0


def test_health_requires_boot_secret_and_exact_host() -> None:
    with running_server() as (_, port):
        assert request(port, headers={"Host": f"127.0.0.1:{port}"})[0] == 401
        assert request(port, headers={**auth(port), "Authorization": "Bearer wrong"})[0] == 401
        assert request(port, headers={**auth(port), "Host": "localhost"})[0] == 421
        status, body, headers = request(port, headers=auth(port))
        assert status == 200 and b'"status":"ready"' in body
        assert "Access-Control-Allow-Origin" not in headers


@pytest.mark.parametrize("origin", ["http://evil.example", "http://127.0.0.1:9999", "null"])
def test_rejects_every_browser_origin(origin: str) -> None:
    with running_server() as (_, port):
        assert request(port, headers={**auth(port), "Origin": origin})[0] == 403


def test_rejects_query_secrets_and_non_websocket_stream_requests() -> None:
    with running_server() as (_, port):
        assert request(port, "GET", "/stream?secret=bad", auth(port))[0] == 400
        assert request(port, "GET", "/stream", auth(port))[0] == 415


class _BlockingOpenRuntime:
    def __init__(self) -> None:
        self.calls: list[str] = []
        self.open_call: tuple[tuple[object, ...], dict[str, object]] | None = None
        self.open_started = threading.Event()
        self.release = threading.Event()
        self.commands_done = threading.Event()

    def readiness(self) -> dict[str, object]:
        return {"type": "readiness.snapshot", "payload": {"status": "ready"}}

    def open_stream(self, *args: object) -> None:
        self.calls.append("stream.open")

    def open_tts(self, *args: object, **kwargs: object) -> None:
        self.open_call = args, kwargs
        self.calls.append("tts.open.begin")
        self.open_started.set()
        if not self.release.wait(timeout=3):
            raise RuntimeError("test TTS admission was not released")
        self.calls.append("tts.open.end")

    def append_tts(self, *args: object, **kwargs: object) -> None:
        self.calls.append("tts.append")

    def commit_tts(self, *args: object, **kwargs: object) -> None:
        self.calls.append("tts.commit")
        self.commands_done.set()

    def close_stream(self, *args: object) -> None:
        pass


async def _exercise_non_blocking_tts_open(runtime: _BlockingOpenRuntime, port: int) -> None:
    stream_id = "018f1f32-7abc-7def-8abc-0123456789ab"
    response_id = "018f1f32-7abd-7def-8abc-0123456789ab"
    part_id = "018f1f32-7abe-7def-8abc-0123456789ab"
    async with connect(
        f"ws://127.0.0.1:{port}/stream",
        additional_headers={"Authorization": f"Bearer {SECRET}"},
        compression=None,
    ) as websocket:
        readiness = json.loads(await websocket.recv())
        assert readiness["type"] == "readiness.snapshot"
        await websocket.send(
            _message(
                "stream.open",
                streamId=stream_id,
                captureStreamId=12,
                sampleRate=16000,
                frameSamples=320,
            )
        )
        await websocket.send(
            _message(
                "tts.open",
                streamId=stream_id,
                responseId=response_id,
                epoch=4,
                partIndex=2,
                partId=part_id,
                voiceId="voice",
                speedModifier=1.25,
                tonePrompt="calm",
                language="English",
            )
        )
        assert await asyncio.to_thread(runtime.open_started.wait, 1)
        await websocket.send(
            _message(
                "tts.append",
                streamId=stream_id,
                responseId=response_id,
                epoch=4,
                sequence=0,
                text="hello",
                partIndex=2,
                partId=part_id,
            )
        )
        await websocket.send(
            _message(
                "tts.commit",
                streamId=stream_id,
                responseId=response_id,
                epoch=4,
                nextSequence=1,
                textSha256="a" * 64,
                partIndex=2,
                partId=part_id,
            )
        )
        assert runtime.calls == ["stream.open", "tts.open.begin"]
        health = asyncio.create_task(asyncio.to_thread(request, port, headers=auth(port)))
        try:
            status, _, _ = await asyncio.wait_for(asyncio.shield(health), timeout=1)
        except asyncio.TimeoutError:
            pytest.fail("tts.open blocked an authorized health request")
        finally:
            runtime.release.set()
            await asyncio.wait_for(asyncio.shield(health), timeout=2)
        assert status == 200
        assert await asyncio.to_thread(runtime.commands_done.wait, 1)
        assert runtime.calls == [
            "stream.open",
            "tts.open.begin",
            "tts.open.end",
            "tts.append",
            "tts.commit",
        ]
        assert runtime.open_call == (
            (stream_id, response_id, 4, 2, part_id),
            {
                "voice_id": "voice",
                "speed_modifier": 1.25,
                "tone_prompt": "calm",
                "language": "English",
            },
        )


def test_tts_open_does_not_block_sidecar_event_loop() -> None:
    runtime = _BlockingOpenRuntime()
    with running_server(runtime) as (_, port):
        asyncio.run(_exercise_non_blocking_tts_open(runtime, port))
