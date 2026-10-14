// Now Playing after a restart, and when PeerSky's home screen widget asks for
// the song it shows. The app used to open on the list under Now Playing, with
// nothing loaded.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const read = (file) => fs.readFileSync(path.join(__dirname, "..", file), "utf8");

// The scripts attach to window.PT, as they do in the page.
function loadPT() {
  global.window = {};
  for (const file of ["../assets/icons.js", "../js/library.js", "../js/player.js", "../js/ui.js"]) {
    delete require.cache[require.resolve(file)];
    require(file);
  }
  return global.window.PT;
}

function fakeAudio() {
  const listeners = {};
  return {
    listeners,
    src: "",
    paused: true,
    currentTime: 0,
    duration: NaN,
    playbackRate: 1,
    volume: 1,
    played: 0,
    addEventListener(name, fn) { (listeners[name] ||= []).push(fn); },
    fire(name) { for (const fn of listeners[name] || []) fn(); },
    play() { this.paused = false; this.played++; return Promise.resolve(); },
    pause() { this.paused = true; },
  };
}

const song = (id, extra = {}) => ({ id, kind: "url", url: `hyper://drive/${id}.mp3`, title: `Song ${id}`, ...extra });

function makePlayer(PT, tracks = {}, { failing = new Set() } = {}) {
  const audio = fakeAudio();
  const library = {
    async trackAudioUrl(track) {
      if (failing.has(track.id)) throw new Error("audio blob missing");
      return "/hyper/asset?url=" + encodeURIComponent(track.url || track.id);
    },
    async trackCover() { return null; },
  };
  const player = new PT.Player(audio, library);
  const find = (id) => tracks[id] || null;
  return { player, audio, find };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

test("the queue and the place in the song are saved apart, and come back paused", async () => {
  const PT = loadPT();
  const tracks = { a: song("a"), b: song("b"), c: song("c") };
  const first = makePlayer(PT, tracks);
  first.player.shuffle = true;
  await first.player.playContext([tracks.a, tracks.b, tracks.c], 1);
  first.audio.currentTime = 83.46;
  const queue = JSON.parse(JSON.stringify(first.player.savedQueue()));
  const place = JSON.parse(JSON.stringify(first.player.savedPlace()));
  assert.equal(place.id, "b");
  assert.equal(place.time, 83.5);
  assert.deepEqual(queue.base, ["a", "b", "c"], "shuffled, so the list's own order is kept too");
  assert.equal(queue.ids[0], "b");

  const again = makePlayer(PT, tracks);
  assert.equal(again.player.restore(queue, place, again.find), true);
  await settle();
  assert.equal(again.player.current().id, "b");
  assert.deepEqual(again.player.queue.map((t) => t.id), queue.ids);
  assert.equal(again.audio.played, 0, "put back, not played");
  assert.match(again.audio.src, /b\.mp3/);
  // The place waits for the file to say how long it is, then is applied.
  assert.equal(again.player.position(), 83.5);
  again.audio.duration = 200;
  again.audio.fire("loadedmetadata");
  assert.equal(again.audio.currentTime, 83.5);

  // Shuffle off puts back the order the songs were picked from.
  again.player.setShuffle(false);
  assert.deepEqual(again.player.queue.map((t) => t.id), ["a", "b", "c"]);
  assert.equal(again.player.current().id, "b");
});

test("a song that is gone is not put back, and songs that are gone drop out of the queue", async () => {
  const PT = loadPT();
  const tracks = { a: song("a"), c: song("c") };
  const { player, find } = makePlayer(PT, tracks);
  const queue = { v: 1, ids: ["a", "b", "c"], base: null, temps: [] };
  assert.equal(player.restore(queue, { v: 1, id: "b", pos: 1, time: 10 }, find), false);
  assert.equal(player.current(), null);

  assert.equal(player.restore(queue, { v: 1, id: "c", pos: 2, time: 10 }, find), true);
  assert.deepEqual(player.queue.map((t) => t.id), ["a", "c"]);
  assert.equal(player.pos, 1);

  for (const junk of [null, {}, { ids: "a" }]) {
    assert.equal(player.restore(junk, { id: "a" }, find), false);
  }
  assert.equal(player.restore(queue, null, find), false);
});

test("Play Only songs come back without the cover address that died with the page", async () => {
  const PT = loadPT();
  const temp = song("t1", { temp: true, coverUrl: "blob:dead" });
  const first = makePlayer(PT, {});
  await first.player.playContext([temp], 0);
  const queue = JSON.parse(JSON.stringify(first.player.savedQueue()));
  assert.equal(queue.temps.length, 1);
  assert.equal(queue.temps[0].coverUrl, undefined);

  const again = makePlayer(PT, {});
  assert.equal(again.player.restore(queue, first.player.savedPlace(), again.find), true);
  assert.equal(again.player.current().title, "Song t1");
});

// The app opening offline used to greet you with "Cannot play this song" for
// a song you had not asked to play.
test("a song put back that cannot be reached says so only when play is pressed", async () => {
  const PT = loadPT();
  const tracks = { a: song("a") };
  const { player, audio, find } = makePlayer(PT, tracks);
  const errors = [];
  player.addEventListener("trackerror", (e) => errors.push(e.detail.id));
  player.restore({ ids: ["a"], temps: [] }, { id: "a", time: 30 }, find);
  await settle();
  audio.fire("error");
  assert.deepEqual(errors, []);

  player.play();
  await settle();
  assert.equal(audio.played, 1, "tried again for real");
  audio.fire("error");
  assert.deepEqual(errors, ["a"]);
});

test("a song whose file is gone stays quiet until play is pressed", async (t) => {
  t.mock.method(console, "warn", () => {});
  const PT = loadPT();
  const tracks = { a: song("a") };
  const { player, find } = makePlayer(PT, tracks, { failing: new Set(["a"]) });
  const errors = [];
  player.addEventListener("trackerror", (e) => errors.push(e.detail.id));
  player.restore({ ids: ["a"], temps: [] }, { id: "a", time: 0 }, find);
  await settle();
  assert.deepEqual(errors, []);
  player.playPause();
  await settle();
  assert.deepEqual(errors, ["a"]);
});

// ---- the widget's song ----

function makeUI(PT, { tracks = [], albums = [] } = {}) {
  const lib = new EventTarget();
  lib.tracks = new Map(tracks.map((t) => [t.id, t]));
  lib.albumOf = (track) => albums.find((a) => a.tracks.includes(track)) || null;
  const { player, audio } = makePlayer(PT, Object.fromEntries(tracks.map((t) => [t.id, t])));
  const wheel = new EventTarget();
  wheel.tick = () => {};
  const settings = { shuffle: false };
  const ui = new PT.UI({ body: null, sbTitle: null, library: lib, player, wheel, settings, saveSettings: () => {} });
  ui._renderTop = () => {};
  const dialogs = [];
  ui.dialog = (opts) => dialogs.push(opts);
  ui.replaceAll({ name: "playlist", route: ["playlist", "p1"] });
  return { ui, player, audio, dialogs };
}

test("the widget's song opens in Now Playing, ready, from the queue that holds it", async () => {
  const PT = loadPT();
  const [a, b, c] = [song("a"), song("b"), song("c")];
  const { ui, player, audio } = makeUI(PT, { tracks: [a, b, c] });
  await player.playContext([a, b, c], 0, { autoplay: false });

  assert.equal(await ui.showSong("c"), true);
  assert.equal(ui.top().name, "now");
  assert.equal(player.current().id, "c");
  assert.equal(audio.played, 0, "ready, not playing");

  // Asking again changes nothing.
  assert.equal(await ui.showSong("c"), true);
  assert.equal(ui.stack.filter((s) => s.name === "now").length, 1);
});

test("a widget song no longer in the queue comes from its album", async () => {
  const PT = loadPT();
  const [a, b, c] = [song("a"), song("b"), song("c")];
  const { ui, player } = makeUI(PT, { tracks: [a, b, c], albums: [{ tracks: [a, b, c] }] });
  assert.equal(await ui.showSong("b"), true);
  assert.deepEqual(player.queue.map((t) => t.id), ["a", "b", "c"]);
  assert.equal(player.current().id, "b");
  assert.equal(ui.top().name, "now");
});

test("whatever is playing keeps playing when the widget is tapped", async () => {
  const PT = loadPT();
  const [a, b] = [song("a"), song("b")];
  const { ui, player } = makeUI(PT, { tracks: [a, b] });
  await player.playContext([a, b], 0);
  assert.equal(player.playing, true);
  assert.equal(await ui.showSong("b"), true);
  assert.equal(player.current().id, "a");
  assert.equal(ui.top().name, "now");
});

test("a song that is gone leaves the screen as it was, with a short note", async () => {
  const PT = loadPT();
  const { ui, dialogs } = makeUI(PT, { tracks: [song("a")] });
  assert.equal(await ui.showSong("gone"), false);
  assert.equal(ui.top().name, "playlist");
  assert.equal(dialogs.length, 1);
  assert.equal(dialogs[0].msg, "Song not found");
  assert.equal(dialogs[0].sub, "It is no longer in your library.");

  // No song named, and nothing loaded: nothing to show, nothing to say.
  assert.equal(await ui.showSong(""), false);
  assert.equal(ui.top().name, "playlist");
  assert.equal(dialogs.length, 1);
});

test("Now Playing is part of the saved page, and comes back only with a song", async () => {
  const PT = loadPT();
  const a = song("a");
  const { ui, player } = makeUI(PT, { tracks: [a] });
  assert.equal(ui.nowPlayingScreen().route[0], "now");
  assert.equal(ui._screenFromRoute(["now"]), null);
  await player.playContext([a], 0, { autoplay: false });
  assert.equal(ui._screenFromRoute(["now"]).name, "now");
});

test("the page puts the song back before drawing the menu, and the host waits for it", () => {
  const main = read("js/main.js");
  const boot = main.slice(main.indexOf("async function boot()"));
  assert.ok(boot.indexOf("restorePlayer();") < boot.indexOf("ui.replaceAll(ui.rootScreen());"));
  assert.match(main, /boot\(\)\.catch\([^)]*\)[^;]*\.finally\(\(\) => bootDone\(\)\);/);
  assert.match(main, /openNowPlaying: \(songId\) => booted\.then\(\(\) => ui\.showSong\(/);
  assert.match(main, /player\.addEventListener\("queuechange", \(\) => writeSaved\(QUEUE_KEY, player\.savedQueue\(\)\)\);/);
  assert.match(main, /document\.addEventListener\("visibilitychange", \(\) => \{ if \(document\.hidden\) savePlace\(\); \}\);/);
});
