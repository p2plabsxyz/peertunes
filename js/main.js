// Boot. Wires the library, player, wheel and screens together.

(function () {
  "use strict";

  const PT = window.PT;
  const $ = (id) => document.getElementById(id);

  let stored = {};
  try { stored = JSON.parse(localStorage.getItem("peertunes-settings") || "{}"); } catch {}
  const settings = Object.assign(
    { clicker: true, shell: "silver", shuffle: false, repeat: "off", dim: true },
    stored,
  );
  const saveSettings = () => {
    try { localStorage.setItem("peertunes-settings", JSON.stringify(settings)); } catch {}
  };

  // shell swap also flips the page backdrop (white for silver, dark for black)
  const metaTheme = document.querySelector('meta[name="theme-color"]');
  PT.applyShell = (black) => {
    document.body.classList.toggle("shell-black", black);
    if (metaTheme) metaTheme.setAttribute("content", black ? "#0b0c0f" : "#eef0f3");
  };
  PT.applyShell(settings.shell === "black");

  const library = new PT.Library();
  const player = new PT.Player($("audio"), library);
  const wheel = new PT.ClickWheel($("wheel"), $("wheel-center"));

  player.shuffle = settings.shuffle;
  player.repeat = settings.repeat;
  wheel.clicker = settings.clicker;

  const ui = new PT.UI({
    body: $("screen-body"),
    sbTitle: $("sb-title"),
    library,
    player,
    wheel,
    settings,
    saveSettings,
  });

  // ---------- mount the shared glyphs from assets/icons.js ----------

  $("sb-play").innerHTML = PT.icons.play;
  $("sb-pause").innerHTML = PT.icons.pause;
  $("sb-bt").innerHTML = PT.icons.bt;
  document.querySelector(".wz-prev").innerHTML = PT.icons.prev;
  document.querySelector(".wz-next").innerHTML = PT.icons.next;
  document.querySelector(".wz-play").innerHTML = PT.icons.playpause;

  // ---------- scale units: --u/--w are 1% of the element's height/width ----------

  function scaleUnits(el) {
    const apply = () => {
      const r = el.getBoundingClientRect();
      if (!r.height) return;
      el.style.setProperty("--u", r.height / 100 + "px");
      el.style.setProperty("--w", r.width / 100 + "px");
    };
    if (typeof ResizeObserver !== "undefined") new ResizeObserver(apply).observe(el);
    else window.addEventListener("resize", apply);
    apply();
  }
  scaleUnits($("screen"));
  scaleUnits($("wheel"));

  // ---------- status bar ----------

  // Background tabs throttle timers, so the clock also resyncs on wake.
  let clockTimer = null;
  function tickClock() {
    const now = new Date();
    $("sb-clock").textContent = now.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    clearTimeout(clockTimer);
    const msToNextMinute = 60000 - (now.getSeconds() * 1000 + now.getMilliseconds());
    clockTimer = setTimeout(tickClock, Math.max(1000, msToNextMinute));
  }
  tickClock();
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) tickClock();
  });
  window.addEventListener("focus", tickClock);
  window.addEventListener("pageshow", tickClock);

  // svg elements ignore the .hidden property, so toggle the attribute
  const show = (el, on) => { if (on) el.removeAttribute("hidden"); else el.setAttribute("hidden", ""); };

  player.addEventListener("state", () => {
    show($("sb-play"), player.playing);
    show($("sb-pause"), player.current() && !player.playing);
  });

  // Show the bluetooth mark whenever sound is routed somewhere external.
  async function updateBluetooth() {
    const el = $("sb-bt");
    try {
      if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) {
        show(el, false);
        return;
      }
      const devices = await navigator.mediaDevices.enumerateDevices();
      show(el, devices.some(PT.looksExternalAudioOutput));
    } catch {
      show(el, false);
    }
  }

  if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) {
    navigator.mediaDevices.addEventListener("devicechange", updateBluetooth);
  }
  player.addEventListener("state", updateBluetooth);
  updateBluetooth();

  // ---------- backlight dim ----------

  let dimTimer = null;
  function pokeBacklight() {
    $("screen").classList.remove("dim");
    clearTimeout(dimTimer);
    if (settings.dim) dimTimer = setTimeout(() => $("screen").classList.add("dim"), 25000);
  }
  ["pointerdown", "keydown", "wheel"].forEach((ev) => window.addEventListener(ev, pokeBacklight, { passive: true }));
  wheel.addEventListener("press", () => player.unlock());
  pokeBacklight();

  // ---------- imports ----------

  $("file-dir").addEventListener("change", (e) => {
    const files = Array.from(e.target.files);
    e.target.value = "";
    if (files.length) ui.runImport(() => library.addFiles(files));
  });
  $("file-flat").addEventListener("change", (e) => {
    const files = Array.from(e.target.files);
    e.target.value = "";
    if (files.length) ui.runImport(() => library.addFiles(files));
  });

  // drag a folder or files anywhere onto the page
  let dragDepth = 0;
  window.addEventListener("dragenter", (e) => {
    e.preventDefault();
    dragDepth++;
    document.body.classList.add("dropping");
  });
  window.addEventListener("dragleave", () => {
    if (--dragDepth <= 0) { dragDepth = 0; document.body.classList.remove("dropping"); }
  });
  window.addEventListener("dragover", (e) => e.preventDefault());
  window.addEventListener("drop", async (e) => {
    e.preventDefault();
    dragDepth = 0;
    document.body.classList.remove("dropping");
    const items = Array.from((e.dataTransfer && e.dataTransfer.items) || []);
    const files = await collectDropped(items, Array.from((e.dataTransfer && e.dataTransfer.files) || []));
    if (files.length) ui.runImport(() => library.addFiles(files));
  });

  async function collectDropped(items, fallbackFiles) {
    const out = [];
    const walkers = items
      .map((it) => (it.webkitGetAsEntry ? it.webkitGetAsEntry() : null))
      .filter(Boolean)
      .map((entry) => walkEntry(entry, out));
    if (!walkers.length) return fallbackFiles;
    await Promise.all(walkers);
    return out;
  }

  function walkEntry(entry, out) {
    return new Promise((resolve) => {
      if (entry.isFile) {
        entry.file((f) => { out.push(f); resolve(); }, resolve);
      } else if (entry.isDirectory) {
        const reader = entry.createReader();
        const readBatch = () => reader.readEntries(async (entries) => {
          if (!entries.length) return resolve();
          await Promise.all(entries.map((e2) => walkEntry(e2, out)));
          readBatch(); // readers return results in batches of 100
        }, resolve);
        readBatch();
      } else resolve();
    });
  }

  // ---------- shared links: peersky://p2p/peertunes/#playlist=<url> ----------

  function sharedSources() {
    const out = [];
    const re = /[#?&](?:playlist|src)=([^&]+)/g;
    for (const s of [location.hash, location.search]) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(s || ""))) {
        try {
          const u = decodeURIComponent(m[1]);
          if (/^(hyper|ipfs|ipns|https?):\/\//i.test(u) && !out.includes(u)) out.push(u);
        } catch {}
      }
    }
    return out;
  }

  // the recipient decides: keep it, listen once, or ignore it
  async function offerShared(urls, savedRoutes) {
    const openPlaylist = (pl) => {
      ui.push(ui.playlistsScreen());
      if (pl) ui.push(ui.playlistScreen(pl.id));
    };
    const existing = urls
      .map((u) => library.getPlaylists().find((p) => p.sourceUrl === u))
      .filter(Boolean);
    if (existing.length === urls.length) {
      // this share is already in the library, just open it
      openPlaylist(existing[0]);
      return;
    }
    ui.dialog({
      msg: "Someone shared a playlist",
      sub: urls[0] + (urls.length > 1 ? `  (+${urls.length - 1} more)` : ""),
      buttons: [
        {
          label: "Import", action: async () => {
            let first = null;
            await ui.runImport(async () => {
              let n = 0;
              for (const u of urls) {
                try {
                  const res = await library.importShared(u);
                  n += res.added;
                  if (!first) first = res.playlist;
                } catch (err) { console.warn(err); }
              }
              return n;
            }, "Syncing");
            if (first) openPlaylist(first);
          },
        },
        {
          label: "Play Only", action: async () => {
            try {
              const tracks = [];
              await ui.runTask(async () => {
                for (const u of urls) {
                  try { tracks.push(...(await library.loadRemote(u)).tracks); } catch (err) { console.warn(err); }
                }
              }, "Loading");
              if (!tracks.length) throw new Error("empty");
              player.playContext(tracks, 0);
              ui.openNowPlaying();
            } catch {
              ui.dialog({ msg: "Could not load playlist", sub: "Check the link and try again.", buttons: [{ label: "OK" }] });
            }
          },
        },
        { label: "Cancel", action: () => ui.restoreRoutes(savedRoutes) },
      ],
      defaultSel: 1,
    });
  }

  // ---------- boot ----------

  async function boot() {
    const splash = document.createElement("div");
    splash.className = "splash";
    splash.innerHTML = `<div class="sp-in"><img src="${PT.DEFAULT_COVER}" alt=""><div class="name">PeerTunes</div></div>`;
    $("screen-body").appendChild(splash);

    // read the saved page before replaceAll wipes it
    const savedRoutes = ui.loadSavedRoutes();

    try {
      await library.open();
    } catch (err) {
      console.error("library failed to open", err);
    }
    ui.replaceAll(ui.rootScreen());

    setTimeout(() => {
      splash.classList.add("bye");
      setTimeout(() => splash.remove(), 520);
    }, 650);

    const shared = sharedSources();
    if (shared.length) {
      await offerShared(shared, savedRoutes);
    } else {
      // ordinary refresh: go back to whatever page they were on
      ui.restoreRoutes(savedRoutes);
    }
  }
  boot();

  // console + testing hooks, also handy for other p2p apps to script
  window.PeerTunes = {
    library, player, ui, wheel, settings,
    addFiles: (files) => ui.runImport(() => library.addFiles(files)),
    addUrl: (url) => ui.runImport(() => library.addUrl(url)),
    importShared: (url) => library.importShared(url),
    loadRemote: (url) => library.loadRemote(url),
  };
})();
