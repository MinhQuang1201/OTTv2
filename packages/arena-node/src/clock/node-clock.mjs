/**
 * NodeClock: monotonic clock port adapter for Node.js runtime.
 * Implements ClockPort using performance.now() and timers.
 */

export function createNodeClock() {
  return {
    nowMs() {
      return performance.now();
    },
    schedule(delayMs, callback) {
      return setTimeout(callback, Math.max(0, delayMs));
    },
    cancel(handle) {
      if (handle !== null && handle !== undefined) {
        clearTimeout(handle);
      }
    }
  };
}
