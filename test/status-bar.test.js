// The status bar over the screen: the clock, Bluetooth while sound goes to a
// wireless device, Shuffle while it is on, and play or pause.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const read = (file) => fs.readFileSync(path.join(__dirname, "..", file), "utf8");

test("Shuffle shows next to Bluetooth while it is on", () => {
  const html = read("index.html");
  const right = html.slice(html.indexOf('<span class="sb-right">'), html.indexOf("</header>"));
  assert.match(right, /id="sb-bt"[^>]*hidden><\/span>\s*<span id="sb-shuffle" class="sb-shuffle" hidden><\/span>/);

  const main = read("js/main.js");
  assert.match(main, /\$\("sb-shuffle"\)\.innerHTML = PT\.icons\.shuffle;/);
  assert.match(main, /const showShuffle = \(\) => show\(\$\("sb-shuffle"\), player\.shuffle\);/);
  const onState = main.slice(main.indexOf('player.addEventListener("state", () => {'));
  assert.match(onState.slice(0, onState.indexOf("});")), /showShuffle\(\);/);
  assert.match(onState, /\}\);\s*showShuffle\(\);/, "and once at start, for a shuffle left on last time");

  const css = read("css/style.css");
  assert.match(css, /\.sb-shuffle \{ display: inline-flex;/);
  assert.match(css, /\[hidden\] \{ display: none !important; \}/);
});
