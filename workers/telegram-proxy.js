/**
 * Cloudflare Worker — browser ↔ api.telegram.org relay.
 *
 * Phone 「Telegram 代理」填: https://<worker>.workers.dev  (无尾斜杠)
 *
 * Modes:
 * 1) Path mirror (getMe etc): GET/POST /bot<token>/<method>
 * 2) JSON upload (preferred for photos on mobile):
 *    POST /tg  Content-Type: application/json
 *    { token, method, chat_id, field, filename, file_b64, caption? }
 */
function corsHeaders(request) {
  const h = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Max-Age": "86400",
  };
  const reqH = request && request.headers.get("Access-Control-Request-Headers");
  h["Access-Control-Allow-Headers"] = reqH || "Content-Type, Authorization";
  return h;
}

function withCors(request, headers) {
  const h = new Headers(headers || {});
  for (const [k, v] of Object.entries(corsHeaders(request))) h.set(k, v);
  return h;
}

function jsonResp(request, obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: withCors(request, { "content-type": "application/json" }),
  });
}

function b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function relayTelegram(pathname, search, method, headers, body) {
  const target = "https://api.telegram.org" + pathname + (search || "");
  const init = { method, headers };
  if (body != null) init.body = body;
  return fetch(target, init);
}

export default {
  async fetch(request) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(request) });
    }

    const url = new URL(request.url);
    if (url.pathname === "/" || url.pathname === "/health") {
      return new Response("ok telegram-proxy\n", {
        headers: withCors(request, {
          "content-type": "text/plain; charset=utf-8",
        }),
      });
    }

    // Preferred mobile upload path
    if (url.pathname === "/tg" && request.method === "POST") {
      let data;
      try {
        data = await request.json();
      } catch (e) {
        return jsonResp(request, { ok: false, description: "invalid json" }, 400);
      }
      const token = String((data && data.token) || "").trim();
      const method = String((data && data.method) || "sendPhoto").trim();
      const chatId = String((data && data.chat_id) || "").trim();
      const field = String((data && data.field) || "photo").trim();
      const filename = String((data && data.filename) || "image.png").trim();
      const caption = data && data.caption != null ? String(data.caption) : "";
      const b64 = String((data && data.file_b64) || "").replace(/^data:[^;]+;base64,/, "");
      if (!token || !chatId || !b64) {
        return jsonResp(
          request,
          { ok: false, description: "token, chat_id, file_b64 required" },
          400
        );
      }
      if (!/^[A-Za-z0-9_]+$/.test(method)) {
        return jsonResp(request, { ok: false, description: "bad method" }, 400);
      }
      let bytes;
      try {
        bytes = b64ToBytes(b64);
      } catch (e) {
        return jsonResp(request, { ok: false, description: "bad base64" }, 400);
      }
      const fd = new FormData();
      fd.append("chat_id", chatId);
      if (caption) fd.append("caption", caption.slice(0, 1024));
      fd.append(field, new Blob([bytes]), filename || "image.png");
      try {
        const resp = await fetch(
          "https://api.telegram.org/bot" + token + "/" + method,
          { method: "POST", body: fd }
        );
        const text = await resp.text();
        return new Response(text, {
          status: resp.status,
          headers: withCors(request, { "content-type": "application/json" }),
        });
      } catch (e) {
        const msg = e && e.message ? e.message : String(e);
        return jsonResp(
          request,
          { ok: false, description: "proxy upstream: " + msg },
          502
        );
      }
    }

    // Path mirror: /bot<token>/<method>
    if (!/^\/bot[^/]+\/[A-Za-z0-9_]+$/.test(url.pathname)) {
      return jsonResp(
        request,
        { ok: false, description: "use /bot<token>/<method> or POST /tg" },
        400
      );
    }

    const headers = new Headers();
    const ct = request.headers.get("Content-Type");
    if (ct) headers.set("Content-Type", ct);
    let body = null;
    if (request.method !== "GET" && request.method !== "HEAD") {
      body = await request.arrayBuffer();
    }
    try {
      const resp = await relayTelegram(
        url.pathname,
        url.search,
        request.method,
        headers,
        body
      );
      const buf = await resp.arrayBuffer();
      const out = withCors(request, resp.headers);
      out.delete("content-encoding");
      out.delete("content-length");
      return new Response(buf, {
        status: resp.status,
        statusText: resp.statusText,
        headers: out,
      });
    } catch (e) {
      const msg = e && e.message ? e.message : String(e);
      return jsonResp(
        request,
        { ok: false, description: "proxy upstream: " + msg },
        502
      );
    }
  },
};
