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

      audio.addEventListener("ended", () => this._onEnded());
      audio.addEventListener("play", () => this._emitState());
      audio.addEventListener("pause", () => this._emitState());
      audio.addEventListener("timeupdate", () => {
        this.dispatchEvent(new CustomEvent("time"));
        this._positionState();
      });
      audio.addEventListener("durationchange", () => this.dispatchEvent(new CustomEvent("time")));
      audio.addEventListener("error", () => {
        if (this.current()) this.dispatchEvent(new CustomEvent("trackerror", { detail: this.current() }));
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

    async playContext(tracks, startIndex = 0, opts = {}) {
      if (!tracks.length) return;
      this.baseQueue = tracks.slice();
      const useShuffle = opts.autoShuffle != null ? opts.autoShuffle : this.shuffle;
      if (useShuffle) {
        const first = tracks[startIndex];
        const rest = tracks.filter((_, i) => i !== startIndex);
        for (let i = rest.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          const tmp = rest[i]; rest[i] = rest[j]; rest[j] = tmp;
        }
        this.queue = [first].concat(rest);
        this.pos = 0;
      } else {
        this.queue = tracks.slice();
        this.pos = startIndex;
      }
      await this._load(true);
    }

    setShuffle(on) {
      this.shuffle = on;
      if (!this.queue.length) return;
      const cur = this.current();
      if (on) {
        const rest = this.queue.filter((t) => t !== cur);
        for (let i = rest.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          const tmp = rest[i]; rest[i] = rest[j]; rest[j] = tmp;
        }
        this.queue = cur ? [cur].concat(rest) : rest;
        this.pos = cur ? 0 : -1;
      } else {
        this.queue = this.baseQueue.slice();
        this.pos = Math.max(0, this.queue.indexOf(cur));
      }
      this._emitState();
    }

    async _load(autoplay) {
      const track = this.current();
      if (!track) return;
      if (this._blobUrl) { URL.revokeObjectURL(this._blobUrl); this._blobUrl = null; }
      let src;
      try {
        src = await this.library.trackAudioUrl(track);
      } catch (err) {
        console.warn("cannot load track", track.title, err);
        this.dispatchEvent(new CustomEvent("trackerror", { detail: track }));
        return;
      }
      if (src.startsWith("blob:")) this._blobUrl = src;
      this.audio.src = src;
      if (autoplay) this.audio.play().catch(() => {});
      this.dispatchEvent(new CustomEvent("trackchange", { detail: track }));
      this._emitState();
      this._mediaMetadata(track);
    }

    playPause() {
      if (!this.current()) return;
      if (this.audio.paused) this.audio.play().catch(() => {});
      else this.audio.pause();
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

    // Jump to an absolute position, used by the touch scrubber.
    seekTo(sec) {
      const d = this.audio.duration;
      if (!Number.isFinite(d) || d <= 0) return;
      this.audio.currentTime = Math.min(Math.max(0, sec), Math.max(0, d - 0.2));
      this.dispatchEvent(new CustomEvent("time"));
    }

    seekBy(sec) {
      const d = this.audio.duration;
      if (!Number.isFinite(d)) return;
      this.audio.currentTime = Math.min(Math.max(0, this.audio.currentTime + sec), d - 0.2);
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
      safe("play", () => this.audio.play().catch(() => {}));
      safe("pause", () => this.audio.pause());
      safe("previoustrack", () => this.prev());
      safe("nexttrack", () => this.next());
      safe("seekto", (d) => { if (d.seekTime != null) this.audio.currentTime = d.seekTime; });
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

    _positionState() {
      if (!("mediaSession" in navigator) || !navigator.mediaSession.setPositionState) return;
      const d = this.audio.duration;
      if (!Number.isFinite(d) || d <= 0) return;
      const now = performance.now();
      if (this._lastPos && now - this._lastPos < 1000) return;
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
