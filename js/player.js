// Playback queue + Media Session. When the phone locks, the system player
// keeps going and shows our metadata and artwork.

(function (PT) {
  "use strict";

  class Player extends EventTarget {
    constructor(audio, library) {
      super();
      this.audio = audio;
      this.library = library;
      this.queue = [];
      this.baseQueue = [];
      this.pos = -1;
      this.shuffle = false;
      this.repeat = "off"; // off | all | one
      this._blobUrl = null;
      this._unlocked = false;
      // A song can be loaded without being played, the one put back after a
      // restart. Its place waits for the file to say how long it is.
      this._cued = false;
      this._failed = false;
      this._pendingSeek = null;

      audio.addEventListener("ended", () => this._onEnded());
      audio.addEventListener("play", () => this._emitState());
      audio.addEventListener("pause", () => this._emitState());
      audio.addEventListener("timeupdate", () => {
        this.dispatchEvent(new CustomEvent("time"));
        this._positionState();
      });
      audio.addEventListener("durationchange", () => this.dispatchEvent(new CustomEvent("time")));
      audio.addEventListener("loadedmetadata", () => this._applyPendingSeek());
      // Where the playhead actually landed, and how fast it is moving: both are
      // what the system scrubber draws itself from.
      audio.addEventListener("seeked", () => this._positionState(true));
      audio.addEventListener("ratechange", () => this._positionState(true));
      audio.addEventListener("error", () => {
        if (!this.current()) return;
        // A song that was only put back, not played, says it cannot be
        // reached when play is pressed, not the moment the app opens.
        if (this._cued) { this._failed = true; return; }
        this.dispatchEvent(new CustomEvent("trackerror", { detail: this.current() }));
      });
      audio.volume = 1;

      this._mediaSession();
    }

    // one silent play inside the first real tap so later plays work on iOS
    unlock() {
      if (this._unlocked) return;
      this._unlocked = true;
      try {
        const a = this.audio;
        if (!a.src) {
          a.src = "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YQAAAAA=";
          a.play().then(() => {
            // only tidy up if nothing real started in the meantime
            if (a.src.startsWith("data:audio/wav")) { a.pause(); a.removeAttribute("src"); a.load(); }
          }).catch(() => {});
        }
      } catch {}
    }

    current() {
      return this.pos >= 0 ? this.queue[this.pos] : null;
    }

    // opts.autoplay false loads the first song without playing it.
    async playContext(tracks, startIndex = 0, opts = {}) {
      if (!tracks.length) return;
      this.baseQueue = tracks.slice();
      const useShuffle = opts.autoShuffle != null ? opts.autoShuffle : this.shuffle;
      if (useShuffle) {
        const first = tracks[startIndex];
        const rest = tracks.filter((_, i) => i !== startIndex);
        shuffleInPlace(rest);
        this.queue = [first].concat(rest);
        this.pos = 0;
      } else {
        this.queue = tracks.slice();
        this.pos = startIndex;
      }
      this._queueChanged();
      await this._load(opts.autoplay !== false);
    }

    setShuffle(on) {
      this.shuffle = on;
      if (!this.queue.length) { this._emitState(); return; }
      const cur = this.current();
      if (on) {
        const rest = this.queue.filter((t) => t !== cur);
        shuffleInPlace(rest);
        this.queue = cur ? [cur].concat(rest) : rest;
        this.pos = cur ? 0 : -1;
      } else {
        this.queue = this.baseQueue.slice();
        this.pos = Math.max(0, this.queue.indexOf(cur));
      }
      this._queueChanged();
      this._emitState();
    }

    // Loads another song of the queue, paused at its start.
    async cueAt(index) {
      if (index < 0 || index >= this.queue.length) return;
      this.pos = index;
      await this._load(false);
    }

    async _load(autoplay, at = 0) {
      const track = this.current();
      if (!track) return;
      if (this._blobUrl) { URL.revokeObjectURL(this._blobUrl); this._blobUrl = null; }
      let src;
      try {
        src = await this.library.trackAudioUrl(track);
      } catch (err) {
        console.warn("cannot load track", track.title, err);
        this._cued = !autoplay;
        this._failed = !autoplay;
        this._pendingSeek = at > 0 ? at : null;
        if (autoplay) this.dispatchEvent(new CustomEvent("trackerror", { detail: track }));
        return;
      }
      // Set with the new source, so the old one finishing up cannot take them.
      this._cued = !autoplay;
      this._failed = false;
      this._pendingSeek = at > 0 ? at : null;
      if (src.startsWith("blob:")) this._blobUrl = src;
      this.audio.src = src;
      if (autoplay) this.audio.play().catch(() => {});
      this.dispatchEvent(new CustomEvent("trackchange", { detail: track }));
      this._emitState();
      this._mediaMetadata(track);
    }

    play() {
      if (!this.current()) return;
      this._cued = false;
      // It could not be loaded while it was only put back: try again now that
      // someone wants it, and say so if it still fails.
      if (this._failed) {
        this._failed = false;
        this._load(true, this.position());
        return;
      }
      this.audio.play().catch(() => {});
    }

    playPause() {
      if (!this.current()) return;
      if (this.audio.paused) this.play();
      else this.audio.pause();
    }

    // Where in the song we are, counting a place still waiting to be applied.
    position() {
      if (this._pendingSeek != null) return this._pendingSeek;
      return this.audio.currentTime || 0;
    }

    _applyPendingSeek() {
      const at = this._pendingSeek;
      if (at == null) return;
      this._pendingSeek = null;
      this.seekTo(at);
    }

    _queueChanged() {
      this.dispatchEvent(new CustomEvent("queuechange"));
    }

    // ---- the song you were on, kept across a restart ----

    // The queue, as ids in play order and in the order it was picked from.
    // Play Only songs are not in the library, so they are kept whole.
    savedQueue() {
      if (!this.queue.length) return null;
      const ids = (list) => list.map((t) => t.id);
      const shuffled = this.baseQueue.length !== this.queue.length ||
        this.baseQueue.some((t, i) => t !== this.queue[i]);
      const temps = this.baseQueue.filter((t) => t.temp).map((t) => {
        const copy = Object.assign({}, t);
        delete copy.coverUrl; // a blob url, gone after a restart
        return copy;
      });
      return { v: 1, ids: ids(this.queue), base: shuffled ? ids(this.baseQueue) : null, temps };
    }

    // Which song, and where in it. Small, so it can be written often.
    savedPlace() {
      const track = this.current();
      if (!track) return null;
      return { v: 1, id: track.id, pos: this.pos, time: Math.round(this.position() * 10) / 10 };
    }

    // Puts a saved queue back, paused on the same song at the same place.
    // find(id) gives the library's song. Returns false, and changes nothing,
    // when that song is gone.
    restore(queue, place, find) {
      if (!queue || !place || !Array.isArray(queue.ids) || typeof place.id !== "string") return false;
      const temps = new Map();
      for (const t of Array.isArray(queue.temps) ? queue.temps : []) {
        if (t && typeof t.id === "string" && t.kind === "url" && typeof t.url === "string") temps.set(t.id, t);
      }
      const look = (id) => (typeof id === "string" && (find(id) || temps.get(id))) || null;
      const tracks = queue.ids.map(look).filter(Boolean);
      const current = look(place.id);
      // The saved index first, for a queue that holds a song twice.
      const pos = current && tracks[place.pos] === current ? place.pos : tracks.indexOf(current);
      if (!current || pos < 0) return false;
      const base = Array.isArray(queue.base) ? queue.base.map(look).filter(Boolean) : [];
      this.queue = tracks;
      this.baseQueue = base.length ? base : tracks.slice();
      this.pos = pos;
      const time = Number(place.time);
      this._load(false, Number.isFinite(time) ? time : 0);
      return true;
    }

    async next() {
      if (!this.queue.length) return;
      this.pos = this.pos < this.queue.length - 1 ? this.pos + 1 : 0;
      await this._load(true);
    }

    async prev() {
      if (!this.queue.length) return;
      if (this.audio.currentTime > 3 || this.pos === 0) {
        this.audio.currentTime = 0;
        return;
      }
      this.pos--;
      await this._load(true);
    }

    _stopAtEnd() {
      this.audio.pause();
      this.audio.currentTime = 0;
      this._emitState();
    }

    async _onEnded() {
      if (this.repeat === "one") {
        this.audio.currentTime = 0;
        this.audio.play().catch(() => {});
        return;
      }
      if (this.pos < this.queue.length - 1) {
        this.pos++;
        await this._load(true);
      } else if (this.repeat === "all") {
        this.pos = 0;
        await this._load(true);
      } else {
        this._stopAtEnd();
      }
    }

    // Jump to an absolute position: the touch scrubber, and the one on the
    // lock screen. fastSeek is what the system asks for mid-drag, cheaper, with
    // the exact landing settled by the seek that ends it.
    seekTo(sec, fast = false) {
      const d = this.audio.duration;
      if (!Number.isFinite(d) || d <= 0) return;
      const target = Math.min(Math.max(0, sec), Math.max(0, d - 0.2));
      try {
        if (fast && typeof this.audio.fastSeek === "function") this.audio.fastSeek(target);
        else this.audio.currentTime = target;
      } catch {
        return;
      }
      this._positionState(true);
      this.dispatchEvent(new CustomEvent("time"));
    }

    seekBy(sec) {
      const d = this.audio.duration;
      if (!Number.isFinite(d)) return;
      // Through the same path as a drag, so the system hears about it too.
      this.seekTo(this.audio.currentTime + sec);
    }

    setVolume(v) {
      this.audio.volume = Math.min(1, Math.max(0, v));
      this.dispatchEvent(new CustomEvent("volume"));
    }

    get playing() {
      return !!this.current() && !this.audio.paused;
    }

    _emitState() {
      this.dispatchEvent(new CustomEvent("state"));
      if ("mediaSession" in navigator) {
        navigator.mediaSession.playbackState = this.playing ? "playing" : this.current() ? "paused" : "none";
      }
    }

    _mediaSession() {
      if (!("mediaSession" in navigator)) return;
      const ms = navigator.mediaSession;
      const safe = (name, fn) => { try { ms.setActionHandler(name, fn); } catch {} };
      safe("play", () => this.play());
      safe("pause", () => this.audio.pause());
      safe("previoustrack", () => this.prev());
      safe("nexttrack", () => this.next());
      // The system scrubber moves on what we last reported, not on what the
      // audio element is doing, and reporting is throttled to once a second. A
      // drag that landed inside that second was answered with the old position
      // and the scrubber sprang straight back. Every seek reports at once.
      safe("seekto", (d) => {
        if (d.seekTime == null) return;
        this.seekTo(d.seekTime, d.fastSeek === true);
      });
      safe("seekbackward", (d) => this.seekBy(-(d.seekOffset || 10)));
      safe("seekforward", (d) => this.seekBy(d.seekOffset || 10));
      safe("stop", () => { this.audio.pause(); this.audio.currentTime = 0; });
    }

    async _mediaMetadata(track) {
      if (!("mediaSession" in navigator) || typeof MediaMetadata === "undefined") return;
      const artwork = [];
      try {
        const cover = await this.library.trackCover(track);
        if (cover) artwork.push({ src: cover, sizes: "512x512", type: "image/jpeg" });
      } catch {}
      try {
        navigator.mediaSession.metadata = new MediaMetadata({
          title: track.title,
          artist: track.artist || "Unknown Artist",
          album: track.album || "",
          artwork,
        });
      } catch {}
    }

    _positionState(force = false) {
      if (!("mediaSession" in navigator) || !navigator.mediaSession.setPositionState) return;
      const d = this.audio.duration;
      if (!Number.isFinite(d) || d <= 0) return;
      const now = performance.now();
      if (!force && this._lastPos && now - this._lastPos < 1000) return;
      this._lastPos = now;
      try {
        navigator.mediaSession.setPositionState({
          duration: d,
          playbackRate: this.audio.playbackRate,
          position: Math.min(this.audio.currentTime, d),
        });
      } catch {}
    }
  }

  function shuffleInPlace(list) {
    for (let i = list.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const tmp = list[i]; list[i] = list[j]; list[j] = tmp;
    }
    return list;
  }

  // Sound routed somewhere that is not the phone's own speaker. Car stereos
  // are named after the car, so keyword matching alone misses them: anything
  // that is not a recognised built-in output counts as external.
  const BUILTIN_OUTPUT = /\b(speaker|earpiece|receiver|built[- ]?in|internal|default|communications|system|phone|handset|wired|headphone jack|3\.5)\b/i;
  const WIRELESS_OUTPUT = /bluetooth|a2dp|airpod|airplay|earbud|buds|headset|wireless|carplay|android auto|\bcar\b|wh-|wf-|beats|jbl|bose|soundbar/i;

  function looksExternalAudioOutput(device) {
    if (!device || device.kind !== "audiooutput") return false;
    const label = String(device.label || "").trim();
    if (!label) return false; // labels need permission; absence is not evidence
    if (WIRELESS_OUTPUT.test(label)) return true;
    return !BUILTIN_OUTPUT.test(label) && device.deviceId !== "default";
  }

  PT.looksExternalAudioOutput = looksExternalAudioOutput;
  PT.Player = Player;
})(typeof window !== "undefined" ? (window.PT = window.PT || {}) : module.exports);
