# Telegram 代理（Cloudflare Worker）

手机在国内常无法直连 `api.telegram.org`（进度条会显示「失败」且原因像 `Failed to fetch`）。
本 Worker 只做中转：手机 → Worker → Telegram。

## 部署（只需一次）

1. 注册 [Cloudflare](https://dash.cloudflare.com/)（免费即可）
2. 本机安装 Node 后：

```bash
cd workers
npx wrangler login
npx wrangler deploy
```

3. 记下输出的地址，形如 `https://comfy-telegram-proxy.<你的子域>.workers.dev`

也可在 Dashboard → Workers & Pages → Create → 粘贴 `telegram-proxy.js` 全文后 Deploy。

## 手机页

1. 勾选「发到 Telegram」，填 Bot Token 与 Chat ID  
2. **Telegram 代理** 填上一步的 Worker 地址（不要末尾 `/`）  
3. 点「测试连接」应显示 Bot 用户名  
4. 再「选择」勾图 →「发到 Telegram」

Token 仍只存在手机浏览器；Worker 不保存密钥。
