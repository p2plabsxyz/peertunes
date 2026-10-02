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
