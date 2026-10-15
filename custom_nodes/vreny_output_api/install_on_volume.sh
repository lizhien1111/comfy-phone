#!/bin/bash
# Copy this extension into a ComfyUI tree (default: RunPod volume).
# Usage: bash install_on_volume.sh [/workspace/ComfyUI]
set -euo pipefail
SRC="$(cd "$(dirname "$0")" && pwd)"
COMFY="${1:-${COMFY_DIR:-/workspace/ComfyUI}}"
DEST="$COMFY/custom_nodes/vreny_output_api"
mkdir -p "$COMFY/custom_nodes"
rm -rf "$DEST"
mkdir -p "$DEST"
cp -a "$SRC/__init__.py" "$DEST/"
echo "Installed → $DEST"
echo "Restart ComfyUI, then GET /vreny_output_api should return {\"ok\":true}"
