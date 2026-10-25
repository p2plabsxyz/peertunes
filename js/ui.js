// Screen stack + list engine. Everything drawn inside the LCD lives here.

(function (PT) {
  "use strict";

  // Words in the language picked (js/i18n.js). No song is called t in this
  // file, so t is always the words.
  const { t, tp, formatNumber } = PT.i18n || require("./i18n.js").i18n;

  const ROW_H = 14.9; // in --u units (1% of screen height)
  const VISIBLE = 6;
  // How often a kept playlist on screen asks how its songs are doing, and how
  // long before it asks the host to keep its folder again.
  const KEEP_CHECK_MS = 3000;
  const KEEP_ASK_AGAIN_MS = 5 * 60 * 1000;
  // Shuffle on Now Playing goes back to the volume after this long untouched,
  // so a later turn of the wheel does not flip it by mistake.
  const SHUFFLE_MODE_MS = 4000;
  const REPO_URL = "https://github.com/p2plabsxyz/peertunes";
  // A companion tool, for people whose music is sitting in a streaming
  // playlist rather than in a folder.
  const ZIPIFY_URL = "https://github.com/akhileshthite/zipify-tunes";
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

  // Words in another language can run longer than the English the screen was
  // drawn for. A line that does not fit shrinks, never below FIT_FLOOR of its
  // size, and only then is cut short with an ellipsis. All are measured
  // before any is changed, so the page is laid out once.
  const FIT_FLOOR = 0.78;
  function fitLines(els) {
    const lines = Array.from(els);
    for (const el of lines) el.style.fontSize = "";
    const over = lines
      .filter((el) => el.isConnected && el.scrollWidth > el.clientWidth + 1)
      .map((el) => [el, el.clientWidth / el.scrollWidth, parseFloat(getComputedStyle(el).fontSize)]);
    for (const [el, ratio, size] of over) {
      el.style.fontSize = `${(size * Math.max(FIT_FLOOR, ratio - 0.01)).toFixed(2)}px`;
    }
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
      // What the host last said about each kept playlist, by playlist id.
      this._kept = new Map();
      this._keepTimer = null;
      this._keepAsked = new Map();

      this.wheel.addEventListener("scroll", (e) => this._onScroll(e.detail.dir));
      this.wheel.addEventListener("press", (e) => this._onPress(e.detail.btn));

      this.lib.addEventListener("changed", () => {
        const top = this.top();
        if (top && top.refreshOnLibrary) this._renderTop(false);
      });
      this.player.addEventListener("trackerror", (e) => {
        if (this._dialog) return;
        const track = e.detail;
        const title = (track && track.title) || "";
        // A song of a kept playlist that has not reached the device yet.
        const away = !!track && Array.from(this._kept.values()).some((s) => s.missing.has(track.id));
        this.dialog({
          msg: t("Cannot play this song"),
          sub: away ? `${title}\n${t("It is not on this device yet.")}` : title,
          buttons: [
            { label: t("Skip"), action: () => this.player.next() },
            { label: t("OK") },
          ],
        });
      });
      if (typeof document !== "undefined") {
        document.addEventListener("visibilitychange", () => { if (!document.hidden) this._watchKept(); });
      }
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
      this._fitTitle();
      fitLines(page.querySelectorAll(".row .lbl, .np-artist, .np-album"));
      this._saveRoute();
      if (animate && oldEl && !matchMedia("(prefers-reduced-motion: reduce)").matches) {
        page.classList.add(dir > 0 ? "anim-in-right" : "anim-in-left");
        oldEl.classList.add(dir > 0 ? "anim-out-left" : "anim-out-right");
        setTimeout(() => stale.forEach((el) => el.remove()), 210);
      } else {
        stale.forEach((el) => el.remove());
      }
    }

    // A title too long for its place even when shrunk takes the clock's too,
    // on that screen only.
    _fitTitle() {
      const bar = this.sbTitle.closest ? this.sbTitle.closest(".statusbar") : null;
      if (bar) bar.classList.remove("long");
      fitLines([this.sbTitle]);
      if (bar && this.sbTitle.scrollWidth > this.sbTitle.clientWidth + 1) {
        bar.classList.add("long");
        fitLines([this.sbTitle]);
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
    _routes() {
      const out = [];
      for (const s of this.stack) {
        if (!s.route) { if (s.name === "root") continue; else break; }
        const pos = typeof s.sel === "number" ? s.sel : (typeof s.idx === "number" ? s.idx : 0);
        out.push({ r: s.route, pos });
      }
      return out;
    }

    _saveRoute() {
      try {
        localStorage.setItem("peertunes-route", JSON.stringify(this._routes()));
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
          if (screen.name === "covers") screen.idx = entry.pos;
          else screen.sel = entry.pos;
        }
        this.stack.push(screen);
      }
      this._renderTop(false);
    }

    // Another language picked while the page is open: every page is made
    // again from where it is, the way a refresh puts them back, so the titles
    // change too. Whatever plays keeps playing.
    retranslate() {
      const routes = this._routes();
      this.replaceAll(this.rootScreen());
      this.restoreRoutes(routes);
    }

    _screenFromRoute(r) {
      if (!Array.isArray(r) || !r.length) return null;
      const key = r[0], arg = r[1];
      switch (key) {
        case "music": return this.lib.count ? this.musicScreen() : null;
        case "cover": return this.lib.getAlbums().length ? this.coverScreen() : null;
        case "album": return this.lib.album(arg) ? this.albumScreen(arg) : null;
        case "artists": return this.lib.count ? this.artistsScreen() : null;
        case "artist": return this.lib.artist(arg) ? this.artistScreen(arg) : null;
        case "artistsongs": {
          const a = this.lib.artist(arg);
          return a ? this.songsScreen(this._artistSongs(a), a.name, ["artistsongs", arg]) : null;
        }
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
        // the song put back at start, if there was one
        case "now": return this.player.current() ? this.nowPlayingScreen() : null;
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
      const buttons = opts.buttons || [{ label: t("OK") }];
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
        rows: opts.rows,
        sel: 0,
        first: 0,
        render(page) {
          this.page = page;
          this.data = opts.rows();
          if (opts.onRender) opts.onRender(this);
          if (!this.data.length) {
            page.appendChild(msgEl(opts.empty || { big: t("Nothing Here"), small: "" }));
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
          // With the rail in place, which narrows the rows. The first paint is
          // before the page is on screen, which fits it then.
          if (this.inner.isConnected) fitLines(this.inner.querySelectorAll(".lbl"));
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
          if (r.glyph) {
            // a small mark at the end of the row: Shuffle, or a kept song
            const mark = h("span", "glyph" + (r.glyphOff ? " off" : ""), r.glyph);
            if (r.glyphTitle) {
              mark.title = r.glyphTitle;
              mark.setAttribute("aria-label", r.glyphTitle);
            }
            row.appendChild(mark);
          }
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
          const rows = [{ label: t("Music"), chevron: true, action: () => ui.push(ui.musicScreen()) }];
          if (ui.player.current()) rows.push({ label: t("Now Playing"), chevron: true, action: () => ui.openNowPlaying() });
          rows.push(
            { label: t("Shuffle Songs"), action: () => ui.shuffleAll() },
            { label: t("Add Music"), chevron: true, action: () => ui.push(ui.addScreen()) },
            { label: t("Settings"), chevron: true, action: () => ui.push(ui.settingsScreen()) },
            { label: t("About"), chevron: true, action: () => ui.push(ui.aboutScreen()) },
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
        title: t("Music"),
        route: ["music"],
        refreshOnLibrary: true,
        rows: () => (ui.lib.count === 0 ? [] : [
          { label: t("Playlists"), chevron: true, action: () => ui.push(ui.playlistsScreen()) },
          { label: t("Albums"), chevron: true, action: () => ui.push(ui.coverScreen()) },
          { label: t("Artists"), chevron: true, action: () => ui.push(ui.artistsScreen()) },
          { label: t("Songs"), chevron: true, action: () => ui.push(ui.songsScreen()) },
          { label: t("Genres"), chevron: true, action: () => ui.push(ui.genresScreen()) },
        ]),
        empty: { big: t("No Music"), small: t("Go to Add Music to load songs from a hyper:// drive or your folders.") },
      });
    }

    // ---------- album covers ----------

    coverScreen() {
      const ui = this;
      return {
        name: "covers",
        title: t("Albums"),
        route: ["cover"],
        refreshOnLibrary: true,
        idx: 0,
        _imgs: new Map(),
        render(page) {
          this.page = page;
          this.albums = ui.lib.getAlbums();
          if (!this.albums.length) {
            page.appendChild(msgEl({ big: t("No Albums"), small: t("Add some music first.") }));
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
      const screen = this.list({
        name: "album",
        title: album ? album.name : t("Album"),
        route: ["album", key],
        rows: () => {
          const a = ui.lib.album(key);
          if (!a) return [];
          return ui._shuffleRow(a.tracks).concat(a.tracks.map((track, i) => ({
            label: track.title,
            tnum: track.track || i + 1,
            action: () => ui.playAndShow(a.tracks, i),
            hold: () => ui.push(ui.songActionsScreen(track)),
          })), [{
            label: t("Delete Album…"),
            dim: true,
            action: () => ui.dialog({
              msg: t("Delete {name}?", { name: a.name }),
              sub: tp({ one: "{count} song will be removed from this device.", other: "{count} songs will be removed from this device." }, a.tracks.length),
              buttons: [
                {
                  label: t("Delete"),
                  action: async () => {
                    await ui.lib.deleteAlbum(key);
                    ui.popIf("album");
                  },
                },
                { label: t("Cancel") },
              ],
            }),
          }]);
        },
        empty: { big: t("Empty Album"), small: "" },
      });
      // land on the first song, Shuffle stays one scroll up
      if (album) screen.sel = this._shuffleRow(album.tracks).length;
      return screen;
    }

    // "Shuffle" at the top of a list of songs: plays the whole list in a
    // random order. Nothing to shuffle in a list of one.
    _shuffleRow(tracks) {
      if (tracks.length < 2) return [];
      return [{ label: t("Shuffle"), glyph: PT.icons.shuffle, action: () => this.shufflePlay(tracks) }];
    }

    _artistSongs(artist) {
      return artist.tracks.slice().sort((x, y) => PT.sortName(x.title).localeCompare(PT.sortName(y.title)));
    }

    artistsScreen() {
      const ui = this;
      return this.list({
        name: "artists",
        title: t("Artists"),
        route: ["artists"],
        refreshOnLibrary: true,
        rows: () => ui.lib.getArtists().map((a) => ({
          label: a.name,
          value: formatNumber(a.tracks.length),
          chevron: true,
          action: () => ui.push(ui.artistScreen(a.key)),
        })),
        empty: { big: t("No Artists"), small: t("Add some music first.") },
      });
    }

    artistScreen(key) {
      const ui = this;
      const artist = ui.lib.artist(key);
      return this.list({
        name: "artist",
        title: artist ? artist.name : t("Artist"),
        route: ["artist", key],
        rows: () => {
          const a = ui.lib.artist(key);
          if (!a) return [];
          const songs = ui._artistSongs(a);
          return [
            { label: t("All Songs"), chevron: true, action: () => ui.push(ui.songsScreen(songs, a.name, ["artistsongs", key])) },
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

    songsScreen(fixed = null, title = t("Songs"), route = null) {
      const ui = this;
      const screen = this.list({
        name: "songs",
        title,
        route: route || (fixed ? null : ["songs"]),
        refreshOnLibrary: !fixed,
        rows: () => {
          const songs = fixed || ui.lib.getSongs();
          return ui._shuffleRow(songs).concat(songs.map((track, i) => ({
            label: track.title,
            sub: [track.artist, track.album].filter(Boolean).join(" — "),
            action: () => ui.playAndShow(songs, i),
            hold: () => ui.push(ui.songActionsScreen(track)),
          })));
        },
        empty: { big: t("No Songs"), small: t("Add some music first.") },
      });
      // land on the first song, Shuffle stays one scroll up
      if ((fixed ? fixed.length : ui.lib.count) > 1) screen.sel = 1;
      return screen;
    }

    genresScreen() {
      const ui = this;
      return this.list({
        name: "genres",
        title: t("Genres"),
        route: ["genres"],
        refreshOnLibrary: true,
        rows: () => ui.lib.getGenres().map((g) => ({
          label: g.name,
          value: formatNumber(g.tracks.length),
          chevron: true,
          action: () => ui.push(ui.songsScreen(
            g.tracks.slice().sort((a, b) => PT.sortName(a.title).localeCompare(PT.sortName(b.title))), g.name, ["genre", g.key])),
        })),
        empty: { big: t("No Genres"), small: t("Add some music first.") },
      });
    }

    // ---------- playlists ----------

    playlistsScreen() {
      const ui = this;
      return this.list({
        name: "playlists",
        title: t("Playlists"),
        route: ["playlists"],
        refreshOnLibrary: true,
        rows: () => [
          {
            label: t("New Playlist…"), chevron: true,
            action: () => ui.push(ui.nameEntryScreen({
              title: t("New Playlist"),
              placeholder: t("My Mixtape"),
              onDone: async (name) => {
                const pl = await ui.lib.createPlaylist(name);
                ui.pop();
                ui.push(ui.playlistScreen(pl.id));
              },
            })),
          },
        ].concat(ui.lib.getPlaylists().map((pl) => ({
          label: pl.name,
          value: formatNumber(pl.trackIds.length),
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
        title: pl ? pl.name : t("Playlist"),
        route: ["playlist", id],
        refreshOnLibrary: true,
        rows: () => {
          const p = ui.lib.playlist(id);
          if (!p) return [];
          const tracks = ui.lib.playlistTracks(id);
          // actions live above the songs so sharing is easy to find
          const rows = ui._playlistActions(p, tracks);
          // Kept for the network off: whether each song made it yet.
          const kept = ui._keepsSongs(p) ? ui._kept.get(id) || null : null;
          rows.push(...tracks.map((track, i) => {
            const row = {
              label: track.title,
              tnum: i + 1,
              sub: track.artist,
              action: () => ui.playAndShow(tracks, i),
              hold: () => ui.dialog({
                msg: t("Remove from {name}?", { name: p.name }),
                sub: track.title,
                buttons: [
                  { label: t("Remove"), action: () => ui.lib.removeFromPlaylist(id, track.id) },
                  { label: t("Cancel") },
                ],
              }),
            };
            if (kept) {
              const here = kept.here.has(track.id);
              row.glyph = here ? PT.icons.onDevice : PT.icons.offDevice;
              row.glyphOff = !here;
              row.glyphTitle = here ? t("On this device") : t("Not on this device yet");
            }
            return row;
          }));
          rows.push({
            label: t("Delete Playlist…"), dim: true, action: () => ui.dialog({
              msg: t("Delete {name}?", { name: p.name }),
              sub: t("The songs stay in your library."),
              buttons: [
                { label: t("Delete"), action: () => ui.lib.deletePlaylist(id).then(() => ui.popIf("playlist")) },
                { label: t("Cancel") },
              ],
            }),
          });
          return rows;
        },
        onRender: () => { if (screen.keepId) ui._watchKept(); },
      });
      // Set while the host keeps this playlist's songs, so they are checked
      // while it is on screen.
      Object.defineProperty(screen, "keepId", {
        get: () => {
          const p = ui.lib.playlist(id);
          return p && ui._keepsSongs(p) ? id : null;
        },
      });
      screen.onKeep = (state, before) => {
        // redrawn in place: the highlighted row and the scroll stay put
        if (!before || before.saved !== state.saved || before.total !== state.total) screen.refresh();
        // Said out loud once, so nobody has to count the marks.
        if (state.complete && before && !before.complete && !ui._dialog) {
          ui.dialog({ msg: allSavedText(state.total), sub: t("They play with the network off."), buttons: [{ label: t("OK") }] });
        }
      };
      // land on the first song, the rows above it stay one scroll up
      const tracks = ui.lib.playlistTracks(id);
      if (pl && tracks.length) screen.sel = ui._playlistActions(pl, tracks).length;
      return screen;
    }

    // The rows above a playlist's songs.
    _playlistActions(p, tracks) {
      const rows = this._shuffleRow(tracks).concat([
        { label: t("Add Songs…"), chevron: true, dim: true, action: () => this.push(this.addSongsScreen(p.id)) },
        { label: t("Share This Playlist…"), dim: true, action: () => this.sharePlaylist(p.id) },
      ]);
      // An imported playlist is a list of addresses until the folder behind
      // it is on the device. Only offered where something can actually do
      // the downloading, and only for a playlist that came from a drive.
      if (window.peerskyKeepOffline && /^hyper:\/\//i.test(p.sourceUrl || "")) {
        if (this._keepsSongs(p)) {
          const state = this._kept.get(p.id);
          rows.push({
            label: t("On This Device"),
            value: !state ? "" : state.complete
              ? t("All {count}", { count: formatNumber(state.total) })
              : t("{count} of {total}", { count: formatNumber(state.saved), total: formatNumber(state.total) }),
            dim: true,
            chevron: true,
            action: () => this.push(this.keepScreen(p.id)),
          });
        } else {
          rows.push({ label: t("Keep On This Device…"), dim: true, action: () => this.keepPlaylistOffline(p) });
        }
      }
      return rows;
    }

    addSongsScreen(id) {
      const ui = this;
      const pl = ui.lib.playlist(id);
      const screen = this.list({
        name: "addsongs",
        title: pl ? t("Add to {name}", { name: pl.name }) : t("Add Songs"),
        route: ["addsongs", id],
        rows: () => {
          const p = ui.lib.playlist(id);
          if (!p) return [];
          return ui.lib.getSongs().map((track) => ({
            label: track.title,
            sub: [track.artist, track.album].filter(Boolean).join(" — "),
            value: p.trackIds.includes(track.id) ? "✓" : "",
            action: async () => {
              if (p.trackIds.includes(track.id)) await ui.lib.removeFromPlaylist(id, track.id);
              else await ui.lib.addToPlaylist(id, track.id);
              const keep = screen.sel;
              screen.refresh();
              screen.sel = keep;
              screen.paint();
            },
          }));
        },
        empty: { big: t("No Songs"), small: t("Add some music first.") },
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
            label: t("Add to Playlist…"),
            chevron: true,
            action: () => { ui.pop(); ui.push(ui.pickPlaylistScreen(track)); },
          },
          {
            label: t("Delete Song…"),
            action: () => ui.dialog({
              msg: t("Delete this song?"),
              sub: track.title,
              buttons: [
                {
                  label: t("Delete"),
                  action: async () => {
                    await ui.lib.deleteTrack(track.id);
                    ui.popIf("songactions");
                  },
                },
                { label: t("Cancel") },
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
        title: t("Add to Playlist"),
        rows: () => [
          {
            label: t("New Playlist…"), chevron: true,
            action: () => ui.push(ui.nameEntryScreen({
              title: t("New Playlist"),
              placeholder: t("My Mixtape"),
              onDone: async (name) => {
                const pl = await ui.lib.createPlaylist(name);
                await ui.lib.addToPlaylist(pl.id, track.id);
                ui.pop();
                ui.popIf("pickpl");
                ui.dialog({ msg: t("Added to {name}", { name: pl.name }), sub: track.title, buttons: [{ label: t("OK") }] });
              },
            })),
          },
        ].concat(ui.lib.getPlaylists().map((pl) => ({
          label: pl.name,
          value: formatNumber(pl.trackIds.length),
          action: async () => {
            const ok = await ui.lib.addToPlaylist(pl.id, track.id);
            ui.popIf("pickpl");
            ui.dialog({
              msg: ok ? t("Added to {name}", { name: pl.name }) : t("Already in {name}", { name: pl.name }),
              sub: track.title,
              buttons: [{ label: t("OK") }],
            });
          },
        }))),
      });
    }

    nameEntryScreen(opts) {
      const ui = this;
      return {
        name: "nameentry",
        title: opts.title || t("Name"),
        render(page) {
          const box = h("div", "urlpage");
          box.innerHTML = `
            <div class="cap"></div>
            <input type="text" spellcheck="false" autocomplete="off" maxlength="80" dir="auto">
            <div class="hint"></div>`;
          box.querySelector(".cap").textContent = this.title;
          box.querySelector(".hint").textContent = t("Press the center button or Enter when done.");
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
          const name = this.input.value.trim() || this.input.placeholder || t("New Playlist");
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
        title: t("About"),
        route: ["about"],
        refreshOnLibrary: true,
        rows: () => [
          {
            label: "PeerTunes", value: "1.0.0", chevron: true,
            action: () => ui.dialog({
              msg: t("Open GitHub?"),
              sub: REPO_URL,
              buttons: [
                { label: t("Open"), action: () => { try { window.open(REPO_URL, "_blank", "noopener"); } catch {} } },
                { label: t("Cancel") },
              ],
            }),
          },
          { label: t("Songs"), value: formatNumber(ui.lib.count) },
          { label: t("Albums"), value: formatNumber(ui.lib.getAlbums().length) },
          { label: t("Artists"), value: formatNumber(ui.lib.getArtists().length) },
          { label: t("Sources"), value: formatNumber(ui.lib.sources.length) },
          { label: t("Made for PeerSky"), value: "hyper://" },
          { label: t("How to Use"), chevron: true, action: () => PT.showWelcome() },
        ],
      });
    }

    shuffleAll() {
      const songs = this.lib.getSongs();
      if (!songs.length) {
        this.dialog({ msg: t("No Music"), sub: t("Add some songs first."), buttons: [{ label: t("OK") }] });
        return;
      }
      this.shufflePlay(songs);
    }

    // Plays a list in a random order. Shuffle stays on afterwards, as the
    // Settings row and the mark on Now Playing both show, until turned off.
    shufflePlay(tracks) {
      if (!tracks.length) return;
      if (!this.settings.shuffle || !this.player.shuffle) {
        this.settings.shuffle = true;
        this.player.shuffle = true;
        this.saveSettings();
      }
      this.player.playContext(tracks, Math.floor(Math.random() * tracks.length));
      this.openNowPlaying();
    }

    // Shuffle on or off, from Settings or Now Playing. The queue playing now
    // is reordered, or put back in its own order.
    setShuffle(on) {
      this.settings.shuffle = on;
      this.saveSettings();
      this.player.setShuffle(on);
    }

    playAndShow(tracks, index) {
      this.player.playContext(tracks, index);
      this.openNowPlaying();
    }

    openNowPlaying() {
      if (this.top() && this.top().name === "now") return;
      this.push(this.nowPlayingScreen());
    }

    // The host asks for Now Playing with a song: the one its widget shows.
    // Whatever is playing keeps playing. Otherwise that song is made ready,
    // paused, from the queue that holds it or else from its album. A song
    // that is gone leaves the screen as it was, with a note.
    async showSong(id) {
      const player = this.player;
      const current = player.current();
      if (player.playing || !id || (current && current.id === id)) {
        if (current) this.openNowPlaying();
        return !!current;
      }
      const at = player.queue.findIndex((track) => track.id === id);
      if (at >= 0) {
        await player.cueAt(at);
      } else {
        const track = this.lib.tracks.get(id);
        if (!track) {
          this.dialog({ msg: t("Song not found"), sub: t("It is no longer in your library."), buttons: [{ label: t("OK") }] });
          return false;
        }
        const album = this.lib.albumOf(track);
        const list = album ? album.tracks : [track];
        await player.playContext(list, Math.max(0, list.indexOf(track)), { autoplay: false });
      }
      this.openNowPlaying();
      return true;
    }

    // ---------- now playing ----------

    nowPlayingScreen() {
      const ui = this;
      let cleanup = [];
      return {
        name: "now",
        title: t("Now Playing"),
        route: ["now"],
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
                <div class="np-idx"><span class="idxtext"></span><button type="button" class="np-shuffle">${PT.icons.shuffle}</button><span class="np-badges"></span></div>
              </div>
            </div>
            <div class="np-bottom">
              <div class="np-progress"><div class="np-fill"></div></div>
              <div class="np-times"><span class="t-el">0:00</span><span class="t-rem">-0:00</span></div>
              <div class="np-vol">${PT.icons.speaker}<div class="vbar"><div class="vfill"></div></div></div>
              <div class="np-shuf">${PT.icons.shuffle}<span class="np-shuf-lbl"></span><span class="np-shuf-opts"><span data-on="0"></span><span data-on="1"></span></span></div>
            </div>`;
          np.querySelector(".np-shuf-lbl").textContent = t("Shuffle");
          np.querySelector('.np-shuf-opts [data-on="0"]').textContent = t("Off");
          np.querySelector('.np-shuf-opts [data-on="1"]').textContent = t("On");
          page.appendChild(np);
          this.np = np;
          this.els = {
            art: np.querySelector(".np-art img"),
            title: np.querySelector(".np-title"),
            artist: np.querySelector(".np-artist"),
            album: np.querySelector(".np-album"),
            idx: np.querySelector(".idxtext"),
            shuffle: np.querySelector(".np-shuffle"),
            badges: np.querySelector(".np-badges"),
            shufOpts: Array.from(np.querySelectorAll(".np-shuf-opts span")),
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
            () => clearTimeout(this._shufTimer),
          ];
          // A tap on the mark turns Shuffle on or off. So does the wheel, on
          // the Shuffle stop the center button reaches after scrubbing.
          this.els.shuffle.addEventListener("click", () => {
            ui.wheel.tick();
            ui.setShuffle(!ui.player.shuffle);
          });
          // No focus from a tap, or the next Enter for the wheel draws a ring.
          this.els.shuffle.addEventListener("mousedown", (e) => e.preventDefault());
          this.els.shufOpts.forEach((el) => el.addEventListener("click", () => this._pickShuffle(el.dataset.on === "1")));
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
          const track = ui.player.current();
          if (!track) return;
          this.els.title.textContent = track.title;
          this.els.artist.textContent = track.artist || t("Unknown Artist");
          this.els.album.textContent = track.album || "";
          fitLines([this.els.artist, this.els.album]);
          this.paintBadges();
          const cover = await ui.lib.trackCover(track).catch(() => null);
          this.els.art.src = cover || DEFAULT_COVER;
        },
        paintBadges() {
          const on = ui.player.shuffle;
          // Shuffle reorders the queue, so the place in it moves too.
          this.els.idx.textContent = ui.player.current()
            ? t("{count} of {total}", { count: formatNumber(ui.player.pos + 1), total: formatNumber(ui.player.queue.length) })
            : "";
          this.els.shuffle.classList.toggle("on", on);
          this.els.shuffle.setAttribute("aria-pressed", on ? "true" : "false");
          this.els.shuffle.setAttribute("aria-label", on ? t("Shuffle is on") : t("Shuffle is off"));
          this.els.shufOpts.forEach((el) => el.classList.toggle("on", (el.dataset.on === "1") === on));
          const b = [];
          if (ui.player.repeat === "all") b.push(PT.icons.repeat);
          if (ui.player.repeat === "one") b.push(PT.icons.repeatOne);
          this.els.badges.innerHTML = b.join("");
        },
        paintTime() {
          if (this._dragging) return;
          const a = ui.player.audio;
          const d = a.duration;
          // A song put back after a restart shows where it will start from.
          const cur = ui.player.position();
          this.els.fill.style.width = Number.isFinite(d) && d > 0 ? `${Math.min(1, cur / d) * 100}%` : "0%";
          this.els.tEl.textContent = fmtTime(cur);
          this.els.tRem.textContent = Number.isFinite(d) ? "-" + fmtTime(Math.max(0, d - cur)) : "--:--";
        },
        _volTimer: null,
        _shufTimer: null,
        // The wheel on the Shuffle stop: forward is on, back is off.
        _pickShuffle(on) {
          if (on !== ui.player.shuffle) {
            ui.wheel.tick();
            ui.setShuffle(on);
          }
          this._armShuffleExit();
        },
        _armShuffleExit() {
          clearTimeout(this._shufTimer);
          this._shufTimer = setTimeout(() => {
            if (this.mode === "shuffle") this._setMode("normal");
          }, SHUFFLE_MODE_MS);
        },
        _setMode(mode) {
          this.mode = mode;
          this.np.classList.remove("volmode");
          this.np.classList.toggle("scrub", mode === "scrub");
          this.np.classList.toggle("shufmode", mode === "shuffle");
          if (mode === "shuffle") this._armShuffleExit();
          else clearTimeout(this._shufTimer);
        },
        onScroll(dir) {
          if (this.mode === "scrub") {
            const d = ui.player.audio.duration;
            const step = Number.isFinite(d) ? Math.min(6, Math.max(1, d / 120)) : 2;
            ui.player.seekBy(dir * step);
            ui.wheel.tick();
            this.paintTime();
            return;
          }
          if (this.mode === "shuffle") {
            this._pickShuffle(dir > 0);
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
        // The center button steps through scrubbing, then Shuffle, then back
        // to the volume.
        onSelect() {
          if (this.mode === "scrub") this._setMode("shuffle");
          else if (this.mode === "shuffle") this._setMode("normal");
          else this._setMode("scrub");
        },
      };
    }

    // ---------- add music ----------

    addScreen() {
      const ui = this;
      return this.list({
        name: "add",
        title: t("Add Music"),
        route: ["add"],
        refreshOnLibrary: true,
        rows: () => {
          // phones rarely support folder pickers, so lead with plain files there
          const phone = matchMedia("(pointer: coarse)").matches;
          const uploads = [
            { label: t("Upload Folder…"), action: () => document.getElementById("file-dir").click() },
            { label: t("Upload Files…"), sub: phone ? t("best on phones") : "", action: () => document.getElementById("file-flat").click() },
          ];
          if (phone) uploads.reverse();
          return [
            { label: t("Open URL…"), sub: PT.P2P_SCHEMES.includes("ipfs") ? "hyper:// ipfs:// https://" : "hyper:// https://", chevron: true, action: () => ui.push(ui.urlScreen()) },
            ...uploads,
            {
              label: "Zipify Tunes…", sub: t("download a playlist to your device first"),
              action: () => ui.dialog({
                msg: t("Open Zipify Tunes?"),
                sub: t("A tool for saving a whole playlist as files you can load here. Opens GitHub."),
                buttons: [
                  { label: t("Open"), action: () => { try { window.open(ZIPIFY_URL, "_blank", "noopener"); } catch {} } },
                  { label: t("Cancel") },
                ],
              }),
            },
            { label: t("Share Library…"), action: () => ui.shareLibrary() },
          { label: t("Rescan Sources"), value: formatNumber(ui.lib.sources.length), action: () => ui.runImport(() => ui.lib.rescan(), t("Rescanning")) },
          ];
        },
      });
    }

    // Ask PeerSky to download the folder this playlist came from, so it plays
    // with the network off. Importing only ever stored the addresses.
    async keepPlaylistOffline(pl) {
      const url = pl && pl.sourceUrl;
      if (!url) return;
      const res = await window.peerskyKeepOffline(url).catch(() => null);
      if (res && res.ok) {
        await this.lib.markSourceKept(url).catch(() => {});
        this._keepAsked.set(pl.id, Date.now());
        // A host that keeps songs one by one shows each of them arrive.
        if (this._keepsSongs(pl)) {
          this.push(this.keepScreen(pl.id));
          return;
        }
        this.dialog({
          msg: res.status === "waiting-for-wifi" ? t("Waiting for Wi-Fi") : t("Downloading"),
          sub: res.status === "waiting-for-wifi"
            ? t("The songs download as soon as you are on Wi-Fi. Settings shows how it is going.")
            : t("The songs are being saved to this device. Settings shows how it is going."),
          buttons: [{ label: t("OK") }],
        });
        return;
      }
      this.dialog({
        msg: t("Could not keep it here"),
        sub: (res && res.error) || t("Nothing answered for that folder."),
        buttons: [{ label: t("OK") }],
      });
    }

    // ---------- songs kept on the device ----------

    // The host keeps this playlist and can say which songs made it.
    _keepsSongs(pl) {
      return typeof window !== "undefined" && typeof window.peerskyKeepSongs === "function" &&
        !!pl && this.lib.isSourceKept(pl.sourceUrl);
    }

    // While a kept playlist, or its progress, is on screen and some of it is
    // still missing, ask how its songs are doing every few seconds.
    _watchKept() {
      if (this._keepTimer || typeof document === "undefined") return;
      const tick = async () => {
        const top = this.top();
        const id = top && top.keepId;
        if (!id || document.hidden || this._keptDone(id)) { this._keepTimer = null; return; }
        try {
          await this._checkKept(id);
        } catch (err) {
          console.warn("could not check kept songs", err);
        }
        this._keepTimer = setTimeout(tick, KEEP_CHECK_MS);
      };
      this._keepTimer = setTimeout(tick, 0);
    }

    // Every song saved, and no song added since.
    _keptDone(id) {
      const known = this._kept.get(id);
      return !!known && known.complete && known.list === songList(this.lib.playlistTracks(id));
    }

    async _checkKept(id) {
      const pl = this.lib.playlist(id);
      if (!pl) return null;
      const before = this._kept.get(id) || null;
      const tracks = this.lib.playlistTracks(id);
      const state = await this.lib.keepSongs(tracks, before);
      if (!state) return null;
      state.list = songList(tracks);
      this._kept.set(id, state);
      if (!state.complete) this._askAgain(pl);
      const top = this.top();
      if (top && top.keepId === id && top.onKeep) top.onKeep(state, before);
      return state;
    }

    // Songs still missing when the playlist is opened again: ask PeerSky to
    // keep its folder once more, which starts over a download that stopped.
    _askAgain(pl) {
      const last = this._keepAsked.get(pl.id) || 0;
      if (Date.now() - last < KEEP_ASK_AGAIN_MS || typeof window.peerskyKeepOffline !== "function") return;
      this._keepAsked.set(pl.id, Date.now());
      Promise.resolve(window.peerskyKeepOffline(pl.sourceUrl)).catch(() => {});
    }

    // Every song of a kept playlist as it reaches the device: how many are
    // here, which one is coming in, and why the rest are not.
    keepScreen(id) {
      const ui = this;
      return {
        name: "keep",
        title: t("On This Device"),
        keepId: id,
        render(page) {
          const el = h("div", "keep");
          el.innerHTML = `<div class="keep-in">
            <span class="keep-icon"></span>
            <div class="big"></div>
            <div class="keep-bar"><div class="keep-fill"></div></div>
            <div class="count"></div>
            <div class="keep-song"><span class="keep-now"></span> <b></b></div>
            <div class="keep-note"></div>
          </div>`;
          page.appendChild(el);
          this.els = {
            icon: el.querySelector(".keep-icon"),
            big: el.querySelector(".big"),
            fill: el.querySelector(".keep-fill"),
            count: el.querySelector(".count"),
            song: el.querySelector(".keep-song"),
            now: el.querySelector(".keep-now"),
            title: el.querySelector(".keep-song b"),
            note: el.querySelector(".keep-note"),
          };
          this.paint(ui._kept.get(id) || null);
          ui._watchKept();
        },
        onKeep(state) { if (this.els) this.paint(state); },
        paint(state) {
          const view = keepView(state);
          const els = this.els;
          if (els.icon.dataset.kind !== view.icon) {
            els.icon.dataset.kind = view.icon;
            els.icon.className = "keep-icon " + view.icon;
            els.icon.innerHTML = view.icon === "done" ? PT.icons.onDevice : view.icon === "stuck" ? PT.icons.offDevice : PT.icons.sync;
          }
          els.big.textContent = view.big;
          els.fill.style.width = `${Math.round(view.fraction * 100)}%`;
          els.count.textContent = view.count;
          els.now.textContent = view.song ? t("Now saving") : "";
          els.title.textContent = view.song;
          els.song.hidden = !view.song;
          els.note.textContent = view.note;
        },
        onScroll() {},
        onSelect() { ui.pop(); },
      };
    }

    // sharing publishes the songs to a hyper:// drive, then hands out a
    // peersky://p2p/peertunes/#playlist= link that opens them on any device
    shareLibrary() {
      const tracks = this.lib.getSongs();
      if (!tracks.length) {
        this.dialog({ msg: t("Nothing to share yet"), sub: t("Add some music first."), buttons: [{ label: t("OK") }] });
        return;
      }
      this._publishAndShare(t("My Music"), tracks, "library");
    }

    sharePlaylist(id) {
      const pl = this.lib.playlist(id);
      const tracks = this.lib.playlistTracks(id);
      if (!pl || !tracks.length) {
        this.dialog({ msg: t("Playlist is empty"), sub: t("Add some songs to it first."), buttons: [{ label: t("OK") }] });
        return;
      }
      this._publishAndShare(pl.name, tracks, pl.id);
    }

    async _publishAndShare(name, tracks, key) {
      if (this.lib.busy) return;
      try {
        const folder = await this.runTask(() => this.lib.publishShare(name, tracks, key), t("Publishing"));
        this._offerLink(SHARE_BASE + "#playlist=" + encodeURIComponent(folder));
      } catch (err) {
        console.warn(err);
        if (err && err.code === "NOWRITE") {
          // not inside PeerSky, so there is no drive to write to
          const urls = this.lib.sources.map((s) => s.url);
          if (urls.length) {
            this.dialog({
              msg: t("Can't publish from here"),
              sub: t("Publishing needs PeerTunes inside PeerSky. You can still share your synced folders directly."),
              buttons: [
                { label: t("Share Sources"), action: () => this._offerLink(SHARE_BASE + "#" + urls.map((u) => "playlist=" + encodeURIComponent(u)).join("&")) },
                { label: t("Cancel") },
              ],
              defaultSel: 0,
            });
          } else {
            this.dialog({
              msg: t("Publishing needs PeerSky"),
              sub: t("Open PeerTunes in PeerSky to publish local songs to a hyper:// drive."),
              buttons: [{ label: t("OK") }],
            });
          }
        } else {
          this.dialog({ msg: t("Could not publish"), sub: t("Check the connection and try again."), buttons: [{ label: t("OK") }] });
        }
      }
    }

    _offerLink(link) {
      // no silent copy attempt: by now the button press is too old for the
      // clipboard api, so we ask for one fresh press on Copy instead
      const buttons = [{
        label: t("Copy"),
        action: async () => {
          const ok = await copyText(link);
          // the link stays on screen after a copy, so it is never lost the
          // moment the first dialog closes
          this.dialog({
            msg: ok ? t("Link copied") : t("Could not copy"),
            sub: `${ok ? t("Send it to a friend.") : t("Select the link below and copy it by hand.")}\n${link}`,
            buttons: [{ label: t("Done") }],
          });
        },
      }];
      if (typeof navigator.share === "function") {
        buttons.push({ label: t("Share…"), action: () => { navigator.share({ title: "PeerTunes", url: link }).catch(() => {}); } });
      }
      buttons.push({ label: t("Done") });
      this.dialog({
        msg: t("Share it with other peers!"),
        sub: `${t("Anyone with this link can listen, straight from the source.")}\n${link}`,
        buttons,
        defaultSel: 0,
      });
    }

    urlScreen() {
      const ui = this;
      return {
        name: "url",
        title: t("Open URL"),
        render(page) {
          const box = h("div", "urlpage");
          box.innerHTML = `
            <div class="cap"></div>
            <input type="url" spellcheck="false" autocapitalize="off" autocomplete="off" placeholder="hyper://…">
            <button type="button" class="urlscan">${PT.icons.qr}<span></span></button>
            <div class="hint"></div>`;
          box.querySelector(".cap").textContent = t("Load music from a URL");
          box.querySelector(".urlscan span").textContent = t("Scan QR Code");
          box.querySelector(".hint").textContent = PT.P2P_SCHEMES.includes("ipfs")
            ? t("Point it at a hyper:// drive folder with songs, an ipfs:// folder, or a direct audio link. Press the center button or Enter to sync.")
            : t("Point it at a hyper:// drive folder with songs or a direct audio link. Press the center button or Enter to sync.");
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
              ui.runImport(() => ui.lib.addUrl(url), t("Syncing"));
            }));
          });
          setTimeout(() => this.input.focus(), 240);
        },
        onSelect() {
          const url = this.input.value.trim();
          if (!url) return;
          this.input.blur();
          ui.pop();
          ui.runImport(() => ui.lib.addUrl(url), t("Syncing"));
        },
        onScroll() {},
      };
    }

    // Point the camera at a QR code holding a music URL or a share link.
    // Runs inside the LCD, so the player's look survives.
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
        title: t("Scan QR"),
        render(page) {
          const box = h("div", "scanpage");
          box.innerHTML = `
            <video playsinline muted autoplay></video>
            <div class="scan-frame"></div>
            <div class="scan-note"></div>`;
          page.appendChild(box);
          this.note = box.querySelector(".scan-note");
          this.note.textContent = t("Point at a QR code");
          this.start(box.querySelector("video"));
        },
        destroy() { stop(); },
        async start(video) {
          // Inside PeerSky the shell hands us its own camera, which is the same
          // scanner the rest of the app uses and works where BarcodeDetector
          // does not exist. Fall back to the web API outside the app.
          if (typeof window.peerskyScanQr === "function") {
            video.remove();
            this.note.textContent = t("Opening the camera...");
            let scanned = null;
            try {
              scanned = await window.peerskyScanQr();
            } catch {
              scanned = null;
            }
            if (stopped) return;
            // Validate exactly like the web path does, so a QR code holding
            // something that is not a supported URL is refused either way.
            const url = scanned ? PT.readScannedUrl(scanned) : null;
            if (url) {
              stop();
              ui.wheel.tick(1.2);
              onResult(url);
              return;
            }
            this.note.textContent = scanned
              ? t("That QR code is not a link PeerTunes can play.")
              : t("Nothing scanned. Type the URL instead.");
            return;
          }

          const Detector = window.BarcodeDetector;
          if (!Detector || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
            this.note.textContent = t("This browser cannot scan QR codes. Type the URL instead.");
            return;
          }

          try {
            detector = new Detector({ formats: ["qr_code"] });
          } catch {
            this.note.textContent = t("This browser cannot scan QR codes. Type the URL instead.");
            return;
          }

          try {
            stream = await navigator.mediaDevices.getUserMedia({
              video: { facingMode: { ideal: "environment" } },
              audio: false,
            });
          } catch (err) {
            this.note.textContent = err && err.name === "NotAllowedError"
              ? t("Camera access was denied.")
              : t("No camera available.");
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

    syncScreen(label = t("Sync in Progress")) {
      const ui = this;
      let cleanup = null;
      return {
        name: "sync",
        title: t("Sync"),
        render(page) {
          const el = h("div", "sync");
          el.innerHTML = `<div class="sync-in">${PT.icons.sync}<div class="big"></div><div class="count"></div><div class="warn"></div></div>`;
          el.querySelector(".big").textContent = label;
          el.querySelector(".warn").textContent = t("Do not disconnect.");
          page.appendChild(el);
          const count = el.querySelector(".count");
          count.textContent = t("Connecting…");
          const onProg = (e) => {
            count.textContent = t("{count} of {total}", { count: formatNumber(e.detail.done), total: formatNumber(e.detail.total) });
          };
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

    async runImport(fn, label = t("Syncing")) {
      if (this.lib.busy) return 0;
      let result = { added: 0, found: 0 }, failed = null;
      try {
        result = await this.runTask(fn, label) || result;
      } catch (err) {
        console.warn(err);
        failed = err || new Error("sync failed");
      }
      if (failed) {
        const schemeMatch = /^(hyper|ipfs|ipns):/i.exec(failed.url || "");
        const p2p = !!schemeMatch;
        const scheme = schemeMatch ? schemeMatch[1].toLowerCase() : "";
        if (failed.code === "UNREACHABLE" && p2p) {
          // Inside PeerSky the protocol works, so nothing answering means
          // nobody is seeding it right now.
          const inPeerSky = /^(hyper|ipfs|ipns|peersky):$/i.test(location.protocol) ||
            typeof window.peerskyHyperAsset === "function";
          this.dialog({
            msg: t("Can't reach that URL"),
            sub: inPeerSky
              ? t("Nothing answered on {scheme}://. Nobody may be seeding it right now, or the link may be wrong.", { scheme })
              : t("This browser does not speak {scheme}://. Open PeerTunes inside PeerSky, or use an http link here.", { scheme }),
            buttons: [{ label: t("OK") }],
          });
        } else if (failed.code === "EMPTY") {
          this.dialog({
            msg: t("No songs found"),
            sub: t("The folder loaded but had no audio files in it."),
            buttons: [{ label: t("OK") }],
          });
        } else {
          this.dialog({ msg: t("Could not sync"), sub: t("Check the URL and try again."), buttons: [{ label: t("OK") }] });
        }
      } else {
        const { added, found, partial } = result;
        const already = Math.max(0, found - added);
        // "Added 1 song" after a sync of eighteen reads as a failure. It was
        // true and useless: the other seventeen were already here from a run
        // that had been interrupted. Say what is in the library now as well.
        const notes = [];
        if (already) {
          notes.push(tp({
            one: "{count} of {total} was already in your library.",
            other: "{count} of {total} were already in your library.",
          }, already, { total: formatNumber(found) }));
        }
        if (partial) notes.push(t("Some folders did not answer yet, so Rescan Sources later."));
        this.dialog({
          msg: added
            ? tp({ one: "Added {count} song", other: "Added {count} songs" }, added)
            : found ? t("Already up to date") : t("No new songs found"),
          // one sentence to a line, which reads right in every language
          sub: notes.join("\n"),
          buttons: [{ label: t("OK") }],
        });
      }
      return result.added;
    }

    // ---------- settings ----------

    settingsScreen() {
      const ui = this;
      const s = ui.settings;
      const screen = this.list({
        name: "settings",
        title: t("Settings"),
        route: ["settings"],
        rows: () => [
          {
            label: t("Shuffle"), value: s.shuffle ? t("Songs") : t("Off"),
            action: () => { ui.setShuffle(!s.shuffle); commit(); },
          },
          {
            label: t("Repeat"), value: { off: t("Off"), one: t("One"), all: t("All") }[s.repeat],
            action: () => { s.repeat = { off: "one", one: "all", all: "off" }[s.repeat]; ui.player.repeat = s.repeat; commit(); },
          },
          {
            label: t("Clicker"), value: s.clicker ? t("On") : t("Off"),
            action: () => { s.clicker = !s.clicker; ui.wheel.clicker = s.clicker; commit(); },
          },
          // The buzz on each turn of the wheel, apart from its sound.
          ...(PT.Wheel.canHaptic() ? [{
            label: t("Haptics"), value: s.haptics ? t("On") : t("Off"),
            action: () => { s.haptics = !s.haptics; ui.wheel.haptics = s.haptics; commit(); },
          }] : []),
          {
            label: t("Shell"), value: s.shell === "black" ? t("Black") : t("Silver"),
            action: () => {
              s.shell = s.shell === "black" ? "silver" : "black";
              PT.applyShell(s.shell === "black");
              commit();
            },
          },
          {
            label: t("Backlight Dim"), value: s.dim ? t("On") : t("Off"),
            action: () => { s.dim = !s.dim; commit(); },
          },
          // Moved here from Add Music, where nobody looked for it.
          {
            label: t("Clear All Songs…"), action: () => ui.dialog({
              msg: t("Clear all songs?"),
              sub: t("Removes every song, playlist and cover from this device. Playlists you shared stay shared."),
              buttons: [
                { label: t("Clear"), action: () => ui.lib.clear().then(() => ui.replaceAll(ui.rootScreen())) },
                { label: t("Cancel") },
              ],
            }),
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

  const songList = (tracks) => tracks.map((track) => track.id).join(",");

  function allSavedText(total) {
    if (!total) return t("This playlist has no songs");
    if (total === 1) return t("The song is on this device");
    return tp({ one: "{count} song is on this device", other: "All {count} songs are on this device" }, total);
  }

  // What the progress screen says for the host's latest answer about a kept
  // playlist (see keepState in library.js). A song is only counted once all
  // of it is here, and the rest always says why it is not.
  function keepView(state) {
    if (!state) return { icon: "busy", big: t("Saving Songs"), fraction: 0, count: t("Checking…"), song: "", note: "" };
    if (state.complete) {
      return { icon: "done", big: t("All Saved"), fraction: 1, count: allSavedText(state.total), song: "", note: t("They play with the network off.") };
    }
    const fraction = state.saved / state.total;
    const count = t("{count} of {total} on this device", { count: formatNumber(state.saved), total: formatNumber(state.total) });
    if (state.cannot === state.total - state.saved) {
      const note = tp({ one: "{count} is a web link, which cannot be kept.", other: "{count} are web links, which cannot be kept." }, state.cannot);
      return { icon: "stuck", big: t("On This Device"), fraction, count, song: "", note };
    }
    if (!state.current) {
      return { icon: "stuck", big: t("Waiting"), fraction, count, song: "", note: t("The rest saves when the person who shared them is back online.") };
    }
    return {
      icon: "busy",
      big: t("Saving Songs"),
      fraction,
      count,
      song: state.current.title,
      note: state.stuck ? t("Some are waiting for the person who shared them.") : "",
    };
  }

  function msgEl(opts) {
    const el = h("div", "msg");
    el.innerHTML = `<div class="msg-in">${PT.icons.note}<div class="big"></div><div class="small"></div></div>`;
    el.querySelector(".big").textContent = opts.big;
    el.querySelector(".small").textContent = opts.small || "";
    return el;
  }

  PT.barFraction = barFraction;
  PT.fitLines = fitLines;
  PT.keepView = keepView;
  PT.UI = UI;
  PT.DEFAULT_COVER = DEFAULT_COVER;
  PT.fmtTime = fmtTime;
})(typeof window !== "undefined" ? (window.PT = window.PT || {}) : module.exports);
