(function (global, factory) {
  if (typeof process === "object" && process && process.versions && process.versions.node && typeof module === "object" && module && module.exports) module.exports = factory();
  else global.PlayhtmlBootstrap = factory();
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  function createUnavailableBootstrap() {
    const fn = function () {
      throw new Error("PlayHTML bootstrap is unavailable until the pinned upstream worker and connection API are proven");
    };
    fn.bootstrap = fn;
    fn.dispose = function () { return Promise.resolve(); };
    return fn;
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
    let installedFactory = null;
    let currentPlayhtml = null;
    let epoch = 0;
    let disposing = null;
    let needsReset = false;

    async function bootstrap(config) {
      if (!config || typeof config.host !== "string" || typeof config.room !== "string" || !config.host || !config.room) {
        throw new Error("PlayHTML requires a host and room");
      }
      while (disposing) {
        try { await disposing; } catch (_) {}
      }
      const requested = { host: config.host, room: config.room };
      if (config.party) requested.party = config.party;
      if (initializedConfig && (initializedConfig.host !== requested.host || initializedConfig.room !== requested.room || initializedConfig.party !== requested.party)) {
        throw new Error("This page is already bound to another PlayHTML room; reload before joining another room");
      }
      if (!initialized) {
        const currentEpoch = ++epoch;
        initializedConfig = requested;
        initialized = (async function () {
          if (epoch !== currentEpoch) {
            throw new Error("PlayHTML bootstrap was aborted");
          }
          const configToPass = { host: config.host, room: config.room };
          if (config.party) configToPass.party = config.party;
          runtime.configure(configToPass);
          needsReset = true;
          const playhtml = runtime.init();
          if (epoch !== currentEpoch) {
            if (playhtml && typeof playhtml.close === "function") {
              try { playhtml.close(); } catch (_) {}
            }
            throw new Error("PlayHTML bootstrap was aborted");
          }
          currentPlayhtml = playhtml;
          if (!playhtml || !playhtml.ready || typeof playhtml.createCustomMessageChannel !== "function") {
            throw new Error("PlayHTML public browser API is invalid");
          }
          return playhtml.ready.then(function () {
            if (epoch !== currentEpoch) {
              if (playhtml && typeof playhtml.close === "function") {
                try { playhtml.close(); } catch (_) {}
              }
              throw new Error("PlayHTML bootstrap was aborted");
            }
            const factory = function () {
              const channel = playhtml.createCustomMessageChannel();
              const handlers = Object.create(null);
              const unsubscribe = channel.subscribe(function (message) {
                let parsed;
                try { parsed = JSON.parse(message); } catch (_) { return; }
                for (const fn of handlers.message || []) fn(parsed);
              });
              if (playhtml.provider && typeof playhtml.provider.on === "function") {
                playhtml.provider.on("status", function (event) {
                  if (event && event.status === "connected") {
                    for (const fn of handlers.open || []) fn();
                  } else if (event && event.status === "connecting") {
                    for (const fn of handlers.reconnecting || []) fn();
                  } else if (event && event.status === "disconnected") {
                    for (const fn of handlers.close || []) fn();
                  }
                });
              }
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
            installedFactory = factory;
            target.OTT_PLAYHTML_CONNECTION_FACTORY = factory;
            return factory;
          });
        })().catch(async function (error) {
          if (epoch !== currentEpoch) {
            if (currentPlayhtml && typeof currentPlayhtml.close === "function") {
              try { currentPlayhtml.close(); } catch (_) {}
            }
            currentPlayhtml = null;
            throw new Error("PlayHTML bootstrap was aborted");
          }
          const playhtmlToClose = currentPlayhtml;
          currentPlayhtml = null;
          if (playhtmlToClose && typeof playhtmlToClose.close === "function") {
            try { playhtmlToClose.close(); } catch (_) {}
          }
          if (installedFactory && target.OTT_PLAYHTML_CONNECTION_FACTORY === installedFactory) {
            delete target.OTT_PLAYHTML_CONNECTION_FACTORY;
          }
          installedFactory = null;
          initialized = null;
          initializedConfig = null;
          if (needsReset && runtime && typeof runtime.reset === "function") {
            needsReset = false;
            try { await runtime.reset(); } catch (_) {}
          }
          throw error;
        });
      }
      return initialized;
    }

    async function dispose() {
      epoch += 1;
      const playhtmlToClose = currentPlayhtml;
      currentPlayhtml = null;
      if (playhtmlToClose && typeof playhtmlToClose.close === "function") {
        try { playhtmlToClose.close(); } catch (_) {}
      }
      if (installedFactory && target.OTT_PLAYHTML_CONNECTION_FACTORY === installedFactory) {
        delete target.OTT_PLAYHTML_CONNECTION_FACTORY;
      }
      installedFactory = null;
      initialized = null;
      initializedConfig = null;

      if (disposing) {
        try { await disposing; } catch (_) {}
        return;
      }

      const shouldReset = needsReset;
      needsReset = false;
      const currentDisposal = (async function () {
        if (shouldReset && runtime && typeof runtime.reset === "function") {
          try { await runtime.reset(); } catch (_) {}
        }
      })();
      disposing = currentDisposal;
      try {
        await currentDisposal;
      } finally {
        if (disposing === currentDisposal) {
          disposing = null;
        }
      }
    }

    bootstrap.bootstrap = bootstrap;
    bootstrap.dispose = dispose;
    return bootstrap;
  }

  return { createUnavailableBootstrap, createBootstrap };
});
