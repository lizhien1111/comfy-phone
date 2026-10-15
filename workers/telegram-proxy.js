/**
 * Cloudflare Worker — browser ↔ api.telegram.org relay.
 *
 * Why: phones in mainland China often cannot reach api.telegram.org
 * (Failed to fetch). Telegram Bot API already sends ACAO *; this is
 * primarily a reachability proxy, not a secret vault. The bot token
 * still travels in the path from the phone; the Worker does not store it.
 *
 * Deploy (once):
 *   cd workers && npx wrangler deploy
 *   # or paste this file into Cloudflare Dashboard → Workers → Create
 *
 * Then on the phone page, set 「Telegram 代理」 to:
 *   https://<your-worker>.workers.dev
 * (no trailing slash)
 *
 * Requests: POST/GET https://worker/bot<token>/<method>  →  api.telegram.org
 */
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "*",
  "Access-Control-Max-Age": "86400",
};

function withCors(headers) {
  const h = new Headers(headers || {});
  for (const [k, v] of Object.entries(CORS)) h.set(k, v);
  return h;
}

export default {
  async fetch(request) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS });
    }

    const url = new URL(request.url);
    if (url.pathname === "/" || url.pathname === "/health") {
      return new Response("ok telegram-proxy\n", {
        headers: withCors({ "content-type": "text/plain; charset=utf-8" }),
      });
    }

    // /bot<token>/<method>  (Telegram Bot API shape)
    if (!/^\/bot[^/]+\/[A-Za-z0-9_]+$/.test(url.pathname)) {
      return new Response(
        JSON.stringify({
          ok: false,
          description: "path must be /bot<token>/<method>",
        }),
        {
          status: 400,
          headers: withCors({ "content-type": "application/json" }),
        }
      );
    }

    const target = "https://api.telegram.org" + url.pathname + url.search;
    const headers = new Headers();
    const ct = request.headers.get("Content-Type");
    if (ct) headers.set("Content-Type", ct);

    const init = { method: request.method, headers };
    if (request.method !== "GET" && request.method !== "HEAD") {
      init.body = request.body;
      // Required for streaming request bodies on some runtimes
      init.duplex = "half";
    }

    try {
      const resp = await fetch(target, init);
      return new Response(resp.body, {
        status: resp.status,
        statusText: resp.statusText,
        headers: withCors(resp.headers),
      });
    } catch (e) {
      const msg = e && e.message ? e.message : String(e);
      return new Response(
        JSON.stringify({ ok: false, description: "proxy upstream: " + msg }),
        {
          status: 502,
          headers: withCors({ "content-type": "application/json" }),
        }
      );
    }
  },
};
