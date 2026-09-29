// Share manifest helpers: what publishShare writes and importShared reads.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const L = require("../js/library.js");

test("buildManifest and parseManifest round trip", () => {
  const m = L.buildManifest("Road Trip", [
    { file: "01 - Song.mp3", title: "Song", artist: "Band", album: "LP" },
    { file: "hyper://key/other.mp3", title: "Other" },
  ]);
  assert.equal(m.app, "peertunes");
  assert.equal(m.name, "Road Trip");
  const parsed = L.parseManifest(JSON.parse(JSON.stringify(m)));
  assert.equal(parsed.name, "Road Trip");
  assert.equal(parsed.files.length, 2);
  assert.equal(parsed.files[0].title, "Song");
});

test("parseManifest rejects junk", () => {
  assert.equal(L.parseManifest(null), null);
  assert.equal(L.parseManifest("hi"), null);
  assert.equal(L.parseManifest({}), null);
  assert.equal(L.parseManifest({ files: "nope" }), null);
  assert.equal(L.parseManifest({ files: [] }), null);
  assert.equal(L.parseManifest({ files: [{ title: "no file field" }] }), null);
});

test("parseManifest fills a default name", () => {
  const parsed = L.parseManifest({ files: [{ file: "a.mp3" }] });
  assert.equal(parsed.name, "Shared Playlist");
});

test("resolveManifestFiles keeps order, encodes names, passes absolute urls", () => {
  const parsed = L.parseManifest({
    name: "Mix",
    files: [
      { file: "01 - First Song.mp3" },
      { file: "hyper://abc/deep/track.flac" },
      { file: "./sub/second.m4a" },
    ],
  });
  const { files: urls, meta } = L.resolveManifestFiles("hyper://key/mix/", parsed);
  assert.deepEqual(urls, [
    "hyper://key/mix/01%20-%20First%20Song.mp3",
    "hyper://abc/deep/track.flac",
    "hyper://key/mix/sub/second.m4a",
  ]);
  // No titles in that manifest, so nothing to take on trust from it.
  assert.equal(meta.size, 0);
});

// The names in the manifest are what make an import quick: with them there is
// nothing to read off the drive before the playlist can be listed.
test("resolveManifestFiles carries the names the manifest gives", () => {
  const parsed = L.parseManifest({
    name: "Mix",
    files: [
      { file: "01 - First.mp3", title: "First", artist: "Band", album: "LP" },
      { file: "02 - Second.mp3" },
    ],
  });
  const { files, meta } = L.resolveManifestFiles("hyper://key/mix/", parsed);

  assert.equal(files.length, 2);
  assert.deepEqual(meta.get(files[0]), { title: "First", artist: "Band", album: "LP" });
  // An entry with no title is still imported, it just has to be read for one.
  assert.equal(meta.has(files[1]), false);
});

test("resolveManifestFiles drops traversal and absolute path entries", () => {
  const parsed = L.parseManifest({
    files: [
      { file: "ok.mp3" },
      { file: "../escape.mp3" },
      { file: "sub/../../escape.mp3" },
      { file: "/etc/passwd" },
    ],
  });
  const { files: urls } = L.resolveManifestFiles("hyper://key/", parsed);
  assert.deepEqual(urls, ["hyper://key/ok.mp3"]);
});

// Play Only, and what it costs. Reading every file before the list could be
// shown was both the wait and the reason songs went missing: one probe that
// failed dropped that song out of the playlist for good.
test("Play Only lists every named song without reading any of them", async () => {
  const lib = Object.create(L.Library.prototype);
  lib._generation = 0;
  lib._emitProgress = () => {};
  // Asserted below: nothing the manifest names should reach this.
  const probed = [];
  lib._coversForRemote = (entries) => { lib.coverEntries = entries; };

  const manifest = L.parseManifest({
    name: "Road Trip",
    files: [
      { file: "01.mp3", title: "One", artist: "Band", album: "LP" },
      { file: "02.mp3", title: "Two", artist: "Band", album: "LP" },
      { file: "03.mp3", title: "Three", artist: "Other", album: "EP" },
    ],
  });
  const resolved = L.resolveManifestFiles("hyper://key/trip/", manifest);
  lib.resolveShared = async () => ({ url: "hyper://key/trip/", name: "Road Trip", ...resolved });

  const savedSource = L.urlSource;
  const savedTags = L.readTags;
  L.urlSource = async (u) => { probed.push(u); return u; };
  L.readTags = async () => ({ title: "read from the drive" });
  try {
    const out = await lib.loadRemote("hyper://key/trip/");

    assert.equal(out.name, "Road Trip");
    assert.deepEqual(out.tracks.map((t) => t.title), ["One", "Two", "Three"]);
    // Not one byte of audio was fetched to build that list.
    assert.deepEqual(probed, []);
    // Covers are chased afterwards, one album at a time rather than one a song.
    assert.equal(lib.coverEntries.length, 3);
  } finally {
    L.urlSource = savedSource;
    L.readTags = savedTags;
  }
})

// The same for Import: the manifest names the songs, so the library can be
// filled without reading the drive, and the artwork is chased afterwards.
test("Import takes the names from the manifest and the covers later", async () => {
  const lib = Object.create(L.Library.prototype);
  lib._generation = 0;
  lib.tracks = new Map();
  lib._emitProgress = () => {};
  lib._invalidate = () => {};
  lib._saveTrack = async (track) => { lib.tracks.set(track.id, track); };
  const probed = [];
  lib._coversForLibrary = (entries) => { lib.coverEntries = entries; };

  const manifest = L.parseManifest({
    files: [
      { file: "01.mp3", title: "One", artist: "Band", album: "LP" },
      { file: "02.mp3", title: "Two", artist: "Band", album: "LP" },
    ],
  });
  const { files, meta } = L.resolveManifestFiles("hyper://key/trip/", manifest);

  const savedSource = L.urlSource;
  const savedTags = L.readTags;
  L.urlSource = async (u) => { probed.push(u); return u; };
  L.readTags = async () => ({ title: "read from the drive" });
  try {
    const res = await lib._importUrls(files, meta);

    assert.equal(res.added, 2);
    assert.equal(res.ids.length, 2);
    assert.deepEqual([...lib.tracks.values()].map((t) => t.title), ["One", "Two"]);
    assert.deepEqual(probed, []);
    assert.equal(lib.coverEntries.length, 2);
  } finally {
    L.urlSource = savedSource;
    L.readTags = savedTags;
  }
})

// Two songs off one record need one cover, not two.
test("artwork is fetched once per album, not once per song", async () => {
  const lib = Object.create(L.Library.prototype);
  lib._generation = 0;
  lib._invalidate = () => {};

  const read = [];
  const savedSource = L.urlSource;
  const savedTags = L.readTags;
  L.urlSource = async (u) => { read.push(u); return u; };
  L.readTags = async (u) => ({ picture: { data: new Uint8Array([1]), mime: "image/jpeg" }, url: u });
  try {
    const applied = [];
    await lib._coversForAlbums([
      { url: "a1", tags: { artist: "Band", album: "LP" } },
      { url: "a2", tags: { artist: "Band", album: "LP" } },
      { url: "b1", tags: { artist: "Other", album: "EP" } },
    ], async (key, picture, group) => { applied.push([key, group.length]); return true; });

    assert.deepEqual(read, ["a1", "b1"], "one read for each album");
    assert.equal(applied.length, 2);
    assert.deepEqual(applied.map(([, n]) => n), [2, 1]);
  } finally {
    L.urlSource = savedSource;
    L.readTags = savedTags;
  }
})
