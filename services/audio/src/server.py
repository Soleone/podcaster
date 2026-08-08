"""Authenticated loopback-only audio sidecar stub."""
from __future__ import annotations

import argparse
import hmac
import json
import os
import signal
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import NoReturn

MAX_BODY = 16 * 1024


class SidecarServer(ThreadingHTTPServer):
    allow_reuse_address = False
    daemon_threads = True

    def __init__(self, address: tuple[str, int], secret: str):
        super().__init__(address, SidecarHandler)
        self.secret = secret


class SidecarHandler(BaseHTTPRequestHandler):
    server: SidecarServer
    protocol_version = "HTTP/1.1"

    def log_message(self, _format: str, *_args: object) -> None:
        return

    def _json(self, status: int, value: dict[str, object]) -> None:
        body = json.dumps(value, separators=(",", ":")).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _authorized(self) -> bool:
        if "Origin" in self.headers:
            self._json(403, {"error": "browser_origin_rejected"})
            return False
        expected_host = f"127.0.0.1:{self.server.server_port}"
        if self.headers.get("Host") != expected_host:
            self._json(421, {"error": "invalid_host"})
            return False
        authorization = self.headers.get("Authorization", "")
        expected = f"Bearer {self.server.secret}"
        if not hmac.compare_digest(authorization, expected):
            self._json(401, {"error": "unauthorized"})
            return False
        return True

    def do_GET(self) -> None:  # noqa: N802
        if self.path != "/health":
            self._json(404, {"error": "not_found"})
        elif self._authorized():
            self._json(200, {"status": "ready", "service": "audio_stub"})

    def do_POST(self) -> None:  # noqa: N802
        if not self._authorized():
            return
        length_text = self.headers.get("Content-Length")
        if length_text is None or not length_text.isdigit():
            self._json(411, {"error": "content_length_required"})
            return
        length = int(length_text)
        if length > MAX_BODY:
            self._json(413, {"error": "body_too_large"})
            return
        if self.headers.get_content_type() != "application/json":
            self._json(415, {"error": "json_required"})
            return
        self.rfile.read(length)
        self._json(501, {"error": "stub_only"})


def run(host: str, port: int, secret: str) -> NoReturn:
    if host != "127.0.0.1" or port < 0:
        raise ValueError("sidecar must use 127.0.0.1 and an OS-assigned or valid port")
    server = SidecarServer((host, port), secret)
    signal.signal(signal.SIGTERM, lambda *_: threading.Thread(target=server.shutdown, daemon=True).start())
    actual_host, actual_port = server.server_address
    print(json.dumps({"host": actual_host, "port": actual_port}), flush=True)
    server.serve_forever()
    server.server_close()
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
