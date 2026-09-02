// Click wheel input. Circular drags scroll, taps hit the five buttons,
// every real move makes the little iPod click.

(function (PT) {
  "use strict";

  const STEP_DEG = 13;

  class ClickWheel extends EventTarget {
    constructor(el, centerEl) {
      super();
      this.el = el;
      this.centerEl = centerEl;
      this.clicker = true;
      this._ctx = null;
      this._lastClick = 0;
      this._drag = null;

      el.addEventListener("pointerdown", (e) => this._down(e));
      el.addEventListener("pointermove", (e) => this._move(e));
      el.addEventListener("pointerup", (e) => this._up(e));
      el.addEventListener("pointercancel", () => { this._drag = null; clearTimeout(this._holdT); });

      // wheel / trackpad anywhere on the page scrolls too
      window.addEventListener("wheel", (e) => {
        e.preventDefault();
        this._wheelAcc = (this._wheelAcc || 0) + e.deltaY;
        const step = 44;
        while (Math.abs(this._wheelAcc) >= step) {
          const dir = this._wheelAcc > 0 ? 1 : -1;
          this._wheelAcc -= dir * step;
          this._scroll(dir);
        }
      }, { passive: false });

      window.addEventListener("keydown", (e) => {
        if (e.target && /^(INPUT|TEXTAREA)$/.test(e.target.tagName)) {
          if (e.key === "Escape") { e.target.blur(); this._press("menu"); }
          return;
        }
        const map = {
          ArrowDown: () => this._scroll(1),
          ArrowUp: () => this._scroll(-1),
          Enter: () => this._press("select"),
          Escape: () => this._press("menu"),
          Backspace: () => this._press("menu"),
          " ": () => this._press("play"),
          ArrowLeft: () => this._press("prev"),
          ArrowRight: () => this._press("next"),
        };
        const fn = map[e.key];
        if (fn) { e.preventDefault(); fn(); }
      });
    }

    _angle(e) {
      const r = this.el.getBoundingClientRect();
      const dx = e.clientX - (r.left + r.width / 2);
      const dy = e.clientY - (r.top + r.height / 2);
      return { deg: (Math.atan2(dy, dx) * 180) / Math.PI, dist: Math.hypot(dx, dy), radius: r.width / 2 };
    }

    _down(e) {
      try { this.el.setPointerCapture && this.el.setPointerCapture(e.pointerId); } catch {}
      const a = this._angle(e);
      this._drag = { lastDeg: a.deg, acc: 0, total: 0, t: performance.now(), moved: false };
      if (e.isTrusted) this._touched = true; // browsers only allow vibration after a real tap
      // holding the center button is the old On-The-Go gesture
      if (a.dist <= a.radius * 0.30) {
        clearTimeout(this._holdT);
        this._holdT = setTimeout(() => {
          if (this._drag && !this._drag.moved) {
            this._drag.consumed = true;
            this._press("hold");
          }
        }, 600);
      }
      this._unlockAudio();
    }

    _move(e) {
      if (!this._drag) return;
      const a = this._angle(e);
      let d = a.deg - this._drag.lastDeg;
      if (d > 180) d -= 360;
      if (d < -180) d += 360;
      this._drag.lastDeg = a.deg;
      // ignore the dead center and tiny jitter
      if (a.dist < a.radius * 0.18) return;
      this._drag.acc += d;
      this._drag.total += Math.abs(d);
      if (this._drag.total > 10) { this._drag.moved = true; clearTimeout(this._holdT); }
      while (this._drag.acc >= STEP_DEG) { this._drag.acc -= STEP_DEG; this._scroll(1); }
      while (this._drag.acc <= -STEP_DEG) { this._drag.acc += STEP_DEG; this._scroll(-1); }
    }

    _up(e) {
      clearTimeout(this._holdT);
      const drag = this._drag;
      this._drag = null;
      if (!drag || drag.consumed) return;
      const dt = performance.now() - drag.t;
      if (drag.moved || dt > 600) return;
      // it was a tap: which zone?
      const a = this._angle(e);
      if (a.dist <= a.radius * 0.30) { this._press("select"); return; }
      if (a.dist > a.radius * 1.02) return;
      const deg = a.deg;
      if (deg > -135 && deg <= -45) this._press("menu");
      else if (deg > -45 && deg <= 45) this._press("next");
      else if (deg > 45 && deg <= 135) this._press("play");
      else this._press("prev");
    }

    _scroll(dir) {
      // no sound here: the UI ticks only when the highlight really moves
      this.dispatchEvent(new CustomEvent("scroll", { detail: { dir } }));
    }

    _press(btn) {
      this.tick(btn === "select" ? 1.2 : 1);
      const lbl = this.el.querySelector(`[data-btn="${btn}"]`);
      if (lbl) {
        lbl.classList.add("pressed");
        setTimeout(() => lbl.classList.remove("pressed"), 130);
      }
      this.dispatchEvent(new CustomEvent("press", { detail: { btn } }));
    }

    // ---- the clicker ----

    _unlockAudio() {
      if (!this._ctx) {
        try {
          this._ctx = new (window.AudioContext || window.webkitAudioContext)();
          this._buildClick();
        } catch {}
      }
      if (this._ctx && this._ctx.resume) this._ctx.resume().catch(() => {});
    }

    _buildClick() {
      const ctx = this._ctx;
      const len = Math.floor(ctx.sampleRate * 0.006);
      const buf = ctx.createBuffer(1, len, ctx.sampleRate);
      const ch = buf.getChannelData(0);
      for (let i = 0; i < len; i++) {
        const t = i / len;
        const env = Math.pow(1 - t, 2.6);
        const tone = Math.sign(Math.sin(2 * Math.PI * 2100 * (i / ctx.sampleRate)));
        const noise = Math.random() * 2 - 1;
        ch[i] = (tone * 0.55 + noise * 0.45) * env;
      }
      this._clickBuf = buf;
    }

    tick(gainMul = 1) {
      if (!this.clicker) return;
      const now = performance.now();
      if (now - this._lastClick < 14) return;
      this._lastClick = now;
      this._unlockAudio();
      const ctx = this._ctx;
      if (!ctx || !this._clickBuf) return;
      try {
        const srcNode = ctx.createBufferSource();
        srcNode.buffer = this._clickBuf;
        const g = ctx.createGain();
        g.gain.value = 0.22 * gainMul;
        const hp = ctx.createBiquadFilter();
        hp.type = "highpass";
        hp.frequency.value = 1200;
        srcNode.connect(hp).connect(g).connect(ctx.destination);
        srcNode.start();
      } catch {}
      if (this._touched) { try { navigator.vibrate && navigator.vibrate(4); } catch {} }
    }
  }

  PT.ClickWheel = ClickWheel;
})(typeof window !== "undefined" ? (window.PT = window.PT || {}) : module.exports);
