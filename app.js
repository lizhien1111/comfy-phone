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
  let lightboxUrl = null;
  let lightboxItem = null;

  let connectedOk = false;
  let cancelRequested = false;

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

  /**
   * Upload blob to private gallery repo via Contents API.
   * Returns true on success, false if skipped or failed (status already set on fail).
   */
  async function maybeUploadToGithub(blob, filename) {
    const chk = $("chkSaveGithub");
    if (!chk || !chk.checked) return false;
    if (!blob) return false;

    const tokenEl = $("ghToken");
    const token = (
      (tokenEl && tokenEl.value) ||
      localStorage.getItem(LS_GH_TOKEN) ||
      ""
    ).trim();
    if (!token) {
      setStatus("已存图库 · 勾选了存入仓库但未填 Token", "err");
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
      setStatus("仓库名无效，应为 owner/repo", "err");
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
        // never echo token
        setStatus("存入仓库失败: " + detail, "err");
        return false;
      }
      setStatus("已存入仓库 · " + path, "ok");
      return true;
    } catch (e) {
      const msg = e && e.message ? e.message : String(e);
      setStatus("存入仓库失败: " + msg.slice(0, 160), "err");
      return false;
    }
  }


  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename.endsWith(".png") ? filename : filename + ".png";
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

    for (const item of items) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "gallery-item";
      btn.title = (item.prompt || item.filename || "").slice(0, 80);
      const img = document.createElement("img");
      img.alt = "缩略图";
      img.loading = "lazy";
      const url = URL.createObjectURL(item.blob);
      thumbUrls.push(url);
      img.src = url;
      btn.appendChild(img);
      btn.addEventListener("click", () => openLightbox(item));
      grid.appendChild(btn);
    }
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

  async function clearGallery() {
    const G = window.ComfyPhoneGallery;
    if (!G) return;
    if (!confirm("确定清空本机图库？此操作不可恢复。")) return;
    try {
      await G.clearAll();
      closeLightbox();
      await renderGallery();
    } catch (e) {
      alert("清空失败: " + (e && e.message ? e.message : e));
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

  async function generate() {
    if (running) return;
    const prompt = ($("prompt").value || "").trim();
    if (!prompt) {
      setStatus("请先填写提示词", "err");
      return;
    }

    const W = window.ComfyPhoneWorkflow;
    if (!W) {
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
    const negative = ($("negative").value || "").trim() || W.DEFAULT_NEG;

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

        const workflow = W.buildWorkflow({
          prompt,
          negative,
          steps,
          width,
          height,
          seed,
          cfg: 1.0,
          prefix: "phone_" + seed,
        });

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
          doneMsg += " · 已存入仓库 " + ghOk + " 张";
        } else if (ghOk === 0) {
          doneMsg += " · 存入仓库失败";
          doneKind = "err";
        } else {
          doneMsg += " · 仓库 " + ghOk + " 成功 / " + ghFail + " 失败";
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

    if ($("btnOpenComfy")) {
      $("btnOpenComfy").addEventListener("click", () => {
        syncUrlFields("bootUrl");
        let base;
        try {
          base = requireBase();
        } catch (e) {
          setConnStatus("失败: " + e.message, "err");
          return;
        }
        localStorage.setItem("comfy_phone_base", base);
        window.open(base, "_blank", "noopener,noreferrer");
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
    if ($("btnGalleryOnly")) {
      $("btnGalleryOnly").addEventListener("click", () => {
        enterApp({ skipConnect: true }).catch(() => showPage("app"));
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
    $("btnClearGallery").addEventListener("click", clearGallery);
    if ($("btnPullImages")) $("btnPullImages").addEventListener("click", pullNewImages);
    if ($("btnCleanComfy")) $("btnCleanComfy").addEventListener("click", cleanComfy);
    if ($("btnShutdownComfy")) $("btnShutdownComfy").addEventListener("click", shutdownComfy);
    if ($("btnPowerOffInstance")) $("btnPowerOffInstance").addEventListener("click", powerOffInstance);
    $("btnLbClose").addEventListener("click", closeLightbox);
    $("btnLbSave").addEventListener("click", () => {
      if (!lightboxItem) return;
      downloadBlob(
        lightboxItem.blob,
        lightboxItem.filename || "comfy_phone.png"
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

    renderGallery();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initDefaults);
  } else {
    initDefaults();
  }
})();
