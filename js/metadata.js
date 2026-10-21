// Tag reader for MP3 (ID3v2/v1), FLAC, M4A/MP4, OGG (vorbis/opus), WAV.
// Works over a chunked source so remote files only need small ranged reads.
// Plain script: attaches to window.PT in the browser, module.exports in Node.

(function (PT) {
  "use strict";

  const AUDIO_EXT = /\.(mp3|m4a|m4b|mp4|aac|flac|ogg|oga|opus|wav|webm)$/i;

  function isAudioName(name) {
    return AUDIO_EXT.test(name);
  }

  // ---------- chunked sources ----------

  function fileSource(file) {
    return {
      size: file.size,
      name: file.name,
      async read(off, len) {
        const end = Math.min(off + len, file.size);
        if (off >= end) return new Uint8Array(0);
        return new Uint8Array(await file.slice(off, end).arrayBuffer());
      },
    };
  }

  function bufferSource(bytes, name = "") {
    const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    return {
      size: u8.length,
      name,
      async read(off, len) {
        return u8.subarray(off, Math.min(off + len, u8.length));
      },
    };
  }

  // Remote file. Tries Range requests, falls back to one full download.
  async function urlSource(url, probeLen = 128 * 1024) {
    const name = decodeSafe(url.split("/").pop() || url);
    const src = { size: null, name, url, ranged: false, full: null, head: null };
    const fetchUrl = mapP2p(url);
    let res;
    try {
      res = await fetch(fetchUrl, { headers: { Range: `bytes=0-${probeLen - 1}` } });
    } catch {
      // some p2p handlers reject the cors preflight a Range header causes
      res = await fetch(fetchUrl);
    }
    if (!res.ok && res.status !== 206) throw new Error(`fetch ${res.status}`);
    if (res.status === 206) {
      src.ranged = true;
      const cr = res.headers.get("Content-Range");
      const total = cr && cr.includes("/") ? parseInt(cr.split("/")[1], 10) : NaN;
      src.head = new Uint8Array(await res.arrayBuffer());
      src.size = Number.isFinite(total) ? total : null;
    } else {
      const clen = parseInt(res.headers.get("Content-Length") || "", 10);
      if (Number.isFinite(clen) && clen > 100 * 1024 * 1024) {
        // too big to pull whole thing just for tags
        try { res.body && res.body.cancel(); } catch {}
        src.head = new Uint8Array(0);
        src.size = clen;
      } else {
        src.full = new Uint8Array(await res.arrayBuffer());
        src.head = src.full;
        src.size = src.full.length;
      }
    }
    src.read = async (off, len) => {
      const end = src.size != null ? Math.min(off + len, src.size) : off + len;
      if (off >= end) return new Uint8Array(0);
      if (src.full) return src.full.subarray(off, end);
      if (end <= src.head.length) return src.head.subarray(off, end);
      if (!src.ranged) return src.head.subarray(Math.min(off, src.head.length), Math.min(end, src.head.length));
      let r;
      try {
        r = await fetch(fetchUrl, { headers: { Range: `bytes=${off}-${end - 1}` } });
      } catch {
        src.ranged = false;
        if (src.size != null && src.size > 100 * 1024 * 1024) return new Uint8Array(0);
        r = await fetch(fetchUrl);
      }
      if (r.status === 206) return new Uint8Array(await r.arrayBuffer());
      if (r.ok) {
        src.full = new Uint8Array(await r.arrayBuffer());
        return src.full.subarray(off, Math.min(end, src.full.length));
      }
      return new Uint8Array(0);
    };
    return src;
  }

  // ---------- helpers ----------

  function decodeSafe(s) {
    try { return decodeURIComponent(s); } catch { return s; }
  }

  // mobile PeerSky pages cannot fetch hyper:// themselves; when the browser
  // exposes its loopback proxy we route requests through it at fetch time.
  // Track identity and share links always keep the real hyper url.
  function mapP2p(url) {
    try {
      if (typeof window !== "undefined" &&
          typeof window.peerskyHyperAsset === "function" &&
          /^hyper:\/\//i.test(url)) {
        const mapped = window.peerskyHyperAsset(url);
        if (typeof mapped === "string" && mapped) return mapped;
      }
    } catch {}
    return url;
  }

  const td = (label) => {
    try { return new TextDecoder(label); } catch { return new TextDecoder("utf-8"); }
  };
  const DEC = {
    latin1: td("windows-1252"),
    utf8: td("utf-8"),
    utf16le: td("utf-16le"),
    utf16be: td("utf-16be"),
  };

  function u32(b, o) { return (b[o] << 24 | b[o + 1] << 16 | b[o + 2] << 8 | b[o + 3]) >>> 0; }
  function u24(b, o) { return b[o] << 16 | b[o + 1] << 8 | b[o + 2]; }
  function u16(b, o) { return b[o] << 8 | b[o + 1]; }
  function u32le(b, o) { return (b[o] | b[o + 1] << 8 | b[o + 2] << 16 | b[o + 3] << 24) >>> 0; }
  function syncsafe(b, o) { return (b[o] & 0x7f) << 21 | (b[o + 1] & 0x7f) << 14 | (b[o + 2] & 0x7f) << 7 | (b[o + 3] & 0x7f); }
  function ascii(b, o, n) { let s = ""; for (let i = 0; i < n; i++) s += String.fromCharCode(b[o + i]); return s; }

  function cleanText(s) {
    return (s || "").replace(/\0+$/g, "").replace(/^﻿/, "").trim();
  }

  function decodeById3Enc(enc, bytes) {
    if (!bytes.length) return "";
    if (enc === 0) return cleanText(DEC.latin1.decode(bytes));
    if (enc === 3) return cleanText(DEC.utf8.decode(bytes));
    if (enc === 2) return cleanText(DEC.utf16be.decode(bytes));
    // enc 1: utf-16 with BOM
    if (bytes[0] === 0xfe && bytes[1] === 0xff) return cleanText(DEC.utf16be.decode(bytes.subarray(2)));
    return cleanText(DEC.utf16le.decode(bytes[0] === 0xff && bytes[1] === 0xfe ? bytes.subarray(2) : bytes));
  }

  // find string terminator honoring the encoding width
  function findTerm(bytes, start, enc) {
    const wide = enc === 1 || enc === 2;
    if (!wide) {
      for (let i = start; i < bytes.length; i++) if (bytes[i] === 0) return [i, i + 1];
      return [bytes.length, bytes.length];
    }
    for (let i = start; i + 1 < bytes.length; i += 2) {
      if (bytes[i] === 0 && bytes[i + 1] === 0) return [i, i + 2];
    }
    return [bytes.length, bytes.length];
  }

  const ID3V1_GENRES = ["Blues","Classic Rock","Country","Dance","Disco","Funk","Grunge","Hip-Hop","Jazz","Metal","New Age","Oldies","Other","Pop","R&B","Rap","Reggae","Rock","Techno","Industrial","Alternative","Ska","Death Metal","Pranks","Soundtrack","Euro-Techno","Ambient","Trip-Hop","Vocal","Jazz+Funk","Fusion","Trance","Classical","Instrumental","Acid","House","Game","Sound Clip","Gospel","Noise","Alt. Rock","Bass","Soul","Punk","Space","Meditative","Instrumental Pop","Instrumental Rock","Ethnic","Gothic","Darkwave","Techno-Industrial","Electronic","Pop-Folk","Eurodance","Dream","Southern Rock","Comedy","Cult","Gangsta","Top 40","Christian Rap","Pop/Funk","Jungle","Native American","Cabaret","New Wave","Psychedelic","Rave","Showtunes","Trailer","Lo-Fi","Tribal","Acid Punk","Acid Jazz","Polka","Retro","Musical","Rock & Roll","Hard Rock"];

  function normGenre(g) {
    if (!g) return "";
    const m = /^\((\d+)\)\s*(.*)$/.exec(g);
    if (m) {
      const byId = ID3V1_GENRES[parseInt(m[1], 10)];
      return m[2] || byId || "";
    }
    if (/^\d+$/.test(g)) return ID3V1_GENRES[parseInt(g, 10)] || g;
    return g;
  }

  function parseTrackNo(s) {
    if (s == null || s === "") return [null, null];
    const m = /^(\d+)\s*(?:\/\s*(\d+))?/.exec(String(s).trim());
    if (!m) return [null, null];
    return [parseInt(m[1], 10), m[2] ? parseInt(m[2], 10) : null];
  }

  function yearOf(s) {
    const m = /(\d{4})/.exec(s || "");
    return m ? parseInt(m[1], 10) : null;
  }

  function emptyTags() {
    return { title: "", artist: "", album: "", albumArtist: "", year: null, genre: "", track: null, trackTotal: null, disc: null, picture: null };
  }

  // A file can hold several pictures. The first one used to be the cover,
  // and it can be the back of the sleeve or a 32 pixel file icon. Now the
  // front cover wins, then one marked as nothing in particular, then any
  // picture but an icon.
  function pictureRank(type) {
    if (type === 3) return 0;
    if (type === 0 || type == null) return 1;
    if (type === 1 || type === 2) return 3;
    return 2;
  }

  function betterPicture(current, next) {
    if (!next) return current;
    if (!current) return next;
    return pictureRank(next.type) < pictureRank(current.type) ? next : current;
  }

  // "01 - Artist - Title" style guesses from the file name
  function tagsFromName(name) {
    const t = emptyTags();
    let base = (name || "").replace(/\.[a-z0-9]+$/i, "").replace(/[_]+/g, " ").trim();
    const numMatch = /^(\d{1,3})[\s.\-]+(.*)$/.exec(base);
    if (numMatch && numMatch[2]) { t.track = parseInt(numMatch[1], 10); base = numMatch[2].trim(); }
    const parts = base.split(/\s+-\s+/);
    if (parts.length >= 2) { t.artist = parts[0].trim(); t.title = parts.slice(1).join(" - ").trim(); }
    else t.title = base;
    return t;
  }

  // ---------- ID3v2 ----------

  async function readId3v2(src, offset = 0) {
    const head = await src.read(offset, 10);
    if (head.length < 10 || ascii(head, 0, 3) !== "ID3") return null;
    const ver = head[3];
    const flags = head[5];
    const size = syncsafe(head, 6);
    if (size <= 0 || size > 60 * 1024 * 1024) return null;
    let body = await src.read(offset + 10, size);
    if (flags & 0x80 && ver < 4) body = unsync(body); // whole-tag unsynchronisation

    const tags = emptyTags();
    let p = 0;
    if (flags & 0x40) { // extended header
      if (ver === 4) p += syncsafe(body, 0);
      else p += u32(body, 0) + 4;
    }

    const idLen = ver === 2 ? 3 : 4;
    const headLen = ver === 2 ? 6 : 10;

    while (p + headLen <= body.length) {
      if (body[p] === 0) break; // padding
      const id = ascii(body, p, idLen);
      if (!/^[A-Z0-9]+$/.test(id)) break;
      let fsize;
      if (ver === 2) fsize = u24(body, p + 3);
      else if (ver === 3) fsize = u32(body, p + 4);
      else {
        fsize = syncsafe(body, p + 4);
        // some writers put plain uint32 in v2.4; pick the one that lands on a valid frame
        const alt = u32(body, p + 4);
        if (alt !== fsize) {
          const okAt = (sz) => {
            const q = p + headLen + sz;
            if (q >= body.length) return q === body.length;
            return body[q] === 0 || /^[A-Z0-9]{4}$/.test(ascii(body, q, 4));
          };
          if (!okAt(fsize) && okAt(alt)) fsize = alt;
        }
      }
      const frameFlags = ver === 2 ? 0 : u16(body, p + 8);
      let data = body.subarray(p + headLen, p + headLen + fsize);
      p += headLen + fsize;
      if (fsize <= 0 || data.length === 0) continue;
      if (ver >= 3 && frameFlags & (ver === 4 ? 0x000c : 0x00c0)) continue; // compressed/encrypted
      if (ver === 4 && frameFlags & 0x0002) data = unsync(data);
      if (ver === 4 && frameFlags & 0x0001) data = data.subarray(4); // data length indicator

      const map2 = { TT2: "TIT2", TP1: "TPE1", TP2: "TPE2", TAL: "TALB", TRK: "TRCK", TPA: "TPOS", TYE: "TYER", TCO: "TCON", PIC: "APIC" };
      const key = ver === 2 ? map2[id] || id : id;

      if (key === "APIC") {
        tags.picture = betterPicture(tags.picture, parseApic(data, ver));
        continue;
      }
      if (key[0] !== "T") continue;
      const enc = data[0];
      // ID3v2.4 keeps several values in one frame, apart by a null.
      const values = decodeById3Enc(enc, data.subarray(1)).split("\0").map((v) => v.replace(/^\uFEFF/, "").trim()).filter(Boolean);
      if (!values.length) continue;
      const text = values[0];
      if (key === "TXXX") {
        // Some taggers keep the album artist here rather than in TPE2.
        if (values.length > 1 && /^album[ _]?artist$/i.test(values[0]) && !tags.albumArtist) tags.albumArtist = values[1];
        continue;
      }
      if (key === "TIT2") tags.title = text;
      else if (key === "TPE1") tags.artist = values.join(", ");
      else if (key === "TPE2") tags.albumArtist = values.join(", ");
      else if (key === "TALB") tags.album = text;
      else if (key === "TRCK") { const t = parseTrackNo(text); tags.track = t[0]; tags.trackTotal = t[1]; }
      else if (key === "TPOS") tags.disc = parseTrackNo(text)[0];
      else if (key === "TYER" || key === "TDRC" || key === "TDRL") tags.year = tags.year || yearOf(text);
      else if (key === "TCON") tags.genre = normGenre(text);
    }
    return tags;
  }

  function unsync(bytes) {
    const out = new Uint8Array(bytes.length);
    let n = 0;
    for (let i = 0; i < bytes.length; i++) {
      out[n++] = bytes[i];
      if (bytes[i] === 0xff && bytes[i + 1] === 0x00) i++;
    }
    return out.subarray(0, n);
  }

  function parseApic(data, ver) {
    try {
      const enc = data[0];
      let mime, p;
      if (ver === 2) {
        const fmt = ascii(data, 1, 3).toLowerCase();
        mime = fmt.includes("png") ? "image/png" : "image/jpeg";
        p = 4;
      } else {
        let e = 1;
        while (e < data.length && data[e] !== 0) e++;
        mime = cleanText(DEC.latin1.decode(data.subarray(1, e))).toLowerCase() || "image/jpeg";
        if (!mime.includes("/")) mime = "image/" + mime;
        p = e + 1;
      }
      const type = data[p];
      p += 1;
      const term = findTerm(data, p, enc); // skip description
      const img = data.slice(term[1]);
      if (img.length < 32) return null;
      return { mime, data: img, type };
    } catch { return null; }
  }

  // ---------- ID3v1 ----------

  async function readId3v1(src) {
    if (!src.size || src.size < 128) return null;
    const b = await src.read(src.size - 128, 128);
    if (b.length < 128 || ascii(b, 0, 3) !== "TAG") return null;
    const t = emptyTags();
    const str = (o, n) => cleanText(DEC.latin1.decode(b.subarray(o, o + n)));
    t.title = str(3, 30);
    t.artist = str(33, 30);
    t.album = str(63, 30);
    t.year = yearOf(str(93, 4));
    if (b[125] === 0 && b[126] !== 0) t.track = b[126];
    t.genre = ID3V1_GENRES[b[127]] || "";
    return t;
  }

  // ---------- FLAC ----------

  function parseFlacPicture(b) {
    try {
      const type = u32(b, 0);
      let p = 4;
      const mlen = u32(b, p); p += 4;
      const mime = ascii(b, p, mlen).toLowerCase(); p += mlen;
      const dlen = u32(b, p); p += 4 + dlen; // description
      p += 16; // w, h, depth, colors
      const size = u32(b, p); p += 4;
      const img = b.slice(p, p + size);
      if (img.length < 32) return null;
      return { mime: mime || "image/jpeg", data: img, type };
    } catch { return null; }
  }

  function applyVorbisComment(tags, b) {
    let p = 0;
    const vlen = u32le(b, p); p += 4 + vlen;
    const count = u32le(b, p); p += 4;
    for (let i = 0; i < count && p + 4 <= b.length; i++) {
      const len = u32le(b, p); p += 4;
      if (p + len > b.length) break;
      const kv = DEC.utf8.decode(b.subarray(p, p + len)); p += len;
      const eq = kv.indexOf("=");
      if (eq < 0) continue;
      const key = kv.slice(0, eq).toUpperCase();
      const val = kv.slice(eq + 1).trim();
      if (!val) continue;
      if (key === "TITLE" && !tags.title) tags.title = val;
      else if (key === "ARTIST" && !tags.artist) tags.artist = val;
      else if (key === "ALBUM" && !tags.album) tags.album = val;
      else if ((key === "ALBUMARTIST" || key === "ALBUM ARTIST" || key === "ALBUM_ARTIST") && !tags.albumArtist) tags.albumArtist = val;
      else if (key === "TRACKNUMBER" && tags.track == null) { const t = parseTrackNo(val); tags.track = t[0]; tags.trackTotal = t[1]; }
      else if (key === "TRACKTOTAL" && tags.trackTotal == null) tags.trackTotal = parseTrackNo(val)[0];
      else if (key === "DISCNUMBER" && tags.disc == null) tags.disc = parseTrackNo(val)[0];
      else if ((key === "DATE" || key === "YEAR") && !tags.year) tags.year = yearOf(val);
      else if (key === "GENRE" && !tags.genre) tags.genre = val;
      else if (key === "METADATA_BLOCK_PICTURE") {
        try {
          const bin = atob(val.replace(/\s+/g, ""));
          const u = new Uint8Array(bin.length);
          for (let j = 0; j < bin.length; j++) u[j] = bin.charCodeAt(j);
          tags.picture = betterPicture(tags.picture, parseFlacPicture(u));
        } catch {}
      }
    }
    return p;
  }

  async function readFlac(src, start = 0) {
    const tags = emptyTags();
    let off = start + 4;
    for (let i = 0; i < 64; i++) {
      const h = await src.read(off, 4);
      if (h.length < 4) break;
      const last = h[0] & 0x80;
      const type = h[0] & 0x7f;
      const size = u24(h, 1);
      if (type === 4 || type === 6) {
        const b = await src.read(off + 4, size);
        if (type === 4) applyVorbisComment(tags, b);
        else tags.picture = betterPicture(tags.picture, parseFlacPicture(b));
      }
      off += 4 + size;
      if (last) break;
    }
    return tags;
  }

  // ---------- MP4 / M4A ----------

  async function readMp4(src) {
    // hop top level atoms to find moov, then parse it in memory
    let off = 0;
    let moov = null;
    const limit = src.size != null ? src.size : Infinity;
    for (let i = 0; i < 64 && off + 8 <= limit; i++) {
      const h = await src.read(off, 16);
      if (h.length < 8) break;
      let size = u32(h, 0);
      const type = ascii(h, 4, 4);
      let hlen = 8;
      if (size === 1) { size = u32(h, 8) * 4294967296 + u32(h, 12); hlen = 16; }
      else if (size === 0) size = limit - off;
      if (size < 8) break;
      if (type === "moov") {
        if (size > 40 * 1024 * 1024) break;
        moov = await src.read(off + hlen, size - hlen);
        break;
      }
      off += size;
    }
    if (!moov) return emptyTags();

    const findChild = (buf, start, end, want) => {
      let p = start;
      while (p + 8 <= end) {
        let size = u32(buf, p);
        const type = ascii(buf, p + 4, 4);
        let hlen = 8;
        if (size === 1) { size = u32(buf, p + 8) * 4294967296 + u32(buf, p + 12); hlen = 16; }
        else if (size === 0) size = end - p;
        if (size < 8) return null;
        if (type === want) return [p + hlen, p + size];
        p += size;
      }
      return null;
    };

    let range = [0, moov.length];
    const path = ["udta", "meta", "ilst"];
    for (const name of path) {
      const found = findChild(moov, range[0], range[1], name);
      if (!found) return emptyTags();
      range = found;
      if (name === "meta") range = [range[0] + 4, range[1]]; // meta has version/flags
    }

    const tags = emptyTags();
    let p = range[0];
    while (p + 8 <= range[1]) {
      let size = u32(moov, p);
      if (size < 8) break;
      const type = ascii(moov, p + 4, 4);
      const inner = findChild(moov, p + 8, p + size, "data");
      if (inner) {
        const dtype = u32(moov, inner[0]);
        const payload = moov.subarray(inner[0] + 8, inner[1]);
        const text = () => cleanText(DEC.utf8.decode(payload));
        if (type === "©nam") tags.title = text();
        else if (type === "©ART") tags.artist = text();
        else if (type === "aART") tags.albumArtist = text();
        else if (type === "©alb") tags.album = text();
        else if (type === "©day") tags.year = yearOf(text());
        else if (type === "©gen") tags.genre = text();
        else if (type === "gnre") tags.genre = ID3V1_GENRES[u16(payload, 0) - 1] || "";
        else if (type === "trkn" && payload.length >= 6) { tags.track = u16(payload, 2); tags.trackTotal = u16(payload, 4) || null; }
        else if (type === "disk" && payload.length >= 4) tags.disc = u16(payload, 2);
        else if (type === "covr" && !tags.picture) {
          const mime = dtype === 14 ? "image/png" : "image/jpeg";
          if (payload.length > 32) tags.picture = { mime, data: payload.slice() };
        }
      }
      p += size;
    }
    return tags;
  }

  // ---------- OGG ----------

  // The comment header, the stream's second packet, can run far past the
  // first pages when it carries a picture. A fixed 256KB read cut the picture
  // off, and every comment after it, so pages are read until it is whole.
  const OGG_HEADER_LIMIT = 16 * 1024 * 1024;

  async function readOgg(src) {
    const tags = emptyTags();
    const packets = [];
    let parts = [];
    let serial = null;
    let off = 0;
    while (packets.length < 2 && off < OGG_HEADER_LIMIT) {
      const head = await src.read(off, 27 + 255);
      if (head.length < 27 || ascii(head, 0, 4) !== "OggS") break;
      const nseg = head[26];
      if (head.length < 27 + nseg) break;
      const pageSerial = u32le(head, 14);
      const lens = head.subarray(27, 27 + nseg);
      let plen = 0;
      for (let i = 0; i < nseg; i++) plen += lens[i];
      const pageStart = off + 27 + nseg;
      off = pageStart + plen;
      if (serial === null) serial = pageSerial;
      if (pageSerial !== serial) continue; // another stream's page
      const body = await src.read(pageStart, plen);
      let q = 0;
      for (let i = 0; i < nseg && packets.length < 2; i++) {
        parts.push(body.subarray(q, q + lens[i]));
        q += lens[i];
        if (lens[i] < 255) {
          let total = 0;
          for (const part of parts) total += part.length;
          const packet = new Uint8Array(total);
          let n = 0;
          for (const part of parts) { packet.set(part, n); n += part.length; }
          packets.push(packet);
          parts = [];
        }
      }
    }
    const comment = packets[1];
    if (!comment) return tags;
    if (ascii(comment, 0, 8) === "OpusTags") applyVorbisComment(tags, comment.subarray(8));
    else if (comment[0] === 3 && ascii(comment, 1, 6) === "vorbis") applyVorbisComment(tags, comment.subarray(7));
    else if ((comment[0] & 0x7f) === 4) applyVorbisComment(tags, comment.subarray(4)); // FLAC in Ogg
    return tags;
  }

  // ---------- WAV ----------

  async function readWav(src) {
    const tags = emptyTags();
    const head = await src.read(0, 12);
    if (ascii(head, 8, 4) !== "WAVE") return tags;
    let off = 12;
    const limit = src.size != null ? src.size : 8 * 1024 * 1024;
    for (let i = 0; i < 128 && off + 8 <= limit; i++) {
      const h = await src.read(off, 8);
      if (h.length < 8) break;
      const id = ascii(h, 0, 4);
      const size = u32le(h, 4);
      if (id === "LIST") {
        const b = await src.read(off + 8, Math.min(size, 512 * 1024));
        if (ascii(b, 0, 4) === "INFO") {
          let q = 4;
          while (q + 8 <= b.length) {
            const cid = ascii(b, q, 4);
            const clen = u32le(b, q + 4);
            const val = cleanText(DEC.latin1.decode(b.subarray(q + 8, q + 8 + clen)));
            if (cid === "INAM") tags.title = val;
            else if (cid === "IART") tags.artist = val;
            else if (cid === "IPRD") tags.album = val;
            else if (cid === "ICRD") tags.year = yearOf(val);
            else if (cid === "IGNR") tags.genre = val;
            else if (cid === "ITRK" || cid === "IPRT") tags.track = parseTrackNo(val)[0];
            q += 8 + clen + (clen & 1);
          }
        }
      } else if (id.toLowerCase().trim() === "id3") {
        const sub = {
          size,
          async read(o, l) { return src.read(off + 8 + o, Math.min(l, size - o)); },
        };
        const v2 = await readId3v2(sub, 0);
        // Its own fields first, the INFO list's where it has none: an empty
        // one used to blank out a title the list had.
        if (v2) Object.assign(tags, merge(v2, { ...tags }));
      }
      off += 8 + size + (size & 1);
    }
    return tags;
  }

  // ---------- entry point ----------

  function merge(base, extra) {
    if (!extra) return base;
    for (const k of Object.keys(base)) {
      if (base[k] == null || base[k] === "") base[k] = extra[k] != null ? extra[k] : base[k];
    }
    return base;
  }

  async function readTags(src) {
    let tags = null;
    try {
      const head = await src.read(0, 16);
      const magic = ascii(head, 0, 4);
      if (magic.startsWith("ID3")) {
        tags = await readId3v2(src, 0);
        // Some FLAC files carry an ID3 tag in front of their own. Their own
        // comments and pictures come after it, and they are the fuller ones.
        const flacAt = 10 + syncsafe(head, 6) + (head[5] & 0x10 ? 10 : 0);
        if (/\.flac$/i.test(src.name || "") && ascii(await src.read(flacAt, 4), 0, 4) === "fLaC") tags = merge(await readFlac(src, flacAt), tags);
        else if (tags && (!tags.title || !tags.artist || !tags.album)) merge(tags, await readId3v1(src).catch(() => null));
      } else if (magic === "fLaC") {
        tags = await readFlac(src);
      } else if (magic === "OggS") {
        tags = await readOgg(src);
      } else if (magic === "RIFF") {
        tags = await readWav(src);
      } else if (head.length >= 12 && ascii(head, 4, 4) === "ftyp") {
        tags = await readMp4(src);
      } else {
        tags = await readId3v1(src).catch(() => null);
      }
    } catch (err) {
      tags = null;
    }
    const hasAny = tags && (tags.title || tags.artist || tags.album || tags.picture);
    if (!hasAny) tags = merge(tags || emptyTags(), tagsFromName(src.name));
    if (!tags.title) tags.title = tagsFromName(src.name).title || src.name || "Unknown";
    return tags;
  }

  // Music is nearly always filed one album to a folder, so when a file
  // carries no album tag the containing folder is a better guess than
  // "Unknown Album". Generic library roots are not albums, so they are
  // skipped rather than turned into a fake one.
  const GENERIC_FOLDER = /^(music|songs?|audio|mp3s?|media|tracks|tunes|library|downloads?|files?|albums?|itunes|playlists?|various|misc|new folder|home|public|root)$/i;

  function albumFromPath(path) {
    const clean = String(path || "").split(/[?#]/)[0];
    const parts = clean.split("/").filter(Boolean);
    if (parts.length < 2) return "";
    const folderIndex = parts.length - 2;
    // hyper://<key>/song.mp3 has no folder: that segment is the drive host
    if (/^[a-z][a-z0-9+.-]*:$/i.test(parts[0]) && folderIndex <= 1) return "";
    // drop the file itself, then take the folder holding it
    const folder = decodeSafe(parts[folderIndex] || "").trim();
    if (!folder || GENERIC_FOLDER.test(folder)) return "";
    if (folder.length > 120) return "";
    return folder;
  }

  PT.albumFromPath = albumFromPath;
  PT.isAudioName = isAudioName;
  PT.mapP2p = mapP2p;
  PT.fileSource = fileSource;
  PT.bufferSource = bufferSource;
  PT.urlSource = urlSource;
  PT.tagsFromName = tagsFromName;
  PT.readTags = readTags;
})(typeof window !== "undefined" ? (window.PT = window.PT || {}) : module.exports);
