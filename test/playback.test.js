// The system player: what the lock screen is told, and when.
const { test } = require("node:test");
const assert = require("node:assert/strict");

// player.js attaches itself to a PT namespace on window, so give it one.
function loadPlayer(mediaSession) {
  const handlers = {};
  const positions = [];
  global.window = {};
  // Node defines navigator itself and will not let it be assigned over.
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: mediaSession === false
      ? {}
      : {
          mediaSession: {
            setActionHandler: (name, fn) => { handlers[name] = fn; },
            setPositionState: (state) => positions.push(state),
            playbackState: "none",
          },
        },
  });
  // A clock the test moves on purpose, so the throttle can be exercised.
  const clock = { ms: 1000 };
  global.performance = { now: () => clock.ms };
  delete require.cache[require.resolve("../js/player.js")];
  require("../js/player.js");
  const Player = global.window.PT.Player;

  const listeners = {};
  const audio = {
    paused: true,
    currentTime: 0,
    duration: 200,
    playbackRate: 1,
    volume: 1,
    addEventListener: (name, fn) => { listeners[name] = fn; },
    play: async () => {},
    pause: () => {},
  };

  const player = new Player(audio, { trackAudioUrl: async () => "blob:x", trackCover: async () => null });
  return { player, audio, handlers, positions, listeners, clock };
}

test("a seek from the lock screen is reported back straight away", () => {
  const { player, audio, handlers, positions } = loadPlayer();
  player.queue = [{ title: "Song" }];
  player.pos = 0;

  // A first report, so the throttle is primed the way it is during playback.
  player._positionState();
  const before = positions.length;

  handlers.seekto({ seekTime: 120 });

  assert.equal(audio.currentTime, 120);
  // Without this the scrubber kept drawing the old position and sprang back.
  assert.equal(positions.length, before + 1);
  assert.equal(positions.at(-1).position, 120);
});

// Just short of the end, the same as the scrubber in the app, so dragging all
// the way across plays out the last moment instead of skipping the song.
test("a seek past the end lands just short of the end, not past it", () => {
  const { audio, handlers } = loadPlayer();
  handlers.seekto({ seekTime: 9999 });
  assert.equal(audio.currentTime, 199.8);
  handlers.seekto({ seekTime: -5 });
  assert.equal(audio.currentTime, 0);
});

test("skipping forward and back is reported the same way", () => {
  const { player, audio, positions } = loadPlayer();
  audio.currentTime = 50;
  const before = positions.length;

  player.seekBy(10);

  assert.equal(Math.round(audio.currentTime), 60);
  assert.equal(positions.length, before + 1);
});

test("ordinary playback is still throttled to once a second", () => {
  const { player, positions, clock } = loadPlayer();
  player._positionState();
  const before = positions.length;

  clock.ms += 200;
  player._positionState();
  clock.ms += 200;
  player._positionState();
  assert.equal(positions.length, before, "a report per timeupdate would be four a second");

  clock.ms += 900;
  player._positionState();
  assert.equal(positions.length, before + 1);
});

test("nothing breaks where there is no media session", () => {
  const { player, audio } = loadPlayer(false);
  audio.currentTime = 10;
  player.seekBy(5);
  assert.equal(Math.round(audio.currentTime), 15);
});

// The wheel's click, for the hand rather than the ear.
function loadWheel() {
  global.window = {};
  delete require.cache[require.resolve("../js/wheel.js")];
  require("../js/wheel.js");
  return global.window.PT.Wheel;
}

test("the wheel asks native for a haptic before falling back to the web", () => {
  const Wheel = loadWheel();
  const asked = [];
  global.window.peerskyHaptic = (weight) => { asked.push(weight); return true; };
  const vibrated = [];
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { vibrate: (ms) => vibrated.push(ms) },
  });

  Wheel.prototype._haptic.call({}, "medium");

  // WKWebView has no navigator.vibrate at all, so on iPhone this was the only
  // way for the wheel to be felt.
  assert.deepEqual(asked, ["medium"]);
  assert.deepEqual(vibrated, []);
});

// The click you hear and the buzz you feel are separate settings. Turning the
// clicker off used to take the haptics with it, and there was no way to turn
// the haptics off alone.
test("haptics turn off apart from the click, and the other way round", () => {
  const Wheel = loadWheel();
  const asked = [];
  global.window.peerskyHaptic = (weight) => { asked.push(weight); return true; };
  global.performance = { now: () => 1000 };

  const silent = {
    clicker: false, haptics: true, _touched: true, _lastClick: 0, _haptic: Wheel.prototype._haptic,
    _unlockAudio() { throw new Error("no sound with the clicker off"); },
  };
  Wheel.prototype.tick.call(silent);
  assert.deepEqual(asked, ["light"]);

  let sounded = 0;
  const still = {
    clicker: true, haptics: false, _touched: true, _lastClick: 0, _haptic: () => asked.push("buzz"),
    _unlockAudio() { sounded++; }, _ctx: null,
  };
  Wheel.prototype.tick.call(still);
  assert.deepEqual(asked, ["light"]);
  assert.equal(sounded, 1);
});

test("the Haptics setting only shows where something can buzz", () => {
  const Wheel = loadWheel();
  global.window.peerskyHaptic = () => true;
  assert.equal(Wheel.canHaptic(), true);

  delete global.window.peerskyHaptic;
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { vibrate: () => true } });
  global.window.matchMedia = () => ({ matches: false });
  assert.equal(Wheel.canHaptic(), false, "a computer has nothing to feel");
  global.window.matchMedia = () => ({ matches: true });
  assert.equal(Wheel.canHaptic(), true);

  const fs = require("node:fs");
  const ui = fs.readFileSync(require.resolve("../js/ui.js"), "utf8");
  const main = fs.readFileSync(require.resolve("../js/main.js"), "utf8");
  assert.match(ui, /\.\.\.\(PT\.Wheel\.canHaptic\(\) \? \[\{\s+label: "Haptics"/);
  assert.match(ui, /s\.haptics = !s\.haptics; ui\.wheel\.haptics = s\.haptics; commit\(\);/);
  assert.match(main, /\{ clicker: true, haptics: true,/);
  assert.match(main, /wheel\.haptics = settings\.haptics;/);
});

test("outside PeerSky the wheel still uses what the web gives it", () => {
  const Wheel = loadWheel();
  const vibrated = [];
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { vibrate: (ms) => vibrated.push(ms) },
  });

  Wheel.prototype._haptic.call({}, "light");
  Wheel.prototype._haptic.call({}, "medium");

  assert.deepEqual(vibrated, [4, 8]);
});

// What an import reports back. "Added 1 song" after syncing eighteen is true
// and useless: the other seventeen were already here from a run that had been
// interrupted, and it reads as a failure.
test("an import says how many were new and how many were already here", () => {
  const messages = [];
  const ui = {
    lib: { busy: false },
    runTask: async (fn) => fn(),
    dialog: (opts) => messages.push(opts),
  };

  const { runImport } = loadRunImport();

  return (async () => {
    await runImport.call(ui, async () => ({ added: 1, found: 18 }));
    assert.equal(messages.at(-1).msg, "Added 1 song");
    assert.equal(messages.at(-1).sub, "17 of 18 were already in your library");

    await runImport.call(ui, async () => ({ added: 18, found: 18 }));
    assert.equal(messages.at(-1).msg, "Added 18 songs");
    assert.equal(messages.at(-1).sub, "");

    // Nothing new, but the source is there: not the same as finding nothing.
    await runImport.call(ui, async () => ({ added: 0, found: 18 }));
    assert.equal(messages.at(-1).msg, "Already up to date");
    assert.equal(messages.at(-1).sub, "18 of 18 were already in your library");

    await runImport.call(ui, async () => ({ added: 0, found: 0 }));
    assert.equal(messages.at(-1).msg, "No new songs found");

    // A folder that never answered is said out loud, not left to look empty.
    await runImport.call(ui, async () => ({ added: 3, found: 5, partial: true }));
    assert.equal(messages.at(-1).sub, "2 of 5 were already in your library. Some folders did not answer yet, so Rescan Sources later");
  })();
});

// ui.js is a browser file built around the DOM, so lift the one method out
// rather than standing the whole thing up.
function loadRunImport() {
  const fs = require("node:fs");
  const path = require("node:path");
  const src = fs.readFileSync(path.join(__dirname, "..", "js", "ui.js"), "utf8");
  const start = src.indexOf("    async runImport(fn, label");
  const end = src.indexOf("\n    }", src.indexOf("return result.added;")) + "\n    }".length;
  const body = src.slice(start, end).replace(/^\s*async runImport\(/, "async function runImport(");
  // eslint-disable-next-line no-new-func
  return { runImport: new Function(`return (${body})`)() };
}
