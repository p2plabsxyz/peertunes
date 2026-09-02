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
  const urls = L.resolveManifestFiles("hyper://key/mix/", parsed);
  assert.deepEqual(urls, [
    "hyper://key/mix/01%20-%20First%20Song.mp3",
    "hyper://abc/deep/track.flac",
    "hyper://key/mix/sub/second.m4a",
  ]);
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
  const urls = L.resolveManifestFiles("hyper://key/", parsed);
  assert.deepEqual(urls, ["hyper://key/ok.mp3"]);
});
