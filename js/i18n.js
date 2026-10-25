// The player's words in the language PeerSky shows. PeerSky on a phone sets
// window.peerskyTunes = { language, strings } before the page loads, and
// hands a new one to PT.setLanguage when another language is picked, so the
// song playing keeps playing. Anywhere else (PeerSky on a desktop, a plain
// browser) it all stays English.
//
// It works the way PeerSky's own screens do: the English text is the key,
// {name} fills a value in, a missing translation shows the English, and a
// count takes the form its language uses, by CLDR's rules for whole numbers.
//
// PeerSky's scanner (scripts/i18n.mjs in peersky-mobile) reads every call of
// t, tp and msg in the files that take them from PT.i18n, so each call names
// its English text as one plain string literal on one line, never pieced
// together with +. Text kept in a table is marked with msg where it is
// written and shown with tKey when it is drawn.

(function (PT) {
  "use strict";

  // Written right to left. The screen and the welcome cards turn around for
  // these; the wheel is part of the player and stays as it is.
  const RTL = new Set(["ar", "fa", "ur", "he", "yi", "ps", "sd", "ug", "dv"]);

  let language = "en";
  let catalog = {};
  let numbers = null;

  // A copy of pluralCategory in peersky-mobile's app/i18n/plural.mjs. Keep
  // the two alike.
  function pluralCategory(code, count) {
    const n = Math.abs(Math.trunc(Number(count) || 0));
    const mod10 = n % 10;
    const mod100 = n % 100;
    switch (code) {
      case "id": case "vi": case "th": case "ja": case "ko": case "zh-Hans": case "zh-Hant":
        return "other";
      // Zero takes the singular too.
      case "fr": case "pt-BR": case "fa": case "hi": case "bn":
        return n <= 1 ? "one" : "other";
      case "ru": case "uk":
        if (mod10 === 1 && mod100 !== 11) return "one";
        if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return "few";
        return "many";
      case "pl":
        if (n === 1) return "one";
        if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return "few";
        return "many";
      case "ar":
        if (n === 0) return "zero";
        if (n === 1) return "one";
        if (n === 2) return "two";
        if (mod100 >= 3 && mod100 <= 10) return "few";
        if (mod100 >= 11) return "many";
        return "other";
      case "sa":
        if (n === 1) return "one";
        if (n === 2) return "two";
        return "other";
      default:
        return n === 1 ? "one" : "other";
    }
  }

  /** The language and its catalog: { language, strings: { english: translation } }. */
  function setup(config) {
    const code = config && config.language;
    language = typeof code === "string" && /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(code) ? code : "en";
    const strings = config && config.strings;
    catalog = strings && typeof strings === "object" ? strings : {};
    numbers = null;
  }

  /** "rtl" for a language written right to left. */
  function direction(code = language) {
    return RTL.has(String(code).split("-")[0].toLowerCase()) ? "rtl" : "ltr";
  }

  function fill(text, values) {
    return String(text).replace(/\{(\w+)\}/g, (match, name) =>
      Object.prototype.hasOwnProperty.call(values, name) ? String(values[name]) : match);
  }

  function translate(text, values) {
    const entry = catalog[text];
    const translated = typeof entry === "string" && entry ? entry : text;
    return values ? fill(translated, values) : translated;
  }

  /** A whole number as the language writes it. */
  function formatNumber(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) return "";
    if (!numbers) {
      try { numbers = new Intl.NumberFormat(language); } catch { numbers = new Intl.NumberFormat("en"); }
    }
    return numbers.format(number);
  }

  /** This English text in the language picked, with each {name} filled in. */
  function t(text, values) {
    return translate(text, values);
  }

  /**
   * Text with a count in it, in the form the count takes in the language:
   * forms is the English one and other, each with {count}, which is filled
   * with the number as the language writes it.
   */
  function tp(forms, count, values) {
    const entry = catalog[forms.other];
    let text = "";
    if (entry && typeof entry === "object") {
      text = entry[pluralCategory(language, count)] || entry.other || "";
    }
    if (!text) text = pluralCategory("en", count) === "one" ? forms.one : forms.other;
    return fill(text, Object.assign({ count: formatNumber(count) }, values));
  }

  /** Marks text for translation where a table is written; tKey shows it. */
  function msg(text) {
    return text;
  }

  /** Like t, for text held in a variable, marked with msg where it was written. */
  function tKey(text, values) {
    return translate(text, values);
  }

  const i18n = {
    setup,
    t,
    tp,
    msg,
    tKey,
    formatNumber,
    pluralCategory,
    direction,
    language: () => language,
  };

  // What PeerSky set before the page loaded.
  if (typeof window !== "undefined" && window.peerskyTunes) setup(window.peerskyTunes);

  PT.i18n = i18n;
  // Each script also reaches it through require when it runs under Node, in
  // the tests, without this file loaded first.
  if (typeof module === "object" && module && module.exports) module.exports.i18n = i18n;
})(typeof window !== "undefined" ? (window.PT = window.PT || {}) : module.exports);
