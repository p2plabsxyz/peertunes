// Walking a folder of music: what happens when parts of a drive are slow.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const L = require("../js/library.js");

L.isAudioName = (name) => /\.(mp3|flac)$/i.test(name);
L.mapP2p = (url) => url;
const { _collectUrls, _listDir } = L.Library.prototype;

// A drive nobody has read before can time out on a deep folder while its
// parent answers. Those songs used to go missing until a Rescan.
test("a subfolder that fails to list is tried again", async () => {
  const calls = [];
  const lib = {
    async _listDir(url) {
      calls.push(url);
      if (url === "hyper://drive/") return ["intro.mp3", "albums/"];
      if (url === "hyper://drive/albums/") {
        if (calls.filter((c) => c === url).length < 2) throw new Error("listing 500");
        return ["song.flac"];
      }
      throw new Error("unexpected " + url);
    },
  };
  const state = {};
  const found = await _collectUrls.call(lib, "hyper://drive/", state);
  assert.deepEqual(found, ["hyper://drive/intro.mp3", "hyper://drive/albums/song.flac"]);
  assert.equal(state.partial, undefined);
});

test("a subfolder that never answers marks the import partial", async () => {
  const lib = {
    async _listDir(url) {
      if (url === "hyper://drive/") return ["intro.mp3", "lost/"];
      throw new Error("listing 500");
    },
  };
  const state = {};
  const found = await _collectUrls.call(lib, "hyper://drive/", state);
  assert.deepEqual(found, ["hyper://drive/intro.mp3"]);
  assert.equal(state.partial, true);
  assert.equal(state.rootError, undefined);
});

// A folder with an index.html or README.md in it answered with that file, so
// its songs were never seen.
test("hyper folders are listed with noResolve", async () => {
  const seen = [];
  const original = global.fetch;
  global.fetch = async (url) => {
    seen.push(url);
    return new Response(JSON.stringify(["a.mp3"]), { headers: { "content-type": "application/json" } });
  };
  try {
    assert.deepEqual(await _listDir.call({}, "hyper://drive/music/"), ["a.mp3"]);
    assert.deepEqual(await _listDir.call({}, "http://host/music/"), ["a.mp3"]);
  } finally {
    global.fetch = original;
  }
  assert.deepEqual(seen, ["hyper://drive/music/?noResolve", "http://host/music/"]);
});

// Upload Files handed the dialog a bare count, which it read as nothing found:
// "No new songs found" came up for songs it had just added.
test("an upload says how many songs were new and how many it found", async () => {
  L.readTags = async () => ({ title: "t" });
  L.fileSource = (f) => f;
  const saved = [];
  const lib = {
    tracks: new Map(),
    _mkTrack: (id) => ({ id }),
    async _saveTrack(track) { saved.push(track.id); this.tracks.set(track.id, track); },
    _emitProgress() {},
    _invalidate() {},
  };
  const file = (name) => ({ name, size: 1, lastModified: 1 });

  const first = await L.Library.prototype.addFiles.call(lib, [file("a.mp3"), file("notes.txt")]);
  assert.deepEqual(first, { added: 1, found: 1 });

  const again = await L.Library.prototype.addFiles.call(lib, [file("a.mp3"), file("b.flac")]);
  assert.deepEqual(again, { added: 1, found: 2 });

  assert.deepEqual(await L.Library.prototype.addFiles.call(lib, [file("cover.jpg")]), { added: 0, found: 0 });
  assert.equal(saved.length, 2);
});
