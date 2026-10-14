#!/bin/bash
# 在 AutoDL 实例上常驻 Comfy 启动接口（默认 6008）
# 用法：bash /root/autodl-tmp/start_api.sh
# 建议挂到 /root/.autodl/start.sh，开机只起 API；手机点「拉起 Comfy」再起 Comfy。
set +e

DIR="$(cd "$(dirname "$0")" && pwd)"
API="${COMFY_START_API:-$DIR/comfy_start_api.py}"
if [[ ! -f "$API" ]]; then
  API="/root/autodl-tmp/comfy_start_api.py"
fi
PY="${COMFY_PY:-/root/miniconda3/bin/python}"
[[ -x "$PY" ]] || PY=python3
LOG_DIR="${COMFY_LOG_DIR:-/root/autodl-tmp/logs}"
mkdir -p "$LOG_DIR"
PORT="${COMFY_START_PORT:-6008}"
PID_FILE="$LOG_DIR/comfy_start_api.pid"
LOG_FILE="$LOG_DIR/comfy_start_api.log"

# 已在听则退出
CODE=$(curl -s -o /dev/null -w '%{http_code}' --connect-timeout 2 "http://127.0.0.1:${PORT}/health" 2>/dev/null || echo 000)
if echo "$CODE" | grep -qE '200'; then
  echo "API_ALREADY_UP port=$PORT"
  exit 0
fi

# 清旧进程
if [[ -f "$PID_FILE" ]]; then
  kill "$(cat "$PID_FILE")" 2>/dev/null || true
  rm -f "$PID_FILE"
fi
pkill -f "comfy_start_api.py" 2>/dev/null || true
sleep 1

export COMFY_START_PORT="$PORT"
nohup "$PY" "$API" > "$LOG_FILE" 2>&1 &
echo $! > "$PID_FILE"
echo "API_STARTED_PID=$(cat "$PID_FILE") port=$PORT"
echo "公网：AutoDL 自定义服务映射 ${PORT}→443，手机页「启动接口地址」填该公网 URL"
