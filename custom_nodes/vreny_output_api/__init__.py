"""
Minimal ComfyUI routes for the vreny phone page:
  GET  /vreny_output_api          → health {ok:true}
  POST /delete_output            → delete specific output/temp files
  POST /clean_output             → wipe output and/or temp dirs

Install: copy this folder into ComfyUI/custom_nodes/ then restart Comfy.
"""
from __future__ import annotations

import os
from pathlib import Path
from typing import Optional, Tuple

from aiohttp import web

NODE_CLASS_MAPPINGS = {}
NODE_DISPLAY_NAME_MAPPINGS = {}

try:
    from server import PromptServer
    import folder_paths
except Exception as e:  # pragma: no cover
    PromptServer = None
    folder_paths = None
    print("[vreny_output_api] skip routes:", e)


def _folder_for_type(kind: str) -> Path:
    kind = (kind or "output").strip().lower()
    if kind not in ("output", "temp", "input"):
        kind = "output"
    base = None
    try:
        base = folder_paths.get_directory_by_type(kind)
    except Exception:
        base = None
    if not base:
        getters = {
            "output": getattr(folder_paths, "get_output_directory", None),
            "temp": getattr(folder_paths, "get_temp_directory", None),
            "input": getattr(folder_paths, "get_input_directory", None),
        }
        fn = getters.get(kind)
        if callable(fn):
            try:
                base = fn()
            except Exception:
                base = None
    if not base:
        root = getattr(folder_paths, "base_path", None) or os.getcwd()
        base = os.path.join(str(root), kind)
    return Path(base).resolve()


def _safe_file(kind: str, subfolder: str, filename: str) -> Optional[Path]:
    """Resolve a path under output/temp/input; reject traversal."""
    if not filename or not isinstance(filename, str):
        return None
    name = os.path.basename(filename.strip())
    if not name or name in (".", "..") or "/" in name or "\\" in name:
        return None
    base = _folder_for_type(kind)
    sub = (subfolder or "").replace("\\", "/").strip().lstrip("/")
    parts = [p for p in sub.split("/") if p and p not in (".", "..")]
    target = base.joinpath(*parts, name).resolve()
    try:
        target.relative_to(base)
    except ValueError:
        return None
    return target


def _delete_one(kind: str, subfolder: str, filename: str) -> dict:
    path = _safe_file(kind, subfolder, filename)
    if path is None:
        return {"ok": False, "error": "bad_path", "filename": filename}
    if not path.is_file():
        return {
            "ok": True,
            "missing": True,
            "filename": filename,
            "bytes": 0,
        }
    size = path.stat().st_size
    path.unlink()
    return {
        "ok": True,
        "missing": False,
        "filename": filename,
        "bytes": size,
        "path": str(path),
    }


def _wipe_dir(root: Path) -> Tuple[int, int]:
    removed = 0
    nbytes = 0
    if not root.is_dir():
        return 0, 0
    for dirpath, dirnames, filenames in os.walk(root, topdown=False):
        for name in filenames:
            p = Path(dirpath) / name
            try:
                nbytes += p.stat().st_size
                p.unlink()
                removed += 1
            except OSError:
                pass
        for name in dirnames:
            d = Path(dirpath) / name
            try:
                d.rmdir()
            except OSError:
                pass
    return removed, nbytes


if PromptServer is not None:

    @PromptServer.instance.routes.get("/vreny_output_api")
    async def vreny_output_api_health(_request):
        return web.json_response({"ok": True, "name": "vreny_output_api"})

    @PromptServer.instance.routes.post("/delete_output")
    async def vreny_delete_output(request):
        try:
            data = await request.json()
        except Exception:
            data = {}
        files = data.get("files") or []
        if not isinstance(files, list):
            return web.json_response(
                {"ok": False, "error": "files must be a list"}, status=400
            )
        results = []
        removed = 0
        nbytes = 0
        for item in files:
            if not isinstance(item, dict):
                continue
            filename = item.get("filename") or item.get("name") or ""
            subfolder = item.get("subfolder") or ""
            kind = item.get("type") or "output"
            r = _delete_one(kind, subfolder, filename)
            results.append(r)
            if r.get("ok") and not r.get("missing"):
                removed += 1
                nbytes += int(r.get("bytes") or 0)
        return web.json_response(
            {
                "ok": True,
                "removed": removed,
                "bytes": nbytes,
                "results": results,
            }
        )

    @PromptServer.instance.routes.post("/clean_output")
    async def vreny_clean_output(request):
        try:
            data = await request.json()
        except Exception:
            data = {}
        do_output = bool(data.get("output", True))
        do_temp = bool(data.get("temp", True))
        removed = 0
        nbytes = 0
        if do_output:
            r, b = _wipe_dir(_folder_for_type("output"))
            removed += r
            nbytes += b
        if do_temp:
            r, b = _wipe_dir(_folder_for_type("temp"))
            removed += r
            nbytes += b
        return web.json_response(
            {"ok": True, "removed": removed, "bytes": nbytes}
        )

    print("[vreny_output_api] routes: /vreny_output_api /delete_output /clean_output")
