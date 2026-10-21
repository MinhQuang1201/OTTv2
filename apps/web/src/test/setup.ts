import "@testing-library/jest-dom/vitest";
import { afterEach } from "vitest";

// Online sessions persist a resumable game in localStorage; never let one test see another's.
afterEach(() => {
  try { globalThis.localStorage?.clear(); } catch { /* storage is unavailable in this environment */ }
});
