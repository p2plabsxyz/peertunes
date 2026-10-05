// Folders PeerSky keeps on the device. Removing one in PeerSky's settings
// takes the songs PeerTunes read from it out of the library too. Other hosts
// have no peerskyKeptFolders, and nothing changes there.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { Library } = require("../js/library.js");

test("a folder that was kept and no longer is takes its songs with it", async (t) => {
  const asked = [];
  global.window = {
    peerskyKeptFolders: async (urls) => {
      asked.push(urls);
      return { ok: true, kept: urls.filter((url) => url !== "hyper://c/removed/" && url !== "hyper://d/never-kept/") };
    },
  };
  t.after(() => { delete global.window; });
  const lib = {
    sources: [
      { url: "hyper://a/kept/", kept: true },
      { url: "hyper://b/new/" },
      { url: "hyper://c/removed/", kept: true },
      { url: "hyper://d/never-kept/" },
      { url: "https://example.com/songs/" },
    ],
    marked: [],
    forgotten: [],
    async _markKept(source) { source.kept = true; this.marked.push(source.url); },
    async forgetSource(url) { this.forgotten.push(url); return 3; },
  };
  assert.equal(await Library.prototype.syncKeptSources.call(lib), 3);
  assert.deepEqual(asked[0], ["hyper://a/kept/", "hyper://b/new/", "hyper://c/removed/", "hyper://d/never-kept/"]);
  assert.deepEqual(lib.forgotten, ["hyper://c/removed/"]);
  assert.deepEqual(lib.marked, ["hyper://b/new/"]);
});

test("every song stays when the host cannot say, or is not PeerSky", async (t) => {
  t.after(() => { delete global.window; });
  const lib = {
    sources: [{ url: "hyper://c/removed/", kept: true }],
    async _markKept() { throw new Error("not expected"); },
    async forgetSource() { throw new Error("not expected"); },
  };
  assert.equal(await Library.prototype.syncKeptSources.call(lib), 0);
  global.window = {};
  assert.equal(await Library.prototype.syncKeptSources.call(lib), 0);
  global.window = { peerskyKeptFolders: async () => ({ ok: false }) };
  assert.equal(await Library.prototype.syncKeptSources.call(lib), 0);
  global.window = { peerskyKeptFolders: async () => { throw new Error("gone"); } };
  assert.equal(await Library.prototype.syncKeptSources.call(lib), 0);
});

test("a folder counts as kept the moment PeerSky says it keeps it", async () => {
  const lib = {
    sources: [{ url: "hyper://a/music/" }],
    marked: [],
    async _markKept(source) { source.kept = true; this.marked.push(source.url); },
  };
  await Library.prototype.markSourceKept.call(lib, "hyper://a/music/");
  await Library.prototype.markSourceKept.call(lib, "hyper://a/music/");
  await Library.prototype.markSourceKept.call(lib, "hyper://unknown/");
  assert.deepEqual(lib.marked, ["hyper://a/music/"]);
});

test("forgetting a folder removes its songs and its empty playlist only", async () => {
  const lib = {
    tracks: new Map([
      ["1", { id: "1", kind: "url", url: "hyper://c/y/song.mp3" }],
      ["2", { id: "2", kind: "url", url: "hyper://c/yz/other.mp3" }],
      ["3", { id: "3", kind: "file" }],
      ["4", { id: "4", kind: "url", url: "hyper://c/y/disc/two.mp3" }],
    ]),
    playlists: new Map([
      ["p1", { id: "p1", sourceUrl: "hyper://c/y/", trackIds: [] }],
      ["p2", { id: "p2", sourceUrl: "hyper://c/y/", trackIds: ["3"] }],
    ]),
    deleted: [],
    droppedPlaylists: [],
    droppedSources: [],
    async deleteTrack(id) { this.deleted.push(id); this.tracks.delete(id); return true; },
    async deletePlaylist(id) { this.droppedPlaylists.push(id); },
    async _dropSource(url) { this.droppedSources.push(url); },
  };
  assert.equal(await Library.prototype.forgetSource.call(lib, "hyper://c/y/"), 2);
  assert.deepEqual(lib.deleted, ["1", "4"]);
  assert.deepEqual(lib.droppedPlaylists, ["p1"]);
  assert.deepEqual(lib.droppedSources, ["hyper://c/y/"]);
});
