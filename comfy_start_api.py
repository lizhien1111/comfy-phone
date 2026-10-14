#!/usr/bin/env python3
"""
ComfyUI 启动接口：轻量 HTTP 服务，供手机出图页点「拉起 Comfy」。

默认监听 0.0.0.0:6008（AutoDL 自定义服务常用端口）。
仅标准库。

端点：
  GET  /health  → {"ok":true,"comfy":true|false}
  GET  /status  → health + last start log snippet
  POST /start   → 若 Comfy 未起则跑 boot_comfy.sh，返回 {ok, already, pid?, message}

环境变量：
  COMFY_START_PORT   默认 6008
  COMFY_PORT         默认 6006（检测 Comfy）
  COMFY_BOOT_SCRIPT  默认 /root/autodl-tmp/boot_comfy.sh（否则本目录 start/boot_comfy.sh）
  COMFY_START_TOKEN  若设置，要求头 X-Start-Token 或 ?token=
  COMFY_START_WAIT   拉起后轮询秒数，默认 60

用法：
  python3 /root/autodl-tmp/comfy_start_api.py
  # 或：bash /root/autodl-tmp/start_api.sh
"""
from __future__ import annotations

import json
import os
import socket
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

HERE = Path(__file__).resolve().parent
PORT = int(os.environ.get("COMFY_START_PORT", "6008"))
COMFY_PORT = int(os.environ.get("COMFY_PORT", "6006"))
TOKEN = (os.environ.get("COMFY_START_TOKEN") or "").strip()
WAIT_SEC = int(os.environ.get("COMFY_START_WAIT", "60"))

_lock = threading.Lock()
_last: dict = {
    "at": None,
    "ok": None,
    "already": None,
    "message": "",
    "log_tail": "",
    "pid": None,
}


def _boot_script() -> Path:
    env = (os.environ.get("COMFY_BOOT_SCRIPT") or "").strip()
    if env:
        return Path(env)
    for name in ("boot_comfy.sh", "start_comfy.sh"):
        p = Path("/root/autodl-tmp") / name
        if p.is_file():
            return p
    for name in ("boot_comfy.sh", "start_comfy.sh"):
        p = HERE / name
        if p.is_file():
            return p
    return Path("/root/autodl-tmp/boot_comfy.sh")


def comfy_up(port: int = COMFY_PORT) -> bool:
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=2.0):
            return True
    except OSError:
        return False


def _read_log_tail(script: Path, n: int = 30) -> str:
    log_dir = os.environ.get("COMFY_LOG_DIR", "/root/autodl-tmp/logs")
    log_file = Path(log_dir) / "comfyui.log"
    candidates = [
        log_file,
        HERE / "logs" / "comfyui.log",
        Path("/tmp/comfy_start_api_last.log"),
    ]
    for p in candidates:
        try:
            if p.is_file():
                lines = p.read_text(errors="replace").splitlines()
                return "\n".join(lines[-n:])
        except OSError:
            continue
    return ""


def do_start() -> dict:
    """Start Comfy via boot script if needed. Thread-safe."""
    with _lock:
        if comfy_up():
            out = {
                "ok": True,
                "already": True,
                "comfy": True,
                "message": f"Comfy already listening on {COMFY_PORT}",
                "pid": None,
            }
            _last.update(
                {
                    "at": time.time(),
                    "ok": True,
                    "already": True,
                    "message": out["message"],
                    "log_tail": "",
                    "pid": None,
                }
            )
            return out

        script = _boot_script()
        if not script.is_file():
            out = {
                "ok": False,
                "already": False,
                "comfy": False,
                "message": f"boot script not found: {script}",
                "pid": None,
            }
            _last.update(
                {
                    "at": time.time(),
                    "ok": False,
                    "already": False,
                    "message": out["message"],
                    "log_tail": "",
                    "pid": None,
                }
            )
            return out

        env = os.environ.copy()
        # Let API own the wait/poll; script just nohups and returns.
        env["COMFY_BOOT_NO_WAIT"] = "1"
        env.setdefault("COMFY_PORT", str(COMFY_PORT))

        try:
            proc = subprocess.Popen(
                ["bash", str(script)],
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                env=env,
                cwd=str(script.parent),
            )
        except OSError as e:
            out = {
                "ok": False,
                "already": False,
                "comfy": False,
                "message": f"failed to spawn script: {e}",
                "pid": None,
            }
            _last.update(
                {
                    "at": time.time(),
                    "ok": False,
                    "already": False,
                    "message": out["message"],
                    "log_tail": "",
                    "pid": None,
                }
            )
            return out

        # Collect short script output (NO_WAIT should exit quickly)
        try:
            stdout, _ = proc.communicate(timeout=15)
        except subprocess.TimeoutExpired:
            stdout = ""
            # Script still running (legacy wait mode) — keep going and poll
            pass

        pid = None
        for line in (stdout or "").splitlines():
            if line.startswith("STARTED_PID="):
                try:
                    pid = int(line.split("=", 1)[1].strip())
                except ValueError:
                    pass
            if "ALREADY_UP" in line:
                out = {
                    "ok": True,
                    "already": True,
                    "comfy": True,
                    "message": line.strip(),
                    "pid": pid,
                }
                _last.update(
                    {
                        "at": time.time(),
                        "ok": True,
                        "already": True,
                        "message": out["message"],
                        "log_tail": (stdout or "")[-2000:],
                        "pid": pid,
                    }
                )
                return out

        deadline = time.time() + WAIT_SEC
        while time.time() < deadline:
            if comfy_up():
                out = {
                    "ok": True,
                    "already": False,
                    "comfy": True,
                    "message": f"Comfy listening on {COMFY_PORT}",
                    "pid": pid,
                }
                _last.update(
                    {
                        "at": time.time(),
                        "ok": True,
                        "already": False,
                        "message": out["message"],
                        "log_tail": _read_log_tail(script) or (stdout or "")[-2000:],
                        "pid": pid,
                    }
                )
                return out
            # If script exited with failure and still no port
            if proc.poll() is not None and proc.returncode not in (0, None):
                break
            time.sleep(2)

        # Final check
        if comfy_up():
            out = {
                "ok": True,
                "already": False,
                "comfy": True,
                "message": f"Comfy listening on {COMFY_PORT}",
                "pid": pid,
            }
        else:
            log_tail = _read_log_tail(script) or (stdout or "")[-2000:]
            rc = proc.poll()
            out = {
                "ok": False,
                "already": False,
                "comfy": False,
                "message": (
                    f"Comfy not up after ~{WAIT_SEC}s"
                    + (f" (script exit={rc})" if rc is not None else "")
                ),
                "pid": pid,
                "log_tail": log_tail[-1500:] if log_tail else "",
            }

        _last.update(
            {
                "at": time.time(),
                "ok": out["ok"],
                "already": False,
                "message": out["message"],
                "log_tail": out.get("log_tail") or _read_log_tail(script),
                "pid": pid,
            }
        )
        return out


class Handler(BaseHTTPRequestHandler):
    server_version = "ComfyStartAPI/1.0"

    def log_message(self, fmt: str, *args) -> None:
        sys.stderr.write("[comfy-start] " + (fmt % args) + "\n")

    def _cors(self) -> None:
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header(
            "Access-Control-Allow-Headers",
            self.headers.get(
                "Access-Control-Request-Headers",
                "Content-Type, X-Start-Token",
            ),
        )
        self.send_header("Access-Control-Max-Age", "86400")

    def _json(self, code: int, obj: dict) -> None:
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self._cors()
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _path(self) -> tuple[str, dict]:
        u = urlparse(self.path)
        qs = parse_qs(u.query)
        return u.path.rstrip("/") or "/", qs

    def _auth_ok(self, qs: dict) -> bool:
        if not TOKEN:
            return True
        hdr = (self.headers.get("X-Start-Token") or "").strip()
        if hdr and hdr == TOKEN:
            return True
        q = qs.get("token") or []
        if q and q[0] == TOKEN:
            return True
        return False

    def do_OPTIONS(self) -> None:
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_GET(self) -> None:
        path, qs = self._path()
        if path in ("/health", "/"):
            up = comfy_up()
            self._json(200, {"ok": True, "comfy": up, "port": COMFY_PORT})
            return
        if path == "/status":
            up = comfy_up()
            self._json(
                200,
                {
                    "ok": True,
                    "comfy": up,
                    "port": COMFY_PORT,
                    "last": {
                        "at": _last.get("at"),
                        "ok": _last.get("ok"),
                        "already": _last.get("already"),
                        "message": _last.get("message") or "",
                        "pid": _last.get("pid"),
                        "log_tail": (_last.get("log_tail") or "")[-800:],
                    },
                },
            )
            return
        self._json(404, {"ok": False, "message": "not found"})

    def do_POST(self) -> None:
        path, qs = self._path()
        if path != "/start":
            self._json(404, {"ok": False, "message": "not found"})
            return
        if not self._auth_ok(qs):
            self._json(401, {"ok": False, "message": "unauthorized"})
            return
        # Drain body if any
        try:
            n = int(self.headers.get("Content-Length") or "0")
        except ValueError:
            n = 0
        if n > 0:
            self.rfile.read(n)
        result = do_start()
        code = 200 if result.get("ok") else 503
        self._json(code, result)


def main() -> None:
    host = os.environ.get("COMFY_START_HOST", "0.0.0.0")
    httpd = ThreadingHTTPServer((host, PORT), Handler)
    print(
        f"Comfy start API on http://{host}:{PORT} "
        f"(comfy port {COMFY_PORT}, script={_boot_script()})",
        flush=True,
    )
    if TOKEN:
        print("Token auth enabled (X-Start-Token / ?token=)", flush=True)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nbye", flush=True)


if __name__ == "__main__":
    main()
