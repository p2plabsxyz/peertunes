// Screen stack + list engine. Everything drawn inside the LCD lives here.

(function (PT) {
  "use strict";

  const ROW_H = 14.9; // in --u units (1% of screen height)
  const VISIBLE = 6;
  const REPO_URL = "https://github.com/p2plabsxyz/peertunes";
  const SHARE_BASE = "peersky://p2p/peertunes/";

  // shared art lives under assets/, glyph markup comes from assets/icons.js
  const DEFAULT_COVER = "./assets/default-cover.svg";

  function fmtTime(s) {
    if (!Number.isFinite(s) || s < 0) return "--:--";
    s = Math.floor(s);
    const m = Math.floor(s / 60);
    return `${m}:${String(s % 60).padStart(2, "0")}`;
  }

  const h = (tag, cls, html) => {
    const el = document.createElement(tag);
    if (cls) el.className = cls;
    if (html != null) el.innerHTML = html;
    return el;
  };

  const text = (tag, cls, val) => {
    const el = h(tag, cls);
    el.textContent = val;
    return el;
  };

  const u = (n) => `calc(var(--u) * ${n})`;

  // Fraction of the way along a bar that a pointer landed on, clamped so a
  // drag past either edge seeks to the start or the end rather than beyond.
  function barFraction(clientX, rect) {
    if (!rect || !rect.width) return 0;
    return Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
  }

  // clipboard api needs a secure context, the textarea trick works everywhere
  async function copyText(s) {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(s);
        return true;
      }
    } catch {}
    try {
      const ta = document.createElement("textarea");
      ta.value = s;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      const ok = document.execCommand("copy");
      ta.remove();
      return ok;
    } catch { return false; }
  }

  class UI {
    constructor(opts) {
      this.body = opts.body;
      this.sbTitle = opts.sbTitle;
      this.lib = opts.library;
      this.player = opts.player;
      this.wheel = opts.wheel;
      this.settings = opts.settings;
      this.saveSettings = opts.saveSettings;
      this.stack = [];
      this._dialog = null;

      this.wheel.addEventListener("scroll", (e) => this._onScroll(e.detail.dir));
      this.wheel.addEventListener("press", (e) => this._onPress(e.detail.btn));

      this.lib.addEventListener("changed", () => {
        const top = this.top();
        if (top && top.refreshOnLibrary) this._renderTop(false);
      });
      this.player.addEventListener("trackerror", (e) => {
        if (this._dialog) return;
        this.dialog({
          msg: "Cannot play this song",
          sub: (e.detail && e.detail.title) || "",
          buttons: [
            { label: "Skip", action: () => this.player.next() },
            { label: "OK" },
          ],
        });
      });
    }

    top() { return this.stack[this.stack.length - 1] || null; }

    push(screen) {
      this.stack.push(screen);
      this._renderTop(true, 1);
    }

    pop() {
      if (this.stack.length <= 1) return;
      const old = this.stack.pop();
      if (old.destroy) old.destroy();
      this._renderTop(true, -1);
    }

    popIf(name) {
      if (this.top() && this.top().name === name) this.pop();
    }

    replaceAll(screen) {
      for (const s of this.stack) if (s.destroy) s.destroy();
      this.stack = [screen];
      this._renderTop(false);
    }

    _renderTop(animate, dir = 1) {
      const screen = this.top();
      if (!screen) return;
      const stale = Array.from(this.body.querySelectorAll(":scope > .page"));
      const oldEl = stale[stale.length - 1] || null;
      const page = h("div", "page");
      screen.render(page, this);
      this.body.appendChild(page);
      this.sbTitle.textContent = screen.title || "PeerTunes";
      this._saveRoute();
      if (animate && oldEl && !matchMedia("(prefers-reduced-motion: reduce)").matches) {
        page.classList.add(dir > 0 ? "anim-in-right" : "anim-in-left");
        oldEl.classList.add(dir > 0 ? "anim-out-left" : "anim-out-right");
        setTimeout(() => stale.forEach((el) => el.remove()), 210);
      } else {
        stale.forEach((el) => el.remove());
      }
    }

    _onScroll(dir) {
      if (this._dialog) { this._dialogMove(dir); return; }
      const s = this.top();
      if (s && s.onScroll) s.onScroll(dir, this);
    }

    // ---------- remember the page across a refresh ----------

    // each screen carries a small `route` like ["album", key]; we persist the
    // whole stack (plus the highlighted row) and replay it on the next boot.
    _saveRoute() {
      try {
        const out = [];
        for (const s of this.stack) {
          if (!s.route) { if (s.name === "root") continue; else break; }
          const pos = typeof s.sel === "number" ? s.sel : (typeof s.idx === "number" ? s.idx : 0);
          out.push({ r: s.route, pos });
        }
        localStorage.setItem("peertunes-route", JSON.stringify(out));
      } catch {}
    }

    _saveRouteSoon() {
      clearTimeout(this._saveT);
      this._saveT = setTimeout(() => this._saveRoute(), 400);
    }

    loadSavedRoutes() {
      try { return JSON.parse(localStorage.getItem("peertunes-route") || "[]"); } catch { return []; }
    }

    restoreRoutes(saved) {
      if (!Array.isArray(saved) || !saved.length) return;
      for (const entry of saved) {
        const screen = this._screenFromRoute(entry.r);
        if (!screen) break;
        if (typeof entry.pos === "number") {
          if (screen.name === "coverflow") screen.idx = entry.pos;
          else screen.sel = entry.pos;
        }
        this.stack.push(screen);
      }
      this._renderTop(false);
    }

    _screenFromRoute(r) {
      if (!Array.isArray(r) || !r.length) return null;
      const key = r[0], arg = r[1];
      switch (key) {
        case "music": return this.lib.count ? this.musicScreen() : null;
        case "cover": return this.lib.getAlbums().length ? this.coverFlowScreen() : null;
        case "album": return this.lib.album(arg) ? this.albumScreen(arg) : null;
        case "artists": return this.lib.count ? this.artistsScreen() : null;
        case "artist": return this.lib.artist(arg) ? this.artistScreen(arg) : null;
        case "songs": return this.lib.count ? this.songsScreen() : null;
        case "genres": return this.lib.count ? this.genresScreen() : null;
        case "genre": {
          const g = this.lib.genre(arg);
          if (!g) return null;
          const list = g.tracks.slice().sort((a, b) => PT.sortName(a.title).localeCompare(PT.sortName(b.title)));
          return this.songsScreen(list, g.name, ["genre", arg]);
        }
        case "playlists": return this.playlistsScreen();
        case "playlist": return this.lib.playlist(arg) ? this.playlistScreen(arg) : null;
        case "addsongs": return this.lib.playlist(arg) ? this.addSongsScreen(arg) : null;
        case "add": return this.addScreen();
        case "settings": return this.settingsScreen();
        case "about": return this.aboutScreen();
        default: return null;
      }
    }

    _onPress(btn) {
      if (this._dialog) {
        if (btn === "select" || btn === "play") this._dialogActivate();
        else if (btn === "menu") this._closeDialog();
        return;
      }
      const s = this.top();
      if (!s) return;
      if (btn === "menu") (s.onMenu || (() => this.pop())).call(s, this);
      else if (btn === "hold") { if (s.onHold) s.onHold(this); }
      else if (btn === "select") { if (s.onSelect) s.onSelect(this); }
      else if (btn === "play") { if (s.onPlay) s.onPlay(this); else this.player.playPause(); }
      else if (btn === "prev") { if (s.onPrev) s.onPrev(this); else this.player.prev(); }
      else if (btn === "next") { if (s.onNext) s.onNext(this); else this.player.next(); }
    }

    // ---------- dialog ----------

    dialog(opts) {
      this._closeDialog();
      const buttons = opts.buttons || [{ label: "OK" }];
      const veil = h("div", "dlg-veil");
      const dlg = h("div", "dlg");
      dlg.appendChild(text("div", "dmsg", opts.msg));
      if (opts.sub) dlg.appendChild(text("div", "dsub", opts.sub));
      const btnRow = h("div", "dbtns" + (buttons.length > 2 ? " stack" : ""));
      buttons.forEach((b, i) => {
        const el = text("div", "dbtn", b.label);
        el.addEventListener("click", () => { this._dialog.sel = i; this._dialogActivate(); });
        btnRow.appendChild(el);
      });
      dlg.appendChild(btnRow);
      veil.appendChild(dlg);
      this.body.parentElement.appendChild(veil);
      const sel = opts.defaultSel != null ? opts.defaultSel : buttons.length - 1;
      this._dialog = { veil, buttons, sel, els: Array.from(btnRow.children) };
      this._dialogPaint();
    }

    _dialogPaint() {
      this._dialog.els.forEach((el, i) => el.classList.toggle("sel", i === this._dialog.sel));
    }

    _dialogMove(dir) {
      const d = this._dialog;
      const next = Math.min(d.buttons.length - 1, Math.max(0, d.sel + dir));
      if (next !== d.sel) { d.sel = next; this._dialogPaint(); this.wheel.tick(); }
    }

    _dialogActivate() {
      const d = this._dialog;
      this._closeDialog();
      const b = d.buttons[d.sel];
      if (b && b.action) b.action();
    }

    _closeDialog() {
      if (!this._dialog) return;
      this._dialog.veil.remove();
      this._dialog = null;
    }

    // ---------- list screen factory ----------

    list(opts) {
      const ui = this;
      return {
        name: opts.name,
        title: opts.title,
        route: opts.route || null,
        refreshOnLibrary: !!opts.refreshOnLibrary,
        onMenu: opts.onMenu,
        sel: 0,
        first: 0,
        render(page) {
          this.page = page;
          this.data = opts.rows();
          if (!this.data.length) {
            page.appendChild(msgEl(opts.empty || { big: "Nothing Here", small: "" }));
            return;
          }
          let host = page;
          if (opts.split) {
            const grid = h("div", "split");
            host = h("div", "list-host");
            grid.appendChild(host);
            const pane = h("div", "artpane");
            grid.appendChild(pane);
            page.appendChild(grid);
            if (opts.artPane) opts.artPane(pane);
          }
          const listEl = h("div", "list");
          this.listEl = listEl;
          this.inner = h("div", "list-inner");
          listEl.appendChild(this.inner);
          this.rail = h("div", "rail");
          this.rail.appendChild(h("div", "knob"));
          listEl.appendChild(this.rail);
          host.appendChild(listEl);
          this._touch(listEl);
          this.sel = Math.min(this.sel, this.data.length - 1);
          this.paint();
        },
        refresh() {
          if (!this.page) return;
          this.page.innerHTML = "";
          this.render(this.page);
        },
        paint() {
          const n = this.data.length;
          if (!n) return;
          if (this.sel < this.first) this.first = this.sel;
          if (this.sel > this.first + VISIBLE - 1) this.first = this.sel - VISIBLE + 1;
          this.first = Math.max(0, Math.min(this.first, Math.max(0, n - VISIBLE)));
          const start = Math.max(0, this.first - 8);
          const end = Math.min(n, this.first + VISIBLE + 8);
          this.inner.innerHTML = "";
          this.inner.style.top = u((start - this.first) * ROW_H);
          for (let i = start; i < end; i++) {
            this.inner.appendChild(this._row(this.data[i], i));
          }
          const hasRail = n > VISIBLE;
          this.listEl.classList.toggle("has-rail", hasRail);
          if (hasRail) {
            const knob = this.rail.firstChild;
            const kh = Math.max(8, (VISIBLE / n) * 89.5);
            knob.style.height = u(kh);
            knob.style.top = u((this.first / Math.max(1, n - VISIBLE)) * (89.5 - kh));
          }
        },
        _row(r, i) {
          const row = h("div", "row" + (i === this.sel ? " sel" : "") + (r.dim ? " dim" : ""));
          if (r.tnum != null) row.appendChild(text("span", "tnum", String(r.tnum)));
          if (r.thumb !== undefined) {
            const img = h("img", "thumb");
            img.src = DEFAULT_COVER;
            if (r.thumb) Promise.resolve(r.thumb).then((src) => { if (src) img.src = src; }).catch(() => {});
            row.appendChild(img);
          }
          const wrap = h("div", "lblwrap");
          wrap.appendChild(text("div", "lbl", r.label));
          if (r.sub) wrap.appendChild(text("div", "sub", r.sub));
          row.appendChild(wrap);
          if (r.value) row.appendChild(text("span", "value", r.value));
          if (r.chevron) row.appendChild(h("span", "chev", "›"));
          row.addEventListener("click", () => {
            if (this._dragged) return;
            if (this.sel !== i) { this.sel = i; this.paint(); ui.wheel.tick(); }
            if (r.action) r.action(r, ui);
          });
          if (r.hold) {
            // touch version of the center-hold gesture
            let holdT = null, downAt = null;
            row.addEventListener("pointerdown", (e) => {
              downAt = { x: e.clientX, y: e.clientY };
              holdT = setTimeout(() => {
                this._dragged = true;
                ui.wheel.tick(1.2);
                r.hold(r, ui);
              }, 550);
            });
            row.addEventListener("pointermove", (e) => {
              if (downAt && Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) > 9) clearTimeout(holdT);
            });
            const stop = () => { clearTimeout(holdT); downAt = null; };
            row.addEventListener("pointerup", stop);
            row.addEventListener("pointercancel", stop);
          }
          return row;
        },
        _touch(listEl) {
          let startY = null, lastMoved = 0;
          listEl.addEventListener("pointerdown", (e) => { startY = e.clientY; lastMoved = 0; this._dragged = false; });
          listEl.addEventListener("pointermove", (e) => {
            if (startY == null) return;
            const rowPx = listEl.getBoundingClientRect().height / VISIBLE;
            if (!rowPx) return;
            const moved = Math.round((startY - e.clientY) / rowPx);
            if (moved !== lastMoved) {
              const dir = moved > lastMoved ? 1 : -1;
              for (let k = 0; k < Math.abs(moved - lastMoved); k++) this.onScroll(dir, ui);
              lastMoved = moved;
              this._dragged = true;
            }
          });
          const done = () => { startY = null; setTimeout(() => { this._dragged = false; }, 60); };
          listEl.addEventListener("pointerup", done);
          listEl.addEventListener("pointercancel", done);
        },
        onScroll(dir) {
          const n = this.data ? this.data.length : 0;
          if (!n) return;
          const next = Math.min(n - 1, Math.max(0, this.sel + dir));
          if (next === this.sel) return;
          this.sel = next;
          this.paint();
          ui.wheel.tick();
          ui._saveRouteSoon();
        },
        onSelect() {
          const r = this.data && this.data[this.sel];
          if (r && r.action) r.action(r, ui);
        },
        onHold() {
          const r = this.data && this.data[this.sel];
          if (r && r.hold) r.hold(r, ui);
        },
      };
    }

    // ---------- screens ----------

    rootScreen() {
      const ui = this;
      return this.list({
        name: "root",
        title: "PeerTunes",
        split: true,
        refreshOnLibrary: true,
        rows: () => {
          const rows = [{ label: "Music", chevron: true, action: () => ui.push(ui.musicScreen()) }];
          if (ui.player.current()) rows.push({ label: "Now Playing", chevron: true, action: () => ui.openNowPlaying() });
          rows.push(
            { label: "Shuffle Songs", action: () => ui.shuffleAll() },
            { label: "Add Music", chevron: true, action: () => ui.push(ui.addScreen()) },
            { label: "Settings", chevron: true, action: () => ui.push(ui.settingsScreen()) },
            { label: "About", chevron: true, action: () => ui.push(ui.aboutScreen()) },
          );
          return rows;
        },
        artPane: (pane) => ui._fillArtPane(pane),
        onMenu: () => {},
      });
    }

    async _fillArtPane(pane) {
      const withArt = this.lib.getAlbums().filter((a) => a.coverId);
      if (!withArt.length) {
        pane.appendChild(h("div", "brand", PT.icons.note));
        return;
      }
      const pick = withArt.sort(() => Math.random() - 0.5).slice(0, 8);
      for (let i = 0; i < pick.length; i++) {
        const src = await this.lib.coverUrl(pick[i].coverId).catch(() => null);
        if (!src || !pane.isConnected) continue;
        const img = h("img", "float-cover");
        img.src = src;
        img.style.left = `${8 + Math.random() * 40}%`;
        img.style.top = `${4 + (i / pick.length) * 72 + Math.random() * 8}%`;
        img.style.animationDelay = `${-Math.random() * 7}s`;
        img.style.animationDuration = `${6 + Math.random() * 4}s`;
        img.style.zIndex = String(i);
        pane.appendChild(img);
      }
    }

    musicScreen() {
      const ui = this;
      return this.list({
        name: "music",
        title: "Music",
        route: ["music"],
        refreshOnLibrary: true,
        rows: () => (ui.lib.count === 0 ? [] : [
          { label: "Playlists", chevron: true, action: () => ui.push(ui.playlistsScreen()) },
          { label: "Albums", chevron: true, action: () => ui.push(ui.coverFlowScreen()) },
          { label: "Artists", chevron: true, action: () => ui.push(ui.artistsScreen()) },
          { label: "Songs", chevron: true, action: () => ui.push(ui.songsScreen()) },
          { label: "Genres", chevron: true, action: () => ui.push(ui.genresScreen()) },
        ]),
        empty: { big: "No Music", small: "Go to Add Music to load songs from a hyper:// drive or your folders." },
      });
    }

    // ---------- cover flow ----------

    coverFlowScreen() {
      const ui = this;
      return {
        name: "coverflow",
        title: "Cover Flow",
        route: ["cover"],
        refreshOnLibrary: true,
        idx: 0,
        _imgs: new Map(),
        render(page) {
          this.page = page;
          this.albums = ui.lib.getAlbums();
          if (!this.albums.length) {
            page.appendChild(msgEl({ big: "No Albums", small: "Add some music first." }));
            return;
          }
          this.stage = h("div", "cf");
          page.appendChild(this.stage);
          const cap = h("div", "cf-cap");
          this.capName = text("div", "cf-name", "");
          this.capArtist = text("div", "cf-artist", "");
          cap.appendChild(this.capName);
          cap.appendChild(this.capArtist);
          page.appendChild(cap);
          this._imgs = new Map();
          this._flick(this.stage);
          this.idx = Math.min(this.idx, this.albums.length - 1);
          this.paint();
        },
        refresh() {
          if (!this.page) return;
          this.page.innerHTML = "";
          this.render(this.page);
        },
        paint() {
          const n = this.albums.length;
          this.idx = Math.max(0, Math.min(n - 1, this.idx));
          const start = Math.max(0, this.idx - 4);
          const end = Math.min(n, this.idx + 5);
          const keep = new Set();
          for (let i = start; i < end; i++) {
            const album = this.albums[i];
            keep.add(album.key);
            let img = this._imgs.get(album.key);
            if (!img) {
              img = h("img", "cf-cover");
              img.src = DEFAULT_COVER;
              if (album.coverId) {
                ui.lib.coverUrl(album.coverId).then((src) => { if (src) img.src = src; }).catch(() => {});
              }
              img.addEventListener("click", () => {
                const at = this.albums.indexOf(album);
                if (at === this.idx) { ui.wheel.tick(1.2); this.open(); }
                else if (at >= 0) { this.idx = at; this.paint(); ui.wheel.tick(); }
              });
              this._imgs.set(album.key, img);
              this.stage.appendChild(img);
            }
            const o = i - this.idx;
            const side = o === 0 ? 0 : (o > 0 ? 1 : -1);
            const spread = o === 0 ? 0 : 58 + (Math.abs(o) - 1) * 26;
            img.style.transform =
              `translateX(calc(-50% + ${side * spread}%)) ` +
              `translateZ(${o === 0 ? u(16) : "0px"}) ` +
              `rotateY(${side * -62}deg)`;
            img.style.zIndex = String(100 - Math.abs(o));
            img.style.filter = o === 0 ? "none" : "brightness(0.72)";
          }
          for (const [key, img] of this._imgs) {
            if (!keep.has(key)) { img.remove(); this._imgs.delete(key); }
          }
          const album = this.albums[this.idx];
          this.capName.textContent = album.name;
          this.capArtist.textContent = album.artist + (album.year ? ` · ${album.year}` : "");
        },
        open() {
          ui.push(ui.albumScreen(this.albums[this.idx].key));
        },
        _flick(stage) {
          // sideways drags flip covers too
          let startX = null, lastMoved = 0;
          stage.addEventListener("pointerdown", (e) => { startX = e.clientX; lastMoved = 0; });
          stage.addEventListener("pointermove", (e) => {
            if (startX == null) return;
            const step = Math.max(40, stage.getBoundingClientRect().width / 8);
            const moved = Math.round((startX - e.clientX) / step);
            if (moved !== lastMoved) {
              this.onScroll(moved > lastMoved ? 1 : -1, ui);
              lastMoved = moved;
            }
          });
          const done = () => { startX = null; };
          stage.addEventListener("pointerup", done);
          stage.addEventListener("pointercancel", done);
        },
        onScroll(dir) {
          const next = Math.max(0, Math.min(this.albums.length - 1, this.idx + dir));
          if (next === this.idx) return;
          this.idx = next;
          this.paint();
          ui.wheel.tick();
          ui._saveRouteSoon();
        },
        onSelect() {
          if (this.albums.length) this.open();
        },
      };
    }

    albumScreen(key) {
      const ui = this;
      const album = ui.lib.album(key);
      return this.list({
        name: "album",
        title: album ? album.name : "Album",
        route: ["album", key],
        rows: () => {
          const a = ui.lib.album(key);
          if (!a) return [];
          return a.tracks.map((t, i) => ({
            label: t.title,
            tnum: t.track || i + 1,
            action: () => ui.playAndShow(a.tracks, i),
            hold: () => ui.push(ui.songActionsScreen(t)),
          })).concat([{
            label: "Delete Album…",
            dim: true,
            action: () => ui.dialog({
              msg: `Delete ${a.name}?`,
              sub: `${a.tracks.length} song${a.tracks.length === 1 ? "" : "s"} will be removed from this device.`,
              buttons: [
                {
                  label: "Delete",
                  action: async () => {
                    await ui.lib.deleteAlbum(key);
                    ui.popIf("album");
                  },
                },
                { label: "Cancel" },
              ],
            }),
          }]);
        },
        empty: { big: "Empty Album", small: "" },
      });
    }

    artistsScreen() {
      const ui = this;
      return this.list({
        name: "artists",
        title: "Artists",
        route: ["artists"],
        refreshOnLibrary: true,
        rows: () => ui.lib.getArtists().map((a) => ({
          label: a.name,
          value: String(a.tracks.length),
          chevron: true,
          action: () => ui.push(ui.artistScreen(a.key)),
        })),
        empty: { big: "No Artists", small: "Add some music first." },
      });
    }

    artistScreen(key) {
      const ui = this;
      const artist = ui.lib.artist(key);
      return this.list({
        name: "artist",
        title: artist ? artist.name : "Artist",
        route: ["artist", key],
        rows: () => {
          const a = ui.lib.artist(key);
          if (!a) return [];
          const songs = a.tracks.slice().sort((x, y) => PT.sortName(x.title).localeCompare(PT.sortName(y.title)));
          return [
            { label: "All Songs", chevron: true, action: () => ui.push(ui.songsScreen(songs, a.name)) },
          ].concat(ui.lib.albumsOfArtist(key).map((al) => ({
            label: al.name,
            sub: al.year ? String(al.year) : "",
            thumb: al.coverId ? ui.lib.coverUrl(al.coverId) : null,
            chevron: true,
            action: () => ui.push(ui.albumScreen(al.key)),
          })));
        },
      });
    }

    songsScreen(fixed = null, title = "Songs", route = null) {
      const ui = this;
      return this.list({
        name: "songs",
        title,
        route: route || (fixed ? null : ["songs"]),
        refreshOnLibrary: !fixed,
        rows: () => {
          const songs = fixed || ui.lib.getSongs();
          return songs.map((t, i) => ({
            label: t.title,
            sub: [t.artist, t.album].filter(Boolean).join(" — "),
            action: () => ui.playAndShow(songs, i),
            hold: () => ui.push(ui.songActionsScreen(t)),
          }));
        },
        empty: { big: "No Songs", small: "Add some music first." },
      });
    }

    genresScreen() {
      const ui = this;
      return this.list({
        name: "genres",
        title: "Genres",
        route: ["genres"],
        refreshOnLibrary: true,
        rows: () => ui.lib.getGenres().map((g) => ({
          label: g.name,
          value: String(g.tracks.length),
          chevron: true,
          action: () => ui.push(ui.songsScreen(
            g.tracks.slice().sort((a, b) => PT.sortName(a.title).localeCompare(PT.sortName(b.title))), g.name, ["genre", g.key])),
        })),
        empty: { big: "No Genres", small: "Add some music first." },
      });
    }

    // ---------- playlists ----------

    playlistsScreen() {
      const ui = this;
      return this.list({
        name: "playlists",
        title: "Playlists",
        route: ["playlists"],
        refreshOnLibrary: true,
        rows: () => [
          {
            label: "New Playlist…", chevron: true,
            action: () => ui.push(ui.nameEntryScreen({
              title: "New Playlist",
              placeholder: "My Mixtape",
              onDone: async (name) => {
                const pl = await ui.lib.createPlaylist(name);
                ui.pop();
                ui.push(ui.playlistScreen(pl.id));
              },
            })),
          },
        ].concat(ui.lib.getPlaylists().map((pl) => ({
          label: pl.name,
          value: String(pl.trackIds.length),
          chevron: true,
          action: () => ui.push(ui.playlistScreen(pl.id)),
        }))),
      });
    }

    playlistScreen(id) {
      const ui = this;
      const pl = ui.lib.playlist(id);
      const screen = this.list({
        name: "playlist",
        title: pl ? pl.name : "Playlist",
        route: ["playlist", id],
        refreshOnLibrary: true,
        rows: () => {
          const p = ui.lib.playlist(id);
          if (!p) return [];
          const tracks = ui.lib.playlistTracks(id);
          // actions live above the songs so sharing is easy to find
          const rows = [
            { label: "Add Songs…", chevron: true, dim: true, action: () => ui.push(ui.addSongsScreen(id)) },
            { label: "Share This Playlist…", dim: true, action: () => ui.sharePlaylist(id) },
          ];
          rows.push(...tracks.map((t, i) => ({
            label: t.title,
            tnum: i + 1,
            sub: t.artist,
            action: () => ui.playAndShow(tracks, i),
            hold: () => ui.dialog({
              msg: `Remove from ${p.name}?`,
              sub: t.title,
              buttons: [
                { label: "Remove", action: () => ui.lib.removeFromPlaylist(id, t.id) },
                { label: "Cancel" },
              ],
            }),
          })));
          rows.push({
            label: "Delete Playlist…", dim: true, action: () => ui.dialog({
              msg: `Delete ${p.name}?`,
              sub: "The songs stay in your library.",
              buttons: [
                { label: "Delete", action: () => ui.lib.deletePlaylist(id).then(() => ui.popIf("playlist")) },
                { label: "Cancel" },
              ],
            }),
          });
          return rows;
        },
      });
      // land on the first song, the action rows stay one scroll up
      if (ui.lib.playlistTracks(id).length) screen.sel = 2;
      return screen;
    }

    addSongsScreen(id) {
      const ui = this;
      const pl = ui.lib.playlist(id);
      const screen = this.list({
        name: "addsongs",
        title: pl ? `Add to ${pl.name}` : "Add Songs",
        route: ["addsongs", id],
        rows: () => {
          const p = ui.lib.playlist(id);
          if (!p) return [];
          return ui.lib.getSongs().map((t) => ({
            label: t.title,
            sub: [t.artist, t.album].filter(Boolean).join(" — "),
            value: p.trackIds.includes(t.id) ? "✓" : "",
            action: async () => {
              if (p.trackIds.includes(t.id)) await ui.lib.removeFromPlaylist(id, t.id);
              else await ui.lib.addToPlaylist(id, t.id);
              const keep = screen.sel;
              screen.refresh();
              screen.sel = keep;
              screen.paint();
            },
          }));
        },
        empty: { big: "No Songs", small: "Add some music first." },
      });
      return screen;
    }

    // On-The-Go: hold the center button (or long press a song) to land here
    // Hold a song to reach this: add it to a playlist, or remove it for good.
    songActionsScreen(track) {
      const ui = this;
      return this.list({
        name: "songactions",
        title: track.title,
        rows: () => [
          {
            label: "Add to Playlist…",
            chevron: true,
            action: () => { ui.pop(); ui.push(ui.pickPlaylistScreen(track)); },
          },
          {
            label: "Delete Song…",
            action: () => ui.dialog({
              msg: "Delete this song?",
              sub: track.title,
              buttons: [
                {
                  label: "Delete",
                  action: async () => {
                    await ui.lib.deleteTrack(track.id);
                    ui.popIf("songactions");
                  },
                },
                { label: "Cancel" },
              ],
            }),
          },
        ],
      });
    }

    pickPlaylistScreen(track) {
      const ui = this;
      return this.list({
        name: "pickpl",
        title: "Add to Playlist",
        rows: () => [
          {
            label: "New Playlist…", chevron: true,
            action: () => ui.push(ui.nameEntryScreen({
              title: "New Playlist",
              placeholder: "My Mixtape",
              onDone: async (name) => {
                const pl = await ui.lib.createPlaylist(name);
                await ui.lib.addToPlaylist(pl.id, track.id);
                ui.pop();
                ui.popIf("pickpl");
                ui.dialog({ msg: `Added to ${pl.name}`, sub: track.title, buttons: [{ label: "OK" }] });
              },
            })),
          },
        ].concat(ui.lib.getPlaylists().map((pl) => ({
          label: pl.name,
          value: String(pl.trackIds.length),
          action: async () => {
            const ok = await ui.lib.addToPlaylist(pl.id, track.id);
            ui.popIf("pickpl");
            ui.dialog({ msg: ok ? `Added to ${pl.name}` : `Already in ${pl.name}`, sub: track.title, buttons: [{ label: "OK" }] });
          },
        }))),
      });
    }

    nameEntryScreen(opts) {
      const ui = this;
      return {
        name: "nameentry",
        title: opts.title || "Name",
        render(page) {
          const box = h("div", "urlpage");
          box.innerHTML = `
            <div class="cap">${opts.title || "Name"}</div>
            <input type="text" spellcheck="false" autocomplete="off" maxlength="80">
            <div class="hint">Press the center button or Enter when done.</div>`;
          page.appendChild(box);
          this.input = box.querySelector("input");
          this.input.placeholder = opts.placeholder || "";
          this.input.value = opts.initial || "";
          this.input.addEventListener("keydown", (e) => {
            if (e.key === "Enter") { e.preventDefault(); this.onSelect(); }
          });
          setTimeout(() => this.input.focus(), 240);
        },
        onSelect() {
          const name = this.input.value.trim() || this.input.placeholder || "New Playlist";
          this.input.blur();
          Promise.resolve(opts.onDone(name)).catch((err) => console.warn(err));
        },
        onScroll() {},
      };
    }

    aboutScreen() {
      const ui = this;
      return this.list({
        name: "about",
        title: "About",
        route: ["about"],
        refreshOnLibrary: true,
        rows: () => [
          {
            label: "PeerTunes", value: "1.0.0", chevron: true,
            action: () => ui.dialog({
              msg: "Open GitHub?",
              sub: REPO_URL,
              buttons: [
                { label: "Open", action: () => { try { window.open(REPO_URL, "_blank", "noopener"); } catch {} } },
                { label: "Cancel" },
              ],
            }),
          },
          { label: "Songs", value: String(ui.lib.count) },
          { label: "Albums", value: String(ui.lib.getAlbums().length) },
          { label: "Artists", value: String(ui.lib.getArtists().length) },
          { label: "Sources", value: String(ui.lib.sources.length) },
          { label: "Made for PeerSky", value: "hyper://" },
        ],
      });
    }

    shuffleAll() {
      const songs = this.lib.getSongs();
      if (!songs.length) {
        this.dialog({ msg: "No Music", sub: "Add some songs first.", buttons: [{ label: "OK" }] });
        return;
      }
      this.player.playContext(songs, Math.floor(Math.random() * songs.length), { autoShuffle: true });
      this.openNowPlaying();
    }

    playAndShow(tracks, index) {
      this.player.playContext(tracks, index);
      this.openNowPlaying();
    }

    openNowPlaying() {
      if (this.top() && this.top().name === "now") return;
      this.push(this.nowPlayingScreen());
    }

    // ---------- now playing ----------

    nowPlayingScreen() {
      const ui = this;
      let cleanup = [];
      return {
        name: "now",
        title: "Now Playing",
        mode: "normal",
        render(page) {
          const np = h("div", "np");
          np.innerHTML = `
            <div class="np-top">
              <div class="np-art"><img alt="" src="${DEFAULT_COVER}"></div>
              <div class="np-meta">
                <div class="np-title"></div>
                <div class="np-artist"></div>
                <div class="np-album"></div>
                <div class="np-idx"><span class="idxtext"></span><span class="np-badges"></span></div>
              </div>
            </div>
            <div class="np-bottom">
              <div class="np-progress"><div class="np-fill"></div></div>
              <div class="np-times"><span class="t-el">0:00</span><span class="t-rem">-0:00</span></div>
              <div class="np-vol">${PT.icons.speaker}<div class="vbar"><div class="vfill"></div></div></div>
            </div>`;
          page.appendChild(np);
          this.np = np;
          this.els = {
            art: np.querySelector(".np-art img"),
            title: np.querySelector(".np-title"),
            artist: np.querySelector(".np-artist"),
            album: np.querySelector(".np-album"),
            idx: np.querySelector(".idxtext"),
            badges: np.querySelector(".np-badges"),
            fill: np.querySelector(".np-fill"),
            tEl: np.querySelector(".t-el"),
            tRem: np.querySelector(".t-rem"),
            vfill: np.querySelector(".vfill"),
          };
          const onTrack = () => this.paintTrack();
          const onTime = () => this.paintTime();
          const onState = () => this.paintBadges();
          ui.player.addEventListener("trackchange", onTrack);
          ui.player.addEventListener("time", onTime);
          ui.player.addEventListener("state", onState);
          cleanup = [
            () => ui.player.removeEventListener("trackchange", onTrack),
            () => ui.player.removeEventListener("time", onTime),
            () => ui.player.removeEventListener("state", onState),
          ];
          this._bindScrub(np.querySelector(".np-progress"));
          this.paintTrack();
          this.paintTime();
        },
        destroy() { cleanup.forEach((f) => f()); },
        // Touch and hold the bar to scrub: the fill follows your finger and
        // the song only jumps once you let go.
        _bindScrub(bar) {
          if (!bar) return;
          const seekTo = (clientX, commit) => {
            const d = ui.player.audio.duration;
            if (!Number.isFinite(d) || d <= 0) return;
            const fraction = barFraction(clientX, bar.getBoundingClientRect());
            const target = fraction * d;
            this.els.fill.style.width = `${fraction * 100}%`;
            this.els.tEl.textContent = fmtTime(target);
            this.els.tRem.textContent = "-" + fmtTime(Math.max(0, d - target));
            if (commit) ui.player.seekTo(target);
          };

          bar.addEventListener("pointerdown", (e) => {
            const d = ui.player.audio.duration;
            if (!Number.isFinite(d) || d <= 0) return;
            this._dragging = true;
            this.np.classList.add("scrub");
            try { bar.setPointerCapture(e.pointerId); } catch {}
            ui.wheel.tick();
            seekTo(e.clientX, false);
            e.preventDefault();
          });
          bar.addEventListener("pointermove", (e) => {
            if (this._dragging) seekTo(e.clientX, false);
          });
          const end = (e) => {
            if (!this._dragging) return;
            this._dragging = false;
            seekTo(e.clientX, true);
            ui.wheel.tick(1.2);
            if (this.mode !== "scrub") this.np.classList.remove("scrub");
          };
          bar.addEventListener("pointerup", end);
          bar.addEventListener("pointercancel", () => {
            this._dragging = false;
            if (this.mode !== "scrub") this.np.classList.remove("scrub");
            this.paintTime();
          });
        },
        async paintTrack() {
          const t = ui.player.current();
          if (!t) return;
          this.els.title.textContent = t.title;
          this.els.artist.textContent = t.artist || "Unknown Artist";
          this.els.album.textContent = t.album || "";
          this.els.idx.textContent = `${ui.player.pos + 1} of ${ui.player.queue.length}`;
          this.paintBadges();
          const cover = await ui.lib.trackCover(t).catch(() => null);
          this.els.art.src = cover || DEFAULT_COVER;
        },
        paintBadges() {
          const b = [];
          if (ui.player.shuffle) b.push(PT.icons.shuffle);
          if (ui.player.repeat === "all") b.push(PT.icons.repeat);
          if (ui.player.repeat === "one") b.push(PT.icons.repeatOne);
          this.els.badges.innerHTML = b.join("");
        },
        paintTime() {
          if (this._dragging) return;
          const a = ui.player.audio;
          const d = a.duration;
          const cur = a.currentTime || 0;
          this.els.fill.style.width = Number.isFinite(d) && d > 0 ? `${(cur / d) * 100}%` : "0%";
          this.els.tEl.textContent = fmtTime(cur);
          this.els.tRem.textContent = Number.isFinite(d) ? "-" + fmtTime(Math.max(0, d - cur)) : "--:--";
        },
        _volTimer: null,
        onScroll(dir) {
          if (this.mode === "scrub") {
            const d = ui.player.audio.duration;
            const step = Number.isFinite(d) ? Math.min(6, Math.max(1, d / 120)) : 2;
            ui.player.seekBy(dir * step);
            ui.wheel.tick();
            this.paintTime();
            return;
          }
          this.mode = "vol";
          this.np.classList.add("volmode");
          ui.player.setVolume(ui.player.audio.volume + dir * 0.05);
          this.els.vfill.style.width = `${ui.player.audio.volume * 100}%`;
          ui.wheel.tick();
          clearTimeout(this._volTimer);
          this._volTimer = setTimeout(() => {
            this.np.classList.remove("volmode");
            if (this.mode === "vol") this.mode = "normal";
          }, 1300);
        },
        onSelect() {
          if (this.mode === "scrub") {
            this.mode = "normal";
            this.np.classList.remove("scrub");
          } else {
            this.mode = "scrub";
            this.np.classList.remove("volmode");
            this.np.classList.add("scrub");
          }
        },
      };
    }

    // ---------- add music ----------

    addScreen() {
      const ui = this;
      return this.list({
        name: "add",
        title: "Add Music",
        route: ["add"],
        refreshOnLibrary: true,
        rows: () => {
          // phones rarely support folder pickers, so lead with plain files there
          const phone = matchMedia("(pointer: coarse)").matches;
          const uploads = [
            { label: "Upload Folder…", action: () => document.getElementById("file-dir").click() },
            { label: "Upload Files…", sub: phone ? "best on phones" : "", action: () => document.getElementById("file-flat").click() },
          ];
          if (phone) uploads.reverse();
          return [
            { label: "Open URL…", sub: "hyper:// ipfs:// https://", chevron: true, action: () => ui.push(ui.urlScreen()) },
            ...uploads,
            { label: "Share Library…", action: () => ui.shareLibrary() },
          { label: "Rescan Sources", value: String(ui.lib.sources.length), action: () => ui.runImport(() => ui.lib.rescan(), "Rescanning") },
          {
            label: "Reset Library…", action: () => ui.dialog({
              msg: "Erase all music?",
              sub: "Removes every song, cover and saved source from this device.",
              buttons: [
                { label: "Erase", action: () => ui.lib.clear().then(() => ui.replaceAll(ui.rootScreen())) },
                { label: "Cancel" },
              ],
            }),
          },
          ];
        },
      });
    }

    // sharing publishes the songs to a hyper:// drive, then hands out a
    // peersky://p2p/peertunes/#playlist= link that opens them on any device
    shareLibrary() {
      const tracks = this.lib.getSongs();
      if (!tracks.length) {
        this.dialog({ msg: "Nothing to share yet", sub: "Add some music first.", buttons: [{ label: "OK" }] });
        return;
      }
      this._publishAndShare("My Music", tracks, "library");
    }

    sharePlaylist(id) {
      const pl = this.lib.playlist(id);
      const tracks = this.lib.playlistTracks(id);
      if (!pl || !tracks.length) {
        this.dialog({ msg: "Playlist is empty", sub: "Add some songs to it first.", buttons: [{ label: "OK" }] });
        return;
      }
      this._publishAndShare(pl.name, tracks, pl.id);
    }

    async _publishAndShare(name, tracks, key) {
      if (this.lib.busy) return;
      try {
        const folder = await this.runTask(() => this.lib.publishShare(name, tracks, key), "Publishing");
        this._offerLink(SHARE_BASE + "#playlist=" + encodeURIComponent(folder));
      } catch (err) {
        console.warn(err);
        if (err && err.code === "NOWRITE") {
          // not inside PeerSky, so there is no drive to write to
          const urls = this.lib.sources.map((s) => s.url);
          if (urls.length) {
            this.dialog({
              msg: "Can't publish from here",
              sub: "Publishing needs PeerSky for desktop right now (mobile drives are read-only). You can still share your synced folders directly.",
              buttons: [
                { label: "Share Sources", action: () => this._offerLink(SHARE_BASE + "#" + urls.map((u) => "playlist=" + encodeURIComponent(u)).join("&")) },
                { label: "Cancel" },
              ],
              defaultSel: 0,
            });
          } else {
            this.dialog({
              msg: "Publishing needs PeerSky",
              sub: "Open PeerTunes in PeerSky for desktop to publish local songs to a hyper:// drive. Mobile drives are read-only for now.",
              buttons: [{ label: "OK" }],
            });
          }
        } else {
          this.dialog({ msg: "Could not publish", sub: "Check the connection and try again.", buttons: [{ label: "OK" }] });
        }
      }
    }

    _offerLink(link) {
      // no silent copy attempt: by now the button press is too old for the
      // clipboard api, so we ask for one fresh press on Copy instead
      const buttons = [{
        label: "Copy",
        action: async () => {
          const ok = await copyText(link);
          this.dialog({
            msg: ok ? "Link copied" : "Could not copy",
            sub: ok ? link : "Select the link below and copy it by hand.\n" + link,
            buttons: [{ label: "OK" }],
          });
        },
      }];
      if (typeof navigator.share === "function") {
        buttons.push({ label: "Share…", action: () => { navigator.share({ title: "PeerTunes", url: link }).catch(() => {}); } });
      }
      buttons.push({ label: "OK" });
      this.dialog({ msg: "Share link ready", sub: link, buttons, defaultSel: 0 });
    }

    urlScreen() {
      const ui = this;
      return {
        name: "url",
        title: "Open URL",
        render(page) {
          const box = h("div", "urlpage");
          box.innerHTML = `
            <div class="cap">Load music from a URL</div>
            <input type="url" spellcheck="false" autocapitalize="off" autocomplete="off" placeholder="hyper://…">
            <button type="button" class="urlscan">${PT.icons.qr}<span>Scan QR Code</span></button>
            <div class="hint">Point it at a hyper:// drive folder with songs, an ipfs:// folder, or a direct audio link. Press the center button or Enter to sync.</div>`;
          page.appendChild(box);
          this.input = box.querySelector("input");
          this.input.addEventListener("keydown", (e) => {
            if (e.key === "Enter") { e.preventDefault(); this.onSelect(); }
          });
          box.querySelector(".urlscan").addEventListener("click", () => {
            this.input.blur();
            ui.push(ui.scanScreen((url) => {
              ui.popIf("scan");
              ui.popIf("url");
              ui.runImport(() => ui.lib.addUrl(url), "Syncing");
            }));
          });
          setTimeout(() => this.input.focus(), 240);
        },
        onSelect() {
          const url = this.input.value.trim();
          if (!url) return;
          this.input.blur();
          ui.pop();
          ui.runImport(() => ui.lib.addUrl(url), "Syncing");
        },
        onScroll() {},
      };
    }

    // Point the camera at a QR code holding a music URL or a share link.
    // Runs inside the LCD, so the iPod look survives.
    scanScreen(onResult) {
      const ui = this;
      let stream = null;
      let detector = null;
      let timer = null;
      let stopped = false;

      const stop = () => {
        stopped = true;
        clearInterval(timer);
        if (stream) {
          for (const track of stream.getTracks()) {
            try { track.stop(); } catch {}
          }
          stream = null;
        }
      };

      return {
        name: "scan",
        title: "Scan QR",
        render(page) {
          const box = h("div", "scanpage");
          box.innerHTML = `
            <video playsinline muted autoplay></video>
            <div class="scan-frame"></div>
            <div class="scan-note">Point at a QR code</div>`;
          page.appendChild(box);
          this.note = box.querySelector(".scan-note");
          this.start(box.querySelector("video"));
        },
        destroy() { stop(); },
        async start(video) {
          const Detector = window.BarcodeDetector;
          if (!Detector || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
            this.note.textContent = "This browser cannot scan QR codes. Type the URL instead.";
            return;
          }

          try {
            detector = new Detector({ formats: ["qr_code"] });
          } catch {
            this.note.textContent = "This browser cannot scan QR codes. Type the URL instead.";
            return;
          }

          try {
            stream = await navigator.mediaDevices.getUserMedia({
              video: { facingMode: { ideal: "environment" } },
              audio: false,
            });
          } catch (err) {
            this.note.textContent = err && err.name === "NotAllowedError"
              ? "Camera access was denied."
              : "No camera available.";
            return;
          }

          if (stopped) { stop(); return; } // screen left while we were asking
          video.srcObject = stream;
          try { await video.play(); } catch {}

          timer = setInterval(async () => {
            if (stopped || !detector || video.readyState < 2) return;
            let codes = [];
            try {
              codes = await detector.detect(video);
            } catch {
              return;
            }
            for (const code of codes) {
              const url = PT.readScannedUrl(code.rawValue);
              if (!url) continue;
              stop();
              ui.wheel.tick(1.2);
              onResult(url);
              return;
            }
          }, 350);
        },
        onScroll() {},
        onSelect() {},
      };
    }

    syncScreen(label = "Sync in Progress") {
      const ui = this;
      let cleanup = null;
      return {
        name: "sync",
        title: "Sync",
        render(page) {
          const el = h("div", "sync");
          el.innerHTML = `<div class="sync-in">${PT.icons.sync}<div class="big">${label}</div><div class="count">Connecting…</div><div class="warn">Do not disconnect.</div></div>`;
          page.appendChild(el);
          const count = el.querySelector(".count");
          const onProg = (e) => { count.textContent = `${e.detail.done} of ${e.detail.total}`; };
          ui.lib.addEventListener("progress", onProg);
          cleanup = () => ui.lib.removeEventListener("progress", onProg);
        },
        destroy() { if (cleanup) cleanup(); },
        onMenu() { ui.pop(); }, // import keeps going in the background
        onScroll() {},
      };
    }

    // shows the sync screen while fn runs, then hands back the result
    async runTask(fn, label) {
      this.push(this.syncScreen(label));
      try {
        return await fn();
      } finally {
        this.popIf("sync");
      }
    }

    async runImport(fn, label = "Syncing") {
      if (this.lib.busy) return 0;
      let added = 0, failed = null;
      try {
        added = await this.runTask(fn, label);
      } catch (err) {
        console.warn(err);
        failed = err || new Error("sync failed");
      }
      if (failed) {
        const schemeMatch = /^(hyper|ipfs|ipns):/i.exec(failed.url || "");
        const p2p = !!schemeMatch;
        const scheme = schemeMatch ? schemeMatch[1].toLowerCase() : "";
        if (failed.code === "UNREACHABLE" && p2p) {
          // a page already on a p2p protocol clearly has hyper support
          const inP2p = /^(hyper|ipfs|ipns|peersky):$/i.test(location.protocol);
          this.dialog({
            msg: "Can't reach that URL",
            sub: inP2p
              ? `Nothing answered on ${scheme}://. The source may not be seeded, or this build may not carry a ${scheme}:// handler.`
              : `This browser does not speak ${scheme}://. Open PeerTunes inside PeerSky, or use an http link here.`,
            buttons: [{ label: "OK" }],
          });
        } else if (failed.code === "EMPTY") {
          this.dialog({
            msg: "No songs found",
            sub: "The folder loaded but had no audio files in it.",
            buttons: [{ label: "OK" }],
          });
        } else {
          this.dialog({ msg: "Could not sync", sub: "Check the URL and try again.", buttons: [{ label: "OK" }] });
        }
      } else {
        this.dialog({
          msg: added ? `Added ${added} song${added === 1 ? "" : "s"}` : "No new songs found",
          buttons: [{ label: "OK" }],
        });
      }
      return added;
    }

    // ---------- settings ----------

    settingsScreen() {
      const ui = this;
      const s = ui.settings;
      const screen = this.list({
        name: "settings",
        title: "Settings",
        route: ["settings"],
        rows: () => [
          {
            label: "Shuffle", value: s.shuffle ? "Songs" : "Off",
            action: () => { s.shuffle = !s.shuffle; ui.player.setShuffle(s.shuffle); commit(); },
          },
          {
            label: "Repeat", value: { off: "Off", one: "One", all: "All" }[s.repeat],
            action: () => { s.repeat = { off: "one", one: "all", all: "off" }[s.repeat]; ui.player.repeat = s.repeat; commit(); },
          },
          {
            label: "Clicker", value: s.clicker ? "On" : "Off",
            action: () => { s.clicker = !s.clicker; ui.wheel.clicker = s.clicker; commit(); },
          },
          {
            label: "Shell", value: s.shell === "black" ? "Black" : "Silver",
            action: () => {
              s.shell = s.shell === "black" ? "silver" : "black";
              PT.applyShell(s.shell === "black");
              commit();
            },
          },
          {
            label: "Backlight Dim", value: s.dim ? "On" : "Off",
            action: () => { s.dim = !s.dim; commit(); },
          },
        ],
      });
      const commit = () => {
        ui.saveSettings();
        const keep = screen.sel;
        screen.refresh();
        screen.sel = keep;
        screen.paint();
      };
      return screen;
    }
  }

  function msgEl(opts) {
    const el = h("div", "msg");
    el.innerHTML = `<div class="msg-in">${PT.icons.note}<div class="big"></div><div class="small"></div></div>`;
    el.querySelector(".big").textContent = opts.big;
    el.querySelector(".small").textContent = opts.small || "";
    return el;
  }

  PT.barFraction = barFraction;
  PT.UI = UI;
  PT.DEFAULT_COVER = DEFAULT_COVER;
  PT.fmtTime = fmtTime;
})(typeof window !== "undefined" ? (window.PT = window.PT || {}) : module.exports);
