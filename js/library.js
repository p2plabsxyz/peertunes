// Music library. Keeps tracks, covers, playlists and uploaded audio blobs in
// IndexedDB so the iPod stays synced between visits. Also handles publishing
// a share to a hyper:// drive and loading someone else's share.

(function (PT) {
  "use strict";

  const DB_NAME = "peertunes";
  const DB_VER = 2; // v2 adds the playlists store
  const MANIFEST_NAME = "playlist.json";

  function hash(s) {
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
    return h.toString(36) + s.length.toString(36);
  }

  function idb(db, store, mode, fn) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(store, mode);
      const out = fn(tx.objectStore(store));
      tx.oncomplete = () => resolve(out && "result" in out ? out.result : undefined);
      tx.onerror = () => reject(tx.error);
    });
  }

  const norm = (s) => (s || "").toLowerCase().trim();
  const sortName = (s) => norm(s).replace(/^the\s+/, "");
  const decodeSafe = (s) => { try { return decodeURIComponent(s); } catch { return s; } };

  // ---------- share manifest (pure helpers, covered by tests) ----------

  function buildManifest(name, entries) {
    return {
      app: "peertunes",
      version: 1,
      name: (name || "").trim() || "Shared Playlist",
      files: entries.map((e) => ({
        file: e.file,
        title: e.title || "",
        artist: e.artist || "",
        album: e.album || "",
      })),
    };
  }

  function parseManifest(data) {
    if (!data || typeof data !== "object" || !Array.isArray(data.files)) return null;
    const files = data.files
      .filter((f) => f && typeof f.file === "string" && f.file.trim())
      .slice(0, 5000)
      .map((f) => ({
        file: f.file.trim(),
        title: typeof f.title === "string" ? f.title : "",
        artist: typeof f.artist === "string" ? f.artist : "",
        album: typeof f.album === "string" ? f.album : "",
      }));
    if (!files.length) return null;
    const name = typeof data.name === "string" && data.name.trim() ? data.name.trim().slice(0, 80) : "Shared Playlist";
    return { name, files };
  }

  // manifest entries are either absolute urls or names inside the folder
  function resolveManifestFiles(base, manifest) {
    const out = [];
    for (const f of manifest.files) {
      const p = f.file;
      if (/^[a-z][a-z0-9+.-]*:\/\//i.test(p)) { out.push(p); continue; }
      const clean = p.replace(/^\.\//, "");
      if (clean.startsWith("/") || clean.split("/").some((seg) => seg === "..")) continue;
      out.push(base + clean.split("/").map(encodeURIComponent).join("/"));
    }
    return out;
  }

  // pull direct children out of an html directory listing. Handles relative
  // names, Chrome-style absolute paths, and full urls, on any url scheme.
  function parseListingHtml(html, baseUrl) {
    let base;
    try { base = new URL(baseUrl); } catch { return []; }
    const basePath = base.pathname.endsWith("/") ? base.pathname : base.pathname + "/";
    const out = [];
    const seen = new Set();
    const re = /<a\s[^>]*?href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;
    let m;
    while ((m = re.exec(html))) {
      const href = (m[1] !== undefined ? m[1] : m[2] !== undefined ? m[2] : m[3] || "").trim();
      if (!href || href.startsWith("#") || href.startsWith("?")) continue;
      let u;
      try { u = new URL(href, base); } catch { continue; }
      // origin is "null" for p2p schemes, so compare protocol and host directly
      if (u.protocol !== base.protocol || u.host !== base.host || u.search) continue;
      let rest = u.pathname;
      if (!rest.startsWith(basePath) || rest === basePath) continue;
      rest = rest.slice(basePath.length);
      const dir = rest.endsWith("/");
      if (dir) rest = rest.slice(0, -1);
      if (!rest || rest.includes("/")) continue; // only direct children
      const name = decodeSafe(rest) + (dir ? "/" : "");
      if (!seen.has(name)) { seen.add(name); out.push(name); }
    }
    return out;
  }

  // What a scanned QR code may legitimately contain: a music source, or a
  // PeerTunes share link carrying one. Anything else is rejected rather than
  // handed to fetch, since a QR code is untrusted input.
  const SCANNABLE_SCHEME = /^(hyper|ipfs|ipns|https?):\/\//i;
  const MAX_SCANNED_URL_LENGTH = 4096;

  function readScannedUrl(text) {
    const raw = String(text || "").trim();
    if (!raw || raw.length > MAX_SCANNED_URL_LENGTH) return "";
    if (/[\s<>"'`\\]/.test(raw)) return "";

    // A share link wraps the real source in ?playlist= / #src=
    const wrapped = /[#?&](?:playlist|src)=([^&]+)/.exec(raw);
    if (wrapped) {
      let inner = "";
      try { inner = decodeURIComponent(wrapped[1]); } catch { return ""; }
      return SCANNABLE_SCHEME.test(inner) ? inner : "";
    }

    return SCANNABLE_SCHEME.test(raw) ? raw : "";
  }

  function slug(s) {
    const out = (s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
    return out || "playlist";
  }

  function sanitizeFileName(s) {
    return (s || "track").replace(/[\/\\?%*:|"<>\u0000-\u001f]/g, "-").trim().slice(0, 80) || "track";
  }

  function extOf(name) {
    const m = /\.([a-z0-9]{2,5})(?:$|\?)/i.exec(name || "");
    return m ? "." + m[1].toLowerCase() : "";
  }

  class Library extends EventTarget {
    constructor() {
      super();
      this.db = null;
      this.tracks = new Map();
      this.playlists = new Map();
      this.sources = [];
      this._coverUrls = new Map();
      this._groups = null;
      this.busy = false;
    }

    async open() {
      this.db = await new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VER);
        req.onupgradeneeded = () => {
          const d = req.result;
          if (!d.objectStoreNames.contains("tracks")) d.createObjectStore("tracks", { keyPath: "id" });
          if (!d.objectStoreNames.contains("blobs")) d.createObjectStore("blobs");
          if (!d.objectStoreNames.contains("covers")) d.createObjectStore("covers");
          if (!d.objectStoreNames.contains("sources")) d.createObjectStore("sources", { keyPath: "url" });
          if (!d.objectStoreNames.contains("playlists")) d.createObjectStore("playlists", { keyPath: "id" });
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      const all = await idb(this.db, "tracks", "readonly", (s) => s.getAll());
      for (const t of all || []) this.tracks.set(t.id, t);
      const pls = await idb(this.db, "playlists", "readonly", (s) => s.getAll());
      for (const p of pls || []) this.playlists.set(p.id, p);
      this.sources = (await idb(this.db, "sources", "readonly", (s) => s.getAll())) || [];
      this._invalidate();
    }

    _invalidate() {
      this._groups = null;
      this.dispatchEvent(new CustomEvent("changed"));
    }

    _emitProgress(done, total, label) {
      this.dispatchEvent(new CustomEvent("progress", { detail: { done, total, label } }));
    }

    albumKeyOf(tags) {
      return hash(norm(tags.albumArtist || tags.artist || "unknown") + "|" + norm(tags.album || "unknown"));
    }

    async _saveTrack(track, file, picture) {
      if (picture) {
        const have = await idb(this.db, "covers", "readonly", (s) => s.getKey(track.coverId)).catch(() => null);
        if (!have) {
          await idb(this.db, "covers", "readwrite", (s) => s.put(new Blob([picture.data], { type: picture.mime }), track.coverId));
        }
      } else {
        track.coverId = null;
      }
      if (file) await idb(this.db, "blobs", "readwrite", (s) => s.put(file, track.id));
      await idb(this.db, "tracks", "readwrite", (s) => s.put(track));
      this.tracks.set(track.id, track);
    }

    // `path` is the file's url or relative path: when the file carries no
    // album tag, the folder holding it is a far better guess than "Unknown".
    _mkTrack(id, kind, tags, extra, path) {
      const album = tags.album || PT.albumFromPath(path) || "";
      return Object.assign({
        id,
        kind, // "file" | "url"
        title: tags.title || "Unknown",
        artist: tags.artist || "",
        album,
        albumArtist: tags.albumArtist || "",
        year: tags.year || null,
        genre: tags.genre || "",
        track: tags.track || null,
        disc: tags.disc || null,
        coverId: this.albumKeyOf({ ...tags, album }),
        added: Date.now(),
      }, extra);
    }

    // ---- import: local files ----

    async addFiles(files) {
      const list = Array.from(files).filter((f) => PT.isAudioName(f.name) || (f.type || "").startsWith("audio/"));
      if (!list.length) return 0;
      this.busy = true;
      let added = 0;
      const total = list.length;
      let done = 0;
      const workers = Array.from({ length: 4 }, async () => {
        while (list.length) {
          const f = list.shift();
          const id = "f" + hash(`${f.name}:${f.size}:${f.lastModified}`);
          try {
            if (!this.tracks.has(id)) {
              const tags = await PT.readTags(PT.fileSource(f));
              const track = this._mkTrack(id, "file", tags, { fileName: f.name, size: f.size }, f.webkitRelativePath || f.name);
              await this._saveTrack(track, f, tags.picture);
              added++;
            }
          } catch (err) {
            console.warn("import failed:", f.name, err);
          }
          this._emitProgress(++done, total, f.name);
        }
      });
      await Promise.all(workers);
      this.busy = false;
      if (added) {
        if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
        this._invalidate();
      }
      return added;
    }

    // ---- import: hyper:// or http(s) urls ----

    // shared by addUrl and importShared: pulls tags for every file url and
    // saves the tracks. Returns how many were new plus the ids in order.
    async _importUrls(fileUrls) {
      const total = fileUrls.length;
      let done = 0;
      let added = 0;
      let unreachable = 0;
      const ids = new Array(total).fill(null);
      const jobs = fileUrls.map((url, i) => ({ url, i }));
      const workers = Array.from({ length: 3 }, async () => {
        while (jobs.length) {
          const job = jobs.shift();
          const id = "u" + hash(job.url);
          try {
            if (!this.tracks.has(id)) {
              let tags;
              try {
                tags = await PT.readTags(await PT.urlSource(job.url));
              } catch (err) {
                // a p2p url we cannot even probe will not play either, so
                // do not fake-add it. http stays lenient: fetch can be
                // cors-blocked while the audio element still plays fine.
                if (/^(hyper|ipfs|ipns):\/\//i.test(job.url)) {
                  unreachable++;
                  console.warn("url unreachable:", job.url, err);
                  this._emitProgress(++done, total, decodeSafe(job.url.split("/").pop() || ""));
                  continue;
                }
                tags = await PT.readTags({ name: decodeSafe(job.url.split("/").pop() || ""), size: 0, read: async () => new Uint8Array(0) });
              }
              const track = this._mkTrack(id, "url", tags, { url: job.url }, job.url);
              await this._saveTrack(track, null, tags.picture);
              added++;
            }
            if (this.tracks.has(id)) ids[job.i] = id;
          } catch (err) {
            console.warn("url import failed:", job.url, err);
          }
          this._emitProgress(++done, total, decodeSafe(job.url.split("/").pop() || ""));
        }
      });
      await Promise.all(workers);
      if (added) this._invalidate();
      return { added, ids: ids.filter(Boolean), unreachable };
    }

    async _rememberSource(url) {
      await idb(this.db, "sources", "readwrite", (s) => s.put({ url, added: Date.now() }));
      if (!this.sources.find((s) => s.url === url)) this.sources.push({ url, added: Date.now() });
    }

    async addUrl(inputUrl, opts = {}) {
      const remember = opts.remember !== false;
      const url = (inputUrl || "").trim();
      if (!url) return 0;
      this.busy = true;
      try {
        const state = {};
        const files = await this._collectUrls(url, state);
        if (!files.length) {
          const err = new Error(state.rootError ? "url unreachable" : "no audio found");
          err.code = state.rootError ? "UNREACHABLE" : "EMPTY";
          err.url = url;
          throw err;
        }
        const res = await this._importUrls(files);
        if (!res.ids.length && res.unreachable === files.length) {
          const err = new Error("url unreachable");
          err.code = "UNREACHABLE";
          err.url = url;
          throw err;
        }
        if (remember && res.added) await this._rememberSource(url);
        return res.added;
      } finally {
        this.busy = false;
      }
    }

    // ---- shares ----

    // a share url is a folder with a playlist.json, a plain folder, or one file
    async resolveShared(inputUrl) {
      const url = (inputUrl || "").trim();
      if (PT.isAudioName(url.split("?")[0])) {
        return { url, name: decodeSafe(url.split("/").pop() || "Shared Song"), files: [url] };
      }
      const base = url.endsWith("/") ? url : url + "/";
      try {
        const res = await fetch(PT.mapP2p(base + MANIFEST_NAME), { headers: { Accept: "application/json" } });
        if (res.ok) {
          const manifest = parseManifest(await res.json());
          if (manifest) {
            const files = resolveManifestFiles(base, manifest);
            if (files.length) return { url, name: manifest.name, files };
          }
        }
      } catch {}
      const files = await this._collectUrls(url);
      const segs = base.split("/").filter(Boolean);
      const name = decodeSafe(segs[segs.length - 1] || "") || "Shared Playlist";
      return { url, name, files };
    }

    // "Import": saves the songs and files them under a playlist
    async importShared(url) {
      this.busy = true;
      try {
        const share = await this.resolveShared(url);
        if (!share.files.length) throw new Error("no audio found");
        const res = await this._importUrls(share.files);
        if (!res.ids.length) throw new Error("nothing imported");
        let pl = Array.from(this.playlists.values()).find((p) => p.sourceUrl === share.url);
        if (!pl) pl = await this.createPlaylist(share.name, { sourceUrl: share.url });
        let grew = false;
        for (const id of res.ids) {
          if (!pl.trackIds.includes(id)) { pl.trackIds.push(id); grew = true; }
        }
        if (grew) await this._savePlaylist(pl);
        await this._rememberSource(share.url);
        return { added: res.added, playlist: pl };
      } finally {
        this.busy = false;
      }
    }

    // "Play Only": builds throwaway tracks, nothing touches the library
    async loadRemote(url, cap = 500) {
      const share = await this.resolveShared(url);
      const files = share.files.slice(0, cap);
      const tracks = new Array(files.length).fill(null);
      let done = 0;
      const jobs = files.map((u, i) => ({ u, i }));
      const workers = Array.from({ length: 3 }, async () => {
        while (jobs.length) {
          const job = jobs.shift();
          try {
            let tags;
            try {
              tags = await PT.readTags(await PT.urlSource(job.u));
            } catch (err) {
              // same rule as importing: skip p2p urls we cannot reach at all
              if (/^(hyper|ipfs|ipns):\/\//i.test(job.u)) {
                console.warn("url unreachable:", job.u, err);
                this._emitProgress(++done, files.length, decodeSafe(job.u.split("/").pop() || ""));
                continue;
              }
              tags = await PT.readTags({ name: decodeSafe(job.u.split("/").pop() || ""), size: 0, read: async () => new Uint8Array(0) });
            }
            const t = this._mkTrack("t" + hash(job.u), "url", tags, { url: job.u, temp: true }, job.u);
            t.coverId = null;
            if (tags.picture) {
              try { t.coverUrl = URL.createObjectURL(new Blob([tags.picture.data], { type: tags.picture.mime })); } catch {}
            }
            tracks[job.i] = t;
          } catch (err) {
            console.warn("load failed:", job.u, err);
          }
          this._emitProgress(++done, files.length, decodeSafe(job.u.split("/").pop() || ""));
        }
      });
      await Promise.all(workers);
      return { name: share.name, tracks: tracks.filter(Boolean) };
    }

    // publish a set of tracks to a hyper:// drive so the share link works
    // anywhere. Local files get copied in, url tracks are listed as-is.
    async publishShare(name, tracks, key = "library") {
      const endpoints = ["hyper://localhost/?key=peertunes"];
      if (/^https?:$/.test(location.protocol)) endpoints.push(location.origin + "/?key=peertunes");
      let driveUrl = null;
      for (const ep of endpoints) {
        try {
          const res = await fetch(ep, { method: "POST" });
          if (!res.ok) continue;
          driveUrl = ((res.headers.get("Location") || "") || (await res.text())).trim();
          if (driveUrl) break;
        } catch {}
      }
      if (!driveUrl) {
        const err = new Error("no hyper write access");
        err.code = "NOWRITE";
        throw err;
      }
      if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(driveUrl)) driveUrl = new URL(driveUrl, location.href).href;
      const folder = driveUrl.replace(/\/+$/, "") + "/" + slug(name) + "-" + hash(String(key)).slice(0, 6) + "/";

      const entries = [];
      const total = tracks.length + 1;
      for (let i = 0; i < tracks.length; i++) {
        const t = tracks[i];
        if (t.kind === "url") {
          entries.push({ file: t.url, title: t.title, artist: t.artist, album: t.album });
        } else {
          const blob = await this.trackBlob(t);
          const base = t.fileName || `${String(i + 1).padStart(2, "0")} - ${t.title}${extOf(t.fileName) || ".mp3"}`;
          const fname = sanitizeFileName(base);
          const res = await fetch(folder + encodeURIComponent(fname), { method: "PUT", body: blob });
          if (!res.ok) throw new Error(`upload failed (${res.status})`);
          entries.push({ file: fname, title: t.title, artist: t.artist, album: t.album });
        }
        this._emitProgress(i + 1, total, t.title);
      }
      const manifest = buildManifest(name, entries);
      const res = await fetch(folder + MANIFEST_NAME, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(manifest, null, 2),
      });
      if (!res.ok) throw new Error(`manifest upload failed (${res.status})`);
      this._emitProgress(total, total, MANIFEST_NAME);
      return folder;
    }

    async trackBlob(track) {
      if (track.kind === "file") {
        const blob = await idb(this.db, "blobs", "readonly", (s) => s.get(track.id));
        if (!blob) throw new Error("audio blob missing");
        return blob;
      }
      const res = await fetch(PT.mapP2p(track.url));
      if (!res.ok) throw new Error(`fetch ${res.status}`);
      return res.blob();
    }

    // walk a directory url and collect audio file urls
    async _collectUrls(rootUrl, state = {}) {
      const found = [];
      if (PT.isAudioName(rootUrl.split("?")[0])) {
        found.push(rootUrl);
        return found;
      }
      const seen = new Set();
      const queue = [{ url: rootUrl.endsWith("/") ? rootUrl : rootUrl + "/", depth: 0 }];
      while (queue.length && found.length < 5000) {
        const item = queue.shift();
        if (seen.has(item.url) || item.depth > 6) continue;
        seen.add(item.url);
        let entries;
        try {
          entries = await this._listDir(item.url);
        } catch (err) {
          // maybe it was a file url without extension after all
          if (item.depth === 0) {
            const res = await fetch(PT.mapP2p(rootUrl)).catch(() => null);
            if (res && res.ok && (res.headers.get("content-type") || "").startsWith("audio/")) return [rootUrl];
            state.rootError = err;
          }
          continue;
        }
        for (const name of entries) {
          if (!name || name.startsWith(".")) continue;
          if (name.endsWith("/")) queue.push({ url: item.url + name, depth: item.depth + 1 });
          else if (PT.isAudioName(name)) found.push(item.url + encodeURIComponent(decodeSafe(name)));
        }
      }
      return found;
    }

    // hypercore-fetch style JSON listing, with an html index fallback
    async _listDir(url) {
      const res = await fetch(PT.mapP2p(url), { headers: { Accept: "application/json" } });
      if (!res.ok) throw new Error(`listing ${res.status}`);
      const ct = res.headers.get("content-type") || "";
      const normalize = (data) => data
        .map((e) => (typeof e === "string" ? e : e && (e.name || e.path || "")))
        .filter(Boolean);
      if (ct.includes("json")) {
        const data = await res.json();
        if (Array.isArray(data)) return normalize(data);
        if (data && Array.isArray(data.files)) return normalize(data.files);
        throw new Error("unexpected listing");
      }
      const text = await res.text();
      // some handlers send json without the content type
      const trimmed = text.trim();
      if (trimmed.startsWith("[")) {
        try {
          const data = JSON.parse(trimmed);
          if (Array.isArray(data)) return normalize(data);
        } catch {}
      }
      return parseListingHtml(text, url);
    }

    async rescan() {
      let added = 0;
      for (const s of this.sources) {
        try { added += await this.addUrl(s.url, { remember: false }); } catch {}
      }
      return added;
    }

    async clear() {
      for (const store of ["tracks", "blobs", "covers", "sources", "playlists"]) {
        await idb(this.db, store, "readwrite", (s) => s.clear());
      }
      this.tracks.clear();
      this.playlists.clear();
      this.sources = [];
      for (const u of this._coverUrls.values()) if (u) URL.revokeObjectURL(u);
      this._coverUrls.clear();
      this._invalidate();
    }

    // ---- playlists ----

    async createPlaylist(name, opts = {}) {
      const id = "p" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      const pl = {
        id,
        name: (name || "").trim().slice(0, 80) || "New Playlist",
        trackIds: [],
        created: Date.now(),
        sourceUrl: opts.sourceUrl || null,
      };
      this.playlists.set(id, pl);
      await idb(this.db, "playlists", "readwrite", (s) => s.put(pl));
      this._invalidate();
      return pl;
    }

    async _savePlaylist(pl) {
      await idb(this.db, "playlists", "readwrite", (s) => s.put(pl));
      this._invalidate();
    }

    // Remove a song everywhere: the record, its audio, any playlist that
    // referenced it, and its cover once no other song shares that album.
    async deleteTrack(id) {
      const track = this.tracks.get(id);
      if (!track) return false;

      this.tracks.delete(id);
      await idb(this.db, "tracks", "readwrite", (s) => s.delete(id));
      if (track.kind === "file") {
        await idb(this.db, "blobs", "readwrite", (s) => s.delete(id)).catch(() => {});
      }

      for (const pl of this.playlists.values()) {
        if (!pl.trackIds.includes(id)) continue;
        pl.trackIds = pl.trackIds.filter((t) => t !== id);
        await idb(this.db, "playlists", "readwrite", (s) => s.put(pl)).catch(() => {});
      }

      if (track.coverId) {
        const stillUsed = Array.from(this.tracks.values()).some((t) => t.coverId === track.coverId);
        if (!stillUsed) {
          await idb(this.db, "covers", "readwrite", (s) => s.delete(track.coverId)).catch(() => {});
          const url = this._coverUrls.get(track.coverId);
          if (url) URL.revokeObjectURL(url);
          this._coverUrls.delete(track.coverId);
        }
      }

      this._invalidate();
      return true;
    }

    // Remove every song on an album in one go.
    async deleteAlbum(key) {
      const album = this.album(key);
      if (!album) return 0;
      const ids = album.tracks.map((t) => t.id);
      let removed = 0;
      for (const id of ids) {
        if (await this.deleteTrack(id)) removed++;
      }
      return removed;
    }

    async deletePlaylist(id) {
      this.playlists.delete(id);
      await idb(this.db, "playlists", "readwrite", (s) => s.delete(id));
      this._invalidate();
    }

    async addToPlaylist(id, trackId) {
      const pl = this.playlists.get(id);
      if (!pl || !this.tracks.has(trackId)) return false;
      if (pl.trackIds.includes(trackId)) return false;
      pl.trackIds.push(trackId);
      await this._savePlaylist(pl);
      return true;
    }

    async removeFromPlaylist(id, trackId) {
      const pl = this.playlists.get(id);
      if (!pl) return;
      pl.trackIds = pl.trackIds.filter((t) => t !== trackId);
      await this._savePlaylist(pl);
    }

    getPlaylists() {
      return Array.from(this.playlists.values()).sort((a, b) => a.created - b.created);
    }

    playlist(id) { return this.playlists.get(id) || null; }

    playlistTracks(id) {
      const pl = this.playlists.get(id);
      if (!pl) return [];
      return pl.trackIds.map((t) => this.tracks.get(t)).filter(Boolean);
    }

    // ---- playback data ----

    async trackAudioUrl(track) {
      if (track.kind === "url") return PT.mapP2p(track.url);
      const blob = await idb(this.db, "blobs", "readonly", (s) => s.get(track.id));
      if (!blob) throw new Error("audio blob missing");
      return URL.createObjectURL(blob);
    }

    // temp tracks from Play Only carry their own cover url
    async trackCover(track) {
      if (!track) return null;
      if (track.coverUrl) return track.coverUrl;
      return this.coverUrl(track.coverId);
    }

    async coverUrl(coverId) {
      if (!coverId) return null;
      if (this._coverUrls.has(coverId)) return this._coverUrls.get(coverId);
      const blob = await idb(this.db, "covers", "readonly", (s) => s.get(coverId)).catch(() => null);
      if (!blob) {
        this._coverUrls.set(coverId, null);
        return null;
      }
      const u = URL.createObjectURL(blob);
      this._coverUrls.set(coverId, u);
      return u;
    }

    // ---- grouping ----

    _group() {
      if (this._groups) return this._groups;
      const albums = new Map();
      const artists = new Map();
      const genres = new Map();
      for (const t of this.tracks.values()) {
        const albumName = t.album || "Unknown Album";
        const albumArtist = t.albumArtist || t.artist || "Unknown Artist";
        const aKey = norm(albumArtist) + "|" + norm(albumName);
        if (!albums.has(aKey)) {
          albums.set(aKey, { key: aKey, name: albumName, artist: albumArtist, year: t.year, coverId: null, tracks: [] });
        }
        const album = albums.get(aKey);
        album.tracks.push(t);
        if (!album.coverId && t.coverId) album.coverId = t.coverId;
        if (t.year && (!album.year || t.year < album.year)) album.year = t.year;

        const artistName = t.artist || t.albumArtist || "Unknown Artist";
        const arKey = norm(artistName);
        if (!artists.has(arKey)) artists.set(arKey, { key: arKey, name: artistName, albums: new Set(), tracks: [] });
        artists.get(arKey).albums.add(aKey);
        artists.get(arKey).tracks.push(t);

        const genreName = t.genre || "Unknown Genre";
        const gKey = norm(genreName);
        if (!genres.has(gKey)) genres.set(gKey, { key: gKey, name: genreName, tracks: [] });
        genres.get(gKey).tracks.push(t);
      }
      for (const album of albums.values()) {
        album.tracks.sort((a, b) => (a.disc || 1) - (b.disc || 1) || (a.track || 999) - (b.track || 999) || a.title.localeCompare(b.title));
      }
      this._groups = { albums, artists, genres };
      return this._groups;
    }

    getAlbums() {
      const g = this._group();
      return Array.from(g.albums.values()).sort((a, b) => sortName(a.name).localeCompare(sortName(b.name), undefined, { numeric: true }));
    }

    getArtists() {
      const g = this._group();
      return Array.from(g.artists.values()).sort((a, b) => sortName(a.name).localeCompare(sortName(b.name)));
    }

    getGenres() {
      const g = this._group();
      return Array.from(g.genres.values()).sort((a, b) => sortName(a.name).localeCompare(sortName(b.name)));
    }

    getSongs() {
      return Array.from(this.tracks.values()).sort((a, b) => sortName(a.title).localeCompare(sortName(b.title), undefined, { numeric: true }));
    }

    albumsOfArtist(artistKey) {
      const g = this._group();
      const artist = g.artists.get(artistKey);
      if (!artist) return [];
      return Array.from(artist.albums).map((k) => g.albums.get(k)).filter(Boolean)
        .sort((a, b) => (a.year || 9999) - (b.year || 9999) || sortName(a.name).localeCompare(sortName(b.name)));
    }

    album(key) { return this._group().albums.get(key) || null; }
    artist(key) { return this._group().artists.get(key) || null; }
    genre(key) { return this._group().genres.get(key) || null; }

    get count() { return this.tracks.size; }
  }

  PT.Library = Library;
  PT.sortName = sortName;
  PT.buildManifest = buildManifest;
  PT.parseManifest = parseManifest;
  PT.resolveManifestFiles = resolveManifestFiles;
  PT.parseListingHtml = parseListingHtml;
  PT.readScannedUrl = readScannedUrl;
})(typeof window !== "undefined" ? (window.PT = window.PT || {}) : module.exports);
