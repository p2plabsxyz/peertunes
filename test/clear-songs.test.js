// Clearing the songs. PeerSky's Clear all P2P data on a phone left every song
// in PeerTunes, whose library lives in the page's own storage, out of reach of
// the clear. Clearing them by hand was under Add Music, where nobody looked.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const read = (file) => fs.readFileSync(path.join(__dirname, "..", file), "utf8");

function loadPT() {
  global.window = {};
  for (const file of ["../assets/icons.js", "../js/library.js", "../js/player.js", "../js/wheel.js", "../js/ui.js"]) {
    delete require.cache[require.resolve(file)];
    require(file);
  }
  return global.window.PT;
}

const { fakeStorage, fakeIndexedDB } = require("./fake-storage.js");

const song = (id) => ({ id, kind: "file", title: `Song ${id}`, artist: "Band", album: "Record" });
const FIRST_RESET = "a".repeat(32);
const NEXT_RESET = "b".repeat(32);

// The library as one page load opens it, with the id PeerSky handed the page.
async function openLibrary(PT, resetId) {
  global.window.peerskyResetId = resetId;
  const lib = new PT.Library();
  await lib.open();
  return lib;
}

test("songs kept before PeerSky cleared its P2P data go with it, and the first id is only noted", async () => {
  global.localStorage = fakeStorage();
  global.indexedDB = fakeIndexedDB();
  const PT = loadPT();

  // The first page to see an id keeps everything: nothing says it is old.
  let lib = await openLibrary(PT, FIRST_RESET);
  await lib._saveTrack(song("a1"), null, null);
  await lib.createPlaylist("Mix");
  assert.equal(localStorage.getItem("peertunes.host-reset"), FIRST_RESET);

  // Opened again after a restart, with the same id: all of it is there.
  lib = await openLibrary(PT, FIRST_RESET);
  assert.deepEqual([...lib.tracks.keys()], ["a1"]);
  assert.equal(lib.playlists.size, 1);

  // P2P data was cleared since: a new id. The songs, the playlists and the
  // drive this library published go, from storage as well as the list.
  localStorage.setItem("peertunes.published", "1");
  lib = await openLibrary(PT, NEXT_RESET);
  assert.equal(lib.tracks.size, 0);
  assert.equal(lib.playlists.size, 0);
  assert.equal(indexedDB.stores.get("tracks").rows.size, 0);
  assert.equal(indexedDB.stores.get("playlists").rows.size, 0);
  assert.equal(localStorage.getItem("peertunes.published"), null);
  assert.equal(localStorage.getItem("peertunes.host-reset"), NEXT_RESET);

  // Songs added since stay through the next restart.
  await lib._saveTrack(song("b1"), null, null);
  lib = await openLibrary(PT, NEXT_RESET);
  assert.deepEqual([...lib.tracks.keys()], ["b1"]);
});

test("a page PeerSky hands no id, as on the desktop, never clears or notes anything", async () => {
  global.localStorage = fakeStorage();
  global.indexedDB = fakeIndexedDB();
  const PT = loadPT();
  let lib = await openLibrary(PT, undefined);
  await lib._saveTrack(song("d1"), null, null);
  lib = await openLibrary(PT, undefined);
  assert.deepEqual([...lib.tracks.keys()], ["d1"]);
  assert.equal(localStorage.getItem("peertunes.host-reset"), null);
});

test("an emptied library takes the song that was on with it, here and after a restart", async () => {
  const PT = loadPT();
  const audio = {
    src: "", paused: true, currentTime: 0, duration: 180, volume: 1, playbackRate: 1, loads: 0,
    addEventListener() {},
    play() { this.paused = false; return Promise.resolve(); },
    pause() { this.paused = true; },
    removeAttribute(name) { if (name === "src") this.src = ""; },
    load() { this.loads++; },
  };
  const player = new PT.Player(audio, { trackAudioUrl: async (t) => "/hyper/" + t.id, trackCover: async () => null });
  const queueChanges = [];
  player.addEventListener("queuechange", () => queueChanges.push(player.queue.length));
  await player.playContext([song("x"), song("y")], 1);
  assert.equal(player.current().id, "y");
  assert.equal(audio.paused, false);

  player.forget();
  assert.equal(player.current(), null);
  assert.deepEqual(player.queue, []);
  assert.equal(audio.paused, true);
  assert.equal(audio.src, "");
  assert.equal(queueChanges.at(-1), 0);
  assert.equal(player.savedQueue(), null);

  // The page forgets the saved queue and place too, so a restart does not
  // put the song back.
  const main = read("js/main.js");
  assert.match(main, /library\.addEventListener\("cleared", \(\) => \{\s+player\.forget\(\);\s+try \{\s+localStorage\.removeItem\(QUEUE_KEY\);\s+localStorage\.removeItem\(PLACE_KEY\);/);
  assert.match(read("js/library.js"), /this\._invalidate\(\);\s+this\.dispatchEvent\(new CustomEvent\("cleared"\)\);/);
});

test("Settings has Clear All Songs, and Add Music no longer has a way to erase", async () => {
  global.matchMedia = () => ({ matches: false });
  const PT = loadPT();
  const lib = new PT.Library();
  lib.tracks.set("s1", song("s1"));
  const audio = { paused: true, currentTime: 0, duration: 180, volume: 1, playbackRate: 1, addEventListener() {}, play() { return Promise.resolve(); }, pause() {} };
  const player = new PT.Player(audio, { trackAudioUrl: async () => "blob:x", trackCover: async () => null });
  const wheel = new EventTarget();
  wheel.tick = () => {};
  const ui = new PT.UI({ body: null, sbTitle: null, library: lib, player, wheel, settings: { shuffle: false, repeat: "off" }, saveSettings: () => {} });
  ui._renderTop = () => {};
  ui.replaceAll({ name: "root" });

  const settings = ui.settingsScreen();
  settings.data = [];
  const row = settings.rows().find((r) => r.label === "Clear All Songs…");
  assert.ok(row, "Settings offers it");
  let dialog = null;
  ui.dialog = (d) => { dialog = d; };
  row.action();
  assert.equal(dialog.msg, "Clear all songs?");
  let cleared = 0;
  lib.clear = async () => { cleared++; };
  await dialog.buttons.find((b) => b.label === "Clear").action();
  assert.equal(cleared, 1);
  assert.equal(dialog.buttons.some((b) => b.label === "Cancel"), true);

  const add = ui.addScreen();
  add.data = [];
  assert.equal(add.rows().some((r) => /Reset Library|Clear/.test(r.label)), false);
});
