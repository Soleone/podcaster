from __future__ import annotations

import http.client
import threading
from contextlib import contextmanager
from typing import Iterator

import pytest

from services.audio.src.server import MAX_BODY, SidecarServer

SECRET = "s" * 43


@contextmanager
def running_server() -> Iterator[tuple[SidecarServer, int]]:
    server = SidecarServer(("127.0.0.1", 0), SECRET)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
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


def test_rejects_oversized_and_non_json_posts() -> None:
    with running_server() as (_, port):
        assert request(port, "POST", "/stream", {**auth(port), "Content-Length": str(MAX_BODY + 1), "Content-Type": "application/json"})[0] == 413
        assert request(port, "POST", "/stream", {**auth(port), "Content-Type": "text/plain"}, b"x")[0] == 415
