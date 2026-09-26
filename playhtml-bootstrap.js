(function (global, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else global.PlayhtmlBootstrap = factory();
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  function createUnavailableBootstrap() {
    return function () {
      throw new Error("PlayHTML bootstrap is unavailable until the pinned upstream worker and connection API are proven");
    };
  }

  function createBootstrap(options) {
    options = options || {};
    const runtime = options.runtime;
    const target = options.globalObject || (typeof globalThis !== "undefined" ? globalThis : {});
    if (!runtime || typeof runtime.configure !== "function" || typeof runtime.init !== "function") {
      return createUnavailableBootstrap();
    }
    let initialized = null;
    let initializedConfig = null;
    return async function bootstrap(config) {
      const requested = { host: config.host, room: config.room };
      if (initializedConfig && (initializedConfig.host !== requested.host || initializedConfig.room !== requested.room)) {
        throw new Error("This page is already bound to another PlayHTML room; reload before joining another room");
      }
      if (!initialized) {
        initializedConfig = requested;
        initialized = Promise.resolve().then(function () {
          runtime.configure({ host: config.host, room: config.room });
          const playhtml = runtime.init();
          if (!playhtml || !playhtml.ready || typeof playhtml.createCustomMessageChannel !== "function") {
            throw new Error("PlayHTML public browser API is invalid");
          }
          return playhtml.ready.then(function () {
            const factory = function () {
              const channel = playhtml.createCustomMessageChannel();
              const handlers = Object.create(null);
              const unsubscribe = channel.subscribe(function (message) {
                let parsed;
                try { parsed = JSON.parse(message); } catch (_) { return; }
                for (const fn of handlers.message || []) fn(parsed);
              });
              return {
                on: function (event, fn) {
                  (handlers[event] || (handlers[event] = [])).push(fn);
                },
                connect: function () { return Promise.resolve(); },
                send: function (message) { return channel.send(JSON.stringify(message)); },
                close: function () {
                  unsubscribe();
                  channel.close();
                  if (typeof playhtml.close === "function") playhtml.close();
                  for (const event of Object.keys(handlers)) handlers[event] = [];
                }
              };
            };
            target.OTT_PLAYHTML_CONNECTION_FACTORY = factory;
            return factory;
          });
        });
      }
      return initialized;
    };
  }

  return { createUnavailableBootstrap, createBootstrap };
});
