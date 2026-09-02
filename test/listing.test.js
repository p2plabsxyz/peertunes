// Directory listing parser: hyper drives, Chrome-style pages, plain indexes.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const L = require("../js/library.js");

test("relative hrefs from a plain index page", () => {
  const html = `<ul>
    <li><a href="01%20-%20Song.mp3">01 - Song.mp3</a></li>
    <li><a href="covers/">covers/</a></li>
    <li><a href="?C=N;O=D">sort</a></li>
    <li><a href="../">parent</a></li>
  </ul>`;
  const names = L.parseListingHtml(html, "http://localhost:8641/music/");
  assert.deepEqual(names, ["01 - Song.mp3", "covers/"]);
});

test("chrome style listings use absolute paths", () => {
  const html = `
    <a class="icon up" href="/music/">[parent directory]</a>
    <a class="icon file" href="/music/albums/song%20one.mp3">song one.mp3</a>
    <a class="icon dir" href="/music/albums/deep/">deep/</a>`;
  const names = L.parseListingHtml(html, "http://host/music/albums/");
  assert.deepEqual(names, ["song one.mp3", "deep/"]);
});

test("hyper urls parse even though their origin is opaque", () => {
  const html = `
    <a href="/mixtape/track.flac">track</a>
    <a href="side-b.mp3">side b</a>
    <a href="hyper://someotherkey/steal.mp3">other drive</a>`;
  const names = L.parseListingHtml(html, "hyper://abcdef123/mixtape/");
  assert.deepEqual(names, ["track.flac", "side-b.mp3"]);
});

test("full urls on the same host pass, other hosts do not", () => {
  const html = `
    <a href="http://host/music/keep.mp3">keep</a>
    <a href="http://evil/music/nope.mp3">nope</a>
    <a href="https://host/music/wrong-scheme.mp3">nope</a>`;
  const names = L.parseListingHtml(html, "http://host/music/");
  assert.deepEqual(names, ["keep.mp3"]);
});

test("nested paths and anchors are skipped, duplicates collapse", () => {
  const html = `
    <a href="a.mp3">a</a>
    <a href='a.mp3'>a again</a>
    <a href="sub/deeper/x.mp3">too deep</a>
    <a href="#top">anchor</a>`;
  const names = L.parseListingHtml(html, "http://h/d/");
  assert.deepEqual(names, ["a.mp3"]);
});

test("garbage input returns nothing instead of throwing", () => {
  assert.deepEqual(L.parseListingHtml("not html at all", "http://h/d/"), []);
  assert.deepEqual(L.parseListingHtml("<a href=", "http://h/d/"), []);
  assert.deepEqual(L.parseListingHtml("<a href='x.mp3'>x</a>", "::bad url::"), []);
});
