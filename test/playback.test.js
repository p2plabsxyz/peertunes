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

test("a seek past the end lands on the end, not past it", () => {
  const { audio, handlers } = loadPlayer();
  handlers.seekto({ seekTime: 9999 });
  assert.equal(audio.currentTime, 200);
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
  return global.window.PT.ClickWheel;
}

test("the wheel asks native for a haptic before falling back to the web", () => {
  const ClickWheel = loadWheel();
  const asked = [];
  global.window.peerskyHaptic = (weight) => { asked.push(weight); return true; };
  const vibrated = [];
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { vibrate: (ms) => vibrated.push(ms) },
  });

  ClickWheel.prototype._haptic.call({}, "medium");

  // WKWebView has no navigator.vibrate at all, so on iPhone this was the only
  // way for the wheel to be felt.
  assert.deepEqual(asked, ["medium"]);
  assert.deepEqual(vibrated, []);
});

test("outside PeerSky the wheel still uses what the web gives it", () => {
  const ClickWheel = loadWheel();
  const vibrated = [];
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { vibrate: (ms) => vibrated.push(ms) },
  });

  ClickWheel.prototype._haptic.call({}, "light");
  ClickWheel.prototype._haptic.call({}, "medium");

  assert.deepEqual(vibrated, [4, 8]);
});
