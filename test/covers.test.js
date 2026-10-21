// Album covers that did not show. A song with no picture of its own showed
// none even when the rest of its album had one. A shared playlist's covers
// came from one file per album, read once, so a bare first file, or a sharer
// offline at that moment, left the album without a cover for good. And songs
// with no album tag by one artist all showed the first one's picture.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { fakeStorage, fakeIndexedDB } = require("./fake-storage.js");

function loadPT() {
  global.window = {};
  for (const file of ["../assets/icons.js", "../js/metadata.js", "../js/library.js"]) {
    delete require.cache[require.resolve(file)];
    require(file);
  }
  return global.window.PT;
}

const picture = (n) => ({ mime: "image/jpeg", data: new Uint8Array(40 + n).fill(n) });
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(check, ms = 2000) {
  const until = Date.now() + ms;
  while (!check()) {
    if (Date.now() > until) throw new Error("timed out waiting");
    await pause(5);
  }
}

function fresh() {
  global.localStorage = fakeStorage();
  global.indexedDB = fakeIndexedDB();
  return loadPT();
}

async function openLibrary(PT) {
  const lib = new PT.Library();
  await lib.open();
  return lib;
}

const covers = () => indexedDB.stores.get("covers").rows;

test("a song with no picture of its own shows its album's, whichever was added first", async () => {
  const PT = fresh();
  const lib = await openLibrary(PT);
  const bare = lib._mkTrack("f1", "file", { title: "One", artist: "Band", album: "LP" }, {});
  const art = lib._mkTrack("f2", "file", { title: "Two", artist: "Band", album: "LP" }, {});
  await lib._saveTrack(bare, null, null);
  await lib._saveTrack(art, null, picture(1));
  assert.equal(bare.coverId, art.coverId);
  assert.equal(covers().get(bare.coverId).size, 41);
});

test("songs with no album keep their own pictures", async () => {
  const PT = fresh();
  const lib = await openLibrary(PT);
  const a = lib._mkTrack("f1", "file", { title: "Single A", artist: "Band" }, {});
  const b = lib._mkTrack("f2", "file", { title: "Single B", artist: "Band" }, {});
  await lib._saveTrack(a, null, picture(1));
  await lib._saveTrack(b, null, picture(2));
  assert.notEqual(a.coverId, b.coverId);
  assert.equal(covers().get(a.coverId).size, 41);
  assert.equal(covers().get(b.coverId).size, 42);
});

test("a shared album whose first file has no picture takes the next one's", async () => {
  const PT = fresh();
  const reads = [];
  PT.urlSource = async (url) => { reads.push(url); return { url, read: async () => new Uint8Array(0) }; };
  PT.readTags = async (src) => ({ picture: src.url.endsWith("/2.mp3") ? picture(5) : null });
  const lib = await openLibrary(PT);
  const songs = [1, 2, 3].map((n) => lib._mkTrack(`u${n}`, "url", { title: `${n}`, artist: "Band", album: "LP" }, { url: `hyper://drive/lp/${n}.mp3` }));
  for (const t of songs) await lib._saveTrack(t, null, null);
  await lib._coversForLibrary(songs.map((t) => ({ id: t.id, url: t.url, tags: t })));
  assert.deepEqual(reads, ["hyper://drive/lp/1.mp3", "hyper://drive/lp/2.mp3"]);
  const key = lib.albumKeyOf({ artist: "Band", album: "LP" });
  assert.equal(covers().get(key).size, 45);
  for (const t of songs) assert.equal(lib.tracks.get(t.id).coverId, key);
});

test("covers missing because the sharer was away are asked for again when the app opens", async () => {
  const PT = fresh();
  let online = false;
  const reads = [];
  PT.urlSource = async (url) => {
    reads.push(url);
    if (!online) throw new Error("no peers have it");
    return { url, read: async () => new Uint8Array(0) };
  };
  PT.readTags = async (src) => ({ picture: src.url.includes("/lp/") ? picture(7) : null });

  let lib = await openLibrary(PT);
  const song = (album, n) => lib._mkTrack(`u${album}${n}`, "url", { title: `${n}`, artist: "Band", album }, { url: `hyper://drive/${album}/${n}.mp3` });
  const songs = [song("lp", 1), song("lp", 2), song("ep", 1)];
  for (const t of songs) await lib._saveTrack(t, null, null);
  await lib._coversForLibrary(songs.map((t) => ({ id: t.id, url: t.url, tags: t })));
  assert.deepEqual(reads, ["hyper://drive/lp/1.mp3", "hyper://drive/ep/1.mp3"], "one try per album while the sharer is away");
  assert.equal(covers().size, 0);

  // The next start, with the sharer back.
  online = true;
  lib = await openLibrary(PT);
  const lpCover = lib.albumKeyOf({ artist: "Band", album: "lp" });
  await waitFor(() => lib.tracks.get("ulp1").coverId === lpCover && covers().has(lpCover) && lib.tracks.get("uep1").artChecked);
  assert.equal(lib.tracks.get("ulp2").coverId, lpCover);

  // The start after: nothing left to ask for, the bare EP included.
  reads.length = 0;
  lib = await openLibrary(PT);
  await pause(50);
  assert.deepEqual(reads, []);
});

test("a song an earlier version left bare picks up its album's cover on the next start", async () => {
  const PT = fresh();
  let lib = await openLibrary(PT);
  const bare = lib._mkTrack("f1", "file", { title: "One", artist: "Band", album: "LP" }, {});
  const art = lib._mkTrack("f2", "file", { title: "Two", artist: "Band", album: "LP" }, {});
  await lib._saveTrack(art, null, picture(1));
  // As an earlier PeerTunes kept it: no cover of its own, so none at all.
  indexedDB.stores.get("tracks").rows.set("f1", { ...bare, coverId: null });

  lib = await openLibrary(PT);
  await waitFor(() => lib.tracks.get("f1").coverId === art.coverId);
  assert.equal(indexedDB.stores.get("tracks").rows.get("f1").coverId, art.coverId);
});
