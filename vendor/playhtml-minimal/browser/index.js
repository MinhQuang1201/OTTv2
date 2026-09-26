// Source-backed minimal browser surface for the OTT fork.
// The provider is deliberately private to this factory; callers receive only
// the custom-message channel contract.

function createMinimalPlayhtml({ ready, provider }) {
  if (!ready || typeof ready.then !== "function") {
    throw new TypeError("PlayHTML ready must be a promise");
  }
  if (!provider || typeof provider.sendMessage !== "function" || typeof provider.on !== "function") {
    throw new TypeError("PlayHTML provider does not support custom messages");
  }
  let isReady = false;
  ready.then(
    () => { isReady = true; },
    () => {}
  );

  function createCustomMessageChannel() {
    const listeners = new Set();
    const removeProviderListener = provider.on("custom-message", (message) => {
      if (typeof message !== "string") return;
      for (const listener of [...listeners]) listener(message);
    });

    return {
      send(message) {
        if (typeof message !== "string") {
          return Promise.reject(new TypeError("Custom messages must be strings"));
        }
        if (!isReady) return Promise.reject(new Error("PlayHTML is not ready"));
        return ready.then(() => {
          provider.sendMessage(message);
        });
      },
      subscribe(listener) {
        if (typeof listener !== "function") {
          throw new TypeError("Custom message listener must be a function");
        }
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      close() {
        listeners.clear();
        if (typeof removeProviderListener === "function") removeProviderListener();
      }
    };
  }

  return { ready, createCustomMessageChannel };
}

module.exports = { createMinimalPlayhtml };
