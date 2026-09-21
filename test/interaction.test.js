// Pure helpers behind the newer screen interactions.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const M = require("../js/metadata.js");
const L = require("../js/library.js");
const P = require("../js/player.js");

// ---- album fallback ----

test("albumFromPath uses the folder holding the file", () => {
  assert.equal(M.albumFromPath("hyper://abc/music/Neon Harbor/01 Song.mp3"), "Neon Harbor");
  assert.equal(M.albumFromPath("hyper://abc/Neon%20Harbor/01.mp3"), "Neon Harbor");
  assert.equal(M.albumFromPath("ipfs://cid/Driftwood/1.mp3"), "Driftwood");
  assert.equal(M.albumFromPath("MyMusic/Driftwood/1.mp3"), "Driftwood");
});

test("albumFromPath refuses drive roots, generic folders and loose files", () => {
  assert.equal(M.albumFromPath("hyper://abc/song.mp3"), "", "drive key is not an album");
  assert.equal(M.albumFromPath("hyper://abc/music/1.mp3"), "", "generic folder");
  assert.equal(M.albumFromPath("downloads/1.mp3"), "");
  assert.equal(M.albumFromPath("song.mp3"), "");
  assert.equal(M.albumFromPath(""), "");
  assert.equal(M.albumFromPath(null), "");
  assert.equal(M.albumFromPath("a/" + "x".repeat(200) + "/1.mp3"), "", "absurd folder name");
});

test("albumFromPath ignores a query or fragment", () => {
  assert.equal(M.albumFromPath("http://h/a/Driftwood/2.flac?token=1"), "Driftwood");
});

// ---- scanned QR payloads ----

test("readScannedUrl accepts p2p and web sources", () => {
  assert.equal(L.readScannedUrl("hyper://abc/music/"), "hyper://abc/music/");
  assert.equal(L.readScannedUrl("  ipfs://cid/songs/  "), "ipfs://cid/songs/");
  assert.equal(L.readScannedUrl("https://host/music/"), "https://host/music/");
});

test("readScannedUrl unwraps a PeerTunes share link", () => {
  assert.equal(
    L.readScannedUrl("peersky://p2p/peertunes/#playlist=hyper%3A%2F%2Fabc%2Fm%2F"),
    "hyper://abc/m/");
  assert.equal(
    L.readScannedUrl("https://x/?src=ipfs%3A%2F%2Fcid%2F"),
    "ipfs://cid/");
});

test("readScannedUrl rejects anything that is not a music source", () => {
  for (const bad of [
    "javascript:alert(1)",
    "file:///etc/passwd",
    "peersky://p2p/peertunes/#playlist=javascript%3Aalert(1)",
    "not a url",
    "hyper://a b/c",
    "",
    null,
    "https://h/" + "a".repeat(5000),
  ]) {
    assert.equal(L.readScannedUrl(bad), "", `should reject ${String(bad).slice(0, 30)}`);
  }
});

// ---- external audio output ----

test("looksExternalAudioOutput spots wireless and car outputs", () => {
  const ext = (label, deviceId = "x1") => P.looksExternalAudioOutput({ kind: "audiooutput", label, deviceId });
  assert.equal(ext("Bluetooth Headset"), true);
  assert.equal(ext("AirPods Pro"), true);
  assert.equal(ext("Honda HFT"), true, "a car stereo named after the car");
  assert.equal(ext("WH-1000XM4"), true);
});

test("looksExternalAudioOutput ignores built-in outputs and unlabelled devices", () => {
  const ext = (label, deviceId = "x1") => P.looksExternalAudioOutput({ kind: "audiooutput", label, deviceId });
  assert.equal(ext("Speaker"), false);
  assert.equal(ext("Earpiece"), false);
  assert.equal(ext("Built-in Output"), false);
  assert.equal(ext("Default"), false);
  assert.equal(ext(""), false, "labels need permission; absence is not evidence");
  assert.equal(ext("Some Device", "default"), false);
  assert.equal(P.looksExternalAudioOutput({ kind: "audioinput", label: "Bluetooth Mic" }), false);
  assert.equal(P.looksExternalAudioOutput(null), false);
});

// ---- scrubbing ----

test("barFraction maps a pointer onto the bar and clamps at both ends", () => {
  const { barFraction } = require("../js/ui.js");
  const rect = { left: 100, width: 200 };
  assert.equal(barFraction(100, rect), 0);
  assert.equal(barFraction(200, rect), 0.5);
  assert.equal(barFraction(300, rect), 1);
  assert.equal(barFraction(40, rect), 0, "dragging past the start");
  assert.equal(barFraction(999, rect), 1, "dragging past the end");
  assert.equal(barFraction(150, { left: 0, width: 0 }), 0, "bar not laid out yet");
});
