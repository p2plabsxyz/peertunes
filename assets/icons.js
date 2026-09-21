// All the small glyphs in one place. Kept as strings so fills can follow
// the shell theme through CSS, which img/svg files cannot do.

(function (PT) {
  "use strict";

  PT.icons = {
    play: `<svg viewBox="0 0 12 12"><path d="M2 1.5 L10.5 6 L2 10.5 Z"/></svg>`,
    pause: `<svg viewBox="0 0 12 12"><path d="M2.5 1.5h2.6v9H2.5zM6.9 1.5h2.6v9H6.9z"/></svg>`,
    bt: `<svg viewBox="0 0 12 14"><path d="M2.2 4.1 9.5 9.9 5.9 12.9 5.9 1.1 9.5 4.1 2.2 9.9" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/></svg>`,

    prev: `<svg viewBox="0 0 20 12"><path d="M10 0 2 6l8 6zM19 0l-8 6 8 6z"/><rect x="0" y="0" width="2" height="12"/></svg>`,
    next: `<svg viewBox="0 0 20 12"><path d="M10 0l8 6-8 6zM1 0l8 6-8 6z"/><rect x="18" y="0" width="2" height="12"/></svg>`,
    playpause: `<svg viewBox="0 0 22 12"><path d="M0 0l9.5 6L0 12z"/><rect x="12.5" y="0" width="3.4" height="12"/><rect x="18" y="0" width="3.4" height="12"/></svg>`,

    note: `<svg viewBox="0 0 24 24"><path d="M9 3v10.55A4 4 0 1 0 11 17V7h8V3H9z"/></svg>`,
    shuffle: `<svg viewBox="0 0 24 24"><path d="M17 4l4 4-4 4V9h-2.6l-8 8H2v-2h3.6l8-8H17V4zM2 7h4.4l1.8 1.8-1.4 1.4L5.2 9H2V7zm12.8 6.8l1.4-1.4 1.8 1.8H17v-3l4 4-4 4v-3h-3.6l-1.6-1.6 1.4-1.4.6.6z"/></svg>`,
    repeat: `<svg viewBox="0 0 24 24"><path d="M7 7h10v3l4-4-4-4v3H5v6h2V7zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2v4z"/></svg>`,
    repeatOne: `<svg viewBox="0 0 24 24"><path d="M7 7h10v3l4-4-4-4v3H5v6h2V7zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2v4zm-5-9h1.5v5H12v-3.5h-1V9l1-1z"/></svg>`,
    speaker: `<svg viewBox="0 0 24 24"><path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3a4.5 4.5 0 0 0-2.5-4v8a4.5 4.5 0 0 0 2.5-4zM14 3.2v2.1a7 7 0 0 1 0 13.4v2.1a9 9 0 0 0 0-17.6z"/></svg>`,
    qr: `<svg viewBox="0 0 24 24"><path d="M3 3h8v8H3V3zm2 2v4h4V5H5zm8-2h8v8h-8V3zm2 2v4h4V5h-4zM3 13h8v8H3v-8zm2 2v4h4v-4H5zm8-2h3v2h-3v-2zm5 0h3v3h-2v-1h-1v-2zm-5 4h2v2h2v2h-4v-4zm6 1h3v3h-3v-3zm-2 2h1v1h-1v-1z"/></svg>`,
        sync: `<svg viewBox="0 0 48 48" class="arrows"><path d="M24 6a18 18 0 0 1 16.9 11.7l3.8-1.4A22 22 0 0 0 24 2v-2l-8 5 8 5V6zM24 42A18 18 0 0 1 7.1 30.3l-3.8 1.4A22 22 0 0 0 24 46v2l8-5-8-5v4z"/></svg>`,
  };
})(typeof window !== "undefined" ? (window.PT = window.PT || {}) : module.exports);
