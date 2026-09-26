const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const indexHtml = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
const styleCss = fs.readFileSync(path.join(__dirname, "..", "style.css"), "utf8");
const tokensCss = fs.readFileSync(path.join(__dirname, "..", "tokens.css"), "utf8");
const gameJs = fs.readFileSync(path.join(__dirname, "..", "game.js"), "utf8");
const configJs = fs.readFileSync(path.join(__dirname, "..", "config.js"), "utf8");

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

test("waiting online rooms explain why a piece cannot be selected", () => {
  assert.match(
    gameJs,
    /if \(app\.status === "waiting"\)[\s\S]*?toast\("Chờ đối thủ vào phòng\."/,
  );
});

test("leaving a table resets the replay cursor before the next room", () => {
  const leaveTable = gameJs.match(/function leaveTable(?:\([^)]*\))? \{([\s\S]*?)\n  \}/);
  assert.ok(leaveTable, "leaveTable should remain a named lifecycle boundary");
  assert.match(leaveTable[1], /app\.history = \[\];[\s\S]*app\.replayAt = null;/);
});

test("optional playHTML failures cannot block table lifecycle", () => {
  assert.match(
    gameJs,
    /function syncPlayhtmlRoom\(\) \{[\s\S]*if \(!commune\.play \|\| !commune\.ready\) return;/,
  );
  assert.match(
    gameJs,
    /function setPlayIdentity\(\) \{[\s\S]*if \(!play \|\| !commune\.ready\) return;/,
  );
});

test("table marks last ply and combat preview without encoding goals in CSS", () => {
  assert.match(indexHtml, /id="hint-line"/);
  assert.match(gameJs, /classList\.add\("is-from"\)/);
  assert.match(gameJs, /classList\.add\("is-to"\)/);
  assert.match(gameJs, /classList\.add\("is-win"\)/);
  assert.match(gameJs, /classList\.add\("is-loss"\)/);
  assert.match(gameJs, /dataset\.goal/);
  assert.match(gameJs, /className = "goal-label"/);
  assert.match(styleCss, /\.goal-label/);
  assert.doesNotMatch(styleCss, /content:\s*["']A9["']/);
  assert.doesNotMatch(gameJs, /btn\.setAttribute\("can-hover"/);
});

test("lobby title card only shows the game name", () => {
  assert.match(indexHtml, /<h1>Oẳn tù tì trên bàn 9×9<\/h1>/);
  assert.equal((indexHtml.match(/class="reg [^"]+" aria-hidden="true" hidden/g) || []).length, 4);
  assert.match(indexHtml, /class="mark" hidden/);
  assert.match(indexHtml, /class="plate-no" hidden/);
  assert.match(indexHtml, /class="lede" hidden/);
  assert.match(indexHtml, /class="rps-cycle"[^>]*hidden/);
  assert.match(indexHtml, /class="spec-strip" hidden/);
  assert.match(indexHtml, /id="lobby-press"[^>]*hidden/);
  assert.match(styleCss, /\[hidden\]\s*{[\s\S]*?display:\s*none\s*!important/);
});

test("lobby keeps an instant-play path", () => {
  assert.match(indexHtml, /assets\/dam\.png/);
  assert.match(indexHtml, /name="intent" value="ai"/);
  assert.match(indexHtml, /Chơi ngay/);
  assert.match(styleCss, /\.btn-now/);
  assert.match(styleCss, /\.seat-dots/);
});

test("instant play does not wait on an empty name field", () => {
  assert.match(indexHtml, /name="intent" value="ai"[^>]*formnovalidate/);
  assert.match(indexHtml, /name="intent" value="local"[^>]*formnovalidate/);
});

test("offline tables hide the network chip and keep the turn stamp off the hint", () => {
  assert.match(gameJs, /els\.netChip\.hidden = app\.mode !== "online"/);
  assert.match(gameJs, /els\.turn\.hidden = yours \|\| app\.status === "waiting"/);
  assert.match(styleCss, /\.you-stamp[\s\S]*?position:\s*relative/);
});

test("room chip does not repeat the room id", () => {
  assert.match(gameJs, /name === "Phòng " \+ id/);
});

test("your-turn stamp sits on the board, not in CSS coordinates", () => {
  assert.match(indexHtml, /id="you-stamp"/);
  assert.match(gameJs, /dataset\.yours/);
  assert.match(gameJs, /ink-splat/);
  assert.match(styleCss, /\.you-stamp/);
  assert.doesNotMatch(gameJs, /btn\.setAttribute\("can-hover"/);
});

test("turn feedback reserves space outside the playable board", () => {
  assert.match(
    styleCss,
    /\.board-shell\s*{[\s\S]*?grid-template-rows:\s*minmax\(0,\s*1fr\)\s*auto/,
  );
  assert.match(
    styleCss,
    /\.turn-line,\s*\n\.wait-line\s*{[\s\S]*?grid-area:\s*2 \/ 1/,
  );
  assert.match(styleCss, /\.you-stamp\s*{[\s\S]*?grid-area:\s*2 \/ 1/);
  assert.doesNotMatch(
    styleCss,
    /@media \(max-height: 740px\)[\s\S]*?\.board-stage\s*{[\s\S]*?padding:\s*0 0 2\.4rem/,
  );
});

test("table board scales with the viewport, not a fixed cell", () => {
  assert.match(indexHtml, /viewport-fit=cover/);
  assert.match(styleCss, /container-type:\s*size/);
  assert.match(styleCss, /100cqmin/);
  assert.match(styleCss, /safe-area-inset/);
  assert.match(styleCss, /@media \(max-width: 768px\)[\s\S]*?\.mode-switch[\s\S]*?grid-template-columns: 1fr/);
});

test("board exposes a keyboard-friendly grid contract", () => {
  assert.match(indexHtml, /role="grid"[\s\S]*aria-rowcount="9"[\s\S]*aria-colcount="9"/);
  assert.match(indexHtml, /id="hint-line"[^>]*aria-live="polite"/);
  assert.match(gameJs, /aria-rowindex/);
  assert.match(gameJs, /aria-colindex/);
  assert.match(gameJs, /aria-selected/);
  assert.match(gameJs, /ArrowUp/);
  assert.match(gameJs, /ArrowDown/);
  assert.match(gameJs, /ArrowLeft/);
  assert.match(gameJs, /ArrowRight/);
  assert.match(gameJs, /function ensureBoardCells/);
  assert.doesNotMatch(gameJs, /function renderBoard\(\) \{[\s\S]*els\.board\.innerHTML = ""/);
});

test("resume failure exits the stale table instead of leaving reconnecting UI", () => {
  assert.match(gameJs, /pf\.on\("resumeFailed"/);
  assert.match(gameJs, /app\.reconnecting = false/);
  assert.match(gameJs, /leaveTable\(\)/);
});

test("touch layout keeps compact board cells close to platform targets", () => {
  assert.match(styleCss, /@media \(max-width: 480px\)[\s\S]*?--cell:\s*min\(\s*44px/);
  assert.match(styleCss, /@media \(max-width: 480px\)[\s\S]*?\.ranks[\s\S]*?display:\s*none/);
  assert.match(styleCss, /width:\s*max\(44px,\s*var\(--cell\)\)/);
  assert.match(styleCss, /height:\s*max\(44px,\s*var\(--cell\)\)/);
  assert.match(gameJs, /function boardPointFromEvent/);
});

test("piece icons use one sprite atlas and audio feedback has a visible toggle", () => {
  assert.match(configJs, /ATLAS:\s*"assets\/rps-atlas\.png"/);
  assert.match(styleCss, /background-image:\s*url\("assets\/rps-atlas\.png"\)/);
  assert.match(indexHtml, /id="audio-toggle"/);
  assert.match(gameJs, /function playSound/);
  assert.match(gameJs, /localStorage\.setItem\("ottv2-audio"/);
});

test("mobile online chrome wraps spectator state without hiding controls", () => {
  assert.match(
    styleCss,
    /@media \(max-width: 480px\)[\s\S]*?grid-template-areas:[\s\S]*?"leave room audio"[\s\S]*?"net role view"/,
  );
  assert.match(styleCss, /\.table-bar \.room-chip[\s\S]*?text-overflow:\s*ellipsis/);
});

test("UI layering and motion use named z-index tokens", () => {
  assert.match(tokensCss, /--z-board:/);
  assert.match(tokensCss, /--z-feedback:/);
  assert.match(styleCss, /z-index:\s*var\(--z-board\)/);
  assert.match(styleCss, /z-index:\s*var\(--z-feedback\)/);
});

test("lobby uses playHTML for presence, not for moves", () => {
  assert.match(indexHtml, /unpkg.com\/playhtml@2\.15\.0/);
  assert.match(indexHtml, /id="lobby-press"/);
  assert.match(indexHtml, /can-hover/);
  assert.match(gameJs, /bootPlayhtml/);
  assert.match(gameJs, /pf\.move/);
  assert.doesNotMatch(gameJs, /can-move/);
  assert.doesNotMatch(gameJs, /btn\.setAttribute\("can-hover"/);
});
