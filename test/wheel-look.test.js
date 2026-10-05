// PeerTunes keeps a player shell, but not another player's exact details:
// no Apple product names, a menu glyph at the top of the wheel instead of a
// MENU label, and a rounded square center inside the round wheel.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

test("no Apple product names in what people see or the code behind it", () => {
  const files = ["index.html", "manifest.webmanifest", "README.md"];
  for (const dir of ["css", "js", "assets"]) {
    for (const name of fs.readdirSync(path.join(root, dir))) {
      if (/\.(html|css|js|json)$/.test(name)) files.push(`${dir}/${name}`);
    }
  }
  assert.ok(files.length > 10);
  for (const file of files) assert.doesNotMatch(read(file), /\bipod\b|click ?wheel|cover ?flow/i, file);
});

test("the top of the wheel shows a menu glyph, not a MENU label", () => {
  const html = read("index.html");
  const welcome = read("js/welcome.js");
  assert.match(html, /<span class="wz wz-menu" data-btn="menu"><\/span>/);
  assert.match(read("js/main.js"), /document\.querySelector\("\.wz-menu"\)\.innerHTML = PT\.icons\.menu;/);
  assert.match(read("assets/icons.js"), /menu: `<svg viewBox="0 0 14 12">/);
  assert.match(welcome, /data-icon="menu"/);
  for (const text of [html, welcome, read("README.md")]) assert.doesNotMatch(text, /MENU/);
});

test("the center button is a rounded square", () => {
  const css = read("css/style.css");
  for (const rule of [".wheel-center {", ".wl-center {"]) {
    const start = css.indexOf(rule);
    assert.notEqual(start, -1, rule);
    assert.match(css.slice(start, css.indexOf("}", start)), /border-radius: 34%;/, rule);
  }
});
