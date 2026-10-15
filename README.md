# 手机出图页（ComfyUI）· 可独立托管

轻量手机网页：启动页开实例 / 填公网 / **拉起 Comfy** → 改提示词出图 → 图库本机保存。

在线：[https://lizhien1111.github.io/vreny/](https://lizhien1111.github.io/vreny/)

## 文件

| 文件 | 说明 |
|------|------|
| `index.html` / `app.js` / `workflow.js` / `gallery.js` | 前端（Pages 只部署这四个） |
| `boot_comfy.sh` / `start_comfy.sh` | 实例内一键拉起 Comfy（6006 + CORS） |
| `comfy_start_api.py` | **启动接口**：`POST /start` 代跑上面的脚本（默认 6008） |
| `start_api.sh` | nohup 启动接口，适合挂开机脚本 |
| `cors_proxy.py` | 可选：同源反代，避开 CORS |

## 手机页用法

1. AutoDL 开机（有 GPU）。
2. **步骤 2**：填 Comfy 公网地址（自定义服务 **6006**→443，形如 `https://u….seetacloud.com`，**不要加端口**）。
3. **步骤 3**：
   - （推荐）再开 **6008** 公网，把该地址填到「启动接口地址」，点 **拉起 Comfy**。
   - 或手动在实例里跑 `boot_comfy.sh` 后，点「检测连接」/「打开 ComfyUI」。
4. 点 **进入出图**。

两个公网地址通常不同（AutoDL 每个映射端口一个 `u….seetacloud.com`）。地址会记在 localStorage。

## RunPod 一键开机

1. 启动页选 **RunPod**。
2. 填 **API Key**（[Settings → API Keys](https://www.runpod.io/console/user/settings)）与 **机器码（Pod ID）**（Pods 列表 / 详情里复制）。
3. Comfy HTTP 端口默认 **8188**（须在 Pod 模板「Expose HTTP Ports」里暴露；Comfy 监听 `0.0.0.0`）。
4. 点 **开机并等 Comfy** → 调用 `POST /pods/{id}/start`，自动填入  
   `https://<机器码>-8188.proxy.runpod.net`，并轮询 `/system_stats`。
5. 就绪后点 **进入出图**。用完可点 **关 Pod**（或出图页「关实例」）。

密钥与机器码存在手机 `localStorage`，不上传本站。

直连 `rest.runpod.io`（已 CORS）。若手机报 `Failed to fetch`，部署 `workers/runpod-proxy.js`，把 Worker 地址填到「API 代理」。

模板需已装好 Comfy 并在启动脚本里拉起；本页只负责 **开机 Pod + 等公网**，不会往容器里装 Comfy。

## 实例部署：启动接口 + Comfy

拷到实例（例：`/root/autodl-tmp/`）：

```bash
# 在本机仓库目录
scp comfy_start_api.py start_api.sh boot_comfy.sh start_comfy.sh \
  root@<实例>:/root/autodl-tmp/
```

### 推荐：开机只起启动接口，手机再拉起 Comfy

`/root/.autodl/start.sh` 示例：

```bash
#!/bin/bash
bash /root/autodl-tmp/start_api.sh
# 需要的话也可同时拉起 Comfy：
# bash /root/autodl-tmp/boot_comfy.sh &
```

然后 AutoDL 控制台：

1. 自定义服务映射 **6006**（Comfy）→ 记下公网 URL → 填手机页步骤 2  
2. 自定义服务映射 **6008**（启动接口）→ 记下公网 URL → 填「启动接口地址」  
3. 手机点 **拉起 Comfy** → 接口执行 `boot_comfy.sh` → 轮询到 6006 就绪

### 或者：开机同时起 Comfy + 接口

```bash
#!/bin/bash
bash /root/autodl-tmp/start_api.sh
bash /root/autodl-tmp/boot_comfy.sh &
```

此时「拉起」会返回 `already: true`，仍可用于确认状态。

### 启动接口端点

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/health` | `{"ok":true,"comfy":true\|false}` |
| GET | `/status` | health + 上次拉起摘要 |
| POST | `/start` | 未起则跑 boot 脚本；已起则 `already=true` |

可选鉴权：环境变量 `COMFY_START_TOKEN`，请求带头 `X-Start-Token` 或 `?token=`。

其它环境变量：`COMFY_START_PORT`（6008）、`COMFY_PORT`（6006）、`COMFY_BOOT_SCRIPT`、`COMFY_DIR`、`COMFY_PY`。

手动拉起（无接口时）：

```bash
bash /root/autodl-tmp/boot_comfy.sh
```

已在跑会报 `ALREADY_UP`。无卡测试：`COMFY_EXTRA=--cpu bash start_comfy.sh`。

## CORS 说明（跨域必看）

页面和 Comfy / 启动接口不在同一域名时，浏览器会拦请求：

| 办法 | 说明 |
|------|------|
| Comfy 开 CORS | `boot_comfy.sh` 已带 `--enable-cors-header` |
| 启动接口 | `comfy_start_api.py` 已 `Access-Control-Allow-Origin: *` |
| `cors_proxy.py` | 静态页 + `/api` → Comfy 同源 |

```bash
export COMFY_BASE="https://u865025-xxxx.bjb1.seetacloud.com"
python3 cors_proxy.py 8765
```

## 功能摘要

- 启动页：AutoDL / RunPod 切换；RunPod 填 API Key + 机器码一键开机；检测连接
- WebSocket 实时「出图中 x/y 步」（失败则 `/history` 轮询）
- IndexedDB 图库（清浏览器缓存会丢）
- Lustify Krea Turbo 默认：30 步、1280×2560、CFG 1

## 注意

- 实例关机后启动接口与 Comfy 都不可用；用完记得关 AutoDL。
- 图库在本机浏览器，换机 / 清缓存不会带走。

## 发到 Telegram（国内需代理）

Bot API 本身允许浏览器 CORS，但**国内手机常连不上** `api.telegram.org`（表现：队列「失败 N」、原因 `Failed to fetch`）。

1. 部署仓库内 `workers/telegram-proxy.js`（Cloudflare Worker，免费），见 `workers/README.md`
2. 手机页勾选「发到 Telegram」，填 Bot Token、Chat ID
3. **Telegram 代理** 填 Worker 地址，如 `https://comfy-telegram-proxy.<sub>.workers.dev`
4. 点「测试 Telegram 连接」→ 再选图发送

若本机跑了 `cors_proxy.py`，代理也可填 `http://<IP>:8765/tg`。

Token **不要**提交到 git。

