/* Sảnh, bàn, duel/arena, xem, chat. Online chỉ gửi nước đi; luật do server. */
(function () {
  const rules = window.OTT_RULES;
  const config = window.OTT_CONFIG;
  const ai = window.OTT_AI;
  const SEATS = ["A", "B", "C", "D"];

  const app = {
    mode: null,
    gameMode: "duel",
    pf: null,
    you: null,
    role: null,
    state: null,
    liveState: null,
    status: "idle",
    names: {
      A: config.SEAT_LABEL.A,
      B: config.SEAT_LABEL.B,
      C: config.SEAT_LABEL.C,
      D: config.SEAT_LABEL.D
    },
    selected: null,
    legal: [],
    lastEvents: [],
    roomId: null,
    roomName: null,
    leaving: false,
    reconnecting: false,
    clockStamp: 0,
    clockTimer: null,
    onlineStateAt: 0,
    chat: [],
    history: [],
    viewers: 0,
    replayAt: null,
    focused: null
  };

  const els = {
    app: document.getElementById("app"),
    lobby: document.getElementById("lobby"),
    table: document.getElementById("table"),
    form: document.getElementById("start-form"),
    name: document.getElementById("player-name"),
    room: document.getElementById("room-code"),
    roomName: document.getElementById("room-name"),
    list: document.getElementById("room-list"),
    board: document.getElementById("board"),
    ranks: document.getElementById("ranks"),
    files: document.getElementById("files"),
    turn: document.getElementById("turn-line"),
    wait: document.getElementById("wait-line"),
    hint: document.getElementById("hint-line"),
    roomChip: document.getElementById("room-chip"),
    netChip: document.getElementById("net-chip"),
    roleChip: document.getElementById("role-chip"),
    viewChip: document.getElementById("view-chip"),
    audioToggle: document.getElementById("audio-toggle"),
    audioGlyph: document.getElementById("audio-glyph"),
    toast: document.getElementById("toast"),
    win: document.getElementById("win-dialog"),
    winTitle: document.getElementById("win-title"),
    winReason: document.getElementById("win-reason"),
    leave: document.getElementById("btn-leave"),
    combat: document.getElementById("combat-banner"),
    youStamp: document.getElementById("you-stamp"),
    chatLog: document.getElementById("chat-log"),
    chatForm: document.getElementById("chat-form"),
    chatInput: document.getElementById("chat-input"),
    reactRow: document.getElementById("react-row"),
    reactFloat: document.getElementById("react-float"),
    historyLog: document.getElementById("history-log"),
    replay: document.getElementById("replay-slider"),
    leaderboard: document.getElementById("leaderboard"),
    confetti: document.querySelector(".confetti"),
    lobbyPresence: document.getElementById("lobby-presence")
  };

  SEATS.forEach(function (seat) {
    const key = seat.toLowerCase();
    els["name" + seat] = document.getElementById("name-" + key);
    els["counts" + seat] = document.getElementById("counts-" + key);
    els["avatar" + seat] = document.getElementById("avatar-" + key);
    els["hud" + seat] = document.querySelector(".hud-" + key);
    els["tag" + seat] = document.querySelector(".hud-" + key + " .seat-tag");
    els["clock" + seat] = document.getElementById("clock-" + key);
  });

  const boardCells = [];
  const audio = {
    enabled: true,
    context: null
  };

  function loadAudioSetting() {
    try {
      audio.enabled = localStorage.getItem("ottv2-audio") !== "off";
    } catch (err) {}
    updateAudioUi();
  }

  function updateAudioUi() {
    if (!els.audioToggle) return;
    els.audioToggle.setAttribute("aria-pressed", String(audio.enabled));
    els.audioToggle.setAttribute(
      "aria-label",
      audio.enabled ? "Tắt âm thanh" : "Bật âm thanh"
    );
    els.audioToggle.title = audio.enabled ? "Tắt âm thanh" : "Bật âm thanh";
    if (els.audioGlyph) els.audioGlyph.textContent = audio.enabled ? "ON" : "OFF";
  }

  function audioContext() {
    if (!audio.enabled || typeof window === "undefined") return null;
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (!AudioContext) return null;
    if (!audio.context) {
      try {
        audio.context = new AudioContext();
      } catch (err) {
        return null;
      }
    }
    if (audio.context.state === "suspended" && audio.context.resume) {
      audio.context.resume().catch(function () {});
    }
    return audio.context;
  }

  function playSound(kind) {
    const ctx = audioContext();
    if (!ctx) return;
    const patterns = {
      tap: [[520, 0.045, 0.018]],
      select: [[640, 0.06, 0.022]],
      move: [[420, 0.08, 0.022], [620, 0.08, 0.018]],
      capture: [[300, 0.1, 0.03], [520, 0.12, 0.024]],
      strike_loss: [[240, 0.12, 0.028], [160, 0.14, 0.02]],
      win: [[420, 0.1, 0.026], [560, 0.1, 0.026], [760, 0.16, 0.03]]
    };
    const notes = patterns[kind] || patterns.tap;
    const start = ctx.currentTime;
    notes.forEach(function (note, index) {
      const oscillator = ctx.createOscillator();
      const gain = ctx.createGain();
      const at = start + index * 0.075;
      oscillator.type = "triangle";
      oscillator.frequency.setValueAtTime(note[0], at);
      gain.gain.setValueAtTime(0.0001, at);
      gain.gain.exponentialRampToValueAtTime(note[2], at + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + note[1]);
      oscillator.connect(gain);
      gain.connect(ctx.destination);
      oscillator.start(at);
      oscillator.stop(at + note[1] + 0.02);
    });
  }

  function selectedMode() {
    const checked = document.querySelector('input[name="mode"]:checked');
    return checked && checked.value === "arena" ? "arena" : "duel";
  }

  function showScreen(name) {
    els.app.dataset.screen = name;
    els.lobby.hidden = name !== "lobby";
    els.table.hidden = name !== "table";
  }

  function toast(message, kind) {
    els.toast.hidden = false;
    els.toast.textContent = message;
    els.toast.className = "t-toast is-open" + (kind === "error" ? " is-error" : "");
    clearTimeout(toast._t);
    toast._t = setTimeout(function () {
      els.toast.classList.remove("is-open");
      els.toast.hidden = true;
    }, 2200);
  }

  function setNet(state, label) {
    els.netChip.dataset.state = state;
    els.netChip.textContent = label;
    els.table.dataset.net = app.mode === "online" ? "on" : "off";
  }

  function playerName() {
    return (els.name.value || "Khách").trim().slice(0, config.NAME_MAX);
  }

  function firstChar(name) {
    const t = String(name || "?").trim();
    return t ? t.charAt(0).toUpperCase() : "?";
  }

  const commune = {
    play: null,
    ready: false,
    chat: null,
    usersUnsub: null
  };

  const SEAT_INK = {
    A: "oklch(68% 0.16 350)",
    B: "oklch(70% 0.12 210)",
    C: "oklch(78% 0.14 85)",
    D: "oklch(68% 0.13 145)"
  };

  function sanitizeClient(text, max) {
    const raw = String(text || "")
      .replace(/<[^>]*>/g, "")
      .replace(/[<>]/g, "")
      .replace(/\s+/g, " ")
      .trim();
    return raw.slice(0, max);
  }

  function playhtmlRoom() {
    const host = typeof location !== "undefined" ? location.host : "ottv2";
    if (app.mode === "online" && app.roomId) return host + "/ott/room/" + app.roomId;
    return host + "/ott/lobby";
  }

  function setPlayIdentity() {
    const play = commune.play;
    if (!play || !commune.ready) return;
    try {
      if (!play.users || !play.users.me) return;
      play.users.me.name = playerName();
      if (app.mode === "online" && app.you && SEAT_INK[app.you]) {
        play.users.me.color = SEAT_INK[app.you];
      } else {
        play.users.me.color = "oklch(72% 0.19 35)";
      }
    } catch (err) {}
  }

  function renderPresence(users) {
    if (!els.lobbyPresence) return;
    const list = users || [];
    const names = list
      .map(function (u) { return u.isMe ? null : u.name; })
      .filter(Boolean)
      .slice(0, 8);
    if (!list.length) {
      els.lobbyPresence.textContent = "Sảnh trống";
      return;
    }
    if (!names.length) {
      els.lobbyPresence.textContent = list.length === 1 ? "Bạn đang ở sảnh" : list.length + " người trong sảnh";
      return;
    }
    els.lobbyPresence.textContent =
      list.length +
      " trong sảnh · " +
      names.join(", ") +
      (list.length - 1 > names.length ? "…" : "");
  }

  function bindChatChannel() {
    const play = commune.play;
    if (!play || typeof play.createPageData !== "function") return;
    if (commune.chat && typeof commune.chat.destroy === "function") {
      commune.chat.destroy();
      commune.chat = null;
    }
    if (app.mode !== "online" || !app.roomId) return;
    commune.chat = play.createPageData("ott-chat", []);
    commune.chat.onUpdate(function (msgs) {
      app.chat = Array.isArray(msgs) ? msgs.slice(-config.CHAT_KEEP) : [];
      renderChat();
    });
    const now = commune.chat.getData();
    if (Array.isArray(now) && now.length) {
      app.chat = now.slice(-config.CHAT_KEEP);
      renderChat();
    }
  }

  function syncPlayhtmlRoom() {
    if (!commune.play || !commune.ready) return;
    setPlayIdentity();
    const nav = commune.play.handleNavigation;
    const after = function () {
      bindChatChannel();
    };
    if (typeof nav === "function") {
      Promise.resolve(nav.call(commune.play)).then(after).catch(after);
    } else after();
  }

  function setupPlayEl(el) {
    if (!commune.play || !el) return;
    try {
      commune.play.setupPlayElement(el, { ignoreIfAlreadySetup: true });
    } catch (err) {}
  }

  function showReactGlyph(glyph) {
    if (!glyph || !els.reactFloat) return;
    const span = document.createElement("span");
    span.textContent = glyph;
    els.reactFloat.appendChild(span);
    setTimeout(function () {
      span.remove();
    }, 700);
  }

  function sendChat(text) {
    const clean = sanitizeClient(text, config.CHAT_MAX);
    if (!clean) return;
    if (commune.ready && commune.chat) {
      commune.chat.setData(function (draft) {
        if (!Array.isArray(draft)) return;
        draft.push({ name: playerName(), text: clean, at: Date.now() });
        if (draft.length > config.CHAT_KEEP) draft.splice(0, draft.length - config.CHAT_KEEP);
      });
      return;
    }
    if (app.pf) app.pf.chat(clean);
  }

  function sendReact(code) {
    const glyph = config.REACTS[code];
    if (!glyph) return;
    if (commune.ready && commune.play && typeof commune.play.dispatchPlayEvent === "function") {
      commune.play.dispatchPlayEvent({
        type: "ott-react",
        eventPayload: { code: code, glyph: glyph, name: playerName() }
      });
      return;
    }
    if (app.pf) app.pf.react(code);
  }

  function bootPlayhtml() {
    return import("https://unpkg.com/playhtml@2.15.0")
      .then(function (mod) {
        const playhtml = mod.playhtml;
        commune.play = playhtml;
        return Promise.resolve(
          playhtml.init({
            room: playhtmlRoom,
            playerIdentity: { name: playerName() },
            cursors: {
              enabled: true,
              enableChat: false,
              coordinateMode: "absolute",
              container: "#play-cursors",
              playerIdentity: { name: playerName() }
            },
            events: {
              "ott-react": {
                type: "ott-react",
                onEvent: function (payload) {
                  showReactGlyph(payload && payload.glyph);
                }
              }
            }
          })
        ).then(function () {
          commune.ready = true;
          window.playhtml = playhtml;
          setPlayIdentity();
          try {
            if (playhtml.users && typeof playhtml.users.onChange === "function") {
              commune.usersUnsub = playhtml.users.onChange(renderPresence);
              renderPresence(playhtml.users.getAll());
            }
          } catch (err) {}
          if (typeof playhtml.register === "function") {
            playhtml.register("lobby-press", {
              defaultData: { n: 0 },
              update: function (ctx) {
                const n = (ctx.data && ctx.data.n) || 0;
                ctx.element.textContent = "Bản in · " + n;
              },
              onClick: function (_ev, ctx) {
                ctx.setData(function (d) {
                  d.n += 1;
                });
              }
            });
          }
          ["mode-duel", "mode-arena", "react-fire", "react-fight", "react-gg", "react-clap", "react-lol"].forEach(
            function (id) {
              setupPlayEl(document.getElementById(id));
            }
          );
        });
      })
      .catch(function () {
        commune.ready = false;
      });
  }

  function buildChrome() {
    els.files.innerHTML = "";
    els.ranks.innerHTML = "";
    for (let x = 0; x < config.SIZE; x += 1) {
      const f = document.createElement("span");
      f.textContent = config.FILES[x];
      els.files.appendChild(f);
    }
    for (let y = 0; y < config.SIZE; y += 1) {
      const r = document.createElement("span");
      r.textContent = String(y + 1);
      els.ranks.appendChild(r);
    }
  }

  const lastCounts = { A: null, B: null, C: null, D: null };

  function iconFor(type) {
    const icon = document.createElement("span");
    icon.className = "rps-icon " + (config.ICON_CLASS[type] || "");
    icon.setAttribute("aria-hidden", "true");
    return icon;
  }

  function countsHtml(counts, seat) {
    const prev = lastCounts[seat];
    return config.TYPES.map(function (type) {
      const n = counts[type] || 0;
      const klass = [];
      if (n === 0) klass.push("is-empty");
      if (prev && prev[type] !== n) klass.push("is-punch");
      return (
        "<li" +
        (klass.length ? ' class="' + klass.join(" ") + '"' : "") +
        '><span class="rps-icon ' +
        (config.ICON_CLASS[type] || "") +
        '" aria-hidden="true"></span><span class="n">' +
        n +
        "</span><span>" +
        config.TYPE_LABEL[type] +
        "</span></li>"
      );
    }).join("");
  }

  function tapFeel(kind) {
    const reduced =
      window.matchMedia &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (!reduced && typeof navigator !== "undefined" && typeof navigator.vibrate === "function") {
      if (kind === "capture") navigator.vibrate(24);
      else if (kind === "strike_loss") navigator.vibrate([10, 24, 10]);
      else if (kind === "win") navigator.vibrate(40);
    }
    playSound(kind);
  }

  function currentPly() {
    if (!app.history.length) return null;
    const at = app.replayAt == null ? app.history.length : app.replayAt;
    if (at < 1) return null;
    return app.history[at - 1] || null;
  }

  function reasonText(state) {
    if (!state) return "";
    if (state.reason === "goal") {
      const goals = rules.goalsOf(state);
      const goal = goals[state.winner];
      return "Đưa quân vào ô thắng " + rules.formatSquare(goal).toUpperCase() + ".";
    }
    if (state.reason === "elimination") return "Đối phương không còn quân nào.";
    if (state.reason === "no_moves") return "Đối phương không còn nước đi hợp lệ.";
    if (state.reason === "timeout") return "Hết giờ.";
    if (state.reason === "leave") return "Đối thủ đã rời bàn.";
    if (state.reason === "disconnect_timeout") return "Đối thủ không kết nối lại trong thời gian cho phép.";
    return "";
  }

  function isSpectator() {
    return app.you === "spectator" || app.role === "spectator";
  }

  function isLive() {
    return app.replayAt == null || app.replayAt === app.history.length;
  }

  function canControl(seat) {
    if (!app.state || app.state.winner || app.reconnecting) return false;
    if (!isLive()) return false;
    if (isSpectator()) return false;
    if (app.status === "waiting") return false;
    if (app.mode === "local") return app.state.turn === seat;
    if (app.mode === "ai") return app.you === seat && app.state.turn === seat;
    return app.you === seat && app.state.turn === seat;
  }

  function formatClock(ms) {
    const seconds = Math.max(0, Math.ceil(ms / 1000));
    return String(Math.floor(seconds / 60)).padStart(2, "0") + ":" + String(seconds % 60).padStart(2, "0");
  }

  function currentClockMs(seat) {
    if (!app.state || !app.state.clock) return 0;
    const remaining = app.state.clock.remainingMs[seat];
    if (!Number.isFinite(remaining)) return 0;
    let value = remaining;
    if (
      app.mode === "online" &&
      !app.reconnecting &&
      app.state.clock.runningSeat === seat &&
      app.onlineStateAt
    ) {
      value -= performance.now() - app.onlineStateAt;
    }
    return Math.max(0, value);
  }

  function renderClock() {
    SEATS.forEach(function (seat) {
      const el = els["clock" + seat];
      if (!el) return;
      if (!app.state || !app.state.clock || !Number.isFinite(app.state.clock.remainingMs[seat])) {
        el.textContent = "10:00";
        el.dataset.running = "false";
        el.dataset.low = "false";
        return;
      }
      const ms = currentClockMs(seat);
      el.textContent = formatClock(ms);
      el.dataset.running = String(app.state.clock.runningSeat === seat && !app.state.winner);
      el.dataset.low = String(ms <= 30000);
    });
  }

  function tickLocalClock() {
    if (!app.state || app.mode === "online" || app.state.winner || !app.state.clock.runningSeat) return;
    const now = performance.now();
    const elapsed = Math.max(0, Math.floor(now - app.clockStamp));
    if (elapsed > 0) {
      const result = rules.elapseClock(app.state, elapsed);
      app.state = result.state;
      app.lastEvents = result.events;
      app.clockStamp = now;
      render();
      if (app.state.winner) {
        stopClock();
        openWin(app.state);
      }
    }
  }

  function startClock() {
    stopClock();
    app.clockStamp = performance.now();
    app.clockTimer = setInterval(function () {
      tickLocalClock();
      renderClock();
    }, 250);
  }

  function stopClock() {
    if (app.clockTimer) clearInterval(app.clockTimer);
    app.clockTimer = null;
  }

  function combatText(ev) {
    if (!ev) return "";
    if (ev.type === "capture") {
      return (
        config.TYPE_LABEL[ev.moverType] +
        " thắng " +
        config.TYPE_LABEL[ev.capturedType]
      );
    }
    if (ev.type === "strike_loss") {
      return (
        config.TYPE_LABEL[ev.byType] +
        " thắng " +
        config.TYPE_LABEL[ev.moverType]
      );
    }
    return "";
  }

  function showCombat(events) {
    const ev = (events || []).find(function (e) {
      return e.type === "capture" || e.type === "strike_loss";
    });
    const text = combatText(ev);
    if (!text) {
      els.combat.hidden = true;
      els.combat.dataset.kind = "";
      return;
    }
    els.combat.hidden = false;
    els.combat.dataset.kind = ev.type;
    els.combat.textContent = text;
    tapFeel(ev.type);
    clearTimeout(showCombat._t);
    showCombat._t = setTimeout(function () {
      els.combat.hidden = true;
    }, 1400);
  }

  function stateAt(index) {
    if (!app.history.length) return app.liveState;
    const max = app.history.length;
    const n = index == null ? max : index;
    if (n >= max) return app.liveState;
    let s = rules.createInitialState(app.gameMode);
    for (let i = 0; i < n; i += 1) {
      const mv = app.history[i];
      const res = rules.applyMove(s, mv.seat, mv.from, mv.to);
      if (!res.ok) break;
      s = res.state;
    }
    return s;
  }

  function syncReplayUi() {
    const max = app.history.length;
    els.replay.max = String(max);
    els.replay.disabled = max === 0;
    const at = app.replayAt == null ? max : app.replayAt;
    els.replay.value = String(at);
  }

  function renderHud() {
    const state = app.state;
    const seats = state ? rules.seatsOf(state) : config.MODES[app.gameMode].seats;
    const goals = state ? rules.goalsOf(state) : config.GOAL;
    els.table.dataset.mode = app.gameMode;
    SEATS.forEach(function (seat) {
      const name = app.names[seat] || config.SEAT_LABEL[seat];
      if (els["name" + seat]) els["name" + seat].textContent = name;
      if (els["avatar" + seat]) els["avatar" + seat].textContent = firstChar(name);
      if (els["tag" + seat] && goals[seat]) {
        els["tag" + seat].textContent =
          config.SEAT_LABEL[seat] + " · " + rules.formatSquare(goals[seat]).toUpperCase();
      }
      if (els["hud" + seat]) {
        els["hud" + seat].hidden = seats.indexOf(seat) < 0;
        els["hud" + seat].dataset.active = String(
          !!(state && state.turn === seat && !state.winner)
        );
        els["hud" + seat].dataset.you = String(app.you === seat);
      }
      if (els["counts" + seat] && state) {
        const nextCounts = rules.countByType(state, seat);
        els["counts" + seat].innerHTML = countsHtml(nextCounts, seat);
        lastCounts[seat] = nextCounts;
      }
    });
    if (!state) return;
    const turnName = app.names[state.turn] || config.SEAT_LABEL[state.turn];
    const yours = !!(state && !state.winner && canControl(state.turn));
    els.table.dataset.turn = state.winner ? "" : state.turn;
    els.table.dataset.status = app.status;
    els.table.dataset.role = isSpectator() ? "spectator" : (app.you || "");
    els.table.dataset.yours = String(yours);
    els.turn.dataset.seat = state.winner ? "" : state.turn;
    els.turn.textContent = state.winner
      ? "Ván đã kết thúc"
      : yours
        ? "Lượt bạn"
        : isSpectator()
          ? "Đang xem · lượt " + turnName
          : "Lượt " + turnName;
    if (els.youStamp) els.youStamp.hidden = !yours;
    els.turn.hidden = yours || app.status === "waiting";
    els.wait.hidden = app.status !== "waiting";
    const shell = els.board && els.board.closest(".board-shell");
    if (shell) shell.classList.toggle("is-waiting", app.status === "waiting");
    if (els.hint) {
      if (app.status === "waiting" || state.winner) {
        els.hint.hidden = true;
      } else if (app.selected) {
        els.hint.hidden = false;
        els.hint.textContent = "Ô sáng: đi được. Vòng lục ăn, vòng vàng thua.";
      } else if (app.history.length) {
        els.hint.hidden = true;
      } else {
        els.hint.hidden = false;
        els.hint.textContent = "Chọn quân mình, rồi chọn ô hợp lệ.";
      }
    }
    if (app.roomId) {
      const id = app.roomId;
      const name = (app.roomName || "").trim();
      if (!name || name === id || name === "Phòng " + id) {
        els.roomChip.textContent = "Phòng " + id;
      } else {
        els.roomChip.textContent = name + " " + id;
      }
    } else if (app.mode === "ai") {
      els.roomChip.textContent = "Đấu máy";
    } else {
      els.roomChip.textContent = "Cùng máy";
    }
    els.netChip.hidden = app.mode !== "online";
    els.roleChip.hidden = !isSpectator();
    els.viewChip.hidden = app.mode !== "online";
    els.viewChip.textContent = app.viewers + " xem";
    renderClock();
  }

  function ensureBoardCells() {
    if (boardCells.length === config.SIZE * config.SIZE) return;
    els.board.replaceChildren();
    boardCells.length = 0;
    for (let y = 0; y < config.SIZE; y += 1) {
      for (let x = 0; x < config.SIZE; x += 1) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "cell";
        btn.setAttribute("role", "gridcell");
        btn.setAttribute("aria-rowindex", String(y + 1));
        btn.setAttribute("aria-colindex", String(x + 1));
        btn.setAttribute("aria-selected", "false");
        btn.dataset.x = String(x);
        btn.dataset.y = String(y);
        btn.tabIndex = -1;
        els.board.appendChild(btn);
        boardCells.push(btn);
      }
    }
  }

  function boardCellAt(x, y) {
    return boardCells[y * config.SIZE + x] || null;
  }

  function boardFocusTarget(state) {
    const candidates = [];
    if (app.focused) candidates.push(app.focused);
    if (app.selected) candidates.push(app.selected);
    if (state) {
      const mine = (state.pieces || []).find(function (piece) {
        return canControl(piece.player);
      });
      if (mine) candidates.push(mine);
    }
    candidates.push({ x: 0, y: 0 });
    return candidates.find(function (pos) {
      return pos && rules.inside(pos.x, pos.y);
    });
  }

  function setBoardFocus(x, y, focus) {
    const nextX = Math.max(0, Math.min(config.SIZE - 1, x));
    const nextY = Math.max(0, Math.min(config.SIZE - 1, y));
    app.focused = { x: nextX, y: nextY };
    boardCells.forEach(function (cell) {
      cell.tabIndex = Number(cell.dataset.x) === nextX && Number(cell.dataset.y) === nextY
        ? 0
        : -1;
    });
    const cell = boardCellAt(nextX, nextY);
    if (focus && cell && document.activeElement !== cell) cell.focus();
  }

  function renderBoard() {
    const state = app.state;
    ensureBoardCells();
    const burstAt = {};
    const slide = (app.lastEvents || []).find(function (ev) {
      return ev.type === "move" || ev.type === "capture";
    });
    for (const ev of app.lastEvents) {
      if (ev.type === "capture" || ev.type === "strike_loss") {
        burstAt[ev.to.x + "," + ev.to.y] = true;
      }
    }
    const goals = state ? rules.goalsOf(state) : config.GOAL;
    const ply = currentPly();
    const mover = app.selected && state
      ? (state.pieces || []).find(function (p) {
          return p.id === app.selected.id;
        })
      : null;
    const focusTarget = boardFocusTarget(state);

    // Reuse fixed board-cell buttons; only dynamic piece/feedback content changes.
    for (let y = 0; y < config.SIZE; y += 1) {
      for (let x = 0; x < config.SIZE; x += 1) {
        const btn = boardCellAt(x, y);
        const odd = (x + y) % 2 === 1;
        btn.className = "cell" + (odd ? " odd" : "");
        btn.replaceChildren();
        btn.removeAttribute("data-goal");
        btn.removeAttribute("data-goal-seat");
        btn.setAttribute(
          "aria-selected",
          String(Boolean(app.selected && app.selected.x === x && app.selected.y === y))
        );
        btn.tabIndex = focusTarget.x === x && focusTarget.y === y ? 0 : -1;
        let label = rules.formatSquare({ x: x, y: y });
        SEATS.forEach(function (seat) {
          const g = goals[seat];
          if (g && g.x === x && g.y === y) {
            btn.classList.add("goal-" + seat.toLowerCase());
            btn.dataset.goal = rules.formatSquare(g).toUpperCase();
            btn.dataset.goalSeat = seat;
            label += ", ô thắng của " + config.SEAT_LABEL[seat];
          }
        });
        if (btn.dataset.goal) {
          const goalLabel = document.createElement("span");
          goalLabel.className = "goal-label";
          goalLabel.textContent = btn.dataset.goal;
          goalLabel.setAttribute("aria-hidden", "true");
          btn.appendChild(goalLabel);
        }
        const occ = state ? rules.piecesAt(state, x, y) : [];
        const piece = occ[0];
        if (piece) {
          btn.classList.add("has-piece");
          const wrap = document.createElement("div");
          wrap.className = "stack";
          const token = document.createElement("span");
          token.className = "piece seat-" + piece.player;
          token.dataset.id = piece.id;
          if (canControl(piece.player)) token.classList.add("is-mine");
          token.appendChild(iconFor(piece.type));
          wrap.appendChild(token);
          btn.appendChild(wrap);
          label +=
            ", " +
            config.TYPE_LABEL[piece.type] +
            " của " +
            (app.names[piece.player] || config.SEAT_LABEL[piece.player]);
          if (canControl(piece.player)) label += ", quân của bạn";
        }
        const selected = Boolean(app.selected && app.selected.x === x && app.selected.y === y);
        if (selected) {
          btn.classList.add("is-selected");
          label += ", đang chọn";
        }
        const legal = app.legal.some(function (m) { return m.x === x && m.y === y; });
        if (legal) {
          btn.classList.add("is-legal");
          label += ", ô đi hợp lệ";
          if (piece && mover && piece.player !== mover.player) {
            const outcome = rules.compare(mover.type, piece.type);
            if (outcome === "win") {
              btn.classList.add("is-win");
              label += ", thắng giao chiến";
            }
            if (outcome === "lose") {
              btn.classList.add("is-loss");
              label += ", quân của bạn sẽ bị loại";
            }
          }
        }
        if (ply && ply.from && ply.from.x === x && ply.from.y === y) {
          btn.classList.add("is-from");
          label += ", ô xuất phát của nước vừa đi";
        }
        if (ply && ply.to && ply.to.x === x && ply.to.y === y) {
          btn.classList.add("is-to");
          label += ", ô đến của nước vừa đi";
        }
        if (burstAt[x + "," + y]) {
          btn.classList.add("is-burst");
          const splat = document.createElement("span");
          splat.className = "ink-splat";
          splat.setAttribute("aria-hidden", "true");
          btn.appendChild(splat);
        }
        btn.setAttribute("aria-label", label);
      }
    }
    if (slide && isLive()) {
      const token = els.board.querySelector('[data-id="' + slide.pieceId + '"]');
      const cell = boardCellAt(0, 0);
      if (token && cell) {
        const size = els.board.getBoundingClientRect().width / config.SIZE;
        token.style.setProperty("--from-x", (slide.from.x - slide.to.x) * size + "px");
        token.style.setProperty("--from-y", (slide.from.y - slide.to.y) * size + "px");
        token.classList.add("is-slide");
      }
    }
  }

  function renderChat() {
    els.chatLog.innerHTML = "";
    app.chat.forEach(function (msg) {
      const li = document.createElement("li");
      const who = document.createElement("span");
      who.className = "who";
      who.textContent = msg.name;
      li.appendChild(who);
      li.appendChild(document.createTextNode(msg.text));
      els.chatLog.appendChild(li);
    });
    els.chatLog.scrollTop = els.chatLog.scrollHeight;
  }

  function renderHistory() {
    els.historyLog.innerHTML = "";
    app.history.forEach(function (mv, i) {
      const li = document.createElement("li");
      const who = document.createElement("span");
      who.className = "who";
      who.textContent = String(i + 1).padStart(2, "0");
      li.appendChild(who);
      li.appendChild(
        document.createTextNode(
          (app.names[mv.seat] || mv.seat) +
            " " +
            rules.formatSquare(mv.from) +
            " → " +
            rules.formatSquare(mv.to)
        )
      );
      const now = (app.replayAt == null ? app.history.length : app.replayAt) - 1;
      if (i === now) li.classList.add("is-now");
      els.historyLog.appendChild(li);
    });
    els.historyLog.scrollTop = els.historyLog.scrollHeight;
    syncReplayUi();
  }

  function render() {
    renderHud();
    renderBoard();
    renderChat();
    renderHistory();
    if (isLive()) app.lastEvents = [];
  }

  function openWin(state) {
    if (!state || !state.winner) return;
    if (isSpectator()) {
      els.winTitle.textContent =
        (app.names[state.winner] || config.SEAT_LABEL[state.winner]) + " thắng";
    } else if (app.mode === "local") {
      els.winTitle.textContent = app.names[state.winner] + " thắng";
    } else if (app.you === state.winner) {
      els.winTitle.textContent = "Bạn thắng";
    } else {
      els.winTitle.textContent = "Bạn thua";
    }
    els.winReason.textContent = reasonText(state);
    tapFeel("win");
    if (els.confetti) {
      els.confetti.innerHTML = "";
      for (let i = 0; i < 14; i += 1) {
        const bit = document.createElement("span");
        bit.style.left = 8 + i * 6 + "%";
        bit.style.animationDelay = (i % 5) * 40 + "ms";
        els.confetti.appendChild(bit);
      }
    }
    if (typeof els.win.showModal === "function" && !els.win.open) els.win.showModal();
  }

  function selectAt(x, y) {
    if (!app.state || app.state.winner || !isLive()) return;
    if (app.status === "waiting") {
      toast("Chờ đối thủ vào phòng.");
      return;
    }
    const occ = rules.piecesAt(app.state, x, y);
    const mine = occ.find(function (p) {
      return canControl(p.player);
    });
    if (!mine) {
      app.selected = null;
      app.legal = [];
      playSound("tap");
      render();
      return;
    }
    app.selected = { x: x, y: y, id: mine.id, player: mine.player };
    app.legal = rules.getLegalMoves(app.state, mine.id);
    playSound("select");
    render();
  }

  function applyLocal(from, to) {
    const player = app.state.turn;
    const result = rules.applyMove(app.state, player, from, to);
    if (!result.ok) {
      toast(result.error, "error");
      return;
    }
    app.history.push({
      seat: player,
      from: { x: from.x, y: from.y },
      to: { x: to.x, y: to.y },
      events: result.events
    });
    app.liveState = result.state;
    app.state = result.state;
    app.lastEvents = result.events;
    app.selected = null;
    app.legal = [];
    app.focused = { x: to.x, y: to.y };
    app.replayAt = app.history.length;
    app.clockStamp = performance.now();
    playSound("move");
    showCombat(result.events);
    render();
    if (app.state.winner) {
      stopClock();
      openWin(app.state);
      return;
    }
    if (app.mode === "ai" && app.state.turn !== app.you) {
      window.setTimeout(playAi, 380);
    }
  }

  function playAi() {
    if (app.mode !== "ai" || !app.state || app.state.winner) return;
    const choice = ai.chooseMove(app.state, app.state.turn);
    if (!choice) {
      toast("Máy không có nước đi hợp lệ.", "error");
      return;
    }
    applyLocal(choice.from, choice.to);
  }

  function attemptMove(to) {
    if (!app.selected) return;
    const from = { x: app.selected.x, y: app.selected.y };
    const legal = app.legal.some(function (m) {
      return m.x === to.x && m.y === to.y;
    });
    if (!legal) {
      selectAt(to.x, to.y);
      return;
    }
    if (app.mode === "online") {
      app.pf.move(from, to);
      app.selected = null;
      app.legal = [];
      app.focused = { x: to.x, y: to.y };
      render();
      return;
    }
    applyLocal(from, to);
  }

  function activateBoardCell(x, y) {
    if (!app.state) return;
    app.focused = { x: x, y: y };
    if (app.selected) attemptMove({ x: x, y: y });
    else selectAt(x, y);
  }

  function boardPointFromEvent(ev) {
    const rect = els.board.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    const x = Math.floor(((ev.clientX - rect.left) / rect.width) * config.SIZE);
    const y = Math.floor(((ev.clientY - rect.top) / rect.height) * config.SIZE);
    return rules.inside(x, y) ? { x: x, y: y } : null;
  }

  function onBoardClick(ev) {
    if (!app.state) return;
    const point = boardPointFromEvent(ev);
    if (point) {
      activateBoardCell(point.x, point.y);
      return;
    }
    const cell = ev.target.closest(".cell");
    if (cell) {
      activateBoardCell(Number(cell.dataset.x), Number(cell.dataset.y));
    }
  }

  function onBoardKeydown(ev) {
    const cell = ev.target.closest(".cell");
    if (!cell) return;
    const x = Number(cell.dataset.x);
    const y = Number(cell.dataset.y);
    let next = null;
    if (ev.key === "ArrowUp") next = { x: x, y: y - 1 };
    if (ev.key === "ArrowDown") next = { x: x, y: y + 1 };
    if (ev.key === "ArrowLeft") next = { x: x - 1, y: y };
    if (ev.key === "ArrowRight") next = { x: x + 1, y: y };
    if (ev.key === "Home") next = { x: 0, y: y };
    if (ev.key === "End") next = { x: config.SIZE - 1, y: y };
    if (next) {
      ev.preventDefault();
      if (rules.inside(next.x, next.y)) setBoardFocus(next.x, next.y, true);
      return;
    }
    if (ev.key === "Enter" || ev.key === " ") {
      ev.preventDefault();
      activateBoardCell(x, y);
      setBoardFocus(x, y, true);
    }
  }

  function applyNames(players) {
    if (!players) return;
    SEATS.forEach(function (seat) {
      if (players[seat] && players[seat].name) app.names[seat] = players[seat].name;
    });
  }

  function bindPlayfull() {
    if (app.pf) return app.pf;
    const pf = new window.Playfull();
    app.pf = pf;
    pf.on("open", function () {
      if (app.reconnecting) setNet("wait", "Đang khôi phục");
      else setNet("on", "Đã nối");
    });
    pf.on("close", function () {
      if (app.roomId && app.mode === "online" && !app.leaving) {
        app.reconnecting = true;
        setNet("wait", "Đang kết nối lại");
        render();
      } else setNet("off", "Mất nối");
    });
    pf.on("reconnecting", function () {
      app.reconnecting = true;
      setNet("wait", "Đang kết nối lại");
      render();
    });
    pf.on("resumed", function () {
      app.reconnecting = false;
      setNet("on", "Đã nối lại");
      render();
    });
    pf.on("resumeFailed", function (msg) {
      app.reconnecting = false;
      toast((msg && msg.message) || "Không khôi phục được ván.", "error");
      leaveTable(true);
    });
    pf.on("error", function (msg) {
      if (msg && msg.resumeFailure) return;
      toast((msg && msg.message) || "Lỗi mạng", "error");
    });
    pf.on("rooms", function (msg) {
      drawRoomList(msg.rooms || []);
    });
    pf.on("hello", function (msg) {
      drawRoomList(msg.rooms || []);
      if (msg.leaderboard) drawLeaderboard(msg.leaderboard);
    });
    pf.on("joined", function (msg) {
      resetTable("online", msg.mode === "arena" ? "arena" : "duel");
      app.you = msg.you;
      app.role = msg.role || msg.you;
      app.roomId = msg.roomId;
      app.status = msg.status;
      app.reconnecting = false;
      app.roomName = msg.roomName || null;
      app.chat = msg.chat || [];
      applyNames(msg.players);
      showScreen("table");
      startClock();
      syncPlayhtmlRoom();
      render();
    });
    pf.on("state", function (msg) {
      const atLive = isLive();
      app.liveState = msg.state;
      app.history = msg.history || app.history;
      app.status = msg.status;
      app.roomId = msg.roomId;
      app.you = msg.you || app.you;
      app.role = msg.role || app.role || app.you;
      app.gameMode = (msg.mode || (msg.state && msg.state.mode) || app.gameMode) === "arena"
        ? "arena"
        : "duel";
      app.roomName = msg.name || app.roomName;
      app.viewers = msg.spectators || 0;
      app.onlineStateAt = performance.now();
      app.reconnecting = false;
      applyNames(msg.players);
      if (atLive) {
        app.state = msg.state;
        app.lastEvents = msg.events || [];
        app.replayAt = app.history.length;
        if (app.lastEvents.some(function (event) { return event.type === "move"; })) {
          playSound("move");
        }
        showCombat(app.lastEvents);
      }
      if (app.status === "playing") setNet("on", "Đang chơi");
      if (app.status === "waiting") setNet("wait", "Chờ đối thủ");
      render();
      if (atLive && app.state && app.state.winner) openWin(app.state);
    });
    pf.on("gameover", function (msg) {
      if (app.liveState) {
        app.liveState.winner = msg.winner;
        app.liveState.reason = msg.reason;
        app.liveState.eliminatedPlayer = msg.eliminatedPlayer || null;
      }
      openWin(app.liveState || msg);
      loadLeaderboard();
    });
    pf.on("chat", function (msg) {
      if (msg.message) {
        app.chat.push(msg.message);
        if (app.chat.length > config.CHAT_KEEP) app.chat.shift();
        renderChat();
      }
    });
    pf.on("react", function (msg) {
      const glyph = msg.react && msg.react.glyph;
      if (!glyph || !els.reactFloat) return;
      const span = document.createElement("span");
      span.textContent = glyph;
      els.reactFloat.appendChild(span);
      setTimeout(function () {
        span.remove();
      }, 700);
    });
    return pf;
  }

  function drawLeaderboard(rows) {
    els.leaderboard.innerHTML = "";
    (rows || []).forEach(function (row) {
      const li = document.createElement("li");
      const left = document.createElement("span");
      left.textContent =
        row.rank +
        ". " +
        row.username +
        (row.badge ? " · " + row.badge : "");
      const right = document.createElement("span");
      right.className = "wins";
      right.textContent = row.wins + " thắng";
      li.appendChild(left);
      li.appendChild(right);
      els.leaderboard.appendChild(li);
    });
  }

  function loadLeaderboard() {
    fetch("/api/leaderboard")
      .then(function (res) {
        return res.json();
      })
      .then(function (body) {
        drawLeaderboard(body.players || []);
      })
      .catch(function () {});
  }

  function drawRoomList(rooms) {
    els.list.innerHTML = "";
    if (!rooms.length) {
      const li = document.createElement("li");
      li.className = "empty-line";
      li.textContent = "Chưa có phòng mở. Tạo phòng hoặc chơi ngay.";
      els.list.appendChild(li);
      return;
    }
    rooms.forEach(function (room) {
      const li = document.createElement("li");
      const card = document.createElement("div");
      card.className = "room-card";
      const title = document.createElement("p");
      title.className = "room-card-title";
      title.textContent = room.name || room.id;
      const meta = document.createElement("p");
      meta.className = "room-card-meta";
      meta.textContent =
        room.id +
        " · " +
        room.players +
        "/" +
        (room.maxPlayers || 2) +
        " · " +
        (room.viewers || 0) +
        " xem";
      const status = document.createElement("span");
      status.className = "room-status" + (room.status === "playing" ? " is-live" : "");
      status.textContent = room.status === "playing" ? "LIVE" : "CHỜ";
      const actions = document.createElement("div");
      actions.className = "room-card-actions";
      const joinBtn = document.createElement("button");
      joinBtn.type = "button";
      joinBtn.className = "btn btn-ghost";
      joinBtn.textContent = "Vào";
      joinBtn.addEventListener("click", function () {
        els.room.value = room.id;
        startOnline("join");
      });
      const watchBtn = document.createElement("button");
      watchBtn.type = "button";
      watchBtn.className = "btn btn-ghost";
      watchBtn.textContent = "Xem";
      watchBtn.addEventListener("click", function () {
        els.room.value = room.id;
        startOnline("watch");
      });
      actions.appendChild(joinBtn);
      actions.appendChild(watchBtn);
      card.appendChild(title);
      card.appendChild(status);
      card.appendChild(actions);
      card.appendChild(meta);
      card.id = "room-" + room.id;
      card.setAttribute("can-hover", "");
      li.appendChild(card);
      els.list.appendChild(li);
      setupPlayEl(card);
    });
  }

  function resetTable(kind, gameMode) {
    app.mode = kind;
    app.gameMode = gameMode || "duel";
    app.reconnecting = false;
    app.selected = null;
    app.legal = [];
    app.focused = null;
    app.chat = [];
    app.history = [];
    app.replayAt = 0;
    app.viewers = 0;
    app.names = {
      A: config.SEAT_LABEL.A,
      B: config.SEAT_LABEL.B,
      C: config.SEAT_LABEL.C,
      D: config.SEAT_LABEL.D
    };
  }

  function startLocal(kind) {
    resetTable(kind, "duel");
    app.you = "A";
    app.role = "A";
    app.status = "playing";
    app.roomId = null;
    app.roomName = null;
    app.state = rules.createInitialState("duel");
    app.liveState = app.state;
    app.names.A = playerName() || config.SEAT_LABEL.A;
    app.names.B = kind === "ai" ? "Máy" : config.SEAT_LABEL.B;
    setNet("off", kind === "ai" ? "Đấu máy" : "Cùng máy");
    showScreen("table");
    render();
    startClock();
  }

  async function startOnline(intent) {
    if ((intent === "join" || intent === "watch") && !(els.room.value || "").trim()) {
      toast("Nhập mã phòng", "error");
      return;
    }
    const pf = bindPlayfull();
    try {
      await pf.connect();
    } catch (err) {
      toast("Không nối được máy chủ", "error");
      return;
    }
    stopClock();
    const name = playerName();
    if (intent === "create") {
      pf.create(name, {
        mode: selectedMode(),
        roomName: (els.roomName.value || "").trim()
      });
    } else if (intent === "watch") {
      pf.watch((els.room.value || "").trim().toUpperCase(), name);
    } else {
      pf.join((els.room.value || "").trim().toUpperCase(), name);
    }
  }

  function leaveTable(skipServerLeave) {
    if (app.leaving) return;
    app.leaving = true;
    if (!skipServerLeave && app.pf && app.mode === "online") app.pf.leave();
    stopClock();
    app.mode = null;
    app.state = null;
    app.liveState = null;
    app.selected = null;
    app.legal = [];
    app.status = "idle";
    app.chat = [];
    app.history = [];
    app.replayAt = null;
    app.focused = null;
    lastCounts.A = lastCounts.B = lastCounts.C = lastCounts.D = null;
    if (els.win.open) els.win.close();
    app.roomId = null;
    app.roomName = null;
    showScreen("lobby");
    setNet("off", "Ngoại tuyến");
    syncPlayhtmlRoom();
    if (app.pf) app.pf.list();
    loadLeaderboard();
    app.leaving = false;
  }

  els.form.addEventListener("submit", function (ev) {
    ev.preventDefault();
    const submitter = ev.submitter;
    const intent = (submitter && submitter.value) || "create";
    if (intent === "local") startLocal("local");
    else if (intent === "ai") startLocal("ai");
    else startOnline(intent);
  });

  els.board.addEventListener("click", onBoardClick);
  els.board.addEventListener("keydown", onBoardKeydown);
  if (els.audioToggle) {
    els.audioToggle.addEventListener("click", function () {
      audio.enabled = !audio.enabled;
      try {
        localStorage.setItem("ottv2-audio", audio.enabled ? "on" : "off");
      } catch (err) {}
      updateAudioUi();
      if (audio.enabled) playSound("tap");
    });
  }
  document.addEventListener("keydown", function (ev) {
    if (ev.key !== "Escape") return;
    if (els.win && els.win.open) return;
    if (!app.selected) return;
    app.selected = null;
    app.legal = [];
    render();
  });
  els.leave.addEventListener("click", leaveTable);
  els.win.addEventListener("close", function () {
    leaveTable();
  });

  els.chatForm.addEventListener("submit", function (ev) {
    ev.preventDefault();
    if (app.mode !== "online") return;
    const text = (els.chatInput.value || "").trim();
    if (!text) return;
    sendChat(text);
    els.chatInput.value = "";
  });

  els.reactRow.addEventListener("click", function (ev) {
    const btn = ev.target.closest("[data-react]");
    if (!btn || app.mode !== "online") return;
    sendReact(btn.getAttribute("data-react"));
  });

  els.replay.addEventListener("input", function () {
    const n = Number(els.replay.value);
    app.replayAt = n;
    app.selected = null;
    app.legal = [];
    app.lastEvents = [];
    app.state = stateAt(n);
    renderHud();
    renderBoard();
  });

  buildChrome();
  loadAudioSetting();
  const saved = localStorage.getItem("ottv2-name");
  if (saved) els.name.value = saved;
  els.name.addEventListener("change", function () {
    localStorage.setItem("ottv2-name", playerName());
    setPlayIdentity();
  });

  const params = new URLSearchParams(location.search);
  if (params.get("room")) els.room.value = params.get("room");
  if (params.get("name")) els.name.value = params.get("name");
  if (params.get("mode") === "arena") {
    const arena = document.querySelector('input[name="mode"][value="arena"]');
    if (arena) arena.checked = true;
  }

  loadLeaderboard();
  bootPlayhtml();
  bindPlayfull()
    .connect()
    .then(function () {
      app.pf.list();
    })
    .catch(function () {
      setNet("off", "Ngoại tuyến");
    });
})();
