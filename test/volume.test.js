// The wheel's volume on Now Playing. An iPhone keeps a song in a web view at
// full volume whatever the page sets, so turning the wheel while a song played
// did nothing there. PeerSky on an iPhone offers window.peerskyVolume, which
// moves the phone's own volume; everywhere else the song's volume moves.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const read = (file) => fs.readFileSync(path.join(__dirname, "..", file), "utf8");

function loadPT(phone) {
  global.window = phone ? { peerskyVolume: phone } : {};
  for (const file of ["../js/library.js", "../js/player.js"]) {
    delete require.cache[require.resolve(file)];
    require(file);
  }
  return global.window.PT;
}

function makePlayer(phone) {
  const PT = loadPT(phone);
  const audio = { volume: 1, paused: false, addEventListener() {} };
  const player = new PT.Player(audio, {});
  let events = 0;
  player.addEventListener("volume", () => events++);
  return { player, audio, events: () => events };
}

// A phone whose answers come when the test lets them.
function slowPhone(start = 0.5) {
  let level = start;
  const asked = [];
  const waiting = [];
  return {
    asked,
    level: () => level,
    change(step) {
      asked.push(Math.round(step * 100) / 100);
      return new Promise((resolve) => waiting.push(() => {
        level = Math.min(1, Math.max(0, level + step));
        resolve({ volume: level });
      }));
    },
    async answer() {
      while (waiting.length) {
        waiting.shift()();
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    },
  };
}

test("without PeerSky's phone volume, the wheel moves the song's volume, as before", async () => {
  const { player, audio, events } = makePlayer(null);
  await player.stepVolume(-0.05);
  assert.equal(Math.round(audio.volume * 100), 95);
  assert.equal(player.volume, audio.volume);
  await player.stepVolume(2);
  assert.equal(audio.volume, 1);
  assert.equal(events(), 2);
  await player.refreshVolume();
  assert.equal(events(), 2);
});

test("on an iPhone the wheel moves the phone's volume and shows where it is", async () => {
  const phone = slowPhone(0.5);
  const { player, audio, events } = makePlayer(phone);
  const turned = player.stepVolume(-0.05);
  await phone.answer();
  await turned;
  assert.deepEqual(phone.asked, [-0.05]);
  assert.equal(Math.round(player.volume * 100), 45);
  // The song's own volume stays where iOS holds it.
  assert.equal(audio.volume, 1);
  assert.equal(events(), 1);
});

test("turns that come while the phone answers are added together, none lost", async () => {
  const phone = slowPhone(0.5);
  const { player } = makePlayer(phone);
  const first = player.stepVolume(0.05);
  player.stepVolume(0.05);
  player.stepVolume(0.05);
  await phone.answer();
  await first;
  assert.deepEqual(phone.asked, [0.05, 0.1]);
  assert.equal(Math.round(player.volume * 100), 65);
  assert.equal(Math.round(phone.level() * 100), 65);
});

test("a phone with no volume to give leaves the song's volume to the wheel", async () => {
  const answers = [null, {}, { volume: "0.4" }, { volume: NaN }].map((a) => () => Promise.resolve(a));
  answers.push(() => Promise.reject(new Error("no slider")));
  for (const answer of answers) {
    const phone = { change: answer };
    const { player, audio } = makePlayer(phone);
    await player.stepVolume(-0.1);
    assert.equal(Math.round(audio.volume * 100), 90);
    assert.equal(player.volume, audio.volume);
  }
});

test("Now Playing reads the phone's volume before the wheel turns, and keeps it between 0 and 1", async () => {
  const asked = [];
  const { player, events } = makePlayer({ change: (step) => { asked.push(step); return Promise.resolve({ volume: 1.4 }); } });
  await player.refreshVolume();
  assert.deepEqual(asked, [0]);
  assert.equal(player.volume, 1);
  assert.equal(events(), 1);
});

test("Now Playing turns the wheel through the player, and paints the bar from the volume it answers", () => {
  const ui = read("js/ui.js");
  assert.match(ui, /ui\.player\.stepVolume\(dir \* 0\.05\);\n\s+this\.paintVolume\(\);/);
  assert.match(ui, /paintVolume\(\) \{\n\s+this\.els\.vfill\.style\.width = `\$\{ui\.player\.volume \* 100\}%`;/);
  assert.match(ui, /ui\.player\.addEventListener\("volume", onVolume\);/);
  assert.match(ui, /ui\.player\.removeEventListener\("volume", onVolume\)/);
  assert.match(ui, /this\.paintVolume\(\);\n\s+ui\.player\.refreshVolume\(\);/);
  assert.doesNotMatch(ui, /ui\.player\.audio\.volume/);
});
