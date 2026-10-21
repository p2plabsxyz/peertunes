// Stand-ins for the page's storage, for tests that open the library itself.

// localStorage, which outlives the page, as the WebView's does.
function fakeStorage() {
  const items = new Map();
  return {
    getItem: (key) => (items.has(key) ? items.get(key) : null),
    setItem: (key, value) => { items.set(key, String(value)); },
    removeItem: (key) => { items.delete(key); },
  };
}

// Just enough IndexedDB for the library: its stores kept between opens, and
// each request done by the time its transaction completes.
function fakeIndexedDB() {
  const stores = new Map();
  const db = {
    objectStoreNames: { contains: (name) => stores.has(name) },
    createObjectStore(name, { keyPath } = {}) { stores.set(name, { keyPath, rows: new Map() }); },
    transaction(name) {
      const store = stores.get(name);
      const tx = {};
      const done = (result) => {
        setTimeout(() => tx.oncomplete && tx.oncomplete(), 0);
        return { result };
      };
      tx.objectStore = () => ({
        get: (key) => done(store.rows.get(key)),
        getAll: () => done([...store.rows.values()]),
        getAllKeys: () => done([...store.rows.keys()]),
        getKey: (key) => done(store.rows.has(key) ? key : undefined),
        put: (value, key) => { store.rows.set(store.keyPath ? value[store.keyPath] : key, value); return done(undefined); },
        delete: (key) => { store.rows.delete(key); return done(undefined); },
        clear: () => { store.rows.clear(); return done(undefined); },
      });
      return tx;
    },
  };
  return {
    stores,
    open() {
      const req = {};
      setTimeout(() => {
        req.result = db;
        if (!stores.size && req.onupgradeneeded) req.onupgradeneeded();
        req.onsuccess();
      }, 0);
      return req;
    },
  };
}

module.exports = { fakeStorage, fakeIndexedDB };
