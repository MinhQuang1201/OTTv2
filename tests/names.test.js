const { test } = require("node:test");
const assert = require("node:assert/strict");
const { cleanDisplayName, NAME_MAX } = require("../packages/game-core/src/names");
const { sanitizeName } = require("../packages/game-core/src/room");

test("cleanDisplayName strips tags and stray brackets, collapses whitespace and cuts to NAME_MAX", () => {
  assert.equal(NAME_MAX, 20);
  assert.equal(cleanDisplayName("<b>Alice</b>"), "Alice");
  assert.equal(cleanDisplayName("a < b"), "a b");
  assert.equal(cleanDisplayName("1 > 0"), "1 0");
  assert.equal(cleanDisplayName("  An \n\t Bình  "), "An Bình");
  assert.equal(cleanDisplayName("x".repeat(40)), "x".repeat(20));
  assert.equal(cleanDisplayName(`${"y".repeat(19)} z`), "y".repeat(19), "no trailing space after the cut");
  assert.equal(cleanDisplayName("x".repeat(40), 32), "x".repeat(32));
});

test("cleanDisplayName returns an empty string when nothing printable is left", () => {
  for (const value of ["", "   ", "<img src=x>", "<>", undefined, null, 42, {}]) {
    assert.equal(cleanDisplayName(value), "");
  }
});

test("Room and the Worker share one cleaning rule, with Room's own fallback name", () => {
  assert.equal(sanitizeName("<i>" + "n".repeat(30) + "</i>"), cleanDisplayName("n".repeat(30)));
  assert.equal(sanitizeName("<script></script>"), "Khách");
});
