/* IndexedDB storage for the cached jar blob and a small project store.
 * Designed to be namespace-agnostic so future modded jars / data-packs
 * can be added alongside the base pack without schema changes. */
(function (global) {
  const DB_NAME = 'mc-planner';
  const DB_VERSION = 1;

  function openDb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains('packs')) {
          // key = slot id ("primary", or in the future "mod:<name>")
          db.createObjectStore('packs', { keyPath: 'slot' });
        }
        if (!db.objectStoreNames.contains('projects')) {
          db.createObjectStore('projects', { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains('kv')) {
          db.createObjectStore('kv', { keyPath: 'k' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  function tx(db, store, mode = 'readonly') {
    return db.transaction(store, mode).objectStore(store);
  }
  function asPromise(req) {
    return new Promise((res, rej) => {
      req.onsuccess = () => res(req.result);
      req.onerror = () => rej(req.error);
    });
  }

  const Storage = {
    async savePack(slot, file, meta) {
      const db = await openDb();
      const buf = await file.arrayBuffer();
      return asPromise(tx(db, 'packs', 'readwrite').put({
        slot,
        name: file.name,
        size: file.size,
        savedAt: Date.now(),
        blob: new Blob([buf], { type: 'application/java-archive' }),
        meta: meta || {},
      }));
    },
    async getPack(slot) {
      const db = await openDb();
      return asPromise(tx(db, 'packs').get(slot));
    },
    async deletePack(slot) {
      const db = await openDb();
      return asPromise(tx(db, 'packs', 'readwrite').delete(slot));
    },
    async listPacks() {
      const db = await openDb();
      return asPromise(tx(db, 'packs').getAll());
    },
    async saveProject(project) {
      const db = await openDb();
      project.savedAt = Date.now();
      return asPromise(tx(db, 'projects', 'readwrite').put(project));
    },
    async getProject(id) {
      const db = await openDb();
      return asPromise(tx(db, 'projects').get(id));
    },
    async listProjects() {
      const db = await openDb();
      return asPromise(tx(db, 'projects').getAll());
    },
    async setKv(k, v) {
      const db = await openDb();
      return asPromise(tx(db, 'kv', 'readwrite').put({ k, v }));
    },
    async getKv(k) {
      const db = await openDb();
      const r = await asPromise(tx(db, 'kv').get(k));
      return r ? r.v : null;
    },
  };

  global.MCStorage = Storage;
})(window);
