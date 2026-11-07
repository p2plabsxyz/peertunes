// Holding a song. It used to offer Add to Playlist and Delete Song, one song
// at a time. Now it also shares the song, and Select Songs picks several to
// add to a playlist, take out of one or delete at once; sharing is for one.
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

const song = (id, title, artist = "Band") => ({ id, kind: "file", title, artist, album: "Record" });

// The real library on stand-in storage, and a UI that keeps its screen stack
// but draws nothing: no page here to draw on.
async function setup() {
  global.localStorage = fakeStorage();
  global.indexedDB = fakeIndexedDB();
  const PT = loadPT();
  const lib = new PT.Library();
  await lib.open();
  for (const [id, title] of [["a", "Alpha"], ["b", "Bravo"], ["c", "Charlie"], ["d", "Delta"]]) {
    await lib._saveTrack(song(id, title), null, null);
  }
  const wheel = { addEventListener() {}, tick() {} };
  const player = { addEventListener() {}, current: () => null };
  const ui = new PT.UI({ body: null, sbTitle: null, library: lib, player, wheel, settings: {}, saveSettings() {} });
  ui._renderTop = () => {};
  ui.dialogs = [];
  ui.dialog = (opts) => ui.dialogs.push(opts);
  ui.shared = [];
  ui._publishAndShare = (name, tracks) => ui.shared.push({ name, ids: tracks.map((x) => x.id) });
  return { PT, lib, ui };
}

// A list screen as drawn: its rows read, and a redraw reads them again.
function shown(screen) {
  screen.refresh = function () { this.data = this.rows(); };
  screen.paint = () => {};
  screen.refresh();
  return screen;
}

const labels = (screen) => screen.rows().map((r) => r.label);
const row = (screen, label) => screen.rows().find((r) => r.label === label);
const press = (b) => b.action && b.action();
const button = (opts, label) => opts.buttons.find((b) => b.label === label);

test("holding a song offers to share it, add it to a playlist, delete it, or select songs", async () => {
  const { lib, ui } = await setup();
  const all = ui.songsScreen();
  ui.push(all);
  const held = all.rows().find((r) => r.label === "Bravo");
  held.hold();
  assert.equal(ui.top().name, "songactions");
  assert.deepEqual(labels(ui.top()), ["Share Song…", "Add to Playlist…", "Delete Song…", "Select Songs…"]);

  // Share Song publishes the one song, the way a playlist is shared.
  press(row(ui.top(), "Share Song…"));
  assert.deepEqual(ui.shared, [{ name: "Bravo", ids: ["b"] }]);
  assert.equal(ui.top(), all);

  // Delete Song still asks first, then takes it off this device.
  held.hold();
  press(row(ui.top(), "Delete Song…"));
  const ask = ui.dialogs.pop();
  assert.equal(ask.msg, "Delete this song?");
  assert.equal(ask.sub, "Bravo");
  await button(ask, "Delete").action();
  assert.equal(lib.tracks.has("b"), false);
  assert.equal(ui.top(), all);
});

test("in a playlist, holding a song can also take it out of that playlist", async () => {
  const { lib, ui } = await setup();
  const mix = await lib.createPlaylist("Mix");
  for (const id of ["a", "b", "c"]) await lib.addToPlaylist(mix.id, id);
  const screen = ui.playlistScreen(mix.id);
  ui.push(screen);
  screen.rows().find((r) => r.label === "Bravo").hold();
  assert.deepEqual(labels(ui.top()), ["Share Song…", "Add to Playlist…", "Remove from Mix…", "Delete Song…", "Select Songs…"]);

  press(row(ui.top(), "Remove from Mix…"));
  const ask = ui.dialogs.pop();
  assert.equal(ask.msg, "Remove from Mix?");
  await button(ask, "Remove").action();
  assert.deepEqual(lib.playlist(mix.id).trackIds, ["a", "c"]);
  assert.equal(lib.tracks.has("b"), true, "the song stays in the library");
  assert.equal(ui.top(), screen);
});

test("Select Songs starts with the held song picked, and the cursor on it", async () => {
  const { ui } = await setup();
  const all = ui.songsScreen();
  ui.push(all);
  all.rows().find((r) => r.label === "Charlie").hold();
  press(row(ui.top(), "Select Songs…"));
  const select = shown(ui.top());
  assert.equal(select.name, "selectsongs");
  assert.equal(select.title, "1 Selected");
  assert.deepEqual(labels(select), ["Share Song…", "Add to Playlist…", "Delete Song…", "Select All", "Alpha", "Bravo", "Charlie", "Delta"]);
  assert.deepEqual(select.rows().map((r) => r.value || ""), ["", "", "", "", "", "", "✓", ""]);
  assert.equal(select.data[select.sel].label, "Charlie");
  // Back leaves it, as Menu does everywhere.
  ui.pop();
  assert.equal(ui.top(), all);
});

test("picking a second song takes Share away, and the cursor stays on its song", async () => {
  const { ui } = await setup();
  const all = ui.songsScreen();
  ui.push(all);
  all.rows().find((r) => r.label === "Alpha").hold();
  press(row(ui.top(), "Select Songs…"));
  const select = shown(ui.top());

  // Down to Bravo and pick it, as the wheel and the center button would.
  select.sel = select.data.findIndex((r) => r.label === "Bravo");
  select.onSelect();
  assert.equal(select.title, "2 Selected");
  assert.deepEqual(labels(select).slice(0, 3), ["Add to Playlist…", "Delete 2 Songs…", "Select All"]);
  assert.equal(select.data[select.sel].label, "Bravo");

  // Holding a song picks it too, or lets it go.
  select.sel = select.data.findIndex((r) => r.label === "Bravo");
  select.onHold();
  assert.equal(select.title, "1 Selected");
  assert.equal(labels(select)[0], "Share Song…");
  assert.equal(select.data[select.sel].label, "Bravo");

  // Let the last one go: only Select All is left above the songs.
  select.sel = select.data.findIndex((r) => r.label === "Alpha");
  select.onSelect();
  assert.equal(select.title, "Select Songs");
  assert.deepEqual(labels(select), ["Select All", "Alpha", "Bravo", "Charlie", "Delta"]);
  assert.equal(select.data[select.sel].label, "Alpha");
});

test("Select All picks every song, and then lets them all go", async () => {
  const { ui } = await setup();
  const all = ui.songsScreen();
  ui.push(all);
  all.rows().find((r) => r.label === "Alpha").hold();
  press(row(ui.top(), "Select Songs…"));
  const select = shown(ui.top());
  select.sel = select.data.findIndex((r) => r.label === "Select All");
  select.onSelect();
  assert.equal(select.title, "4 Selected");
  assert.equal(select.data[select.sel].label, "Deselect All");
  assert.ok(select.rows().filter((r) => r.value === "✓").length === 4);
  select.onSelect();
  assert.equal(select.title, "Select Songs");
  assert.equal(select.data[select.sel].label, "Select All");
});

test("several songs picked are deleted at once, after one question", async () => {
  const { lib, ui } = await setup();
  const all = ui.songsScreen();
  ui.push(all);
  all.rows().find((r) => r.label === "Alpha").hold();
  press(row(ui.top(), "Select Songs…"));
  const select = shown(ui.top());
  select.sel = select.data.findIndex((r) => r.label === "Delta");
  select.onSelect();
  press(row(select, "Delete 2 Songs…"));
  const ask = ui.dialogs.pop();
  assert.equal(ask.msg, "Delete 2 songs?");
  assert.equal(ask.sub, "2 songs will be removed from this device.");
  await button(ask, "Delete").action();
  assert.deepEqual([...lib.tracks.keys()].sort(), ["b", "c"]);
  assert.equal(ui.top(), all, "back on the list the songs were picked in");

  // Cancel deletes nothing.
  all.rows().find((r) => r.label === "Bravo").hold();
  press(row(ui.top(), "Select Songs…"));
  press(row(ui.top(), "Delete Song…"));
  press(button(ui.dialogs.pop(), "Cancel"));
  assert.equal(lib.tracks.size, 2);
});

test("several songs picked go into a playlist at once, and the note counts those added", async () => {
  const { lib, ui } = await setup();
  const mix = await lib.createPlaylist("Mix");
  await lib.addToPlaylist(mix.id, "a");
  const all = ui.songsScreen();
  ui.push(all);
  all.rows().find((r) => r.label === "Alpha").hold();
  press(row(ui.top(), "Select Songs…"));
  const select = shown(ui.top());
  for (const name of ["Bravo", "Charlie"]) {
    select.sel = select.data.findIndex((r) => r.label === name);
    select.onSelect();
  }
  press(row(select, "Add to Playlist…"));
  assert.equal(ui.top().name, "pickpl");
  // Alpha was in Mix already, so two are added and the note says so.
  await ui.top().rows().find((r) => r.label === "Mix").action();
  assert.deepEqual(lib.playlist(mix.id).trackIds, ["a", "b", "c"]);
  const note = ui.dialogs.pop();
  assert.equal(note.msg, "Added to Mix");
  assert.equal(note.sub, "2 songs");
  assert.equal(ui.top(), all);
});

test("a new playlist made from the picker takes every song picked", async () => {
  const { lib, ui } = await setup();
  const all = ui.songsScreen();
  ui.push(all);
  all.rows().find((r) => r.label === "Alpha").hold();
  press(row(ui.top(), "Select Songs…"));
  const select = shown(ui.top());
  select.sel = select.data.findIndex((r) => r.label === "Delta");
  select.onSelect();
  // The name screen is drawn on a page; here its Done is called with a name.
  let onDone = null;
  ui.nameEntryScreen = (opts) => { onDone = opts.onDone; return { name: "nameentry" }; };
  press(row(select, "Add to Playlist…"));
  ui.top().rows().find((r) => r.label === "New Playlist…").action();
  await onDone("Road Trip");
  const road = lib.getPlaylists().find((p) => p.name === "Road Trip");
  assert.deepEqual(road.trackIds.slice().sort(), ["a", "d"]);
  assert.equal(ui.dialogs.pop().sub, "2 songs");
  assert.equal(ui.top(), all);
});

test("several songs picked in a playlist come out of it together", async () => {
  const { lib, ui } = await setup();
  const mix = await lib.createPlaylist("Mix");
  for (const id of ["a", "b", "c", "d"]) await lib.addToPlaylist(mix.id, id);
  const screen = ui.playlistScreen(mix.id);
  ui.push(screen);
  screen.rows().find((r) => r.label === "Alpha").hold();
  press(row(ui.top(), "Select Songs…"));
  const select = shown(ui.top());
  assert.deepEqual(labels(select).slice(0, 5), ["Share Song…", "Add to Playlist…", "Remove from Mix…", "Delete Song…", "Select All"]);
  select.sel = select.data.findIndex((r) => r.label === "Charlie");
  select.onSelect();
  press(row(select, "Remove from Mix…"));
  const ask = ui.dialogs.pop();
  assert.equal(ask.sub, "2 songs");
  await button(ask, "Remove").action();
  assert.deepEqual(lib.playlist(mix.id).trackIds, ["b", "d"]);
  assert.equal(lib.tracks.size, 4);
  assert.equal(ui.top(), screen);
});

test("Share Song is there with one song picked, and shares that one", async () => {
  const { ui } = await setup();
  const all = ui.songsScreen();
  ui.push(all);
  all.rows().find((r) => r.label === "Delta").hold();
  press(row(ui.top(), "Select Songs…"));
  press(row(shown(ui.top()), "Share Song…"));
  assert.deepEqual(ui.shared, [{ name: "Delta", ids: ["d"] }]);
  assert.equal(ui.top(), all);
});

test("an artist's songs drop one deleted while they are open", async () => {
  const { lib, ui } = await setup();
  await lib._saveTrack(song("e", "Echo", "Other"), null, null);
  const fixed = lib.getSongs().filter((x) => x.artist === "Band");
  const screen = ui.songsScreen(fixed, "Band", ["artistsongs", "band"]);
  assert.equal(screen.refreshOnLibrary, true);
  await lib.deleteTrack("b");
  assert.deepEqual(screen.rows().map((r) => r.label), ["Shuffle", "Alpha", "Charlie", "Delta"]);
});
