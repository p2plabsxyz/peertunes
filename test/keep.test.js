// Keep On This Device, song by song. A shared playlist was kept while its
// sharer was online, the laptop was closed halfway, and later only half the
// songs played, with nothing ever saying so. Now every song is counted only
// once all of it is here, the rest says why, and the host is asked again.
const { test } = require("node:test");
const assert = require("node:assert/strict");

function loadPT() {
  global.window = {};
  for (const file of ["../assets/icons.js", "../js/library.js", "../js/player.js", "../js/ui.js"]) {
    delete require.cache[require.resolve(file)];
    require(file);
  }
  return global.window.PT;
}

const FOLDER = "hyper://key/late-night-drive/";
const hyperSong = (n) => ({ id: `u${n}`, kind: "url", url: `${FOLDER}${n}.mp3`, title: `Song ${n}`, artist: "Band" });

test("a song counts only once all of it is on the device", () => {
  const PT = loadPT();
  const tracks = [hyperSong(1), hyperSong(2), hyperSong(3), hyperSong(4),
    { id: "f1", kind: "file", title: "From this phone" },
    { id: "w1", kind: "url", url: "https://example.com/a.mp3", title: "Web link" }];
  const state = PT.keepState(tracks, {
    saved: [`${FOLDER}1.mp3`],
    saving: [`${FOLDER}3.mp3`],
    waiting: [`${FOLDER}4.mp3`],
  });
  assert.equal(state.total, 6);
  assert.equal(state.saved, 2, "the saved song and the one added from this phone");
  assert.deepEqual([...state.here], ["u1", "f1"]);
  assert.deepEqual([...state.missing], ["u2", "u3", "u4", "w1"]);
  // Part of song 3 is here already, so it is the one coming in, before song
  // 2, which has not started.
  assert.equal(state.current.id, "u3");
  assert.equal(state.stuck, 1);
  assert.equal(state.cannot, 1);
  assert.equal(state.complete, false);

  // Nothing started yet: the next one in the list is next.
  assert.equal(PT.keepState(tracks, { saved: [], saving: [], waiting: [] }).current.id, "u1");
  // Every one that is left waits on someone: nothing is coming in.
  const stuck = PT.keepState([hyperSong(1), hyperSong(2)], { saved: [`${FOLDER}1.mp3`], waiting: [`${FOLDER}2.mp3`] });
  assert.equal(stuck.current, null);
  assert.equal(stuck.stuck, 1);

  const done = PT.keepState([hyperSong(1)], { saved: [], saving: [] }, new Set([`${FOLDER}1.mp3`]));
  assert.equal(done.complete, true);
  assert.equal(done.saved, 1);
});

test("the host is asked about each song not yet known to be here, and only those", async () => {
  const PT = loadPT();
  const lib = new PT.Library();
  const tracks = [hyperSong(1), hyperSong(2), hyperSong(3), { id: "f1", kind: "file", title: "Local" }];
  assert.equal(await lib.keepSongs(tracks), null, "a host that cannot keep songs one by one");

  const asked = [];
  global.window.peerskyKeepSongs = async (urls) => {
    asked.push(urls);
    return { ok: true, saved: urls.filter((u) => u.endsWith("1.mp3")), saving: [], waiting: [] };
  };
  const first = await lib.keepSongs(tracks);
  assert.deepEqual(asked[0], [`${FOLDER}1.mp3`, `${FOLDER}2.mp3`, `${FOLDER}3.mp3`]);
  assert.equal(first.saved, 2);
  const second = await lib.keepSongs(tracks, first);
  assert.deepEqual(asked[1], [`${FOLDER}2.mp3`, `${FOLDER}3.mp3`]);
  assert.equal(second.saved, 2);

  global.window.peerskyKeepSongs = async () => ({ ok: false });
  assert.equal(await lib.keepSongs(tracks, first), null);
  global.window.peerskyKeepSongs = async () => { throw new Error("gone"); };
  assert.equal(await lib.keepSongs(tracks, first), null);
});

test("the progress screen says how many are here, which is coming in, and why the rest are not", () => {
  const PT = loadPT();
  const songs = [hyperSong(1), hyperSong(2), hyperSong(3), hyperSong(4)];
  const busy = PT.keepView(PT.keepState(songs, { saved: [`${FOLDER}1.mp3`], saving: [`${FOLDER}2.mp3`] }));
  assert.equal(busy.big, "Saving Songs");
  assert.equal(busy.count, "1 of 4 on this device");
  assert.equal(busy.song, "Song 2");
  assert.equal(busy.fraction, 0.25);
  assert.equal(busy.note, "");

  const waiting = PT.keepView(PT.keepState(songs, {
    saved: [`${FOLDER}1.mp3`],
    waiting: [`${FOLDER}2.mp3`, `${FOLDER}3.mp3`, `${FOLDER}4.mp3`],
  }));
  assert.equal(waiting.big, "Waiting");
  assert.equal(waiting.count, "1 of 4 on this device");
  assert.equal(waiting.song, "");
  assert.equal(waiting.note, "The rest saves when the person who shared them is back online.");

  const some = PT.keepView(PT.keepState(songs, { saving: [`${FOLDER}1.mp3`], waiting: [`${FOLDER}2.mp3`] }));
  assert.equal(some.note, "Some are waiting for the person who shared them.");

  const done = PT.keepView(PT.keepState(songs, { saved: songs.map((t) => t.url) }));
  assert.equal(done.big, "All Saved");
  assert.equal(done.count, "All 4 songs are on this device");
  assert.equal(done.note, "They play with the network off.");

  const web = PT.keepView(PT.keepState([hyperSong(1), { id: "w", kind: "url", url: "https://x/a.mp3", title: "Web" }], { saved: [`${FOLDER}1.mp3`] }));
  assert.equal(web.note, "1 is a web link, which cannot be kept.");
  assert.equal(PT.keepView(null).count, "Checking…");
});

function setup(PT) {
  const tracks = [hyperSong(1), hyperSong(2), hyperSong(3)];
  const lib = new PT.Library();
  for (const t of tracks) lib.tracks.set(t.id, t);
  lib.playlists.set("p1", { id: "p1", name: "Late Night Drive", trackIds: tracks.map((t) => t.id), created: 1, sourceUrl: FOLDER });
  lib.sources = [{ url: FOLDER }];
  lib._markKept = async (source) => { source.kept = true; };
  const audio = { paused: true, currentTime: 0, volume: 1, addEventListener() {}, play: async () => {}, pause() {} };
  const player = new PT.Player(audio, { trackAudioUrl: async () => "blob:x", trackCover: async () => null });
  const wheel = new EventTarget();
  wheel.tick = () => {};
  const ui = new PT.UI({ body: null, sbTitle: null, library: lib, player, wheel, settings: {}, saveSettings: () => {} });
  ui._renderTop = () => {};
  const dialogs = [];
  ui.dialog = (opts) => dialogs.push(opts);
  ui.replaceAll({ name: "root" });

  const host = { kept: [], saved: 0, waiting: false, calls: 0 };
  global.window.peerskyKeepOffline = async (url) => { host.kept.push(url); return { ok: true, status: "downloading" }; };
  global.window.peerskyKeepSongs = async (urls) => {
    host.calls++;
    const saved = new Set(tracks.slice(0, host.saved).map((t) => t.url));
    const rest = urls.filter((u) => !saved.has(u));
    return {
      ok: true,
      saved: urls.filter((u) => saved.has(u)),
      saving: host.waiting ? [] : rest.slice(0, 1),
      waiting: host.waiting ? rest : [],
    };
  };
  return { ui, lib, player, tracks, dialogs, host };
}

test("keeping a shared playlist shows its songs arrive, and marks each one in the list", async () => {
  const PT = loadPT();
  const { ui, lib, dialogs, host } = setup(PT);
  const pl = lib.playlist("p1");
  const keepRow = () => ui.playlistScreen("p1").rows().find((r) => /This Device/.test(r.label));
  assert.equal(keepRow().label, "Keep On This Device…");

  await ui.keepPlaylistOffline(pl);
  assert.deepEqual(host.kept, [FOLDER]);
  assert.equal(lib.isSourceKept(FOLDER), true);
  assert.equal(ui.top().name, "keep");
  assert.equal(ui.top().keepId, "p1");
  assert.equal(dialogs.length, 0, "the progress screen says it, not a dialog");

  host.saved = 1;
  await ui._checkKept("p1");
  ui.pop();
  const screen = ui.playlistScreen("p1");
  const rows = screen.rows();
  assert.equal(keepRow().label, "On This Device");
  assert.equal(keepRow().value, "1 of 3");
  const marks = rows.filter((r) => r.label.startsWith("Song")).map((r) => r.glyphOff);
  assert.deepEqual(marks, [false, true, true]);
  assert.equal(rows.find((r) => r.label === "Song 2").glyphTitle, "Not on this device yet");
});

test("all saved is said once, and the checks stop", async () => {
  const PT = loadPT();
  const { ui, lib, dialogs, host } = setup(PT);
  await ui.keepPlaylistOffline(lib.playlist("p1"));
  ui.pop();
  ui.push(ui.playlistScreen("p1"));
  host.saved = 2;
  await ui._checkKept("p1");
  assert.equal(dialogs.length, 0);
  assert.equal(ui._keptDone("p1"), false);
  host.saved = 3;
  await ui._checkKept("p1");
  assert.equal(dialogs.length, 1);
  assert.equal(dialogs[0].msg, "All 3 songs are on this device");
  assert.equal(ui._keptDone("p1"), true);
  await ui._checkKept("p1");
  assert.equal(dialogs.length, 1);

  // A song added later is checked like the others.
  const extra = hyperSong(9);
  lib.tracks.set(extra.id, extra);
  lib.playlist("p1").trackIds.push(extra.id);
  assert.equal(ui._keptDone("p1"), false);
});

// The laptop that shared it was closed: the songs it still had to send are
// not counted, and PeerSky is asked to keep the folder again later.
test("songs whose sharer went offline stay missing and are asked for again", async (t) => {
  const PT = loadPT();
  const { ui, lib, host } = setup(PT);
  await ui.keepPlaylistOffline(lib.playlist("p1"));
  host.saved = 1;
  host.waiting = true;
  const state = await ui._checkKept("p1");
  assert.equal(state.saved, 1);
  assert.equal(state.complete, false);
  assert.equal(state.stuck, 2);
  assert.equal(host.kept.length, 1, "asked just now, not again yet");

  const now = Date.now();
  t.mock.method(Date, "now", () => now + 6 * 60 * 1000);
  await ui._checkKept("p1");
  assert.equal(host.kept.length, 2, "the folder is asked for again");
  await ui._checkKept("p1");
  assert.equal(host.kept.length, 2, "and not on every check");
});

test("a kept song that cannot play says it is not on this device yet", async () => {
  const PT = loadPT();
  const { ui, lib, player, tracks, dialogs, host } = setup(PT);
  await ui.keepPlaylistOffline(lib.playlist("p1"));
  host.saved = 1;
  await ui._checkKept("p1");
  player.dispatchEvent(new CustomEvent("trackerror", { detail: tracks[2] }));
  assert.equal(dialogs.at(-1).sub, "Song 3\nIt is not on this device yet.");
  player.dispatchEvent(new CustomEvent("trackerror", { detail: tracks[0] }));
  assert.equal(dialogs.at(-1).sub, "Song 1");
});

test("a host that cannot keep songs one by one keeps the old message", async () => {
  const PT = loadPT();
  const { ui, lib, dialogs } = setup(PT);
  delete global.window.peerskyKeepSongs;
  await ui.keepPlaylistOffline(lib.playlist("p1"));
  assert.equal(ui.top().name, "root");
  assert.equal(dialogs[0].msg, "Downloading");
});
