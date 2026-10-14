#!/bin/bash
# 在 AutoDL 实例里一键拉起 ComfyUI（GPU + CORS，供手机出图页连接）
# 用法：bash /root/autodl-tmp/boot_comfy.sh
#   或：bash start_comfy.sh
# COMFY_BOOT_NO_WAIT=1 时：nohup 后立即返回（由 comfy_start_api 轮询端口）
set +e

COMFY="${COMFY_DIR:-/root/autodl-tmp/ComfyUI}"
PY="${COMFY_PY:-/root/miniconda3/bin/python}"
LOG_DIR="${COMFY_LOG_DIR:-/root/autodl-tmp/logs}"
PORT="${COMFY_PORT:-6006}"
PID_FILE="$LOG_DIR/comfyui.pid"
LOG_FILE="$LOG_DIR/comfyui.log"

if [[ ! -d "$COMFY" ]]; then
  echo "ERROR: ComfyUI 目录不存在: $COMFY"
  exit 1
fi
if [[ ! -x "$PY" ]]; then
  echo "ERROR: Python 不存在: $PY"
  exit 1
fi

mkdir -p "$LOG_DIR"
cd "$COMFY" || exit 1

# 已在听端口则直接成功
CODE=$(curl -s -o /dev/null -w '%{http_code}' --connect-timeout 2 "http://127.0.0.1:${PORT}/" 2>/dev/null || echo 000)
if echo "$CODE" | grep -qE '200|302|401|404'; then
  echo "ALREADY_UP HTTP=$CODE port=$PORT"
  echo "公网：AutoDL 自定义服务映射 ${PORT}（浏览器地址不要加 :8443）"
  exit 0
fi

# 清掉旧的同路径进程
pkill -f "${COMFY}/main.py" 2>/dev/null || true
sleep 1

# GPU 正常；无卡时可用 COMFY_EXTRA="--cpu" 覆盖
EXTRA="${COMFY_EXTRA:---disable-assets --enable-cors-header}"

nohup "$PY" main.py --listen 0.0.0.0 --port "$PORT" $EXTRA \
  > "$LOG_FILE" 2>&1 &
echo $! > "$PID_FILE"
echo "STARTED_PID=$(cat "$PID_FILE")"

if [[ "${COMFY_BOOT_NO_WAIT:-0}" == "1" ]]; then
  echo "NO_WAIT=1 (API will poll port $PORT)"
  exit 0
fi

for i in $(seq 1 20); do
  sleep 3
  CODE=$(curl -s -o /dev/null -w '%{http_code}' --connect-timeout 2 "http://127.0.0.1:${PORT}/" 2>/dev/null || echo 000)
  echo "try$i HTTP=$CODE"
  if echo "$CODE" | grep -qE '200|302|401|404'; then
    echo "LISTENING=YES port=$PORT"
    echo "公网：在 AutoDL 开通自定义服务 ${PORT}→443，手机页填 https://u….seetacloud.com（勿加端口）"
    nvidia-smi -L 2>/dev/null || echo "NOTE: 当前 nvidia-smi 无卡"
    exit 0
  fi
  if ! kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
    echo "CRASHED — 最近日志："
    tail -n 40 "$LOG_FILE"
    exit 1
  fi
done

echo "TIMEOUT — 未在约 60s 内监听 ${PORT}，日志："
tail -n 40 "$LOG_FILE"
exit 1
