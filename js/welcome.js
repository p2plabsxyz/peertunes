// First visit: what PeerTunes is, then how the wheel works. Two small cards
// over the player, shown once, and again from About whenever someone asks.

(function (PT) {
  "use strict";

  const { t, msg, tKey, direction } = PT.i18n || require("./i18n.js").i18n;

  const SEEN_KEY = "peertunes-welcome";

  // The words are marked here and put in the language picked as each card is
  // drawn. <b> is the one tag they hold.
  const STEPS = [
    {
      art: `<div class="wl-art wl-p2p" aria-hidden="true">
        <span class="wl-device wl-drive"></span>
        <span class="wl-wire"><i></i><i></i><i></i></span>
        <span class="wl-device wl-pod"><b></b></span>
      </div>`,
      title: "PeerTunes",
      lead: msg("A classic music player for your own songs."),
      text: msg("Play songs from a <b>hyper://</b> drive, a folder on this device, or a playlist a friend shares. The music comes straight from whoever has it: no account, no server, no tracking."),
    },
    {
      art: `<div class="wl-art wl-wheel" aria-hidden="true">
        <span class="wl-ring">
          <span class="wl-glyph wl-menu-icon" data-icon="menu"></span>
          <span class="wl-glyph wl-prev" data-icon="prev"></span>
          <span class="wl-glyph wl-next-icon" data-icon="next"></span>
          <span class="wl-glyph wl-play" data-icon="playpause"></span>
          <span class="wl-arm"><i></i></span>
        </span>
        <span class="wl-center"></span>
      </div>`,
      title: msg("The wheel"),
      moves: [
        msg("<b>Circle</b> the wheel to scroll"),
        msg("<b>Press the center</b> to pick"),
        msg("<b>The top</b> goes back"),
        msg("The bottom plays and pauses, the sides skip"),
        msg("<b>Hold the center</b> on a song to add it to a playlist"),
      ],
    },
  ];

  // Text as HTML with only its <b> tags kept: anything else is shown as is.
  function bold(text) {
    return String(text)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/&lt;(\/?)b&gt;/g, "<$1b>");
  }

  function bodyOf(step) {
    if (step.moves) return `<ul class="wl-moves">${step.moves.map((move) => `<li>${bold(tKey(move))}</li>`).join("")}</ul>`;
    return `<p class="wl-lead">${bold(tKey(step.lead))}</p><p>${bold(tKey(step.text))}</p>`;
  }

  function seen() {
    try { return localStorage.getItem(SEEN_KEY) === "1"; } catch { return false; }
  }

  function remember() {
    try { localStorage.setItem(SEEN_KEY, "1"); } catch {}
  }

  // Resolves once the cards are closed, so whoever opened them can carry on.
  function showWelcome() {
    return new Promise((resolve) => {
      const root = document.createElement("div");
      root.className = "welcome";
      root.setAttribute("role", "dialog");
      root.setAttribute("aria-modal", "true");
      root.setAttribute("aria-labelledby", "wl-title");
      root.dir = direction();
      root.innerHTML = `<div class="wl-card">
        <div class="wl-step"></div>
        <div class="wl-dots">${STEPS.map(() => "<span></span>").join("")}</div>
        <div class="wl-actions">
          <button type="button" class="wl-skip"></button>
          <button type="button" class="wl-next"></button>
        </div>
      </div>`;

      const stepEl = root.querySelector(".wl-step");
      const dots = Array.from(root.querySelectorAll(".wl-dots span"));
      const skip = root.querySelector(".wl-skip");
      const next = root.querySelector(".wl-next");
      skip.textContent = t("Skip");
      let index = 0;

      function render() {
        const step = STEPS[index];
        stepEl.innerHTML = `${step.art}<h1 id="wl-title"></h1>${bodyOf(step)}`;
        stepEl.querySelector("h1").textContent = tKey(step.title);
        stepEl.querySelectorAll("[data-icon]").forEach((el) => {
          if (PT.icons && PT.icons[el.dataset.icon]) el.innerHTML = PT.icons[el.dataset.icon];
        });
        dots.forEach((dot, i) => dot.classList.toggle("on", i === index));
        const last = index === STEPS.length - 1;
        next.textContent = last ? t("Start listening") : t("Next");
        skip.hidden = last;
        next.focus({ preventScroll: true });
      }

      function close() {
        remember();
        window.removeEventListener("keydown", onKey, true);
        root.classList.add("bye");
        setTimeout(() => root.remove(), 220);
        resolve();
      }

      function forward() {
        if (index < STEPS.length - 1) {
          index++;
          render();
        } else {
          close();
        }
      }

      // The wheel and the lists also listen for keys, so while the cards are
      // up they keep them all to themselves.
      function onKey(event) {
        if (event.key === "Escape") close();
        else if (event.key === "Enter" || event.key === " " || event.key === "ArrowRight") forward();
        else if (event.key === "ArrowLeft" && index > 0) { index--; render(); }
        else return;
        event.preventDefault();
        event.stopPropagation();
      }

      skip.addEventListener("click", close);
      next.addEventListener("click", forward);
      window.addEventListener("keydown", onKey, true);
      document.body.appendChild(root);
      render();
    });
  }

  PT.showWelcome = showWelcome;
  PT.welcomeSeen = seen;
})(typeof window !== "undefined" ? (window.PT = window.PT || {}) : module.exports);
