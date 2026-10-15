/**
 * IndexedDB gallery + durable upload queue (GitHub / Telegram) for Comfy phone page.
 * Upload queue keeps Blob copies so switching apps / reloading can resume.
 */
(function (root) {
  const DB_NAME = "comfy_phone_gallery";
  const DB_VER = 2;
  const STORE = "images";
  const UPLOAD_STORE = "uploads";
  const MAX_ITEMS = 60;

  function openDb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VER);
      req.onupgradeneeded = function (ev) {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          const os = db.createObjectStore(STORE, { keyPath: "id" });
          os.createIndex("createdAt", "createdAt", { unique: false });
        }
        if (!db.objectStoreNames.contains(UPLOAD_STORE)) {
          const uos = db.createObjectStore(UPLOAD_STORE, { keyPath: "id" });
          uos.createIndex("createdAt", "createdAt", { unique: false });
          uos.createIndex("status", "status", { unique: false });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error("IndexedDB open failed"));
    });
  }

  function txDone(tx) {
    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error || new Error("tx error"));
      tx.onabort = () => reject(tx.error || new Error("tx abort"));
    });
  }

  async function addImage(record) {
    const db = await openDb();
    const id =
      record.id ||
      "img_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8);
    const item = {
      id,
      filename: record.filename || "comfy_phone.png",
      subfolder: record.subfolder || "",
      comfyType: record.comfyType || record.type || "output",
      blob: record.blob,
      prompt: record.prompt || "",
      seed: record.seed != null ? record.seed : null,
      width: record.width || null,
      height: record.height || null,
      steps: record.steps || null,
      createdAt: record.createdAt || Date.now(),
    };
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(item);
    await txDone(tx);

    const all = await listImages();
    if (all.length > MAX_ITEMS) {
      const drop = all.slice(MAX_ITEMS);
      const tx2 = db.transaction(STORE, "readwrite");
      const os = tx2.objectStore(STORE);
      for (const d of drop) os.delete(d.id);
      await txDone(tx2);
    }
    db.close();
    return item.id;
  }

  async function listImages() {
    const db = await openDb();
    const tx = db.transaction(STORE, "readonly");
    const os = tx.objectStore(STORE);
    const req = os.getAll();
    const rows = await new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
    await txDone(tx);
    db.close();
    rows.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    return rows;
  }

  async function getImage(id) {
    const db = await openDb();
    const tx = db.transaction(STORE, "readonly");
    const req = tx.objectStore(STORE).get(id);
    const row = await new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
    await txDone(tx);
    db.close();
    return row;
  }

  async function deleteImage(id) {
    const db = await openDb();
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).delete(id);
    await txDone(tx);
    db.close();
  }

  async function clearAll() {
    const db = await openDb();
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).clear();
    await txDone(tx);
    db.close();
  }

  async function enqueueUpload(record) {
    if (!record || !record.blob) throw new Error("upload needs blob");
    const db = await openDb();
    const id =
      record.id ||
      "up_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8);
    const dest =
      record.dest === "telegram" || record.dest === "github"
        ? record.dest
        : "github";
    const item = {
      id,
      filename: record.filename || "comfy_phone.png",
      blob: record.blob,
      galleryId: record.galleryId || null,
      dest,
      caption: record.caption || "",
      status: "pending",
      error: null,
      attempts: record.attempts || 0,
      bytes: record.blob.size || 0,
      createdAt: record.createdAt || Date.now(),
      updatedAt: Date.now(),
    };
    const tx = db.transaction(UPLOAD_STORE, "readwrite");
    tx.objectStore(UPLOAD_STORE).put(item);
    await txDone(tx);
    db.close();
    return item.id;
  }

  async function listUploads() {
    const db = await openDb();
    if (!db.objectStoreNames.contains(UPLOAD_STORE)) {
      db.close();
      return [];
    }
    const tx = db.transaction(UPLOAD_STORE, "readonly");
    const req = tx.objectStore(UPLOAD_STORE).getAll();
    const rows = await new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
    await txDone(tx);
    db.close();
    rows.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
    return rows;
  }

  async function getUpload(id) {
    const db = await openDb();
    const tx = db.transaction(UPLOAD_STORE, "readonly");
    const req = tx.objectStore(UPLOAD_STORE).get(id);
    const row = await new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
    await txDone(tx);
    db.close();
    return row;
  }

  async function updateUpload(id, patch) {
    const db = await openDb();
    const tx = db.transaction(UPLOAD_STORE, "readwrite");
    const os = tx.objectStore(UPLOAD_STORE);
    const cur = await new Promise((resolve, reject) => {
      const r = os.get(id);
      r.onsuccess = () => resolve(r.result || null);
      r.onerror = () => reject(r.error);
    });
    if (!cur) {
      await txDone(tx);
      db.close();
      return null;
    }
    const next = Object.assign({}, cur, patch || {}, { updatedAt: Date.now() });
    os.put(next);
    await txDone(tx);
    db.close();
    return next;
  }

  async function deleteUpload(id) {
    const db = await openDb();
    const tx = db.transaction(UPLOAD_STORE, "readwrite");
    tx.objectStore(UPLOAD_STORE).delete(id);
    await txDone(tx);
    db.close();
  }

  async function resetStuckUploads() {
    const all = await listUploads();
    let n = 0;
    for (const u of all) {
      if (u.status === "uploading") {
        await updateUpload(u.id, { status: "pending", error: null });
        n++;
      }
    }
    return n;
  }

  async function retryFailedUploads() {
    const all = await listUploads();
    let n = 0;
    for (const u of all) {
      if (u.status === "error") {
        await updateUpload(u.id, { status: "pending", error: null });
        n++;
      }
    }
    return n;
  }

  /** Delete upload-queue jobs whose dest is in dests (e.g. telegram, github). */
  async function clearUploadsByDest(dests) {
    const want = new Set(Array.isArray(dests) ? dests : [dests]);
    const all = await listUploads();
    let n = 0;
    for (const u of all) {
      const d = u.dest || "github";
      if (want.has(d)) {
        await deleteUpload(u.id);
        n++;
      }
    }
    return n;
  }

  async function clearAllUploads() {
    const all = await listUploads();
    for (const u of all) await deleteUpload(u.id);
    return all.length;
  }

  root.ComfyPhoneGallery = {
    MAX_ITEMS,
    addImage,
    listImages,
    getImage,
    deleteImage,
    clearAll,
    enqueueUpload,
    listUploads,
    getUpload,
    updateUpload,
    deleteUpload,
    resetStuckUploads,
    retryFailedUploads,
    clearUploadsByDest,
    clearAllUploads,
  };
})(typeof window !== "undefined" ? window : globalThis);
