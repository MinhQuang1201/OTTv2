"use strict";

/**
 * scripts/bot-cup/similarity.mjs without Java: the JPlag workspace layout (templates as base code, references beside
 * submissions), parsing JPlag's results.csv and the report rows the admin site imports. The real JPlag run is in the
 * P8 evidence (docs/evidence/2026-10-24-bot-cup-p8.md).
 */
const { describe, it, before } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

let similarity;
before(async () => {
  similarity = await import("../scripts/bot-cup/similarity.mjs");
});

describe("bot-cup similarity script", () => {
  it("lays out one workspace per language with the template as base code and the reference corpus", () => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), "bot-cup-sim-"));
    try {
      const bundle = {
        format: "ott-bot-cup-sources-1",
        submissions: [
          { id: "s-1", language: "python", source: "print(1)\n" },
          { id: "s-2", language: "node", source: "console.log(1)\n" }
        ]
      };
      const spaces = similarity.buildWorkspace(bundle, out);
      assert.deepEqual(Object.keys(spaces).sort(), ["node", "python"]);
      assert.equal(fs.readFileSync(path.join(out, "python", "subs", "s-1", "bot.py"), "utf8"), "print(1)\n");
      assert.equal(fs.readFileSync(path.join(out, "node", "subs", "s-2", "bot.js"), "utf8"), "console.log(1)\n");
      assert.ok(fs.existsSync(path.join(out, "python", "base", "template.py")), "the Python template is base code");
      assert.ok(fs.existsSync(path.join(out, "node", "base", "template.js")));
      const nodeRefs = [...spaces.node.references.values()];
      assert.ok(nodeRefs.includes("packages/game-core/src/ai.js"));
      assert.ok(!nodeRefs.includes("sdk/bot-cup/js/bot.mjs"), "the template is base code, not a reference");
      assert.ok([...spaces.python.references.values()].includes("sdk/arena/python/ott_bot.py"));
      assert.throws(() => similarity.buildWorkspace({ format: "x", submissions: [] }, out), /not a Bot Cup source bundle/);
      assert.throws(() => similarity.buildWorkspace({ ...bundle, submissions: [{ id: "../evil", language: "python", source: "" }] }, path.join(out, "x")), /bad submission id/);
    } finally {
      fs.rmSync(out, { recursive: true, force: true });
    }
  });

  it("turns JPlag's results.csv into report pairs: submissions and references, nothing between two references", () => {
    const csv = [
      "submissionName1,submissionName2,averageSimilarity,maxSimilarity",
      "s-1,ref~packages~game-core~src~ai.js,0.97,0.99",
      "s-2,s-1,0.81234,0.9",
      "ref~bots~sentinel.mjs,ref~packages~game-core~src~ai.js,0.6,0.7",
      "s-3,s-1,0.2,0.3"
    ].join("\r\n");
    const rows = similarity.parseResultsCsv(csv);
    assert.equal(rows.length, 4);
    const references = new Map([["ref~packages~game-core~src~ai.js", "packages/game-core/src/ai.js"], ["ref~bots~sentinel.mjs", "bots/sentinel.mjs"]]);
    assert.deepEqual(similarity.reportPairs(rows, { language: "node", references, keep: 0.5 }), [
      { a: "s-1", b: null, reference: "packages/game-core/src/ai.js", similarity: 0.97, max: 0.99, language: "node" },
      { a: "s-2", b: "s-1", reference: null, similarity: 0.812, max: 0.9, language: "node" }
    ]);
    assert.equal(similarity.referenceName("packages/game-core/src/ai.js"), "ref~packages~game-core~src~ai.js");
    assert.throws(() => similarity.parseResultsCsv("a,b\n1,2"), /no submissionName1 column/);
  });
});
