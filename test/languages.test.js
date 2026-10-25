// PeerTunes in the language PeerSky shows. On a phone set to another language
// every PeerSky screen changed and the player stayed English. PeerSky now
// hands the page its words (window.peerskyTunes), and a new set when another
// language is picked, and PeerTunes shows them, English for any it lacks.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const SCRIPTS = ["js/main.js", "js/ui.js", "js/welcome.js", "js/library.js", "js/player.js"];

// The scripts as a page loads them, with what PeerSky set before.
function loadPT(host = {}, files = ["../js/i18n.js"]) {
  global.window = Object.assign({}, host);
  for (const file of files) {
    delete require.cache[require.resolve(file)];
    require(file);
  }
  return global.window.PT;
}

const GERMAN = {
  language: "de",
  strings: {
    "Music": "Musik",
    "Delete {name}?": "{name} löschen?",
    "{count} songs will be removed from this device.": {
      one: "{count} Song wird von diesem Gerät entfernt.",
      other: "{count} Songs werden von diesem Gerät entfernt.",
    },
    "Unknown Album": "Unbekanntes Album",
    "{count} of {total} on this device": "{count} von {total} auf diesem Gerät",
  },
};

test("everything stays English when nothing says otherwise", () => {
  const { i18n } = loadPT();
  assert.equal(i18n.language(), "en");
  assert.equal(i18n.t("Music"), "Music");
  assert.equal(i18n.t("Delete {name}?", { name: "Road Trip" }), "Delete Road Trip?");
  const forms = { one: "{count} song will be removed from this device.", other: "{count} songs will be removed from this device." };
  assert.equal(i18n.tp(forms, 1), "1 song will be removed from this device.");
  assert.equal(i18n.tp(forms, 1200), "1,200 songs will be removed from this device.");
  assert.equal(i18n.direction(), "ltr");
});

test("the words PeerSky set before the page loaded are the ones shown", () => {
  const { i18n } = loadPT({ peerskyTunes: GERMAN });
  assert.equal(i18n.language(), "de");
  assert.equal(i18n.t("Music"), "Musik");
  assert.equal(i18n.t("Delete {name}?", { name: "Road Trip" }), "Road Trip löschen?");
  const forms = { one: "{count} song will be removed from this device.", other: "{count} songs will be removed from this device." };
  assert.equal(i18n.tp(forms, 1), "1 Song wird von diesem Gerät entfernt.");
  assert.equal(i18n.tp(forms, 1200), "1.200 Songs werden von diesem Gerät entfernt.");
  // Anything the catalog lacks is shown in English.
  assert.equal(i18n.t("Settings"), "Settings");
});

test("a count takes the form its language uses", () => {
  const { i18n } = loadPT();
  const forms = { one: "{count} song", other: "{count} songs" };
  i18n.setup({ language: "ru", strings: { "{count} songs": { one: "{count} песня", few: "{count} песни", many: "{count} песен" } } });
  assert.deepEqual([1, 3, 5, 21, 112].map((n) => i18n.tp(forms, n)), ["1 песня", "3 песни", "5 песен", "21 песня", "112 песен"]);
  i18n.setup({ language: "ja", strings: { "{count} songs": { other: "{count} 曲" } } });
  assert.equal(i18n.tp(forms, 1), "1 曲");
  // A bad tag is taken for English, rather than breaking every number.
  i18n.setup({ language: "<b>", strings: {} });
  assert.equal(i18n.language(), "en");
});

test("Arabic, Persian and Urdu turn the screen around, the wheel stays", () => {
  const { i18n } = loadPT();
  for (const code of ["ar", "fa", "ur"]) assert.equal(i18n.direction(code), "rtl", code);
  for (const code of ["en", "hi", "zh-Hans"]) assert.equal(i18n.direction(code), "ltr", code);
  const main = read("js/main.js");
  assert.match(main, /\$\("screen"\)\.dir = PT\.i18n\.direction\(\);/);
  assert.match(main, /document\.documentElement\.lang = PT\.i18n\.language\(\);/);
  assert.match(read("js/welcome.js"), /root\.dir = direction\(\);/);
  // The song's bar is scrubbed left to right in every language.
  assert.match(read("css/style.css"), /\.np-progress, \.np-times, \.np-vol \{ direction: ltr; \}/);
});

test("an album with no name is named in the language picked, and keeps its place", async () => {
  const { fakeStorage, fakeIndexedDB } = require("./fake-storage.js");
  global.localStorage = fakeStorage();
  global.indexedDB = fakeIndexedDB();
  const PT = loadPT({}, ["../js/i18n.js", "../assets/icons.js", "../js/metadata.js", "../js/library.js"]);
  const lib = new PT.Library();
  await lib.open();
  const song = lib._mkTrack("f1", "file", { title: "Demo", artist: "Band" }, {});
  lib.tracks.set(song.id, song);
  lib._groups = null;

  const [before] = lib.getAlbums();
  assert.equal(before.name, "Unknown Album");
  PT.i18n.setup(GERMAN);
  const [after] = lib.getAlbums();
  assert.equal(after.name, "Unbekanntes Album");
  // Keyed the same, so a page saved in English opens in German.
  assert.equal(after.key, before.key);
  assert.equal(lib.album(before.key), after);
  // A real album's name is never translated, even one that is a word the
  // catalog has.
  const named = lib._mkTrack("f2", "file", { title: "Two", artist: "Band", album: "Music" }, {});
  lib.tracks.set(named.id, named);
  lib._groups = null;
  assert.ok(lib.getAlbums().some((album) => album.name === "Music"));
  PT.i18n.setup({});
});

test("Keep On This Device counts in the language picked", () => {
  const PT = loadPT({ peerskyTunes: GERMAN }, ["../js/i18n.js", "../assets/icons.js", "../js/library.js", "../js/player.js", "../js/ui.js"]);
  const view = PT.keepView({ total: 5, saved: 2, cannot: 0, stuck: 0, current: { title: "Song" }, complete: false });
  assert.equal(view.count, "2 von 5 auf diesem Gerät");
  PT.i18n.setup({});
});

test("another language picked while the page is open draws the pages again where they are", () => {
  const PT = loadPT({}, ["../js/i18n.js", "../assets/icons.js", "../js/library.js", "../js/player.js", "../js/ui.js"]);
  const calls = [];
  const ui = {
    stack: [{ name: "root" }, { name: "music", route: ["music"], sel: 2 }, { name: "songactions" }],
    _routes: PT.UI.prototype._routes,
    rootScreen: () => ({ name: "root" }),
    replaceAll: (screen) => calls.push(["replaceAll", screen.name]),
    restoreRoutes: (routes) => calls.push(["restoreRoutes", routes]),
  };
  PT.UI.prototype.retranslate.call(ui);
  assert.deepEqual(calls, [["replaceAll", "root"], ["restoreRoutes", [{ r: ["music"], pos: 2 }]]]);
  // The host's hook sets the words first, then draws.
  assert.match(read("js/main.js"), /PT\.setLanguage = \(config\) => \{\s+PT\.i18n\.setup\(config\);\s+applyLanguage\(\);\s+ui\.retranslate\(\);/);
});

// PeerSky's scanner (scripts/i18n.mjs in peersky-mobile) can only list text
// written out whole, and it reads only the files that take t, tp and msg
// from PT.i18n.
test("every call names its English text as one plain string", () => {
  for (const file of SCRIPTS) {
    const source = read(file).replace(/^\s*\/\/.*$/gm, "");
    assert.match(source, /const \{[^}]*\b(?:t|tp|msg)\b[^}]*\} = PT\.i18n\b/, file);
    for (const match of source.matchAll(/(?<![\w.$])(t|msg|tKey)\(([^)]?)/g)) {
      if (match[1] === "tKey") continue;
      assert.equal(match[2], "\"", `${file}: ${match[1]}( at ${match.index} needs a plain string`);
    }
    for (const match of source.matchAll(/(?<![\w.$])tp\(/g)) {
      assert.match(source.slice(match.index), /^tp\(\{ one: "[^"\n]*", other: "[^"\n]*" \}|^tp\(\{\n\s+one: "[^"\n]*",\n\s+other: "[^"\n]*",\n\s+\}/, `${file}: tp( at ${match.index}`);
    }
  }
  // i18n.js loads before every script that uses it.
  const html = read("index.html");
  assert.ok(html.indexOf("./js/i18n.js") > 0 && html.indexOf("./js/i18n.js") < html.indexOf("./js/library.js"));
});

test("the welcome cards keep their bold words and nothing else as HTML", () => {
  const welcome = read("js/welcome.js");
  assert.match(welcome, /\.replace\(\/&lt;\(\\\/\?\)b&gt;\/g, "<\$1b>"\)/);
  assert.match(welcome, /stepEl\.querySelector\("h1"\)\.textContent = tKey\(step\.title\);/);
});
