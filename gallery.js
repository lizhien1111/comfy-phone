/**
 * IndexedDB gallery for Comfy phone page.
 * Stores PNG blobs locally so reloads keep recent gens.
 */
(function (root) {
  const DB_NAME = "comfy_phone_gallery";
  const DB_VER = 1;
  const STORE = "images";
  const MAX_ITEMS = 60;

  function openDb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VER);
      req.onupgradeneeded = function () {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          const os = db.createObjectStore(STORE, { keyPath: "id" });
          os.createIndex("createdAt", "createdAt", { unique: false });
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

    // Trim oldest if over cap
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

  root.ComfyPhoneGallery = {
    MAX_ITEMS,
    addImage,
    listImages,
    getImage,
    deleteImage,
    clearAll,
  };
})(typeof window !== "undefined" ? window : globalThis);
