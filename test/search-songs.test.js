// Finding a song in a long library meant turning the wheel through all of it.
// Songs has a search field once there are more than a few screens of songs:
// it finds songs by title, artist or album, and what it finds plays as a list.
const { test } = require("node:test");
const assert = require("node:assert/strict");

const { fakeStorage, fakeIndexedDB } = require("./fake-storage.js");

function loadPT() {
  global.window = {};
  for (const file of ["../assets/icons.js", "../js/library.js", "../js/player.js", "../js/wheel.js", "../js/ui.js"]) {
    delete require.cache[require.resolve(file)];
    require(file);
  }
  return global.window.PT;
}

const SONGS = [
  ["a", "Alpha", "Band", "First"],
  ["b", "Bravo", "Beyoncé", "Renaissance"],
  ["c", "Charlie", "Band", "Second"],
  ["d", "Delta Blues", "Muddy", "Delta"],
  ["e", "Echo", "Echoes", "Live"],
  ["f", "Foxtrot", "Band", "Second"],
  ["g", "Golf", "Caddy", "Links"],
  ["h", "Hotel", "Band", "Stay"],
  ["i", "India", "Asha", "गीत"],
  ["j", "Juliet", "Romeo", "Verona"],
  ["k", "Kilo", "Weights", "Heavy"],
];

async function setup(songs = SONGS) {
  global.localStorage = fakeStorage();
  global.indexedDB = fakeIndexedDB();
  const PT = loadPT();
  const lib = new PT.Library();
  await lib.open();
  for (const [id, title, artist, album] of songs) {
    await lib._saveTrack({ id, kind: "file", title, artist, album }, null, null);
  }
  const wheel = { addEventListener() {}, tick() {} };
  const player = { addEventListener() {}, current: () => null };
  const ui = new PT.UI({ body: null, sbTitle: null, library: lib, player, wheel, settings: {}, saveSettings() {} });
  ui._renderTop = () => {};
  ui.played = [];
  ui.playAndShow = (tracks, i) => ui.played.push({ ids: tracks.map((x) => x.id), i });
  return { PT, lib, ui };
}

const labels = (screen) => screen.rows().map((r) => r.label);

test("a search finds every word in the title, artist or album, whatever the case and accents", async () => {
  const { PT } = await setup([]);
  const song = { title: "Halo", artist: "Beyoncé", album: "I Am... Sasha Fierce" };
  assert.equal(PT.songMatches(song, "beyonce"), true);
  assert.equal(PT.songMatches(song, "BEYONCÉ halo"), true);
  assert.equal(PT.songMatches(song, "sasha halo"), true);
  assert.equal(PT.songMatches(song, "halo rihanna"), false);
  assert.equal(PT.songMatches(song, "   "), true);
  assert.equal(PT.songMatches({ title: "Untitled" }, "untitled"), true);
  // Marks another script spells with stay: only Latin accents go.
  assert.equal(PT.songMatches({ title: "गीत" }, "गीत"), true);
  assert.equal(PT.songMatches({ title: "गीत" }, "गत"), false);
});

test("Songs shows what a search finds, and plays it as its own list", async () => {
  const { ui } = await setup();
  const songs = ui.songsScreen();
  ui.push(songs);
  assert.equal(labels(songs)[0], "Shuffle");
  assert.equal(songs.sel, 1);

  songs.setQuery("band second");
  assert.deepEqual(labels(songs), ["Charlie", "Foxtrot"]);
  assert.equal(songs.sel, 0, "the first song found, with no Shuffle above it");
  songs.rows()[1].action();
  assert.deepEqual(ui.played.pop(), { ids: ["c", "f"], i: 1 });

  songs.setQuery("beyonce");
  assert.deepEqual(labels(songs), ["Bravo"]);
  songs.setQuery("nothing like this");
  assert.deepEqual(labels(songs), []);

  songs.setQuery("");
  assert.equal(labels(songs).length, SONGS.length + 1);
  assert.equal(songs.sel, 1, "back on the first song, Shuffle one row up");
});

test("MENU takes the words away first, then goes back", async () => {
  const { ui } = await setup();
  const songs = ui.songsScreen();
  ui.push(ui.list({ name: "music", rows: () => [] }));
  ui.push(songs);
  songs.setQuery("echo");
  ui._onPress("menu");
  assert.equal(ui.top(), songs);
  assert.equal(songs.query, "");
  ui._onPress("menu");
  assert.equal(ui.top().name, "music");
});

test("the field is there once Songs runs past ten songs, and only on Songs", async () => {
  const { ui, PT, lib } = await setup();
  assert.equal(PT.SONG_SEARCH_AFTER, 10);
  assert.equal(lib.count, 11);
  const songs = ui.songsScreen();
  assert.equal(songs.canSearch(), true);
  // With no page drawn, typing has nowhere to go.
  assert.equal(songs.onType("a"), false);
  assert.equal(songs.query, "");

  // An artist's songs, a genre's and an album's are short lists of their own.
  const artist = ui.lib.getArtists().find((a) => a.name === "Band");
  assert.equal(ui.songsScreen(ui._artistSongs(artist), "Band", ["artistsongs", artist.key]).canSearch(), false);
  assert.equal(ui.musicScreen().canSearch(), false);

  // Ten songs fit in a turn or two of the wheel.
  await lib.deleteTrack("k");
  assert.equal(lib.count, 10);
  const fewer = ui.songsScreen();
  assert.equal(fewer.canSearch(), false);
  // Words already typed keep the field, so they can be taken away.
  fewer.setQuery("band");
  assert.equal(fewer.canSearch(), true);
});

test("a search is not saved as the place to come back to", async () => {
  const { ui } = await setup();
  const songs = ui.songsScreen();
  ui.push(songs);
  songs.sel = 4;
  assert.equal(ui._routes().at(-1).pos, 4);
  songs.setQuery("band");
  songs.sel = 2;
  assert.deepEqual(ui._routes().at(-1), { r: ["songs"], pos: undefined });
});

test("a letter typed on the keyboard goes to the screen, and only when it takes it", async () => {
  const listeners = {};
  global.window = { addEventListener: (type, fn) => { listeners[type] = fn; } };
  delete require.cache[require.resolve("../js/wheel.js")];
  require("../js/wheel.js");
  const { Wheel } = global.window.PT;
  const el = { addEventListener() {}, querySelector: () => null };
  const wheel = new Wheel(el, {});
  wheel.tick = () => {};
  const typed = [];
  let take = true;
  wheel.addEventListener("type", (e) => { typed.push(e.detail.key); if (take) e.preventDefault(); });
  const key = (k, extra = {}) => {
    const e = { key: k, target: { tagName: "BODY" }, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...extra };
    listeners.keydown(e);
    return e;
  };

  assert.equal(key("b").defaultPrevented, true);
  take = false;
  assert.equal(key("c").defaultPrevented, false, "a screen with no field leaves the key alone");
  key("k", { metaKey: true });
  key("Shift");
  key(" ");
  // In a field, keys are the field's.
  key("d", { target: { tagName: "INPUT" } });
  assert.deepEqual(typed, ["b", "c"]);
});
