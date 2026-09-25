const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const indexHtml = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
const styleCss = fs.readFileSync(path.join(__dirname, "..", "style.css"), "utf8");

function modeMarkup() {
  const match = indexHtml.match(/<fieldset class="mode-switch">([\s\S]*?)<\/fieldset>/);
  assert.ok(match, "mode picker fieldset should exist");
  return match[1];
}

test("mode picker keeps two accessible radio cards", () => {
  const markup = modeMarkup();

  assert.equal((markup.match(/type="radio"/g) || []).length, 2);
  assert.equal((markup.match(/class="mode-option"/g) || []).length, 2);
  assert.match(markup, /name="mode" value="duel" checked/);
  assert.match(markup, /name="mode" value="arena"/);
  assert.match(markup, /2 ghế/);
  assert.match(markup, /4 ghế/);
  assert.equal((markup.match(/class="mode-check"/g) || []).length, 2);
});

test("mode picker has responsive selection and focus states", () => {
  assert.match(styleCss, /\.mode-option:has\(input:checked\)/);
  assert.match(styleCss, /\.mode-option:focus-within/);
  assert.match(styleCss, /@media \(max-width: 768px\)[\s\S]*?\.mode-switch[\s\S]*?grid-template-columns: 1fr/);
});

test("table keeps unique HUD ids", () => {
  assert.equal((indexHtml.match(/id="avatar-a"/g) || []).length, 1);
  assert.equal((indexHtml.match(/id="name-a"/g) || []).length, 1);
  assert.equal((indexHtml.match(/id="counts-a"/g) || []).length, 1);
  assert.equal((indexHtml.match(/id="clock-a"/g) || []).length, 1);
  assert.equal((indexHtml.match(/id="clock-b"/g) || []).length, 1);
});
