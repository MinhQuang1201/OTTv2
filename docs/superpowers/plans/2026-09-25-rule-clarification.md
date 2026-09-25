# Rule Clarification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Update the official game rules so move validity, terminal-state precedence, clocks, and reconnection are unambiguous.

**Architecture:** `Rule.md` remains the sole implementation target. It will define game-state rules before room lifecycle rules, so the latter cannot override a completed game. Documentation consistency is verified through targeted searches and a manual read of every cross-reference.

**Tech Stack:** Markdown; PowerShell; ripgrep.

---

### Task 1: Clarify board-state and terminal rules

**Files:**
- Modify: `Rule.md:153-307`

- [ ] **Step 1: Define a valid move at the start of §7**

Add source ownership, turn ownership, in-board destination, one-square movement,
and target legality. State that a losing battle is still a valid move.

- [ ] **Step 2: Replace §11 with a complete terminal-state sequence**

Order checks as: own-goal arrival; either side having zero pieces; then whether the
next player has a legal move. Make the winner and reason explicit in every branch.

- [ ] **Step 3: Restructure §12’s matrix**

Use “trạng thái ô đích” as the first column so same-side and same-type conditions
are relationships, not apparent piece types.

- [ ] **Step 4: Validate internal consistency**

Run: `rg -n "nước đi hợp lệ|không còn quân|không còn nước đi|bị loại" Rule.md`

Expected: source validity, full elimination, and stalemate use the same terms and
do not claim that same-type pieces stack.

### Task 2: Add time and reconnection lifecycle rules

**Files:**
- Modify: `Rule.md:355-392`

- [ ] **Step 1: Add a clock subsection**

Set 10 minutes total for each seat. The active player’s clock runs; invalid moves
do not pause it or switch turns; time expiry gives the other seat the win.

- [ ] **Step 2: Replace immediate disconnect loss with reconnection grace**

Reserve the disconnected seat for 60 seconds, pause its clock during the grace
period, resume normal clock behavior on timely reconnection, and award the win to
the opponent only on expiry.

- [ ] **Step 3: Update the short and ultra-short summaries**

Include the clock and reconnect rules, and ensure the end conditions list all
canonical reasons without introducing a draw-by-repetition rule.

- [ ] **Step 4: Validate the final document**

Run: `git diff --check; rg -n "10 phút|60 giây|xếp chồng|lặp|hết giờ|kết nối lại" Rule.md`

Expected: no whitespace errors; only the explicit no-stacking rule; no repetition-
draw rule; clock and reconnect values each appear in the detailed rule and summary.
