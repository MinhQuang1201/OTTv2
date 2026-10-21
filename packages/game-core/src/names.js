(function (global, factory) {
  const config =
    typeof require === "function"
      ? require("./config")
      : global.OTT_CONFIG;
  const api = factory(config);
  if (typeof module === "object" && module && module.exports) module.exports = api;
  global.OTT_NAMES = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function (config) {
  /**
   * The one display-name cleaner for every surface (Room, Lobby, Game DO, tournaments):
   * strip HTML tags and stray angle brackets, collapse whitespace, cut to `max`.
   * Returns "" when nothing printable is left; callers pick their own fallback.
   */
  function cleanDisplayName(value, max = config.NAME_MAX) {
    if (typeof value !== "string") return "";
    return value
      .replace(/<[^>]*>/g, "")
      .replace(/[<>]/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, max)
      .trim();
  }

  return { cleanDisplayName, NAME_MAX: config.NAME_MAX };
});
