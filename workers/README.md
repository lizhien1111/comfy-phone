# Cloudflare Workers（可选代理）

手机页可直连多数 API；国内网络不稳时再部署代理。

## Telegram 代理

见 `telegram-proxy.js`。手机「Telegram 代理」填 Worker 地址。

```bash
cd workers
npx wrangler deploy -c wrangler.toml
# 或 Dashboard 粘贴 telegram-proxy.js
```

## RunPod API 代理

`rest.runpod.io` 已开 CORS，多数环境可直连。若手机「开机」报 `Failed to fetch`，再部署 `runpod-proxy.js`：

```bash
cd workers
npx wrangler deploy -c wrangler.runpod.toml
```

手机 RunPod 面板「API 代理」填：`https://comfy-runpod-proxy.<sub>.workers.dev`（无尾 `/`）。

密钥仍只存在手机浏览器；Worker 按请求转发，不落盘。
