// Parser tests with hand-built files, so CI needs no fixtures or ffmpeg.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const M = require("../js/metadata.js");

// ---- byte builders ----

function bytes(...parts) {
  const arrs = parts.map((p) => {
    if (p instanceof Uint8Array) return p;
    if (Array.isArray(p)) return Uint8Array.from(p);
    if (typeof p === "string") return Uint8Array.from(p, (c) => c.charCodeAt(0) & 0xff);
    throw new Error("bad part");
  });
  const total = arrs.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(total);
  let n = 0;
  for (const a of arrs) { out.set(a, n); n += a.length; }
  return out;
}
const be32 = (n) => [n >>> 24 & 255, n >>> 16 & 255, n >>> 8 & 255, n & 255];
const be24 = (n) => [n >>> 16 & 255, n >>> 8 & 255, n & 255];
const be16 = (n) => [n >>> 8 & 255, n & 255];
const le32 = (n) => [n & 255, n >>> 8 & 255, n >>> 16 & 255, n >>> 24 & 255];
const ss32 = (n) => [n >>> 21 & 127, n >>> 14 & 127, n >>> 7 & 127, n & 127];

const PNG = bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], new Uint8Array(64).fill(7));
const JPG = bytes([0xff, 0xd8, 0xff, 0xe0], new Uint8Array(64).fill(9));
const MP3_AUDIO = bytes([0xff, 0xfb, 0x90, 0x00], new Uint8Array(256).fill(0x55));

const read = (u8, name) => M.readTags(M.bufferSource(u8, name));

// ---- id3v2 builders ----

function id3v23(frames, { version = 3, sizeBytes = null } = {}) {
  const body = bytes(...frames);
  const pad = new Uint8Array(16);
  return bytes("ID3", [version, 0, 0], ss32(body.length + pad.length), body, pad);
}
function frame23(id, data, { version = 3, plainSize = false } = {}) {
  const size = version === 4 && !plainSize ? ss32(data.length) : be32(data.length);
  return bytes(id, size, [0, 0], data);
}
const t23 = (id, s, opts) => frame23(id, bytes([0], s), opts);

test("id3v2.3 text frames, genre id, track x/y and png APIC", async () => {
  const apic = frame23("APIC", bytes([0], "image/png", [0], [3], [0], PNG));
  const tag = id3v23([
    t23("TIT2", "Glass Piers"),
    t23("TPE1", "Midnight Peers"),
    t23("TALB", "Neon Harbor"),
    t23("TRCK", "3/12"),
    t23("TYER", "2024"),
    t23("TCON", "(17)"),
    apic,
  ]);
  const tags = await read(bytes(tag, MP3_AUDIO), "x.mp3");
  assert.equal(tags.title, "Glass Piers");
  assert.equal(tags.artist, "Midnight Peers");
  assert.equal(tags.album, "Neon Harbor");
  assert.equal(tags.track, 3);
  assert.equal(tags.trackTotal, 12);
  assert.equal(tags.year, 2024);
  assert.equal(tags.genre, "Rock");
  assert.equal(tags.picture.mime, "image/png");
  assert.deepEqual(Array.from(tags.picture.data.subarray(0, 4)), [0x89, 0x50, 0x4e, 0x47]);
});

test("id3v2.4 syncsafe frame sizes and TDRC date", async () => {
  const tag = id3v23([
    t23("TIT2", "Salt and Signal", { version: 4 }),
    t23("TPE1", "The Lantern Club", { version: 4 }),
    t23("TDRC", "2019-04-01", { version: 4 }),
  ], { version: 4 });
  const tags = await read(bytes(tag, MP3_AUDIO), "x.mp3");
  assert.equal(tags.title, "Salt and Signal");
  assert.equal(tags.artist, "The Lantern Club");
  assert.equal(tags.year, 2019);
});

test("id3v2.4 with broken plain uint32 frame sizes still parses", async () => {
  const long = "a very long lowercase title ".repeat(8).trim(); // > 128 bytes
  const tag = id3v23([
    t23("TIT2", long, { version: 4, plainSize: true }),
  ], { version: 4 });
  const tags = await read(bytes(tag, MP3_AUDIO), "x.mp3");
  assert.equal(tags.title, long);
});

test("id3v2.3 utf-16 text with BOM", async () => {
  const utf16 = bytes([1, 0xff, 0xfe], Uint8Array.from(Buffer.from("Träume", "utf16le")));
  const tag = id3v23([frame23("TIT2", utf16)]);
  const tags = await read(bytes(tag, MP3_AUDIO), "x.mp3");
  assert.equal(tags.title, "Träume");
});

test("id3v2.2 short frames and PIC art", async () => {
  const f22 = (id, data) => bytes(id, be24(data.length), data);
  const body = bytes(
    f22("TT2", bytes([0], "Old School")),
    f22("TP1", bytes([0], "Tape Deck")),
    f22("PIC", bytes([0], "PNG", [3], [0], PNG)),
  );
  const tag = bytes("ID3", [2, 0, 0], ss32(body.length), body);
  const tags = await read(bytes(tag, MP3_AUDIO), "x.mp3");
  assert.equal(tags.title, "Old School");
  assert.equal(tags.artist, "Tape Deck");
  assert.equal(tags.picture.mime, "image/png");
});

test("id3v1 tail fallback", async () => {
  const pad = (s, n) => bytes(s, new Uint8Array(n - s.length));
  const v1 = bytes("TAG", pad("Warm Static", 30), pad("Lo Tape", 30), pad("B-Sides", 30), "1999",
    new Uint8Array(28), [0], [7], [17]);
  const tags = await read(bytes(MP3_AUDIO, v1), "x.mp3");
  assert.equal(tags.title, "Warm Static");
  assert.equal(tags.artist, "Lo Tape");
  assert.equal(tags.album, "B-Sides");
  assert.equal(tags.year, 1999);
  assert.equal(tags.track, 7);
  assert.equal(tags.genre, "Rock");
});

// ---- flac ----

test("flac vorbis comment and picture block", async () => {
  const comment = (s) => bytes(le32(s.length), s);
  const vorbis = bytes(le32(4), "test", le32(4),
    comment("TITLE=Tidal Memory"), comment("ARTIST=The Lantern Club"),
    comment("TRACKNUMBER=3"), comment("DATE=2019"));
  const pic = bytes(be32(3), be32(10), "image/jpeg", be32(0),
    be32(600), be32(600), be32(24), be32(0), be32(JPG.length), JPG);
  const file = bytes("fLaC",
    [0x04], be24(vorbis.length), vorbis,
    [0x86], be24(pic.length), pic);
  const tags = await read(file, "x.flac");
  assert.equal(tags.title, "Tidal Memory");
  assert.equal(tags.artist, "The Lantern Club");
  assert.equal(tags.track, 3);
  assert.equal(tags.year, 2019);
  assert.equal(tags.picture.mime, "image/jpeg");
  assert.deepEqual(Array.from(tags.picture.data.subarray(0, 2)), [0xff, 0xd8]);
});

// ---- m4a ----

test("m4a ilst atoms with cover", async () => {
  const atom = (type, ...payload) => {
    const body = bytes(...payload);
    return bytes(be32(body.length + 8), type, body);
  };
  const item = (type, dtype, payload) => atom(type, atom("data", be32(dtype), be32(0), payload));
  const ilst = atom("ilst",
    item("©nam", 1, bytes("Skyline Loop")),
    item("©ART", 1, bytes("Midnight Peers")),
    item("©alb", 1, bytes("Neon Harbor")),
    item("©day", 1, bytes("2024")),
    item("trkn", 0, bytes([0, 0], be16(4), be16(12), [0, 0])),
    item("covr", 13, JPG),
  );
  const file = bytes(
    atom("ftyp", "M4A ", be32(0)),
    atom("moov", atom("udta", atom("meta", [0, 0, 0, 0], ilst))),
  );
  const tags = await read(file, "x.m4a");
  assert.equal(tags.title, "Skyline Loop");
  assert.equal(tags.artist, "Midnight Peers");
  assert.equal(tags.album, "Neon Harbor");
  assert.equal(tags.year, 2024);
  assert.equal(tags.track, 4);
  assert.equal(tags.trackTotal, 12);
  assert.equal(tags.picture.mime, "image/jpeg");
});

// ---- ogg ----

test("ogg opus tags across pages", async () => {
  const page = (payload, seq) => {
    const segs = [];
    let left = payload.length;
    while (left >= 255) { segs.push(255); left -= 255; }
    segs.push(left);
    return bytes("OggS", [0, seq === 0 ? 2 : 0], new Uint8Array(8), le32(1), le32(seq), new Uint8Array(4), [segs.length], segs, payload);
  };
  const head = bytes("OpusHead", [1, 2], [0, 0], le32(48000), [0, 0], [0]);
  const comment = (s) => bytes(le32(s.length), s);
  const tagsPkt = bytes("OpusTags", le32(4), "test", le32(2),
    comment("TITLE=Low Tide Radio"), comment("ARTIST=The Lantern Club"));
  const file = bytes(page(head, 0), page(tagsPkt, 1));
  const tags = await read(file, "x.opus");
  assert.equal(tags.title, "Low Tide Radio");
  assert.equal(tags.artist, "The Lantern Club");
});

// ---- wav ----

test("wav LIST INFO chunk", async () => {
  const chunk = (id, s) => {
    const pad = s.length % 2 ? "\0" : "";
    return bytes(id, le32(s.length), s, pad);
  };
  const info = bytes("INFO", chunk("INAM", "Field Notes"), chunk("IART", "Wind Recorder"), chunk("ICRD", "2021"));
  const file = bytes("RIFF", le32(4 + 8 + info.length), "WAVE", "LIST", le32(info.length), info);
  const tags = await read(file, "x.wav");
  assert.equal(tags.title, "Field Notes");
  assert.equal(tags.artist, "Wind Recorder");
  assert.equal(tags.year, 2021);
});

// ---- filename fallback ----

test("filename guesses when there are no tags", async () => {
  const tags = await read(MP3_AUDIO, "07 - Lo Tape - Warm Static.mp3");
  assert.equal(tags.title, "Warm Static");
  assert.equal(tags.artist, "Lo Tape");
  assert.equal(tags.track, 7);
  assert.equal(tags.picture, null);
});

test("tagsFromName handles plain and underscore names", () => {
  assert.equal(M.tagsFromName("some_song_name.mp3").title, "some song name");
  const t = M.tagsFromName("12. Artist Name - The Song.flac");
  assert.equal(t.track, 12);
  assert.equal(t.artist, "Artist Name");
  assert.equal(t.title, "The Song");
});

test("isAudioName filters by extension", () => {
  assert.equal(M.isAudioName("a.mp3"), true);
  assert.equal(M.isAudioName("a.FLAC"), true);
  assert.equal(M.isAudioName("a.txt"), false);
  assert.equal(M.isAudioName("cover.png"), false);
});

test("corrupt input still falls back to the filename", async () => {
  const garbage = bytes("ID3", [3, 0, 0], ss32(50000)); // size points past the end
  const tags = await read(garbage, "Artist - Broken File.mp3");
  assert.equal(tags.title, "Broken File");
  assert.equal(tags.artist, "Artist");
});
