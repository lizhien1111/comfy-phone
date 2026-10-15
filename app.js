(function () {
  const $ = (id) => document.getElementById(id);

  const CLIENT_ID =
    localStorage.getItem("comfy_phone_client_id") ||
    (crypto.randomUUID
      ? crypto.randomUUID()
      : "phone-" + Math.random().toString(36).slice(2) + Date.now());
  localStorage.setItem("comfy_phone_client_id", CLIENT_ID);

  let running = false;
  let lastBlobUrl = null;
  let lastBlob = null;
  let lastFilename = "comfy_phone.png";
  /** @type {WebSocket|null} */
  let activeWs = null;
  let wsHadProgress = false;
  let wsFatalError = null;
  let currentPromptId = null;

  /** Object URLs created for gallery thumbs — revoke on refresh */
  const thumbUrls = [];
  /** @type {Set<string>} */
  const selectedGalleryIds = new Set();
  let lightboxUrl = null;
  let lightboxItem = null;

  /** Durable GitHub / Telegram upload queue pump (UI retired — keep off) */
  const UPLOAD_FEATURES_ENABLED = false;
  let uploadPumpRunning = false;
  let uploadBannerHideTimer = null;
  let uploadSessionDone = 0;
  let uploadSessionFail = 0;
  let uploadSessionTotal = 0;
  let lastUploadedPaths = [];
  let retiredUploadsCleared = false;

  /** Gallery multi-select only active after user taps 「选择」 */
  let gallerySelectMode = false;

  let connectedOk = false;
  let cancelRequested = false;

  /** Imported Comfy API prompt from PNG (full graph mode), or null for Lustify form path */
  let importedApiPrompt = null;
  let importMode = "none"; // none | params | api

  function getBase() {
    const fromBase = ($("baseUrl") && $("baseUrl").value) || "";
    const fromBoot = ($("bootUrl") && $("bootUrl").value) || "";
    const raw = (fromBase || fromBoot || "").trim().replace(/\/+$/, "");
    return raw;
  }

  function syncUrlFields(fromId) {
    const src = $(fromId);
    if (!src) return;
    const v = (src.value || "").trim();
    if ($("baseUrl") && fromId !== "baseUrl") $("baseUrl").value = v;
    if ($("bootUrl") && fromId !== "bootUrl") $("bootUrl").value = v;
  }

  function showPage(which) {
    const boot = $("pageBoot");
    const app = $("pageApp");
    if (!boot || !app) return;
    const goApp = which === "app";
    boot.hidden = goApp;
    app.hidden = !goApp;
    try {
      localStorage.setItem("comfy_phone_page", goApp ? "app" : "boot");
    } catch (e) {}
    if (goApp) {
      // ensure gallery renders when first entering app
      try {
        if (typeof renderGallery === "function") renderGallery();
      } catch (e) {}
    }
  }

  function requireBase() {
    const base = getBase();
    if (!base) {
      throw new Error("请先填写服务器地址");
    }
    try {
      const u = new URL(base);
      if (u.protocol !== "http:" && u.protocol !== "https:") {
        throw new Error("地址需以 http:// 或 https:// 开头");
      }
    } catch (e) {
      if (e && e.message && e.message.indexOf("地址") === 0) throw e;
      throw new Error("服务器地址无效");
    }
    return base;
  }

  function apiUrl(path) {
    const base = requireBase();
    if (!path.startsWith("/")) path = "/" + path;
    return base + path;
  }

  /** WS from entered base (supports .../api proxy prefix). */
  function wsUrl() {
    const base = requireBase();
    const u = new URL(base.endsWith("/") ? base : base + "/");
    u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
    let path = u.pathname.replace(/\/+$/, "");
    u.pathname = (path || "") + "/ws";
    u.search = "";
    u.hash = "";
    u.searchParams.set("clientId", CLIENT_ID);
    return u.toString();
  }

  function setConnStatus(text, kind) {
    const cls = "conn" + (kind ? " conn--" + kind : "");
    const el = $("connStatus");
    if (el) {
      el.textContent = text;
      el.className = cls;
    }
    const boot = $("bootConnStatus");
    if (boot) {
      boot.textContent = text;
      boot.className = cls;
    }
  }

  async function connectComfy() {
    let base;
    try {
      base = requireBase();
    } catch (e) {
      connectedOk = false;
      setConnStatus("失败: " + e.message, "err");
      return false;
    }
    localStorage.setItem("comfy_phone_base", base);
    setConnStatus("连接中…", "run");
    try {
      const res = await fetch(base + "/system_stats", {
        method: "GET",
        mode: "cors",
      });
      if (!res.ok) throw new Error("HTTP " + res.status);
      const data = await res.json().catch(() => ({}));
      const name =
        data &&
        data.devices &&
        data.devices[0] &&
        (data.devices[0].name || data.devices[0].type);
      connectedOk = true;
      setConnStatus(
        "已连接" + (name ? " · " + name : "") + " · " + base.replace(/^https?:\/\//, ""),
        "ok"
      );
      return true;
    } catch (e) {
      connectedOk = false;
      const msg = e && e.message ? e.message : String(e);
      const corsHint =
        /Failed to fetch|NetworkError|CORS|cross-origin/i.test(msg) ||
        msg === "Failed to fetch"
          ? "（多半是 CORS：请开 Comfy CORS 或用 cors_proxy.py / 反代）"
          : "";
      setConnStatus("失败: " + msg + corsHint, "err");
      return false;
    }
  }

  function setStatus(text, kind) {
    const el = $("status");
    el.textContent = text;
    el.className = "status" + (kind ? " status--" + kind : "");
  }

  function setBusy(busy) {
    running = busy;
    $("btnGen").disabled = busy;
    if ($("btnCancel")) $("btnCancel").disabled = !busy;
    $("btnSave").disabled = busy || !lastBlob;
  }

  function randomSeed() {
    return Math.floor(Math.random() * 2 ** 32);
  }

  function closeWs() {
    if (activeWs) {
      try {
        activeWs.onopen = null;
        activeWs.onmessage = null;
        activeWs.onerror = null;
        activeWs.onclose = null;
        if (
          activeWs.readyState === WebSocket.OPEN ||
          activeWs.readyState === WebSocket.CONNECTING
        ) {
          activeWs.close();
        }
      } catch (e) {}
      activeWs = null;
    }
  }

  function handleWsMessage(ev) {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch (e) {
      return;
    }
    const type = msg.type;
    const data = msg.data || {};

    if (
      data.prompt_id &&
      currentPromptId &&
      data.prompt_id !== currentPromptId &&
      type !== "status"
    ) {
      return;
    }

    if (type === "progress") {
      wsHadProgress = true;
      const value = data.value != null ? data.value : 0;
      const max = data.max != null ? data.max : 0;
      if (max > 0) setStatus("出图中 " + value + "/" + max + " 步", "run");
      else setStatus("出图中…", "run");
      return;
    }

    if (type === "executing") {
      if (data.node == null) {
        if (!wsHadProgress) setStatus("出图中…", "run");
        return;
      }
      if (!wsHadProgress) setStatus("执行节点 " + data.node + "…", "run");
      return;
    }

    if (type === "execution_cached") {
      if (!wsHadProgress) setStatus("排队中（缓存节点）…", "run");
      return;
    }

    if (type === "execution_start") {
      setStatus("出图中…", "run");
      return;
    }

    if (type === "status") {
      const exec = (data.status && data.status.exec_info) || {};
      const q = exec.queue_remaining;
      if (typeof q === "number" && q > 1 && !wsHadProgress) {
        setStatus("排队中（队列 " + q + "）…", "run");
      }
      return;
    }

    if (type === "execution_error") {
      const reason =
        data.exception_message ||
        data.message ||
        (data.node_id != null ? "节点 " + data.node_id : "") ||
        "execution_error";
      wsFatalError = String(reason).slice(0, 180);
      setStatus("失败: " + wsFatalError, "err");
    }
  }

  function openProgressWs() {
    closeWs();
    let ws;
    try {
      ws = new WebSocket(wsUrl());
    } catch (e) {
      return false;
    }
    activeWs = ws;
    ws.onmessage = handleWsMessage;
    ws.onerror = function () {};
    ws.onclose = function () {
      if (activeWs === ws) activeWs = null;
    };
    return true;
  }

  async function postPrompt(workflow) {
    const res = await fetch(apiUrl("/prompt"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: workflow, client_id: CLIENT_ID }),
    });
    if (!res.ok) {
      const t = await res.text().catch(() => "");
      throw new Error("POST /prompt 失败 " + res.status + " " + t.slice(0, 200));
    }
    const data = await res.json();
    if (data.error) {
      throw new Error(
        typeof data.error === "string"
          ? data.error
          : JSON.stringify(data.error)
      );
    }
    if (!data.prompt_id) throw new Error("无 prompt_id: " + JSON.stringify(data));
    return data.prompt_id;
  }

  async function pollHistory(promptId, onTick) {
    const maxTries = 600;
    for (let i = 0; i < maxTries; i++) {
      if (cancelRequested || !running) throw new Error("已取消");
      if (wsFatalError) throw new Error(wsFatalError);
      onTick && onTick(i);
      let hist;
      try {
        const res = await fetch(apiUrl("/history/" + promptId));
        if (!res.ok) {
          await sleep(2000);
          continue;
        }
        hist = await res.json();
      } catch (e) {
        await sleep(2000);
        continue;
      }
      if (hist && hist[promptId]) {
        const entry = hist[promptId];
        const st = entry.status || {};
        if (st.status_str === "error") {
          const msgs = (st.messages || [])
            .map((m) => (typeof m === "string" ? m : JSON.stringify(m)))
            .join("; ");
          throw new Error((msgs || "error").slice(0, 180));
        }
        const outputs = entry.outputs || {};
        for (const key of Object.keys(outputs)) {
          const imgs = outputs[key].images || [];
          if (imgs.length) return imgs[0];
        }
        if (st.completed) {
          await sleep(500);
          continue;
        }
      }
      await sleep(2000);
    }
    throw new Error("超时：长时间无结果");
  }

  function viewUrl(img) {
    const q = new URLSearchParams({
      filename: img.filename,
      subfolder: img.subfolder || "",
      type: img.type || "output",
    });
    return apiUrl("/view?" + q.toString());
  }

  async function fetchImageBlob(img) {
    const url = viewUrl(img);
    const res = await fetch(url);
    if (!res.ok) throw new Error("取图失败 " + res.status);
    return { blob: await res.blob(), url, filename: img.filename };
  }

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  function showImage(blob, filename) {
    if (lastBlobUrl) URL.revokeObjectURL(lastBlobUrl);
    lastBlob = blob;
    lastBlobUrl = URL.createObjectURL(blob);
    lastFilename = filename || "comfy_phone.png";
    const img = $("preview");
    img.src = lastBlobUrl;
    img.hidden = false;
    $("placeholder").hidden = true;
    const box = document.querySelector(".preview-box");
    if (box) box.classList.add("has-image");
    $("btnSave").disabled = false;
  }


  const LS_SAVE_GH = "comfy_phone_save_github";
  const LS_GH_TOKEN = "comfy_phone_gh_token";
  const LS_GH_REPO = "comfy_phone_gh_repo";
  const DEFAULT_GH_REPO = "lizhien1111/comfy-phone-gallery";

  function blobToBase64(blob) {
    return new Promise(function (resolve, reject) {
      const reader = new FileReader();
      reader.onload = function () {
        const dataUrl = String(reader.result || "");
        const i = dataUrl.indexOf(",");
        resolve(i >= 0 ? dataUrl.slice(i + 1) : dataUrl);
      };
      reader.onerror = function () {
        reject(reader.error || new Error("read failed"));
      };
      reader.readAsDataURL(blob);
    });
  }

  function pad2(n) {
    return String(n).padStart(2, "0");
  }

  function galleryDatePath(d) {
    d = d || new Date();
    return (
      d.getFullYear() +
      "-" +
      pad2(d.getMonth() + 1) +
      "-" +
      pad2(d.getDate())
    );
  }

  function sanitizeFilename(name) {
    name = (name || "comfy_phone.png").replace(/[^a-zA-Z0-9._-]+/g, "_");
    if (!/\.png$/i.test(name)) name += ".png";
    return name;
  }

  function syncGhSettingsUi() {
    const chk = $("chkSaveGithub");
    const panel = $("ghSettings");
    if (!chk || !panel) return;
    panel.hidden = !chk.checked;
  }

  function loadGhSettings() {
    const chk = $("chkSaveGithub");
    if (chk) {
      chk.checked = localStorage.getItem(LS_SAVE_GH) === "1";
    }
    const tok = $("ghToken");
    if (tok) tok.value = localStorage.getItem(LS_GH_TOKEN) || "";
    const repo = $("ghRepo");
    if (repo) {
      repo.value =
        localStorage.getItem(LS_GH_REPO) || DEFAULT_GH_REPO;
      if (!repo.value) repo.placeholder = DEFAULT_GH_REPO;
    }
    syncGhSettingsUi();
  }

  function persistGhSettings() {
    const chk = $("chkSaveGithub");
    if (chk) {
      localStorage.setItem(LS_SAVE_GH, chk.checked ? "1" : "0");
    }
    const tok = $("ghToken");
    if (tok) {
      const v = (tok.value || "").trim();
      if (v) localStorage.setItem(LS_GH_TOKEN, v);
      else localStorage.removeItem(LS_GH_TOKEN);
    }
    const repo = $("ghRepo");
    if (repo) {
      const v = (repo.value || "").trim() || DEFAULT_GH_REPO;
      localStorage.setItem(LS_GH_REPO, v);
      repo.value = v;
    }
    syncGhSettingsUi();
  }

  const LS_SAVE_TG = "comfy_phone_save_telegram";
  const LS_TG_TOKEN = "comfy_phone_telegram_bot_token";
  const LS_TG_CHAT = "comfy_phone_telegram_chat_id";
  const LS_TG_PROXY = "comfy_phone_telegram_proxy";
  /** Placeholder suggestion only — never treat as hard-coded default in logic */
  const TG_CHAT_PLACEHOLDER = "5407949298";
  const TG_PHOTO_MAX = 10 * 1024 * 1024;
  const TG_API_DIRECT = "https://api.telegram.org";

  function syncTgSettingsUi() {
    const chk = $("chkSaveTelegram");
    const panel = $("tgSettings");
    if (!chk || !panel) return;
    panel.hidden = !chk.checked;
  }

  function loadTgSettings() {
    const chk = $("chkSaveTelegram");
    if (chk) {
      chk.checked = localStorage.getItem(LS_SAVE_TG) === "1";
    }
    const tok = $("tgToken");
    if (tok) tok.value = localStorage.getItem(LS_TG_TOKEN) || "";
    const chat = $("tgChatId");
    if (chat) {
      chat.value = localStorage.getItem(LS_TG_CHAT) || "";
      chat.placeholder = TG_CHAT_PLACEHOLDER;
    }
    const proxy = $("tgProxy");
    if (proxy) proxy.value = localStorage.getItem(LS_TG_PROXY) || "";
    syncTgSettingsUi();
  }

  function persistTgSettings() {
    const chk = $("chkSaveTelegram");
    if (chk) {
      localStorage.setItem(LS_SAVE_TG, chk.checked ? "1" : "0");
    }
    const tok = $("tgToken");
    if (tok) {
      const v = (tok.value || "").trim();
      if (v) localStorage.setItem(LS_TG_TOKEN, v);
      else localStorage.removeItem(LS_TG_TOKEN);
    }
    const chat = $("tgChatId");
    if (chat) {
      const v = (chat.value || "").trim();
      if (v) localStorage.setItem(LS_TG_CHAT, v);
      else localStorage.removeItem(LS_TG_CHAT);
    }
    const proxy = $("tgProxy");
    if (proxy) {
      let v = (proxy.value || "").trim().replace(/\/+$/, "");
      if (v) localStorage.setItem(LS_TG_PROXY, v);
      else localStorage.removeItem(LS_TG_PROXY);
      proxy.value = v;
    }
    syncTgSettingsUi();
  }

  function getTgToken() {
    return (
      (($("tgToken") && $("tgToken").value) ||
        localStorage.getItem(LS_TG_TOKEN) ||
        "")
    ).trim();
  }

  function getTgChatId() {
    return (
      (($("tgChatId") && $("tgChatId").value) ||
        localStorage.getItem(LS_TG_CHAT) ||
        "")
    ).trim();
  }

  /** Optional Cloudflare Worker / self-host relay base (no trailing slash). */
  function getTgProxyBase() {
    return (
      (($("tgProxy") && $("tgProxy").value) ||
        localStorage.getItem(LS_TG_PROXY) ||
        "")
    )
      .trim()
      .replace(/\/+$/, "");
  }

  function tgApiBase() {
    return getTgProxyBase() || TG_API_DIRECT;
  }

  function tgApiUrl(method) {
    const token = getTgToken();
    return tgApiBase() + "/bot" + token + "/" + method;
  }

  function normalizeTgNetworkError(msg) {
    const m = String(msg || "");
    const low = m.toLowerCase();
    if (
      low.indexOf("failed to fetch") >= 0 ||
      low.indexOf("networkerror") >= 0 ||
      low.indexOf("load failed") >= 0 ||
      low.indexOf("network request failed") >= 0
    ) {
      if (!getTgProxyBase()) {
        return (
          "连不上 api.telegram.org（国内常见）。请在设置填 Cloudflare Worker 代理，见仓库 workers/"
        );
      }
      return "代理也连不上：" + m.slice(0, 100);
    }
    return m.slice(0, 160);
  }

  async function testTelegramConnection() {
    persistTgSettings();
    const token = getTgToken();
    if (!token) {
      setStatus("请先填写 Bot Token", "err");
      return;
    }
    setStatus("正在测试 Telegram…", "");
    try {
      const res = await fetch(tgApiUrl("getMe"), { method: "GET", mode: "cors" });
      let data = null;
      try {
        data = await res.json();
      } catch (e) {}
      if (res.ok && data && data.ok && data.result) {
        const u = data.result.username || data.result.first_name || "bot";
        const via = getTgProxyBase() ? "经代理" : "直连";
        setStatus("Telegram 通（" + via + "）· @" + u, "ok");
        return;
      }
      const detail =
        (data && data.description) || "HTTP " + res.status;
      setStatus("Telegram 失败: " + String(detail).slice(0, 160), "err");
    } catch (e) {
      setStatus(
        "Telegram 失败: " +
          normalizeTgNetworkError(e && e.message ? e.message : String(e)),
        "err"
      );
    }
  }

  function blobToBase64(blob) {
    return new Promise(function (resolve, reject) {
      const reader = new FileReader();
      reader.onload = function () {
        const s = String(reader.result || "");
        const i = s.indexOf(",");
        resolve(i >= 0 ? s.slice(i + 1) : s);
      };
      reader.onerror = function () {
        reject(reader.error || new Error("read failed"));
      };
      reader.readAsDataURL(blob);
    });
  }

  async function uploadBlobToTelegramWithMeta(blob, filename, caption) {
    if (!blob) return { ok: false, error: "no blob" };
    const token = getTgToken();
    const chatId = getTgChatId();
    if (!token) return { ok: false, error: "no telegram token" };
    if (!chatId) return { ok: false, error: "no chat id" };
    const safeName = sanitizeFilename(filename);
    const cap = (caption || safeName || "").slice(0, 1024);
    const proxyBase = getTgProxyBase();

    async function sendViaProxyJson(method, field) {
      const file_b64 = await blobToBase64(blob);
      const res = await fetch(proxyBase + "/tg", {
        method: "POST",
        mode: "cors",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          token: token,
          method: method,
          chat_id: chatId,
          field: field,
          filename: safeName,
          file_b64: file_b64,
          caption: cap,
        }),
      });
      let detail = "HTTP " + res.status;
      let data = null;
      try {
        data = await res.json();
        if (data && data.description) detail = String(data.description).slice(0, 160);
        else if (data && data.ok === false) detail = "Telegram rejected";
      } catch (e) {}
      return { res: res, data: data, detail: detail };
    }

    async function sendDirect(method, field) {
      const fd = new FormData();
      fd.append("chat_id", chatId);
      fd.append(field, blob, safeName);
      if (cap) fd.append("caption", cap);
      const res = await fetch(tgApiUrl(method), { method: "POST", body: fd, mode: "cors" });
      let detail = "HTTP " + res.status;
      let data = null;
      try {
        data = await res.json();
        if (data && data.description) detail = String(data.description).slice(0, 160);
        else if (data && data.ok === false) detail = "Telegram rejected";
      } catch (e) {}
      return { res: res, data: data, detail: detail };
    }

    const send = proxyBase ? sendViaProxyJson : sendDirect;
    try {
      const tooBigForPhoto = (blob.size || 0) > TG_PHOTO_MAX;
      if (!tooBigForPhoto) {
        const r = await send("sendPhoto", "photo");
        if (r.res.ok && r.data && r.data.ok) {
          return { ok: true, via: "photo" };
        }
        const d = (r.detail || "").toLowerCase();
        const sizeFail =
          r.res.status === 413 ||
          d.indexOf("too big") >= 0 ||
          d.indexOf("too large") >= 0 ||
          d.indexOf("file is too big") >= 0 ||
          d.indexOf("photo_invalid_dimensions") >= 0;
        if (!sizeFail) {
          return { ok: false, error: r.detail };
        }
      }
      const r2 = await send("sendDocument", "document");
      if (r2.res.ok && r2.data && r2.data.ok) {
        return { ok: true, via: "document" };
      }
      return { ok: false, error: r2.detail };
    } catch (e) {
      const msg = e && e.message ? e.message : String(e);
      return { ok: false, error: normalizeTgNetworkError(msg) };
    }
  }

  async function uploadBlobToGithub(blob, filename, { quiet } = {}) {
    if (!blob) return false;
    const tokenEl = $("ghToken");
    const token = (
      (tokenEl && tokenEl.value) ||
      localStorage.getItem(LS_GH_TOKEN) ||
      ""
    ).trim();
    if (!token) {
      if (!quiet) setStatus("存入仓库需要 Token（勾选存入仓库并填写）", "err");
      return false;
    }
    let repo = (
      ($("ghRepo") && $("ghRepo").value) ||
      localStorage.getItem(LS_GH_REPO) ||
      DEFAULT_GH_REPO
    ).trim();
    if (!repo) repo = DEFAULT_GH_REPO;
    const parts = repo.split("/");
    if (parts.length !== 2 || !parts[0] || !parts[1]) {
      if (!quiet) setStatus("仓库名无效，应为 owner/repo", "err");
      return false;
    }
    const owner = parts[0];
    const repoName = parts[1];
    const safeName = sanitizeFilename(filename);
    const ts = Date.now();
    const day = galleryDatePath(new Date());
    const path = "gallery/" + day + "/" + ts + "-" + safeName;
    const api =
      "https://api.github.com/repos/" +
      encodeURIComponent(owner) +
      "/" +
      encodeURIComponent(repoName) +
      "/contents/" +
      path
        .split("/")
        .map(encodeURIComponent)
        .join("/");
    try {
      const content = await blobToBase64(blob);
      const res = await fetch(api, {
        method: "PUT",
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: "Bearer " + token,
          "Content-Type": "application/json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
        body: JSON.stringify({
          message: "gallery: " + safeName,
          content: content,
          branch: "main",
        }),
      });
      if (!res.ok) {
        let detail = "HTTP " + res.status;
        try {
          const err = await res.json();
          if (err && err.message) detail = String(err.message).slice(0, 160);
        } catch (e) {}
        if (!quiet) setStatus("存入仓库失败: " + detail, "err");
        return false;
      }
      if (!quiet) setStatus("已存入仓库 · " + path, "ok");
      return true;
    } catch (e) {
      const msg = e && e.message ? e.message : String(e);
      if (!quiet) setStatus("存入仓库失败: " + msg.slice(0, 160), "err");
      return false;
    }
  }

  function getGhToken() {
    return (
      (($("ghToken") && $("ghToken").value) ||
        localStorage.getItem(LS_GH_TOKEN) ||
        "")
    ).trim();
  }

  function getGhRepo() {
    let repo = (
      ($("ghRepo") && $("ghRepo").value) ||
      localStorage.getItem(LS_GH_REPO) ||
      DEFAULT_GH_REPO
    ).trim();
    if (!repo) repo = DEFAULT_GH_REPO;
    return repo;
  }

  function ensureUploadBanner() {
    let el = $("uploadBanner");
    if (el) return el;
    el = document.createElement("div");
    el.id = "uploadBanner";
    el.className = "upload-banner";
    el.hidden = true;
    el.innerHTML =
      '<div class="upload-banner-inner">' +
      '<div class="upload-banner-text" id="uploadBannerText">上传</div>' +
      '<div class="upload-banner-bar"><div class="upload-banner-fill" id="uploadBannerFill"></div></div>' +
      '<div class="upload-banner-actions">' +
      '<button type="button" class="btn btn-ghost" id="btnUploadRetry" hidden style="min-height:36px;padding:0 10px;font-size:0.8rem;width:auto;margin:0">重试失败</button>' +
      '<button type="button" class="btn btn-ghost" id="btnUploadDismiss" style="min-height:36px;padding:0 10px;font-size:0.8rem;width:auto;margin:0">关闭</button>' +
      '<a class="upload-banner-link" id="uploadBannerLink" href="https://github.com/lizhien1111/comfy-phone-gallery" target="_blank" rel="noopener">在 GitHub 看图</a>' +
      "</div></div>";
    document.body.appendChild(el);
    const retry = $("btnUploadRetry");
    if (retry) {
      retry.addEventListener("click", () => {
        if (!UPLOAD_FEATURES_ENABLED) return;
        const G = window.ComfyPhoneGallery;
        if (!G) return;
        G.retryFailedUploads()
          .then(() => kickUploadPump())
          .catch((e) => console.error(e));
      });
    }
    const dismiss = $("btnUploadDismiss");
    if (dismiss) {
      dismiss.addEventListener("click", () => {
        clearRetiredUploadJobs()
          .then(() => {
            el.hidden = true;
            setStatus("已关闭上传提示", "ok");
          })
          .catch((e) => console.error(e));
      });
    }
    return el;
  }

  function updateUploadBanner(state) {
    const el = ensureUploadBanner();
    const textEl = $("uploadBannerText");
    const fill = $("uploadBannerFill");
    const retry = $("btnUploadRetry");
    const link = $("uploadBannerLink");
    const pending = state.pending || 0;
    const uploading = state.uploading || 0;
    const errors = state.errors || 0;
    const current = state.currentName || "";
    const done = state.done || 0;
    const total = state.total || 0;
    const dest = state.dest || "github";
    const lastError = (state.lastError || "").trim();
    const label = dest === "telegram" ? "发到 Telegram" : "存入仓库";
    const active = pending + uploading + errors > 0;
    if (!UPLOAD_FEATURES_ENABLED || (!active && done === 0)) {
      el.hidden = true;
      return;
    }
    el.hidden = false;
    el.classList.toggle("upload-banner--err", errors > 0 && pending + uploading === 0);
    el.classList.toggle("upload-banner--ok", !active && errors === 0 && done > 0);
    let msg;
    if (uploading || pending) {
      const finished = Math.max(0, total - pending - uploading);
      msg =
        label +
        " " +
        finished +
        "/" +
        total +
        (current ? " · " + current : "") +
        (document.hidden ? " · 后台排队中" : " · 上传中");
      if (errors) msg += " · 失败 " + errors;
      if (errors && lastError) msg += " · " + lastError;
    } else if (errors) {
      msg =
        label +
        "完成：成功 " +
        done +
        " · 失败 " +
        errors +
        (lastError ? " · " + lastError : "") +
        "（可点重试）";
    } else if (dest === "telegram") {
      msg = "已发到 Telegram " + done + " 张 · 打开 @vrenybot 私聊可看";
    } else {
      msg = "已存入仓库 " + done + " 张 · 可在 GitHub 仓库 README 看图";
    }
    if (textEl) textEl.textContent = msg;
    if (fill) {
      const pct = total > 0 ? Math.round(((total - pending - uploading) / total) * 100) : 0;
      fill.style.width = Math.max(0, Math.min(100, pct)) + "%";
    }
    if (link) {
      if (dest === "telegram") {
        link.href = "https://t.me/vrenybot";
        link.textContent = "打开 Telegram";
      } else {
        link.href = "https://github.com/lizhien1111/comfy-phone-gallery";
        link.textContent = "在 GitHub 看图";
      }
    }
    if (retry) retry.hidden = !(UPLOAD_FEATURES_ENABLED && errors > 0 && pending + uploading === 0);
    if (link) link.hidden = !UPLOAD_FEATURES_ENABLED;
    // Auto-hide success quickly; also dismiss stuck error banners (telegram leftovers)
    if (!active || (errors > 0 && pending + uploading === 0)) {
      if (uploadBannerHideTimer) clearTimeout(uploadBannerHideTimer);
      const delay = errors > 0 ? 2500 : 8000;
      uploadBannerHideTimer = setTimeout(() => {
        if (!el) return;
        if (errors > 0 && pending + uploading === 0) {
          clearRetiredUploadJobs().catch(() => {});
        }
        if (!uploadPumpRunning) el.hidden = true;
      }, delay);
    } else if (uploadBannerHideTimer) {
      clearTimeout(uploadBannerHideTimer);
      uploadBannerHideTimer = null;
    }
  }

  async function refreshUploadBannerFromDb() {
    const G = window.ComfyPhoneGallery;
    if (!G || !G.listUploads) return;
    const all = await G.listUploads();
    const pending = all.filter((x) => x.status === "pending").length;
    const uploading = all.filter((x) => x.status === "uploading").length;
    const errors = all.filter((x) => x.status === "error").length;
    const cur =
      all.find((x) => x.status === "uploading") ||
      all.find((x) => x.status === "pending") ||
      all.find((x) => x.status === "error");
    const errRow = all
      .filter((x) => x.status === "error" && x.error)
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))[0];
    const total =
      uploadSessionTotal ||
      pending + uploading + errors + uploadSessionDone;
    updateUploadBanner({
      pending,
      uploading,
      errors,
      currentName: cur ? cur.filename : "",
      done: uploadSessionDone,
      total,
      dest: cur && cur.dest === "telegram" ? "telegram" : "github",
      lastError: errRow ? String(errRow.error).slice(0, 120) : "",
    });
  }

  /**
   * Enqueue blob(s) for durable GitHub upload. Survives app switch via IndexedDB.
   * Returns number enqueued (0 if skipped / no token).
   */
  async function enqueueGithubUploads(items, { requireTokenUi } = {}) {
    const G = window.ComfyPhoneGallery;
    if (!G || !G.enqueueUpload) return 0;
    const list = (items || []).filter((x) => x && x.blob);
    if (!list.length) return 0;
    const tok = getGhToken();
    if (!tok) {
      if (requireTokenUi) {
        const chk = $("chkSaveGithub");
        if (chk) chk.checked = true;
        syncGhSettingsUi();
        setStatus("请先填写 GitHub Token，再点存入仓库", "err");
      }
      return 0;
    }
    persistGhSettings();
    let n = 0;
    for (const it of list) {
      await G.enqueueUpload({
        blob: it.blob,
        filename: it.filename || "comfy_phone.png",
        galleryId: it.id || it.galleryId || null,
        dest: "github",
      });
      n++;
    }
    uploadSessionTotal += n;
    await refreshUploadBannerFromDb();
    kickUploadPump();
    return n;
  }

  async function enqueueTelegramUploads(items, { requireTokenUi } = {}) {
    const G = window.ComfyPhoneGallery;
    if (!G || !G.enqueueUpload) return 0;
    const list = (items || []).filter((x) => x && x.blob);
    if (!list.length) return 0;
    const tok = getTgToken();
    const chat = getTgChatId();
    if (!tok || !chat) {
      if (requireTokenUi) {
        const chk = $("chkSaveTelegram");
        if (chk) chk.checked = true;
        syncTgSettingsUi();
        if (!tok) setStatus("请先填写 Telegram Bot Token，再点发到 Telegram", "err");
        else setStatus("请填写 Chat ID（可参考占位 " + TG_CHAT_PLACEHOLDER + "）", "err");
      }
      return 0;
    }
    persistTgSettings();
    let n = 0;
    for (const it of list) {
      const fname = it.filename || "comfy_phone.png";
      await G.enqueueUpload({
        blob: it.blob,
        filename: fname,
        galleryId: it.id || it.galleryId || null,
        dest: "telegram",
        caption: it.caption || fname,
      });
      n++;
    }
    uploadSessionTotal += n;
    await refreshUploadBannerFromDb();
    kickUploadPump();
    return n;
  }

  /**
   * When auto-save checkbox on: queue upload (non-blocking). Returns true if queued.
   */
  async function maybeUploadToGithub(blob, filename) {
    const chk = $("chkSaveGithub");
    if (!chk || !chk.checked) return false;
    const n = await enqueueGithubUploads([{ blob, filename }], { requireTokenUi: true });
    return n > 0;
  }

  async function maybeUploadToTelegram(blob, filename) {
    const chk = $("chkSaveTelegram");
    if (!chk || !chk.checked) return false;
    const n = await enqueueTelegramUploads([{ blob, filename, caption: filename }], {
      requireTokenUi: true,
    });
    return n > 0;
  }

  async function uploadBlobToGithubWithMeta(blob, filename) {
    // Same as uploadBlobToGithub but returns {ok, path, error}
    if (!blob) return { ok: false, error: "no blob" };
    const token = getGhToken();
    if (!token) return { ok: false, error: "no token" };
    let repo = getGhRepo();
    const parts = repo.split("/");
    if (parts.length !== 2 || !parts[0] || !parts[1]) {
      return { ok: false, error: "仓库名无效" };
    }
    const owner = parts[0];
    const repoName = parts[1];
    const safeName = sanitizeFilename(filename);
    const ts = Date.now();
    const day = galleryDatePath(new Date());
    const path = "gallery/" + day + "/" + ts + "-" + safeName;
    const api =
      "https://api.github.com/repos/" +
      encodeURIComponent(owner) +
      "/" +
      encodeURIComponent(repoName) +
      "/contents/" +
      path
        .split("/")
        .map(encodeURIComponent)
        .join("/");
    try {
      const content = await blobToBase64(blob);
      const res = await fetch(api, {
        method: "PUT",
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: "Bearer " + token,
          "Content-Type": "application/json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
        body: JSON.stringify({
          message: "gallery: " + safeName,
          content: content,
          branch: "main",
        }),
      });
      if (!res.ok) {
        let detail = "HTTP " + res.status;
        try {
          const err = await res.json();
          if (err && err.message) detail = String(err.message).slice(0, 160);
        } catch (e) {}
        return { ok: false, error: detail, path };
      }
      return { ok: true, path };
    } catch (e) {
      const msg = e && e.message ? e.message : String(e);
      return { ok: false, error: msg.slice(0, 160) };
    }
  }

  async function putGithubFile(path, textContent, message) {
    const token = getGhToken();
    if (!token) return false;
    const repo = getGhRepo();
    const parts = repo.split("/");
    if (parts.length !== 2) return false;
    const owner = parts[0];
    const repoName = parts[1];
    const api =
      "https://api.github.com/repos/" +
      encodeURIComponent(owner) +
      "/" +
      encodeURIComponent(repoName) +
      "/contents/" +
      path
        .split("/")
        .map(encodeURIComponent)
        .join("/");
    let sha = null;
    try {
      const getRes = await fetch(api + "?ref=main", {
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: "Bearer " + token,
          "X-GitHub-Api-Version": "2022-11-28",
        },
      });
      if (getRes.ok) {
        const j = await getRes.json();
        sha = j && j.sha;
      }
    } catch (e) {}
    const body = {
      message: message || ("update " + path),
      content: btoa(unescape(encodeURIComponent(textContent))),
      branch: "main",
    };
    if (sha) body.sha = sha;
    const res = await fetch(api, {
      method: "PUT",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: "Bearer " + token,
        "Content-Type": "application/json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      body: JSON.stringify(body),
    });
    return res.ok;
  }

  async function refreshGalleryReadmeIndex() {
    const token = getGhToken();
    if (!token) return;
    const repo = getGhRepo();
    const parts = repo.split("/");
    if (parts.length !== 2) return;
    const owner = parts[0];
    const repoName = parts[1];
    try {
      const treeRes = await fetch(
        "https://api.github.com/repos/" +
          encodeURIComponent(owner) +
          "/" +
          encodeURIComponent(repoName) +
          "/git/trees/main?recursive=1",
        {
          headers: {
            Accept: "application/vnd.github+json",
            Authorization: "Bearer " + token,
            "X-GitHub-Api-Version": "2022-11-28",
          },
        }
      );
      if (!treeRes.ok) return;
      const tree = await treeRes.json();
      const pngs = (tree.tree || [])
        .filter((t) => t.type === "blob" && /\.png$/i.test(t.path || ""))
        .map((t) => t.path)
        .sort()
        .reverse();
      const latest = pngs.slice(0, 40);
      const lines = [];
      lines.push("# comfy-phone-gallery");
      lines.push("");
      lines.push(
        "手机出图私有图库（从 [vreny](https://lizhien1111.github.io/vreny/) 上传）。"
      );
      lines.push("");
      lines.push("## 怎么看图");
      lines.push("");
      lines.push("1. 用浏览器登录 GitHub 后打开本仓库。");
      lines.push("2. 下面「最近出图」可直接预览；也可点开 `gallery/日期/` 里的 `.png` 文件看大图。");
      lines.push("3. 私有仓库：必须登录后才能看到图片。");
      lines.push("");
      lines.push("## 最近出图");
      lines.push("");
      if (!latest.length) {
        lines.push("_还没有图片_");
      } else {
        lines.push("共 **" + pngs.length + "** 张 · 展示最近 " + latest.length + " 张：");
        lines.push("");
        for (const p of latest) {
          const name = p.split("/").pop();
          lines.push("### `" + name + "`");
          lines.push("");
          lines.push("![](" + p + ")");
          lines.push("");
          lines.push("[打开文件](" + p + ")");
          lines.push("");
        }
      }
      lines.push("---");
      lines.push("");
      lines.push("目录：`gallery/YYYY-MM-DD/{timestamp}-{filename}.png`");
      lines.push("");
      await putGithubFile(
        "README.md",
        lines.join("\n"),
        "docs: refresh gallery README previews (" + latest.length + " images)"
      );
    } catch (e) {
      console.warn("readme refresh failed", e);
    }
  }

  async function clearRetiredUploadJobs() {
    const G = window.ComfyPhoneGallery;
    let n = 0;
    try {
      if (G && G.clearUploadsByDest) {
        n = await G.clearUploadsByDest(["telegram", "github"]);
      } else if (G && G.clearAllUploads) {
        n = await G.clearAllUploads();
      }
    } catch (e) {
      console.warn("clearRetiredUploadJobs", e);
    }
    uploadSessionDone = 0;
    uploadSessionFail = 0;
    uploadSessionTotal = 0;
    lastUploadedPaths = [];
    retiredUploadsCleared = true;
    const el = $("uploadBanner");
    if (el) el.hidden = true;
    return n;
  }

  async function kickUploadPump() {
    if (!UPLOAD_FEATURES_ENABLED) {
      await clearRetiredUploadJobs();
      return;
    }
    const G = window.ComfyPhoneGallery;
    if (!G || !G.listUploads) return;
    if (uploadPumpRunning) {
      await refreshUploadBannerFromDb();
      return;
    }
    uploadPumpRunning = true;
    ensureUploadBanner();
    try {
      await G.resetStuckUploads();
      while (true) {
        const all = await G.listUploads();
        const pending = all.filter((x) => x.status === "pending");
        const uploading = all.filter((x) => x.status === "uploading");
        const errors = all.filter((x) => x.status === "error");
        const total =
          uploadSessionTotal ||
          pending.length + uploading.length + errors.length + uploadSessionDone;
        const peek = uploading[0] || pending[0] || null;
        const peekDest = peek && peek.dest === "telegram" ? "telegram" : "github";
        updateUploadBanner({
          pending: pending.length,
          uploading: uploading.length,
          errors: errors.length,
          currentName: peek ? peek.filename : "",
          done: uploadSessionDone,
          total,
          dest: peekDest,
        });
        if (!pending.length) break;
        const job = pending[0];
        const dest = job.dest === "telegram" ? "telegram" : "github";
        if (dest === "github" && !getGhToken()) {
          setStatus("上传暂停：缺少 GitHub Token", "err");
          // skip github jobs; try telegram next
          const nextTg = pending.find((x) => x.dest === "telegram");
          if (!nextTg) break;
          // move stuck github to error so pump can continue telegram
          await G.updateUpload(job.id, {
            status: "error",
            error: "no github token",
          });
          continue;
        }
        if (dest === "telegram" && (!getTgToken() || !getTgChatId())) {
          setStatus("上传暂停：缺少 Telegram Token 或 Chat ID", "err");
          const nextGh = pending.find((x) => x.dest !== "telegram");
          if (!nextGh) break;
          await G.updateUpload(job.id, {
            status: "error",
            error: "no telegram credentials",
          });
          continue;
        }
        await G.updateUpload(job.id, {
          status: "uploading",
          attempts: (job.attempts || 0) + 1,
          error: null,
        });
        await refreshUploadBannerFromDb();
        let result;
        if (dest === "telegram") {
          result = await uploadBlobToTelegramWithMeta(
            job.blob,
            job.filename || "comfy_phone.png",
            job.caption || job.filename || ""
          );
        } else {
          result = await uploadBlobToGithubWithMeta(
            job.blob,
            job.filename || "comfy_phone.png"
          );
        }
        if (result.ok) {
          if (result.path) lastUploadedPaths.push(result.path);
          await G.deleteUpload(job.id);
          uploadSessionDone++;
          uploadSessionFail = Math.max(0, uploadSessionFail);
        } else {
          const errMsg = result.error || "upload failed";
          await G.updateUpload(job.id, {
            status: "error",
            error: errMsg,
          });
          uploadSessionFail++;
          if (dest === "telegram") {
            setStatus("Telegram: " + String(errMsg).slice(0, 160), "err");
          }
        }
        // brief yield so UI paints; also friendlier to API rate limits
        await new Promise((r) => setTimeout(r, 180));
      }
      const left = await G.listUploads();
      const errLeft = left.filter((x) => x.status === "error").length;
      const pendLeft = left.filter((x) => x.status === "pending" || x.status === "uploading").length;
      await refreshUploadBannerFromDb();
      if (!pendLeft && uploadSessionDone > 0) {
        const hadGh = lastUploadedPaths.length > 0 || left.some((x) => x.dest !== "telegram");
        // Refresh README when any github uploads succeeded this session
        if (lastUploadedPaths.length > 0) {
          await refreshGalleryReadmeIndex();
        }
        if (errLeft === 0) {
          setStatus("上传完成 " + uploadSessionDone + " 张", "ok");
        } else {
          setStatus(
            "上传：成功 " + uploadSessionDone + " / 失败 " + errLeft,
            "err"
          );
        }
      }
    } catch (e) {
      console.error(e);
    } finally {
      uploadPumpRunning = false;
      await refreshUploadBannerFromDb();
    }
  }

  function bindUploadResumeHooks() {
    const kick = () => {
      kickUploadPump().catch((e) => console.error(e));
    };
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) kick();
    });
    window.addEventListener("pageshow", kick);
    window.addEventListener("online", kick);
    window.addEventListener("focus", kick);
  }



  function downloadBlob(blob, filename) {
    const safe = sanitizeFilename(filename || "comfy_phone.png");
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = safe;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  function saveImage() {
    if (!lastBlob) return;
    downloadBlob(lastBlob, lastFilename);
  }

  function formatTime(ts) {
    try {
      const d = new Date(ts);
      const p = (n) => String(n).padStart(2, "0");
      return (
        p(d.getMonth() + 1) +
        "-" +
        p(d.getDate()) +
        " " +
        p(d.getHours()) +
        ":" +
        p(d.getMinutes())
      );
    } catch (e) {
      return "";
    }
  }

  function revokeThumbs() {
    while (thumbUrls.length) {
      try {
        URL.revokeObjectURL(thumbUrls.pop());
      } catch (e) {}
    }
  }

  async function renderGallery() {
    if (!retiredUploadsCleared) {
      clearRetiredUploadJobs().catch((e) => console.error(e));
    }
    const G = window.ComfyPhoneGallery;
    const grid = $("galleryGrid");
    const empty = $("galleryEmpty");
    const meta = $("galleryMeta");
    if (!G || !grid) return;

    let items = [];
    try {
      items = await G.listImages();
    } catch (e) {
      console.error(e);
      meta.textContent = "图库读取失败（浏览器可能禁用了存储）";
      return;
    }

    revokeThumbs();
    grid.innerHTML = "";
    meta.textContent =
      items.length > 0
        ? "本机已存 " + items.length + " 张（最多 " + G.MAX_ITEMS + "）"
        : "本机保存 · 刷新页面还在";

    if (!items.length) {
      empty.hidden = false;
      return;
    }
    empty.hidden = true;

    // drop selection for deleted ids
    const idSet = new Set(items.map((x) => x.id));
    for (const id of Array.from(selectedGalleryIds)) {
      if (!idSet.has(id)) selectedGalleryIds.delete(id);
    }

    grid.classList.toggle("select-mode", gallerySelectMode);

    for (const item of items) {
      const wrap = document.createElement("div");
      wrap.className =
        "gallery-item" +
        (gallerySelectMode && selectedGalleryIds.has(item.id) ? " selected" : "");
      wrap.dataset.id = item.id;
      wrap.title = (item.prompt || item.filename || "").slice(0, 80);

      const btn = document.createElement("button");
      btn.type = "button";
      btn.style.cssText =
        "display:block;width:100%;height:100%;padding:0;border:0;background:transparent;cursor:pointer";
      const img = document.createElement("img");
      img.alt = "缩略图";
      img.loading = "lazy";
      const url = URL.createObjectURL(item.blob);
      thumbUrls.push(url);
      img.src = url;
      btn.appendChild(img);

      if (gallerySelectMode) {
        const chk = document.createElement("input");
        chk.type = "checkbox";
        chk.className = "gallery-check";
        chk.checked = selectedGalleryIds.has(item.id);
        chk.addEventListener("click", (ev) => ev.stopPropagation());
        chk.addEventListener("change", () => {
          if (chk.checked) selectedGalleryIds.add(item.id);
          else selectedGalleryIds.delete(item.id);
          wrap.classList.toggle("selected", chk.checked);
          updateGallerySelMeta();
        });
        btn.addEventListener("click", () => {
          const next = !selectedGalleryIds.has(item.id);
          if (next) selectedGalleryIds.add(item.id);
          else selectedGalleryIds.delete(item.id);
          chk.checked = next;
          wrap.classList.toggle("selected", next);
          updateGallerySelMeta();
        });
        wrap.appendChild(chk);
      } else {
        btn.addEventListener("click", () => openLightbox(item));
      }

      wrap.appendChild(btn);
      grid.appendChild(wrap);
    }
    updateGallerySelMeta();
    syncGallerySelectUi();
  }

  function syncGallerySelectUi() {
    const modeBtn = $("btnGalSelectMode");
    const actions = $("gallerySelectActions");
    if (modeBtn) modeBtn.textContent = gallerySelectMode ? "完成" : "选择";
    if (actions) {
      if (gallerySelectMode) {
        actions.hidden = false;
        actions.style.display = "contents";
      } else {
        actions.hidden = true;
      }
    }
    const grid = $("galleryGrid");
    if (grid) grid.classList.toggle("select-mode", gallerySelectMode);
  }

  async function setGallerySelectMode(on) {
    gallerySelectMode = !!on;
    if (!gallerySelectMode) {
      selectedGalleryIds.clear();
    }
    syncGallerySelectUi();
    await renderGallery();
  }

  function updateGallerySelMeta() {
    const meta = $("galleryMeta");
    if (!meta) return;
    const n = selectedGalleryIds.size;
    const base = meta.textContent.replace(/ · 已选 \d+ 张$/, "").replace(/ · 已勾选 \d+ 张$/, "");
    meta.textContent =
      gallerySelectMode && n > 0 ? base + " · 已选 " + n + " 张" : base;
  }

  async function getSelectedGalleryItems() {
    const G = window.ComfyPhoneGallery;
    if (!G) return [];
    const all = await G.listImages();
    return all.filter((x) => selectedGalleryIds.has(x.id));
  }

  function blobToImageFile(blob, filename) {
    const name = sanitizeFilename(filename || "comfy_phone.png");
    const type = (blob && blob.type) || "image/png";
    return new File([blob], name, { type });
  }

  /**
   * Prefer Web Share Level 2 (files) so iOS/Android show Save Image / 存储到相册.
   * Avoid plain <a download> which dumps into Chrome Downloads via Google UI.
   */
  async function shareImageFiles(files) {
    if (!files || !files.length) return { mode: "none", count: 0 };
    if (typeof navigator !== "undefined" && navigator.share) {
      try {
        if (!navigator.canShare || navigator.canShare({ files })) {
          await navigator.share({ files: files, title: "vreny" });
          return { mode: "share", count: files.length };
        }
      } catch (e) {
        if (e && e.name === "AbortError") return { mode: "abort", count: 0 };
      }
      let shared = 0;
      for (let i = 0; i < files.length; i++) {
        const one = [files[i]];
        try {
          if (navigator.canShare && !navigator.canShare({ files: one })) break;
          await navigator.share({ files: one, title: files[i].name });
          shared++;
        } catch (e) {
          if (e && e.name === "AbortError") {
            return { mode: "abort", count: shared };
          }
          return { mode: "fallback", count: shared, index: i };
        }
      }
      if (shared === files.length) return { mode: "share", count: shared };
      if (shared > 0) return { mode: "fallback", count: shared, index: shared };
    }
    return { mode: "fallback", count: 0, index: 0 };
  }

  async function saveSelectedAlbum() {
    if (!gallerySelectMode) {
      setStatus("请先点「选择」，再勾选图片", "err");
      return;
    }
    const items = await getSelectedGalleryItems();
    if (!items.length) {
      setStatus("请先选择图库里的图片", "err");
      return;
    }
    setStatus("正在打开系统分享 " + items.length + " 张…", "run");
    const files = items.map((item) =>
      blobToImageFile(item.blob, item.filename || "comfy_phone.png")
    );
    const result = await shareImageFiles(files);
    if (result.mode === "share") {
      setStatus(
        "已打开系统分享（" + result.count + " 张）· 请选「存储图像」或「存储到相册」",
        "ok"
      );
      return;
    }
    if (result.mode === "abort") {
      setStatus(
        result.count > 0
          ? "已取消（已分享 " + result.count + " 张）"
          : "已取消",
        ""
      );
      return;
    }
    // Fallback: open first remaining image in lightbox — long-press → 存储图像
    const idx = result.index != null ? result.index : 0;
    const left = items[idx];
    if (left) {
      openLightbox(left);
      setStatus(
        "当前浏览器不支持一键存相册。请长按大图 →「存储图像」" +
          (items.length > 1 ? "（其余请在图库逐张打开）" : ""),
        "err"
      );
    } else {
      setStatus("无法分享，请点开大图后长按保存", "err");
    }
  }

  /** @deprecated alias — kept for any leftover callers */
  async function saveSelectedLocal() {
    return saveSelectedAlbum();
  }

  async function saveSelectedGithub() {
    if (!gallerySelectMode) {
      setStatus("请先点「选择」，再勾选图片", "err");
      return;
    }
    const items = await getSelectedGalleryItems();
    if (!items.length) {
      setStatus("请先选择图库里的图片", "err");
      return;
    }
    uploadSessionDone = 0;
    uploadSessionFail = 0;
    uploadSessionTotal = 0;
    lastUploadedPaths = [];
    const n = await enqueueGithubUploads(items, { requireTokenUi: true });
    if (!n) return;
    setStatus(
      "已加入上传队列 " + n + " 张（可切到别的 App，回来会继续）",
      "run"
    );
  }

  async function saveSelectedTelegram() {
    if (!gallerySelectMode) {
      setStatus("请先点「选择」，再勾选图片", "err");
      return;
    }
    const items = await getSelectedGalleryItems();
    if (!items.length) {
      setStatus("请先选择图库里的图片", "err");
      return;
    }
    uploadSessionDone = 0;
    uploadSessionFail = 0;
    uploadSessionTotal = 0;
    const n = await enqueueTelegramUploads(items, { requireTokenUi: true });
    if (!n) return;
    setStatus(
      "已加入 Telegram 队列 " + n + " 张（可切到别的 App，回来会继续）",
      "run"
    );
  }


  function openLightbox(item) {
    lightboxItem = item;
    if (lightboxUrl) {
      try {
        URL.revokeObjectURL(lightboxUrl);
      } catch (e) {}
    }
    lightboxUrl = URL.createObjectURL(item.blob);
    $("lightboxImg").src = lightboxUrl;
    const bits = [];
    if (item.createdAt) bits.push(formatTime(item.createdAt));
    if (item.seed != null) bits.push("种子 " + item.seed);
    if (item.width && item.height) bits.push(item.width + "×" + item.height);
    if (item.steps) bits.push(item.steps + " 步");
    if (item.prompt) bits.push(item.prompt.slice(0, 120));
    $("lightboxInfo").textContent = bits.join(" · ");
    $("lightbox").hidden = false;
  }

  function closeLightbox() {
    $("lightbox").hidden = true;
    lightboxItem = null;
    if (lightboxUrl) {
      try {
        URL.revokeObjectURL(lightboxUrl);
      } catch (e) {}
      lightboxUrl = null;
    }
    $("lightboxImg").removeAttribute("src");
  }

  async function saveToGallery(meta) {
    const G = window.ComfyPhoneGallery;
    if (!G || !meta.blob) return;
    try {
      await G.addImage(meta);
      await renderGallery();
    } catch (e) {
      console.error("gallery save failed", e);
    }
  }

  async function deleteSelectedGallery() {
    const G = window.ComfyPhoneGallery;
    if (!G) return;
    if (!gallerySelectMode) {
      setStatus("请先选择要删除的图片", "err");
      return;
    }
    const items = await getSelectedGalleryItems();
    if (!items.length) {
      setStatus("请先选择要删除的图片", "err");
      return;
    }
    const n = items.length;
    if (!confirm("确定删除选中的 " + n + " 张？")) return;
    try {
      for (const item of items) {
        await G.deleteImage(item.id);
        selectedGalleryIds.delete(item.id);
      }
      if (lightboxItem && items.some((x) => x.id === lightboxItem.id)) {
        closeLightbox();
      }
      await renderGallery();
      setStatus("已删除 " + n + " 张", "ok");
    } catch (e) {
      alert("删除失败: " + (e && e.message ? e.message : e));
    }
  }



  async function cancelTask() {
    if (!running && !cancelRequested) return;
    cancelRequested = true;
    setStatus("正在取消…", "run");
    try {
      requireBase();
      const headers = { "Content-Type": "application/json" };
      await fetch(apiUrl("/interrupt"), {
        method: "POST",
        headers,
        body: "{}",
        mode: "cors",
      }).catch(function () {});
      await fetch(apiUrl("/queue"), {
        method: "POST",
        headers,
        body: JSON.stringify({ clear: true }),
        mode: "cors",
      }).catch(function () {});
      closeWs();
      setStatus("已取消", "err");
    } catch (e) {
      setStatus("取消失败: " + (e && e.message ? e.message : String(e)), "err");
    }
  }



  async function pullNewImages() {
    if (running) {
      setStatus("出图中，请稍后再拉取", "err");
      return;
    }
    try {
      requireBase();
    } catch (e) {
      setStatus(e.message, "err");
      return;
    }
    setStatus("拉取中…", "run");
    try {
      const ok = await connectComfy();
      if (!ok) throw new Error("未连接成功");

      const res = await fetch(apiUrl("/history"), { mode: "cors" });
      if (!res.ok) throw new Error("读取历史失败 " + res.status);
      const hist = await res.json();

      const G = window.ComfyPhoneGallery;
      let existing = [];
      try {
        existing = G ? await G.listImages() : [];
      } catch (e) {}
      const have = {};
      for (const it of existing) {
        if (it && it.filename) have[it.filename] = true;
      }

      const items = [];
      const ids = Object.keys(hist || {});
      for (const id of ids) {
        const entry = hist[id] || {};
        const st = entry.status || {};
        if (st.status_str && st.status_str !== "success") continue;
        const outputs = entry.outputs || {};
        for (const key of Object.keys(outputs)) {
          const imgs = outputs[key].images || [];
          for (const img of imgs) {
            if (!img || !img.filename) continue;
            if (have[img.filename]) continue;
            items.push({
              img: img,
              promptId: id,
              createdAt: (st.messages && st.messages.length) ? Date.now() : Date.now(),
            });
          }
        }
      }

      // newest filenames tend to sort higher with higher counters; reverse so we process recent first
      items.reverse();

      if (!items.length) {
        setStatus("没有新照片（历史里都已在图库或为空）", "ok");
        await renderGallery();
        return;
      }

      let got = 0;
      let lastBlobLocal = null;
      let lastName = null;
      const maxPull = 30;
      for (let i = 0; i < items.length && got < maxPull; i++) {
        const { img } = items[i];
        setStatus("拉取中… " + (got + 1) + "/" + Math.min(items.length, maxPull), "run");
        try {
          const { blob, filename } = await fetchImageBlob(img);
          await saveToGallery({
            blob,
            filename,
            prompt: "",
            seed: null,
            width: (img.metadata && img.metadata.width) || null,
            height: (img.metadata && img.metadata.height) || null,
            steps: null,
            createdAt: Date.now() - (items.length - i),
          });
          await maybeUploadToGithub(blob, filename);
          await maybeUploadToTelegram(blob, filename);
          have[filename] = true;
          lastBlobLocal = blob;
          lastName = filename;
          got++;
        } catch (e) {
          console.warn("pull skip", img.filename, e);
        }
      }
      if (lastBlobLocal) showImage(lastBlobLocal, lastName || "pulled.png");
      setStatus("已拉取 " + got + " 张新照片到图库", "ok");
    } catch (e) {
      console.error(e);
      setStatus("拉取失败: " + (e && e.message ? e.message : String(e)), "err");
    }
  }

  async function shutdownComfy() {
    try {
      requireBase();
    } catch (e) {
      setStatus(e.message, "err");
      return;
    }
    if (
      !confirm(
        "确定关机 Comfy？会中断当前任务并结束服务，公网页将无法出图，需在实例里重新启动。"
      )
    ) {
      return;
    }
    setStatus("正在关机 Comfy…", "run");
    cancelRequested = true;
    try {
      const ok = await connectComfy();
      if (!ok) throw new Error("未连接成功");
      const headers = { "Content-Type": "application/json" };
      await fetch(apiUrl("/interrupt"), {
        method: "POST",
        headers,
        body: "{}",
        mode: "cors",
      }).catch(function () {});
      await fetch(apiUrl("/queue"), {
        method: "POST",
        headers,
        body: JSON.stringify({ clear: true }),
        mode: "cors",
      }).catch(function () {});
      // Comfy has no official shutdown HTTP API; try common extensions then kill via autodl helper if present
      let shutOk = false;
      const tries = [
        { path: "/shutdown", body: "{}" },
        { path: "/api/shutdown", body: "{}" },
        { path: "/internal/shutdown", body: "{}" },
      ];
      for (const p of tries) {
        try {
          const res = await fetch(apiUrl(p.path), {
            method: "POST",
            headers,
            body: p.body,
            mode: "cors",
          });
          if (res.ok || res.status === 200) {
            shutOk = true;
            break;
          }
        } catch (e) {}
      }
      closeWs();
      connectedOk = false;
      if (shutOk) {
        setStatus("Comfy 已关机", "ok");
        setConnStatus("未连接 · Comfy 已关机", "");
      } else {
        setStatus(
          "已中断并清队列；此 Comfy 无关机接口，请在实例终端执行 pkill 或关 AutoDL",
          "err"
        );
      }
    } catch (e) {
      console.error(e);
      setStatus("关机失败: " + (e && e.message ? e.message : String(e)), "err");
    }
  }


  async function powerOffInstance() {
    // RunPod path: stop via REST when credentials present
    if (getProvider() === "runpod") {
      const key = ($("runpodApiKey") && $("runpodApiKey").value || "").trim() || localStorage.getItem(LS_RP_KEY) || "";
      const pod = ($("runpodPodId") && $("runpodPodId").value || "").trim() || localStorage.getItem(LS_RP_POD) || "";
      if (key && pod) {
        setStatus("正在关 RunPod…", "run");
        const ok = await runpodStopAndConfirm();
        if (ok) setStatus("RunPod 已关机", "ok");
        return;
      }
    }
    try {
      requireBase();
    } catch (e) {
      setStatus(e.message, "err");
      return;
    }
    if (
      !confirm(
        "确定关 AutoDL 实例？会关掉整台机器并停止计费，公网地址失效，下次需在 AutoDL 重新开机。"
      )
    ) {
      return;
    }
    if (!confirm("再确认一次：真的关实例？")) {
      return;
    }
    setStatus("正在关实例…", "run");
    cancelRequested = true;
    try {
      const ok = await connectComfy();
      if (!ok) throw new Error("未连接成功");
      const headers = { "Content-Type": "application/json" };
      await fetch(apiUrl("/interrupt"), {
        method: "POST",
        headers,
        body: "{}",
        mode: "cors",
      }).catch(function () {});
      await fetch(apiUrl("/queue"), {
        method: "POST",
        headers,
        body: JSON.stringify({ clear: true }),
        mode: "cors",
      }).catch(function () {});
      let offOk = false;
      const tries = [
        { path: "/poweroff_instance", body: "{}" },
        { path: "/api/poweroff_instance", body: "{}" },
      ];
      for (const p of tries) {
        try {
          const res = await fetch(apiUrl(p.path), {
            method: "POST",
            headers,
            body: p.body,
            mode: "cors",
          });
          if (res.ok || res.status === 200) {
            offOk = true;
            break;
          }
        } catch (e) {}
      }
      closeWs();
      connectedOk = false;
      if (offOk) {
        setStatus("实例正在关机，公网即将断开", "ok");
        setConnStatus("未连接 · 实例关机中", "");
      } else {
        setStatus(
          "关实例接口不可用；可先「关机 Comfy」，再到 AutoDL 控制台关实例",
          "err"
        );
      }
    } catch (e) {
      console.error(e);
      setStatus("关实例失败: " + (e && e.message ? e.message : String(e)), "err");
    }
  }

  async function cleanComfy() {
    try {
      requireBase();
    } catch (e) {
      setStatus(e.message, "err");
      return;
    }
    if (
      !confirm(
        "清理 Comfy 队列、历史、显存，并删除服务器 output/temp 出图文件？\n不会删模型。"
      )
    ) {
      return;
    }
    setStatus("清理中…", "run");
    try {
      const ok = await connectComfy();
      if (!ok) throw new Error("未连接成功");

      const headers = { "Content-Type": "application/json" };
      const posts = [
        { path: "/interrupt", body: "{}" },
        { path: "/queue", body: JSON.stringify({ clear: true }) },
        { path: "/history", body: JSON.stringify({ clear: true }) },
        {
          path: "/free",
          body: JSON.stringify({ unload_models: false, free_memory: true }),
        },
      ];
      const notes = [];
      for (const p of posts) {
        const res = await fetch(apiUrl(p.path), {
          method: "POST",
          headers,
          body: p.body,
          mode: "cors",
        });
        notes.push(p.path + " " + res.status);
        if (!res.ok && res.status !== 200) {
          // interrupt may 400 if idle — ignore soft fails
          if (!(p.path === "/interrupt" && res.status >= 400)) {
            console.warn("clean step", p.path, res.status);
          }
        }
      }
      let outNote = "";
      try {
        const res2 = await fetch(apiUrl("/clean_output"), {
          method: "POST",
          headers,
          body: JSON.stringify({ output: true, temp: true }),
          mode: "cors",
        });
        if (res2.ok) {
          const data = await res2.json().catch(() => ({}));
          const n = data.removed != null ? data.removed : "?";
          const mb =
            data.bytes != null ? (Number(data.bytes) / 1048576).toFixed(1) : "?";
          outNote = " · 原图已删 " + n + " 个/" + mb + "MB";
          notes.push("/clean_output " + res2.status);
        } else {
          outNote = " · 原图清理失败(需装扩展并重启 Comfy)";
          notes.push("/clean_output " + res2.status);
        }
      } catch (e) {
        outNote = " · 原图清理失败(接口不可用)";
      }
      setStatus("Comfy 已清理" + outNote + " · " + notes.join(" · "), "ok");
    } catch (e) {
      console.error(e);
      setStatus("清理失败: " + (e && e.message ? e.message : String(e)), "err");
    }
  }


  function setImportHint(text, kind) {
    const el = $("pngImportHint");
    if (!el) return;
    el.textContent = text || "";
    el.style.color =
      kind === "ok" ? "var(--ok)" : kind === "err" ? "var(--err)" : "var(--muted)";
  }

  function clearPngImport() {
    importedApiPrompt = null;
    importMode = "none";
    const clr = $("btnClearImport");
    if (clr) clr.hidden = true;
    const file = $("pngImportFile");
    if (file) file.value = "";
    setImportHint(
      "选择 Comfy 生成的 PNG，本页会读取内嵌 prompt / workflow，填入提示词与参数；完整图也可直接按原工作流出图。",
      ""
    );
  }

  function applyParamsToForm(params) {
    if (!params) return;
    if (params.prompt) $("prompt").value = params.prompt;
    if (params.negative != null && String(params.negative).length) {
      $("negative").value = params.negative;
    }
    if (params.steps != null && Number.isFinite(Number(params.steps))) {
      $("steps").value = String(Math.round(Number(params.steps)));
    }
    if (params.width != null && Number.isFinite(Number(params.width))) {
      $("width").value = String(Math.round(Number(params.width)));
    }
    if (params.height != null && Number.isFinite(Number(params.height))) {
      $("height").value = String(Math.round(Number(params.height)));
    }
    if (params.seed != null && Number.isFinite(Number(params.seed))) {
      $("seed").value = String(Math.round(Number(params.seed)));
    }
  }

  async function handlePngImportFile(file) {
    if (!file) return;
    const Meta = window.ComfyPngMeta;
    if (!Meta) {
      setStatus("png-meta.js 未加载", "err");
      setImportHint("解析模块未加载", "err");
      return;
    }
    const name = file.name || "image.png";
    if (!/\.png$/i.test(name) && file.type && file.type !== "image/png") {
      setStatus("请选择 PNG 文件", "err");
      setImportHint("仅支持 PNG", "err");
      return;
    }
    setStatus("正在读取 PNG 元数据…", "run");
    setImportHint("读取中…", "");
    try {
      const buf = await file.arrayBuffer();
      const meta = await Meta.parsePngComfyMeta(buf);
      if (!meta.prompt && !meta.workflow) {
        importedApiPrompt = null;
        importMode = "none";
        const clr = $("btnClearImport");
        if (clr) clr.hidden = true;
        setStatus("这张 PNG 没有 Comfy 工作流元数据", "err");
        setImportHint(
          "未找到 prompt / workflow 文本块。请用 Comfy 的 SaveImage 生成的图，或确认未被其它软件重新导出。",
          "err"
        );
        return;
      }

      let params = { prompt: "", negative: "", steps: null, width: null, height: null, seed: null, cfg: null, matchedLustify: false };
      if (meta.prompt) {
        params = Meta.extractParamsFromApiPrompt(meta.prompt);
      }
      if (!params.prompt && meta.workflow) {
        const ui = Meta.extractParamsFromUiWorkflow(meta.workflow);
        params = Object.assign(params, {
          prompt: ui.prompt || params.prompt,
          negative: ui.negative || params.negative,
          steps: params.steps != null ? params.steps : ui.steps,
          width: params.width != null ? params.width : ui.width,
          height: params.height != null ? params.height : ui.height,
          seed: params.seed != null ? params.seed : ui.seed,
          cfg: params.cfg != null ? params.cfg : ui.cfg,
          matchedLustify: params.matchedLustify || ui.matchedLustify,
        });
      }

      applyParamsToForm(params);

      const hasApi = !!(meta.prompt && typeof meta.prompt === "object");
      const useFullApi = hasApi && !params.matchedLustify;
      if (useFullApi) {
        importedApiPrompt = meta.prompt;
        importMode = "api";
        setStatus(
          "已导入完整工作流 · 点「生成」将按原图节点出图（表单种子/步数可覆盖）",
          "ok"
        );
        setImportHint(
          "模式：完整 API 工作流（" +
            Object.keys(meta.prompt).length +
            " 节点）· 来自 " +
            name,
          "ok"
        );
      } else {
        importedApiPrompt = null;
        importMode = "params";
        const bits = [];
        if (params.prompt) bits.push("提示词");
        if (params.negative) bits.push("负面");
        if (params.steps != null) bits.push("步数 " + params.steps);
        if (params.width != null && params.height != null) {
          bits.push(params.width + "×" + params.height);
        }
        if (params.seed != null) bits.push("种子 " + params.seed);
        setStatus(
          "已填入参数" + (params.matchedLustify ? "（Lustify）" : "") + " · 点「生成」出图",
          "ok"
        );
        setImportHint(
          "模式：填入表单 · " +
            (bits.length ? bits.join(" · ") : "已读取元数据") +
            " · " +
            name,
          "ok"
        );
      }
      const clr = $("btnClearImport");
      if (clr) clr.hidden = false;
    } catch (e) {
      console.error(e);
      setStatus("导入失败: " + (e && e.message ? e.message : String(e)), "err");
      setImportHint("解析失败: " + (e && e.message ? e.message : String(e)), "err");
    }
  }

  function bindPngImport() {
    const btn = $("btnImportPng");
    const input = $("pngImportFile");
    const zone = $("pngImportZone");
    const clr = $("btnClearImport");
    if (btn && input) {
      btn.addEventListener("click", () => input.click());
      input.addEventListener("change", () => {
        const f = input.files && input.files[0];
        if (f) handlePngImportFile(f).catch((e) => console.error(e));
      });
    }
    if (clr) {
      clr.addEventListener("click", () => {
        clearPngImport();
        setStatus("已清除 PNG 导入", "");
      });
    }
    if (zone) {
      zone.addEventListener("dragover", (ev) => {
        ev.preventDefault();
        zone.classList.add("dragover");
      });
      zone.addEventListener("dragleave", () => zone.classList.remove("dragover"));
      zone.addEventListener("drop", (ev) => {
        ev.preventDefault();
        zone.classList.remove("dragover");
        const f = ev.dataTransfer && ev.dataTransfer.files && ev.dataTransfer.files[0];
        if (f) handlePngImportFile(f).catch((e) => console.error(e));
      });
    }
  }

  async function generate() {
    if (running) return;
    const prompt = ($("prompt").value || "").trim();
    const useImportedApi = importMode === "api" && importedApiPrompt;
    if (!prompt && !useImportedApi) {
      setStatus("请先填写提示词，或从 PNG 导入工作流", "err");
      return;
    }

    const W = window.ComfyPhoneWorkflow;
    if (!useImportedApi && !W) {
      setStatus("workflow.js 未加载", "err");
      return;
    }

    let seedStr = ($("seed").value || "").trim();
    let baseSeed = seedStr === "" ? randomSeed() : Number(seedStr);
    if (!Number.isFinite(baseSeed) || baseSeed < 0) {
      setStatus("种子无效", "err");
      return;
    }
    if (seedStr === "") $("seed").placeholder = "上次随机: " + baseSeed;

    const steps = Number($("steps").value) || 30;
    const width = Number($("width").value) || 1280;
    const height = Number($("height").value) || 2560;
    let batch = Math.floor(Number($("batch") && $("batch").value) || 1);
    if (!Number.isFinite(batch) || batch < 1) batch = 1;
    if (batch > 20) batch = 20;
    if ($("batch")) $("batch").value = String(batch);
    const negative = ($("negative").value || "").trim() || (W && W.DEFAULT_NEG) || "";

    try {
      requireBase();
    } catch (e) {
      setStatus(e.message, "err");
      setConnStatus("失败: " + e.message, "err");
      return;
    }

    cancelRequested = false;
    setBusy(true);
    setStatus("排队中… 1/" + batch, "run");
    $("preview").hidden = true;
    $("placeholder").hidden = false;
    const box = document.querySelector(".preview-box");
    if (box) box.classList.remove("has-image");
    const prev = $("preview");
    if (prev) { prev.removeAttribute("src"); prev.src = ""; }

    try {
      const ok = await connectComfy();
      if (!ok) {
        throw new Error("未连接成功，请先点「连接」或检查 CORS / 地址");
      }

      let lastSeed = baseSeed;
      let ghOk = 0;
      let ghFail = 0;
      let tgOk = 0;
      let tgFail = 0;
      for (let n = 0; n < batch; n++) {
        if (cancelRequested) {
          setStatus("已取消 · 完成 " + n + "/" + batch, "err");
          break;
        }
        const seed = baseSeed + n;
        lastSeed = seed;
        wsHadProgress = false;
        wsFatalError = null;
        currentPromptId = null;
        closeWs();

        let workflow;
        if (useImportedApi) {
          const Meta = window.ComfyPngMeta;
          workflow = Meta
            ? Meta.patchApiPrompt(importedApiPrompt, { seed: seed, steps: steps })
            : JSON.parse(JSON.stringify(importedApiPrompt));
        } else {
          workflow = W.buildWorkflow({
            prompt,
            negative,
            steps,
            width,
            height,
            seed,
            cfg: 1.0,
            prefix: "phone_" + seed,
          });
        }

        openProgressWs();
        setStatus("排队中… " + (n + 1) + "/" + batch + " · 种子 " + seed, "run");

        if (cancelRequested) break;

        const promptId = await postPrompt(workflow);
        currentPromptId = promptId;

        const imgInfo = await pollHistory(promptId, (i) => {
          if (!wsHadProgress && i > 0 && i % 5 === 0) {
            setStatus(
              "出图中… " + (n + 1) + "/" + batch + " · " + i * 2 + "s",
              "run"
            );
          }
        });

        setStatus("拉取图片… " + (n + 1) + "/" + batch, "run");
        const { blob, filename } = await fetchImageBlob(imgInfo);
        showImage(blob, filename);
        await saveToGallery({
          blob,
          filename,
          prompt,
          seed,
          width,
          height,
          steps,
          createdAt: Date.now(),
        });
        const up = await maybeUploadToGithub(blob, filename);
        if ($("chkSaveGithub") && $("chkSaveGithub").checked) {
          if (up) ghOk++;
          else ghFail++;
        }
        const upTg = await maybeUploadToTelegram(blob, filename);
        if ($("chkSaveTelegram") && $("chkSaveTelegram").checked) {
          if (upTg) tgOk++;
          else tgFail++;
        }
      }
      let doneMsg =
        "完成 · " +
        batch +
        " 张已存图库 · 种子 " +
        baseSeed +
        (batch > 1 ? "～" + lastSeed : "");
      let doneKind = "ok";
      if (ghOk || ghFail) {
        if (ghFail === 0) {
          doneMsg += " · 仓库队列 " + ghOk;
        } else if (ghOk === 0) {
          doneMsg += " · 存入仓库未排队（检查 Token）";
          doneKind = "err";
        } else {
          doneMsg += " · 仓库队列 " + ghOk + " · 跳过 " + ghFail;
          doneKind = "err";
        }
      }
      if (tgOk || tgFail) {
        if (tgFail === 0) {
          doneMsg += " · Telegram 队列 " + tgOk;
        } else if (tgOk === 0) {
          doneMsg += " · Telegram 未排队（检查 Token/Chat ID）";
          doneKind = "err";
        } else {
          doneMsg += " · Telegram " + tgOk + " · 跳过 " + tgFail;
          doneKind = "err";
        }
      }
      setStatus(doneMsg, doneKind);
    } catch (e) {
      console.error(e);
      setStatus("失败: " + (e && e.message ? e.message : String(e)), "err");
    } finally {
      closeWs();
      currentPromptId = null;
      setBusy(false);
    }
  }


  /* ========== RunPod one-click ========== */
  const LS_RP_KEY = "comfy_phone_runpod_key";
  const LS_RP_POD = "comfy_phone_runpod_pod";
  const LS_RP_PORT = "comfy_phone_runpod_port";
  const LS_RP_PROXY = "comfy_phone_runpod_proxy";
  const LS_PROVIDER = "comfy_phone_provider";

  function setRunpodStatus(msg, kind) {
    const el = $("runpodStatus");
    if (!el) return;
    el.textContent = msg || "";
    el.className = "conn" + (kind ? " " + kind : "");
  }

  function getProvider() {
    return localStorage.getItem(LS_PROVIDER) === "runpod" ? "runpod" : "autodl";
  }

  function setProvider(prov) {
    const p = prov === "runpod" ? "runpod" : "autodl";
    localStorage.setItem(LS_PROVIDER, p);
    const autodl = $("bootPanelAutodl");
    const runpod = $("bootPanelRunpod");
    if (autodl) autodl.hidden = p !== "autodl";
    if (runpod) runpod.hidden = p !== "runpod";
    const tA = $("tabProvAutodl");
    const tR = $("tabProvRunpod");
    if (tA) tA.classList.toggle("is-active", p === "autodl");
    if (tR) tR.classList.toggle("is-active", p === "runpod");
    const hint = $("bootUrlHint");
    if (hint) {
      hint.textContent =
        p === "runpod"
          ? "RunPod 开机后会自动填入 proxy 地址，也可手改；再点检测连接。"
          : "AutoDL 填 6006 公网；有启动接口时先点「拉起 Comfy」。";
    }
    const ph = $("bootUrl");
    if (ph) {
      ph.placeholder =
        p === "runpod"
          ? "https://<机器码>-8188.proxy.runpod.net"
          : "https://u865025-xxxx.bjb1.seetacloud.com";
    }
  }

  function persistRunpodFields() {
    const key = ($("runpodApiKey") && $("runpodApiKey").value || "").trim();
    const pod = ($("runpodPodId") && $("runpodPodId").value || "").trim();
    const port = ($("runpodPort") && $("runpodPort").value || "").trim() || "8188";
    const proxy = ($("runpodProxy") && $("runpodProxy").value || "").trim().replace(/\/+$/, "");
    if (key) localStorage.setItem(LS_RP_KEY, key);
    else localStorage.removeItem(LS_RP_KEY);
    if (pod) localStorage.setItem(LS_RP_POD, pod);
    else localStorage.removeItem(LS_RP_POD);
    localStorage.setItem(LS_RP_PORT, port);
    if (proxy) localStorage.setItem(LS_RP_PROXY, proxy);
    else localStorage.removeItem(LS_RP_PROXY);
  }

  function loadRunpodFields() {
    if ($("runpodApiKey")) $("runpodApiKey").value = localStorage.getItem(LS_RP_KEY) || "";
    if ($("runpodPodId")) $("runpodPodId").value = localStorage.getItem(LS_RP_POD) || "";
    if ($("runpodPort")) $("runpodPort").value = localStorage.getItem(LS_RP_PORT) || "8188";
    if ($("runpodProxy")) $("runpodProxy").value = localStorage.getItem(LS_RP_PROXY) || "";
  }

  function requireRunpodCreds() {
    persistRunpodFields();
    const apiKey =
      ($("runpodApiKey") && $("runpodApiKey").value || "").trim() ||
      localStorage.getItem(LS_RP_KEY) ||
      "";
    const podId =
      ($("runpodPodId") && $("runpodPodId").value || "").trim() ||
      localStorage.getItem(LS_RP_POD) ||
      "";
    if ($("runpodApiKey") && apiKey && !$("runpodApiKey").value) $("runpodApiKey").value = apiKey;
    if ($("runpodPodId") && podId && !$("runpodPodId").value) $("runpodPodId").value = podId;
    if (!apiKey) throw new Error("请填写 RunPod API Key");
    if (!podId) throw new Error("请填写机器码（Pod ID）");
    if (!/^[A-Za-z0-9_-]{4,64}$/.test(podId)) {
      throw new Error("机器码格式不对，请从 RunPod 控制台复制 Pod ID");
    }
    let port = Math.floor(Number(($("runpodPort") && $("runpodPort").value) || 8188));
    if (!Number.isFinite(port) || port < 1 || port > 65535) port = 8188;
    const proxy = ($("runpodProxy") && $("runpodProxy").value || "").trim().replace(/\/+$/, "");
    return { apiKey, podId, port, proxy };
  }

  function runpodPublicUrl(podId, port) {
    return "https://" + podId + "-" + port + ".proxy.runpod.net";
  }

  function fillComfyUrl(url) {
    if ($("bootUrl")) $("bootUrl").value = url;
    if ($("baseUrl")) $("baseUrl").value = url;
    try {
      localStorage.setItem("comfy_phone_base", url.replace(/\/+$/, ""));
    } catch (e) {}
  }

  /**
   * Call RunPod REST. Prefer direct rest.runpod.io (CORS *).
   * Optional Worker: POST {proxy}/runpod  { method, path, apiKey, body? }
   */
  async function runpodFetch(creds, method, path, bodyObj) {
    const pathClean = path.startsWith("/") ? path : "/" + path;
    if (creds.proxy) {
      const res = await fetch(creds.proxy + "/runpod", {
        method: "POST",
        mode: "cors",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          method: method,
          path: pathClean,
          apiKey: creds.apiKey,
          body: bodyObj == null ? null : bodyObj,
        }),
      });
      const text = await res.text();
      let json = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch (e) {
        json = { raw: text };
      }
      return { ok: res.ok, status: res.status, json, text };
    }
    const url = "https://rest.runpod.io/v1" + pathClean;
    const headers = {
      Authorization: "Bearer " + creds.apiKey,
    };
    const init = { method: method, mode: "cors", headers: headers };
    if (bodyObj != null && method !== "GET" && method !== "HEAD") {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(bodyObj);
    }
    const res = await fetch(url, init);
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch (e) {
      json = { raw: text };
    }
    return { ok: res.ok, status: res.status, json, text };
  }

  async function runpodGetPod(creds) {
    return runpodFetch(creds, "GET", "/pods/" + encodeURIComponent(creds.podId));
  }

  async function runpodStartPod(creds) {
    return runpodFetch(creds, "POST", "/pods/" + encodeURIComponent(creds.podId) + "/start");
  }

  async function runpodStopPod(creds) {
    return runpodFetch(creds, "POST", "/pods/" + encodeURIComponent(creds.podId) + "/stop");
  }

  function runpodErrMessage(res) {
    if (!res) return "未知错误";
    const j = res.json;
    if (j && typeof j === "object") {
      if (j.error) return typeof j.error === "string" ? j.error : JSON.stringify(j.error);
      if (j.message) return String(j.message);
      if (j.description) return String(j.description);
    }
    if (res.status === 401) return "API Key 无效或无权访问";
    if (res.status === 404) return "找不到该机器码对应的 Pod";
    if (res.text) return res.text.slice(0, 200);
    return "HTTP " + res.status;
  }

  async function runpodFillPublicUrlOnly() {
    try {
      const creds = requireRunpodCreds();
      const url = runpodPublicUrl(creds.podId, creds.port);
      fillComfyUrl(url);
      setRunpodStatus("已填入公网: " + url, "ok");
      setConnStatus("已填入 RunPod 公网 · 可点检测连接", "");
      return url;
    } catch (e) {
      setRunpodStatus("失败: " + (e && e.message ? e.message : String(e)), "err");
      return "";
    }
  }

  async function runpodBootAndWait() {
    let creds;
    try {
      creds = requireRunpodCreds();
    } catch (e) {
      setRunpodStatus("失败: " + e.message, "err");
      return false;
    }

    const publicUrl = runpodPublicUrl(creds.podId, creds.port);
    fillComfyUrl(publicUrl);

    setRunpodStatus("查询 Pod 状态…", "run");
    setConnStatus("RunPod · 查询中…", "run");

    let info;
    try {
      info = await runpodGetPod(creds);
    } catch (e) {
      const msg = e && e.message ? e.message : String(e);
      const corsHint =
        /Failed to fetch|NetworkError|CORS/i.test(msg)
          ? "（直连 API 失败，可填「API 代理」Worker，见 workers/）"
          : "";
      setRunpodStatus("查询失败: " + msg + corsHint, "err");
      setConnStatus("RunPod 查询失败", "err");
      return false;
    }
    if (!info.ok) {
      setRunpodStatus("查询失败: " + runpodErrMessage(info), "err");
      setConnStatus("RunPod 查询失败", "err");
      return false;
    }

    const desired = (info.json && info.json.desiredStatus) || "";
    setRunpodStatus("Pod 状态: " + (desired || "?") + " · 机器码 " + creds.podId, "run");

    if (desired !== "RUNNING") {
      setRunpodStatus("正在开机（resume）…", "run");
      setConnStatus("RunPod · 开机中…", "run");
      let startRes;
      try {
        startRes = await runpodStartPod(creds);
      } catch (e) {
        const msg = e && e.message ? e.message : String(e);
        setRunpodStatus("开机失败: " + msg, "err");
        setConnStatus("RunPod 开机失败", "err");
        return false;
      }
      // 200 empty body is success; some errors still return JSON
      if (!startRes.ok && startRes.status !== 200) {
        // already running etc — re-check
        const again = await runpodGetPod(creds).catch(function () { return null; });
        const st = again && again.json && again.json.desiredStatus;
        if (st !== "RUNNING") {
          setRunpodStatus("开机失败: " + runpodErrMessage(startRes), "err");
          setConnStatus("RunPod 开机失败", "err");
          return false;
        }
      }
    } else {
      setRunpodStatus("Pod 已在运行 · 等待 Comfy…", "run");
    }

    // Poll desiredStatus + Comfy /system_stats
    const deadline = Date.now() + 180000;
    let attempt = 0;
    let podRunning = desired === "RUNNING";
    while (Date.now() < deadline) {
      attempt += 1;
      if (!podRunning && attempt % 2 === 1) {
        try {
          const g = await runpodGetPod(creds);
          if (g.ok && g.json && g.json.desiredStatus === "RUNNING") {
            podRunning = true;
          } else if (g.ok && g.json && g.json.desiredStatus === "TERMINATED") {
            setRunpodStatus("Pod 已终止，无法开机", "err");
            setConnStatus("RunPod Pod 已终止", "err");
            return false;
          }
        } catch (e) {}
      }
      setRunpodStatus(
        (podRunning ? "等待 Comfy 就绪…" : "等待 Pod RUNNING…") +
          " (" +
          attempt +
          ") · " +
          publicUrl,
        "run"
      );
      setConnStatus("等待 Comfy… (" + attempt + ")", "run");
      try {
        const res = await fetch(publicUrl + "/system_stats", {
          method: "GET",
          mode: "cors",
        });
        if (res.ok) {
          const ok = await connectComfy();
          if (ok) {
            setRunpodStatus("就绪 · " + publicUrl, "ok");
            return true;
          }
        }
      } catch (e) {
        /* keep polling — proxy may 502 while container boots */
      }
      await sleep(3000);
    }
    setRunpodStatus(
      "已请求开机，但 Comfy 公网仍未连通（超时）。确认端口 " +
        creds.port +
        " 已暴露且 Comfy 已启动，再点检测连接。",
      "err"
    );
    setConnStatus("RunPod 已开机，Comfy 超时未通", "err");
    return false;
  }

  async function runpodStopAndConfirm() {
    let creds;
    try {
      creds = requireRunpodCreds();
    } catch (e) {
      setRunpodStatus("失败: " + e.message, "err");
      return false;
    }
    if (
      !confirm(
        "确定关 RunPod（机器码 " +
          creds.podId +
          "）？会停止计费，公网失效，下次需再开机。"
      )
    ) {
      return false;
    }
    setRunpodStatus("正在关 Pod…", "run");
    try {
      const res = await runpodStopPod(creds);
      if (!res.ok && res.status !== 200) {
        setRunpodStatus("关机失败: " + runpodErrMessage(res), "err");
        return false;
      }
      connectedOk = false;
      closeWs();
      setRunpodStatus("Pod 已停止 · " + creds.podId, "ok");
      setConnStatus("未连接 · RunPod 已关机", "");
      return true;
    } catch (e) {
      setRunpodStatus("关机失败: " + (e && e.message ? e.message : String(e)), "err");
      return false;
    }
  }

  function getStartApiBase() {

    const el = $("startApiUrl");
    const raw = ((el && el.value) || "").trim().replace(/\/+$/, "");
    return raw;
  }

  function requireStartApiBase() {
    const base = getStartApiBase();
    if (!base) {
      throw new Error("请先填写启动接口地址（AutoDL 6008 公网）");
    }
    try {
      const u = new URL(base);
      if (u.protocol !== "http:" && u.protocol !== "https:") {
        throw new Error("启动接口地址需以 http:// 或 https:// 开头");
      }
    } catch (e) {
      if (e && e.message && /启动接口|http/.test(e.message)) throw e;
      throw new Error("启动接口地址无效");
    }
    return base;
  }

  async function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  /** POST /start on start API, then poll Comfy /system_stats until up or timeout. */
  async function startComfyViaApi() {
    let apiBase;
    try {
      apiBase = requireStartApiBase();
    } catch (e) {
      setConnStatus("失败: " + e.message, "err");
      return false;
    }
    localStorage.setItem("comfy_phone_start_api", apiBase);

    // Persist comfy URL too if present
    try {
      const comfyBase = getBase();
      if (comfyBase) localStorage.setItem("comfy_phone_base", comfyBase);
    } catch (e) {}

    setConnStatus("正在请求启动接口…", "run");
    let startJson = null;
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 90000);
      const res = await fetch(apiBase + "/start", {
        method: "POST",
        mode: "cors",
        headers: { "Content-Type": "application/json" },
        body: "{}",
        signal: ctrl.signal,
      });
      clearTimeout(t);
      startJson = await res.json().catch(() => ({}));
      if (!res.ok && !(startJson && startJson.ok)) {
        const msg =
          (startJson && startJson.message) || "HTTP " + res.status;
        setConnStatus("拉起失败: " + msg, "err");
        return false;
      }
    } catch (e) {
      const msg = e && e.name === "AbortError" ? "启动接口超时" : (e && e.message ? e.message : String(e));
      const corsHint =
        /Failed to fetch|NetworkError|CORS|cross-origin/i.test(msg) ||
        msg === "Failed to fetch"
          ? "（检查 6008 公网与 CORS；接口需已开机运行）"
          : "";
      setConnStatus("拉起失败: " + msg + corsHint, "err");
      return false;
    }

    if (startJson && startJson.already) {
      setConnStatus("Comfy 已在运行 · 正在检测…", "run");
    } else {
      setConnStatus(
        (startJson && startJson.message) || "已请求拉起 · 等待 Comfy…",
        "run"
      );
    }

    // Poll Comfy public URL
    let comfyBase = "";
    try {
      comfyBase = getBase();
    } catch (e) {}
    if (!comfyBase) {
      setConnStatus(
        "启动接口已响应，但未填 Comfy 公网地址 — 请填 6006 公网后点检测",
        startJson && startJson.ok ? "ok" : "err"
      );
      return !!(startJson && startJson.ok);
    }

    const deadline = Date.now() + 90000;
    let attempt = 0;
    while (Date.now() < deadline) {
      attempt += 1;
      setConnStatus("等待 Comfy 就绪… (" + attempt + ")", "run");
      try {
        const res = await fetch(comfyBase + "/system_stats", {
          method: "GET",
          mode: "cors",
        });
        if (res.ok) {
          const ok = await connectComfy();
          if (ok) {
            // connectComfy already set detailed status
            return true;
          }
        }
      } catch (e) {
        /* keep polling */
      }
      await sleep(2500);
    }
    setConnStatus(
      "启动接口已调用，但 Comfy 公网仍未连通（超时）。可再点检测连接。",
      "err"
    );
    return false;
  }


  function initDefaults() {
    const W = window.ComfyPhoneWorkflow;
    if (W && !$("negative").value) $("negative").value = W.DEFAULT_NEG;
    $("steps").value = $("steps").value || 30;
    if ($("batch")) $("batch").value = $("batch").value || 1;
    $("width").value = $("width").value || 1280;
    $("height").value = $("height").value || 2560;

    const saved = localStorage.getItem("comfy_phone_base");
    if (saved) {
      if ($("baseUrl") && !$("baseUrl").value) $("baseUrl").value = saved;
      if ($("bootUrl") && !$("bootUrl").value) $("bootUrl").value = saved;
    }
    const savedApi = localStorage.getItem("comfy_phone_start_api");
    if (savedApi && $("startApiUrl") && !$("startApiUrl").value) {
      $("startApiUrl").value = savedApi;
    }

    loadRunpodFields();
    setProvider(getProvider());
    if ($("tabProvAutodl")) {
      $("tabProvAutodl").addEventListener("click", () => setProvider("autodl"));
    }
    if ($("tabProvRunpod")) {
      $("tabProvRunpod").addEventListener("click", () => setProvider("runpod"));
    }
    ["runpodApiKey", "runpodPodId", "runpodPort", "runpodProxy"].forEach((id) => {
      const el = $(id);
      if (!el) return;
      el.addEventListener("change", persistRunpodFields);
      el.addEventListener("blur", persistRunpodFields);
    });
    if ($("btnRunpodStart")) {
      $("btnRunpodStart").addEventListener("click", () => {
        const btn = $("btnRunpodStart");
        if (btn) btn.disabled = true;
        runpodBootAndWait()
          .catch((e) => {
            setRunpodStatus(
              "失败: " + (e && e.message ? e.message : String(e)),
              "err"
            );
          })
          .finally(() => {
            if (btn) btn.disabled = false;
          });
      });
    }
    if ($("btnRunpodFillUrl")) {
      $("btnRunpodFillUrl").addEventListener("click", () => {
        runpodFillPublicUrlOnly();
      });
    }
    if ($("btnRunpodStop")) {
      $("btnRunpodStop").addEventListener("click", () => {
        const btn = $("btnRunpodStop");
        if (btn) btn.disabled = true;
        runpodStopAndConfirm()
          .finally(() => {
            if (btn) btn.disabled = false;
          });
      });
    }

    function persistBaseFrom(id) {
      syncUrlFields(id);
      const v = getBase();
      if (v) localStorage.setItem("comfy_phone_base", v);
      connectedOk = false;
      setConnStatus("未连接 · 地址已改，请重新点连接", "");
    }

    function wireUrlField(id) {
      const el = $(id);
      if (!el) return;
      el.addEventListener("input", () => syncUrlFields(id));
      el.addEventListener("change", () => persistBaseFrom(id));
      el.addEventListener("blur", () => {
        syncUrlFields(id);
        const v = getBase();
        if (v) localStorage.setItem("comfy_phone_base", v);
      });
    }
    wireUrlField("baseUrl");
    wireUrlField("bootUrl");

    if ($("btnConnect")) {
      $("btnConnect").addEventListener("click", () => {
        syncUrlFields("baseUrl");
        setConnStatus("连接中…", "run");
        connectComfy().catch((e) => {
          setConnStatus("失败: " + (e && e.message ? e.message : String(e)), "err");
        });
      });
    }

    if ($("btnBootConnect")) {
      $("btnBootConnect").addEventListener("click", () => {
        syncUrlFields("bootUrl");
        setConnStatus("连接中…", "run");
        connectComfy().catch((e) => {
          setConnStatus("失败: " + (e && e.message ? e.message : String(e)), "err");
        });
      });
    }


    if ($("startApiUrl")) {
      const persistApi = () => {
        const v = getStartApiBase();
        if (v) localStorage.setItem("comfy_phone_start_api", v);
      };
      $("startApiUrl").addEventListener("change", persistApi);
      $("startApiUrl").addEventListener("blur", persistApi);
    }

    if ($("btnStartComfy")) {
      $("btnStartComfy").addEventListener("click", () => {
        syncUrlFields("bootUrl");
        const btn = $("btnStartComfy");
        if (btn) btn.disabled = true;
        startComfyViaApi()
          .catch((e) => {
            setConnStatus(
              "失败: " + (e && e.message ? e.message : String(e)),
              "err"
            );
          })
          .finally(() => {
            if (btn) btn.disabled = false;
          });
      });
    }

    async function enterApp(opts) {
      opts = opts || {};
      syncUrlFields($("bootUrl") && $("bootUrl").value ? "bootUrl" : "baseUrl");
      const hasUrl = !!getBase();
      if (hasUrl && !opts.skipConnect) {
        setConnStatus("连接中…", "run");
        try {
          await connectComfy();
        } catch (e) {
          setConnStatus("失败: " + (e && e.message ? e.message : String(e)), "err");
        }
      }
      showPage("app");
    }

    if ($("btnEnterApp")) {
      $("btnEnterApp").addEventListener("click", () => {
        enterApp({ skipConnect: false }).catch(() => showPage("app"));
      });
    }
    if ($("btnChangeServer")) {
      $("btnChangeServer").addEventListener("click", () => {
        syncUrlFields("baseUrl");
        showPage("boot");
      });
    }

    // Always start on boot so user can reconnect / open Comfy
    showPage("boot");
    $("btnGen").addEventListener("click", generate);
    if ($("btnCancel")) $("btnCancel").addEventListener("click", cancelTask);
    $("btnSave").addEventListener("click", saveImage);
    $("btnRandSeed").addEventListener("click", () => {
      $("seed").value = String(randomSeed());
    });
    if ($("btnClearGallery")) {
      $("btnClearGallery").addEventListener("click", () => {
        deleteSelectedGallery().catch((e) => console.error(e));
      });
    }
    if ($("btnPullImages")) $("btnPullImages").addEventListener("click", pullNewImages);
    if ($("btnGalSelectMode")) {
      $("btnGalSelectMode").addEventListener("click", () => {
        setGallerySelectMode(!gallerySelectMode).catch((e) => console.error(e));
      });
    }
    if ($("btnGalSelectAll")) {
      $("btnGalSelectAll").addEventListener("click", async () => {
        if (!gallerySelectMode) {
          await setGallerySelectMode(true);
        }
        const G = window.ComfyPhoneGallery;
        if (!G) return;
        const items = await G.listImages();
        selectedGalleryIds.clear();
        for (const it of items) selectedGalleryIds.add(it.id);
        await renderGallery();
      });
    }
    if ($("btnGalClearSel")) {
      $("btnGalClearSel").addEventListener("click", async () => {
        selectedGalleryIds.clear();
        await renderGallery();
      });
    }
    if ($("btnGalSaveAlbum")) $("btnGalSaveAlbum").addEventListener("click", () => {
      saveSelectedAlbum().catch((e) =>
        setStatus("存到相册失败: " + (e && e.message ? e.message : String(e)), "err")
      );
    });
    // GitHub / Telegram gallery buttons removed from UI; code paths kept if elements reappear
    if ($("btnGalSaveGh")) $("btnGalSaveGh").addEventListener("click", () => {
      saveSelectedGithub().catch((e) => setStatus("上传失败: " + (e && e.message ? e.message : String(e)), "err"));
    });
    if ($("btnGalSaveTg")) $("btnGalSaveTg").addEventListener("click", () => {
      saveSelectedTelegram().catch((e) =>
        setStatus("Telegram 失败: " + (e && e.message ? e.message : String(e)), "err")
      );
    });
    if ($("btnCleanComfy")) $("btnCleanComfy").addEventListener("click", cleanComfy);
    if ($("btnShutdownComfy")) $("btnShutdownComfy").addEventListener("click", shutdownComfy);
    if ($("btnPowerOffInstance")) $("btnPowerOffInstance").addEventListener("click", powerOffInstance);
    $("btnLbClose").addEventListener("click", closeLightbox);
    $("btnLbSave").addEventListener("click", () => {
      if (!lightboxItem) return;
      const file = blobToImageFile(
        lightboxItem.blob,
        lightboxItem.filename || "comfy_phone.png"
      );
      shareImageFiles([file])
        .then((result) => {
          if (result.mode === "share") {
            setStatus("已打开系统分享 · 请选「存储图像」或「存储到相册」", "ok");
          } else if (result.mode === "abort") {
            setStatus("已取消", "");
          } else {
            setStatus("请长按大图 →「存储图像」保存到相册", "err");
          }
        })
        .catch((e) =>
          setStatus("分享失败: " + (e && e.message ? e.message : String(e)), "err")
        );
    });
    $("lightbox").addEventListener("click", (ev) => {
      if (ev.target === $("lightbox")) closeLightbox();
    });

    loadGhSettings();
    if ($("chkSaveGithub")) {
      $("chkSaveGithub").addEventListener("change", persistGhSettings);
    }
    if ($("ghToken")) {
      $("ghToken").addEventListener("change", persistGhSettings);
      $("ghToken").addEventListener("blur", persistGhSettings);
    }
    if ($("ghRepo")) {
      $("ghRepo").addEventListener("change", persistGhSettings);
      $("ghRepo").addEventListener("blur", persistGhSettings);
    }

    loadTgSettings();
    if ($("chkSaveTelegram")) {
      $("chkSaveTelegram").addEventListener("change", persistTgSettings);
    }
    if ($("tgToken")) {
      $("tgToken").addEventListener("change", persistTgSettings);
      $("tgToken").addEventListener("blur", persistTgSettings);
    }
    if ($("tgChatId")) {
      $("tgChatId").addEventListener("change", persistTgSettings);
      $("tgChatId").addEventListener("blur", persistTgSettings);
    }
    if ($("tgProxy")) {
      $("tgProxy").addEventListener("change", persistTgSettings);
      $("tgProxy").addEventListener("blur", persistTgSettings);
    }
    if ($("btnTgTest")) {
      $("btnTgTest").addEventListener("click", () => {
        testTelegramConnection().catch((e) =>
          setStatus("Telegram 测试失败: " + (e && e.message ? e.message : String(e)), "err")
        );
      });
    }

    ensureUploadBanner();
    syncGallerySelectUi();
    // Telegram / GitHub UI removed — clear leftover IndexedDB queue + hide sticky banner
    clearRetiredUploadJobs()
      .then((n) => {
        if (n > 0) console.info("cleared retired upload jobs:", n);
      })
      .catch((e) => console.error(e));
    // Do not auto-start upload pump (would re-show Telegram banner)
    if (UPLOAD_FEATURES_ENABLED) {
      bindUploadResumeHooks();
      kickUploadPump().catch((e) => console.error(e));
    }

    renderGallery();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initDefaults);
  } else {
    initDefaults();
  }
})();
