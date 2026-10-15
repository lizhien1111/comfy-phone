#!/usr/bin/env python3
"""
同源反代：本页静态文件 + /api/* → Comfy，避开浏览器 CORS。

用法：
  export COMFY_BASE="https://u865025-xxxx.bjb1.seetacloud.com"
  python3 cors_proxy.py          # 默认 0.0.0.0:8765
  python3 cors_proxy.py 8787

手机打开 http://<这台机器IP>:8765/
服务器地址填：http://<这台机器IP>:8765/api
Telegram 代理可填：http://<这台机器IP>:8765/tg
然后点「连接」。

依赖：仅 Python 3 标准库。WebSocket 会尽量转发；失败时页面仍可用 /history 轮询。
"""
from __future__ import annotations

import argparse
import os
import select
import socket
import sys
import threading
import urllib.error
import urllib.request
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parent
COMFY_BASE = os.environ.get("COMFY_BASE", "").rstrip("/")


def die(msg: str, code: int = 2) -> None:
    print(msg, file=sys.stderr)
    raise SystemExit(code)


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def log_message(self, fmt: str, *args) -> None:
        sys.stderr.write("[proxy] " + (fmt % args) + "\n")

    def do_OPTIONS(self) -> None:
        if self.path.startswith("/api") or self.path.startswith("/tg"):
            self.send_response(204)
            self._cors()
            self.end_headers()
            return
        self.send_error(404)

    def do_GET(self) -> None:
        if self.path.startswith("/tg/") or self.path == "/tg":
            self._tg_proxy()
            return
        if self.path.startswith("/api/") or self.path == "/api":
            if self.headers.get("Upgrade", "").lower() == "websocket":
                self._ws_proxy()
                return
            self._proxy()
            return
        super().do_GET()

    def do_POST(self) -> None:
        if self.path.startswith("/tg/") or self.path == "/tg":
            self._tg_proxy()
            return
        if self.path.startswith("/api/") or self.path == "/api":
            self._proxy()
            return
        self.send_error(404)

    def do_PUT(self) -> None:
        if self.path.startswith("/api/"):
            self._proxy()
            return
        self.send_error(404)

    def _cors(self) -> None:
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, PUT, OPTIONS")
        self.send_header(
            "Access-Control-Allow-Headers",
            self.headers.get("Access-Control-Request-Headers", "*"),
        )

    def _target_url(self) -> str:
        # /api/prompt -> COMFY_BASE/prompt ; /api/ws?x= -> COMFY_BASE/ws?x=
        raw = self.path
        if raw == "/api":
            suffix = "/"
        elif raw.startswith("/api/"):
            suffix = raw[len("/api") :]
        else:
            suffix = raw
        return COMFY_BASE + suffix

    def _proxy(self) -> None:
        if not COMFY_BASE:
            self.send_error(500, "COMFY_BASE not set")
            return
        url = self._target_url()
        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length) if length > 0 else None
        headers = {}
        for k in ("Content-Type", "Accept", "Authorization"):
            if self.headers.get(k):
                headers[k] = self.headers.get(k)
        req = urllib.request.Request(
            url, data=body, headers=headers, method=self.command
        )
        try:
            with urllib.request.urlopen(req, timeout=600) as resp:
                data = resp.read()
                self.send_response(resp.status)
                self._cors()
                ct = resp.headers.get("Content-Type")
                if ct:
                    self.send_header("Content-Type", ct)
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)
        except urllib.error.HTTPError as e:
            data = e.read()
            self.send_response(e.code)
            self._cors()
            self.send_header("Content-Type", e.headers.get("Content-Type", "text/plain"))
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
        except Exception as e:
            msg = str(e).encode()
            self.send_response(502)
            self._cors()
            self.send_header("Content-Type", "text/plain; charset=utf-8")
            self.send_header("Content-Length", str(len(msg)))
            self.end_headers()
            self.wfile.write(msg)

    def _ws_proxy(self) -> None:
        """Best-effort WebSocket tunnel to Comfy."""
        if not COMFY_BASE:
            self.send_error(500, "COMFY_BASE not set")
            return
        parsed = urlparse(COMFY_BASE)
        host = parsed.hostname
        if not host:
            self.send_error(500, "bad COMFY_BASE")
            return
        port = parsed.port or (443 if parsed.scheme == "https" else 80)
        use_ssl = parsed.scheme == "https"
        # path: /api/ws?clientId= -> /ws?clientId=
        target_path = self._target_url()
        tp = urlparse(target_path)
        path_q = tp.path + (("?" + tp.query) if tp.query else "")

        try:
            raw = socket.create_connection((host, port), timeout=30)
            if use_ssl:
                import ssl

                ctx = ssl.create_default_context()
                sock = ctx.wrap_socket(raw, server_hostname=host)
            else:
                sock = raw
        except Exception as e:
            self.send_error(502, f"ws connect failed: {e}")
            return

        # Rebuild upgrade request toward Comfy
        key = self.headers.get("Sec-WebSocket-Key", "")
        ver = self.headers.get("Sec-WebSocket-Version", "13")
        proto = self.headers.get("Sec-WebSocket-Protocol", "")
        lines = [
            f"GET {path_q} HTTP/1.1",
            f"Host: {host}",
            "Upgrade: websocket",
            "Connection: Upgrade",
            f"Sec-WebSocket-Key: {key}",
            f"Sec-WebSocket-Version: {ver}",
        ]
        if proto:
            lines.append(f"Sec-WebSocket-Protocol: {proto}")
        lines.append("")
        lines.append("")
        sock.sendall("\r\n".join(lines).encode())

        # Read upstream handshake
        buf = b""
        while b"\r\n\r\n" not in buf:
            chunk = sock.recv(4096)
            if not chunk:
                break
            buf += chunk
            if len(buf) > 65536:
                break
        if b"101" not in buf.split(b"\r\n", 1)[0]:
            try:
                sock.close()
            except Exception:
                pass
            self.send_error(502, "upstream ws handshake failed")
            return

        # Reply 101 to client (reuse upstream headers mostly)
        head, rest = buf.split(b"\r\n\r\n", 1)
        self.wfile.write(head + b"\r\n\r\n")
        self.wfile.flush()
        if rest:
            self.wfile.write(rest)
            self.wfile.flush()

        client = self.connection
        # Bidirectional copy
        try:
            while True:
                r, _, _ = select.select([client, sock], [], [], 60)
                if not r:
                    continue
                if client in r:
                    data = client.recv(65536)
                    if not data:
                        break
                    sock.sendall(data)
                if sock in r:
                    data = sock.recv(65536)
                    if not data:
                        break
                    client.sendall(data)
        except Exception:
            pass
        finally:
            try:
                sock.close()
            except Exception:
                pass


def main() -> None:
    global COMFY_BASE
    ap = argparse.ArgumentParser(description="Comfy phone CORS reverse proxy")
    ap.add_argument("port", nargs="?", type=int, default=int(os.environ.get("PORT", "8765")))
    ap.add_argument("--comfy", default=COMFY_BASE, help="Comfy public base URL")
    ap.add_argument("--bind", default="0.0.0.0")
    args = ap.parse_args()
    COMFY_BASE = (args.comfy or "").rstrip("/")
    if not COMFY_BASE:
        die("请设置 COMFY_BASE 或传入 --comfy https://u865025-….seetacloud.com")

    httpd = ThreadingHTTPServer((args.bind, args.port), Handler)
    print(f"Static+API proxy on http://{args.bind}:{args.port}/")
    print(f"  COMFY_BASE = {COMFY_BASE}")
    print(f"  手机打开页面后，服务器地址填: http://<本机IP>:{args.port}/api")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nbye")


if __name__ == "__main__":
    main()
