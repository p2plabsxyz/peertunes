// Shuffle where people look for it: a Shuffle row at the top of a list of
// songs, and a switch on Now Playing. The menu's Shuffle Songs and the
// Shuffle setting stay in step with both.
const { test } = require("node:test");
const assert = require("node:assert/strict");

function loadPT() {
  global.window = {};
  for (const file of ["../assets/icons.js", "../js/library.js", "../js/player.js", "../js/wheel.js", "../js/ui.js"]) {
    delete require.cache[require.resolve(file)];
    require(file);
  }
  return global.window.PT;
}

// Just enough of an element for the Now Playing screen's own bookkeeping.
function fakeEl(data = {}) {
  const classes = new Set();
  return {
    classes,
    classList: {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      contains: (c) => classes.has(c),
      toggle: (c, on) => {
        const want = on === undefined ? !classes.has(c) : on;
        if (want) classes.add(c); else classes.delete(c);
        return want;
      },
    },
    attrs: {},
    setAttribute(name, value) { this.attrs[name] = value; },
    style: {},
    dataset: data,
    textContent: "",
    innerHTML: "",
  };
}

const song = (id, title) => ({ id, kind: "file", title: title || `Song ${id}`, artist: "Band", album: "Record" });

function setup(PT, count = 5) {
  const tracks = Array.from({ length: count }, (_, i) => song(`s${i}`));
  const lib = new PT.Library();
  for (const t of tracks) lib.tracks.set(t.id, t);
  lib.playlists.set("p1", { id: "p1", name: "Mix", trackIds: tracks.map((t) => t.id), created: 1, sourceUrl: null });
  const audio = {
    paused: true, currentTime: 0, duration: 180, volume: 1, playbackRate: 1,
    addEventListener() {}, play() { this.paused = false; return Promise.resolve(); }, pause() { this.paused = true; },
  };
  const player = new PT.Player(audio, { trackAudioUrl: async (t) => "blob:" + t.id, trackCover: async () => null });
  const wheel = new EventTarget();
  wheel.tick = () => {};
  const settings = { shuffle: false, repeat: "off" };
  let saves = 0;
  const ui = new PT.UI({ body: null, sbTitle: null, library: lib, player, wheel, settings, saveSettings: () => { saves++; } });
  ui._renderTop = () => {};
  ui.replaceAll({ name: "root" });
  return { ui, lib, player, settings, tracks, saves: () => saves };
}

test("a playlist has Shuffle at the top and still opens on its first song", () => {
  const PT = loadPT();
  const { ui } = setup(PT);
  const screen = ui.playlistScreen("p1");
  const rows = screen.rows();
  assert.equal(rows[0].label, "Shuffle");
  assert.equal(rows[0].glyph, PT.icons.shuffle);
  assert.deepEqual(rows.slice(1, 3).map((r) => r.label), ["Add Songs…", "Share This Playlist…"]);
  assert.equal(rows[screen.sel].label, "Song s0");
});

test("albums and song lists have it too, but a list of one has nothing to shuffle", () => {
  const PT = loadPT();
  const { ui, lib } = setup(PT);
  const album = lib.getAlbums()[0];
  const albumScreen = ui.albumScreen(album.key);
  assert.equal(albumScreen.rows()[0].label, "Shuffle");
  assert.equal(albumScreen.sel, 1);

  const songs = ui.songsScreen();
  assert.equal(songs.rows()[0].label, "Shuffle");
  assert.equal(songs.sel, 1);

  const one = ui.songsScreen([song("x")], "One");
  assert.notEqual(one.rows()[0].label, "Shuffle");
  assert.equal(one.sel, 0);

  // The artist's song list is a page of its own now, so it comes back too.
  const artist = lib.getArtists()[0];
  const all = ui.artistScreen(artist.key).rows()[0];
  assert.equal(all.label, "All Songs");
  assert.deepEqual(ui._screenFromRoute(["artistsongs", artist.key]).route, ["artistsongs", artist.key]);
});

test("Shuffle plays the whole list in a random order and leaves Shuffle on", async () => {
  const PT = loadPT();
  const { ui, player, settings, tracks, saves } = setup(PT);
  ui.playlistScreen("p1").rows()[0].action();
  assert.equal(settings.shuffle, true);
  assert.equal(player.shuffle, true);
  assert.ok(saves() >= 1, "the setting is saved");
  assert.equal(ui.top().name, "now");
  assert.deepEqual(player.baseQueue.map((t) => t.id), tracks.map((t) => t.id));
  assert.deepEqual(player.queue.map((t) => t.id).sort(), tracks.map((t) => t.id).sort());
});

test("Shuffle Songs in the menu does the same for every song", () => {
  const PT = loadPT();
  const { ui, player, settings } = setup(PT);
  const row = ui.rootScreen().rows().find((r) => r.label === "Shuffle Songs");
  row.action();
  assert.equal(settings.shuffle, true);
  assert.equal(player.shuffle, true);
  assert.equal(player.queue.length, 5);
});

test("the Settings row and Now Playing turn the same Shuffle on and off", async () => {
  const PT = loadPT();
  const { ui, player, settings, tracks } = setup(PT);
  await player.playContext(tracks, 2);

  const settingsScreen = ui.settingsScreen();
  settingsScreen.data = [];
  const shuffleRow = () => settingsScreen.rows().find((r) => r.label === "Shuffle");
  assert.equal(shuffleRow().value, "Off");
  shuffleRow().action();
  assert.equal(settings.shuffle, true);
  assert.equal(player.shuffle, true);
  assert.equal(player.current().id, "s2", "the song playing stays");
  assert.equal(shuffleRow().value, "Songs");

  ui.setShuffle(false);
  assert.equal(shuffleRow().value, "Off");
  assert.deepEqual(player.queue.map((t) => t.id), tracks.map((t) => t.id), "back in the list's own order");
  assert.equal(player.pos, 2);
});

function nowPlaying(ui) {
  const np = ui.nowPlayingScreen();
  np.np = fakeEl();
  np.els = {
    idx: fakeEl(), shuffle: fakeEl(), badges: fakeEl(), vfill: fakeEl(), fill: fakeEl(), tEl: fakeEl(), tRem: fakeEl(),
    shufOpts: [fakeEl({ on: "0" }), fakeEl({ on: "1" })],
  };
  return np;
}

test("the shuffle mark on Now Playing shows whether Shuffle is on", async () => {
  const PT = loadPT();
  const { ui, player, tracks } = setup(PT);
  await player.playContext(tracks, 0);
  const np = nowPlaying(ui);
  np.paintBadges();
  assert.equal(np.els.shuffle.classList.contains("on"), false);
  assert.equal(np.els.shuffle.attrs["aria-pressed"], "false");
  ui.setShuffle(true);
  np.paintBadges();
  assert.equal(np.els.shuffle.classList.contains("on"), true);
  assert.equal(np.els.shuffle.attrs["aria-pressed"], "true");
  assert.equal(np.els.idx.textContent, "1 of 5");
  assert.equal(np.els.shufOpts[1].classList.contains("on"), true);
});

test("the center button steps through scrubbing and Shuffle, and the wheel switches it", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const PT = loadPT();
  const { ui, player, settings, tracks } = setup(PT);
  await player.playContext(tracks, 0);
  const np = nowPlaying(ui);

  np.onSelect();
  assert.equal(np.mode, "scrub");
  assert.equal(np.np.classList.contains("scrub"), true);
  np.onSelect();
  assert.equal(np.mode, "shuffle");
  assert.equal(np.np.classList.contains("scrub"), false);
  assert.equal(np.np.classList.contains("shufmode"), true);

  np.onScroll(1);
  assert.equal(player.shuffle, true);
  assert.equal(settings.shuffle, true);
  np.onScroll(1);
  assert.equal(player.shuffle, true, "forward again keeps it on");
  np.onScroll(-1);
  assert.equal(player.shuffle, false);

  np.onSelect();
  assert.equal(np.mode, "normal");
  assert.equal(np.np.classList.contains("shufmode"), false);

  // Left alone, the Shuffle stop gives the wheel back to the volume.
  np.onSelect();
  np.onSelect();
  assert.equal(np.mode, "shuffle");
  t.mock.timers.tick(4000);
  assert.equal(np.mode, "normal");
  np.onScroll(1);
  assert.equal(np.mode, "vol");
  assert.equal(player.shuffle, false, "a turn after that is the volume");
});
