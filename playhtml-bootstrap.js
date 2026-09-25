(function (global, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else global.PlayhtmlBootstrap = factory();
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  function createUnavailableBootstrap() {
    return function () {
      throw new Error("PlayHTML bootstrap is unavailable until the pinned upstream worker and connection API are proven");
    };
  }

  return { createUnavailableBootstrap };
});
