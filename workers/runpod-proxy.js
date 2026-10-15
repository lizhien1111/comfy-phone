/**
 * Cloudflare Worker — browser ↔ rest.runpod.io relay (optional).
 *
 * Phone 「API 代理」填: https://<worker>.workers.dev  (无尾斜杠)
 *
 * POST /runpod  Content-Type: application/json
 * { method: "GET"|"POST"|..., path: "/pods/{id}", apiKey: "...", body?: object|null }
 *
 * Also: GET /health
 *
 * API key is forwarded per-request; Worker does not store secrets.
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

export default {
  async fetch(request) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(request) });
    }

    const url = new URL(request.url);
    if (url.pathname === "/" || url.pathname === "/health") {
      return new Response("ok runpod-proxy\n", {
        headers: withCors(request, {
          "content-type": "text/plain; charset=utf-8",
        }),
      });
    }

    if (url.pathname !== "/runpod" || request.method !== "POST") {
      return jsonResp(
        request,
        { ok: false, message: "use POST /runpod { method, path, apiKey, body? }" },
        400
      );
    }

    let data;
    try {
      data = await request.json();
    } catch (e) {
      return jsonResp(request, { ok: false, message: "invalid json" }, 400);
    }

    const method = String((data && data.method) || "GET")
      .trim()
      .toUpperCase();
    const path = String((data && data.path) || "").trim();
    const apiKey = String((data && data.apiKey) || "").trim();
    if (!apiKey) {
      return jsonResp(request, { ok: false, message: "apiKey required" }, 400);
    }
    if (!/^\/pods(\/|$)/.test(path)) {
      return jsonResp(
        request,
        { ok: false, message: "path must start with /pods" },
        400
      );
    }
    if (!/^(GET|POST|PATCH|DELETE)$/.test(method)) {
      return jsonResp(request, { ok: false, message: "bad method" }, 400);
    }

    const target = "https://rest.runpod.io/v1" + path;
    const headers = { Authorization: "Bearer " + apiKey };
    const init = { method, headers };
    if (method !== "GET" && method !== "HEAD" && data.body != null) {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(data.body);
    }

    try {
      const resp = await fetch(target, init);
      const text = await resp.text();
      return new Response(text, {
        status: resp.status,
        headers: withCors(request, {
          "content-type": resp.headers.get("content-type") || "application/json",
        }),
      });
    } catch (e) {
      const msg = e && e.message ? e.message : String(e);
      return jsonResp(request, { ok: false, message: "proxy upstream: " + msg }, 502);
    }
  },
};
