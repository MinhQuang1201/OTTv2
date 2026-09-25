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
    replayAt: null
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
    roomChip: document.getElementById("room-chip"),
    netChip: document.getElementById("net-chip"),
    roleChip: document.getElementById("role-chip"),
    viewChip: document.getElementById("view-chip"),
    toast: document.getElementById("toast"),
    win: document.getElementById("win-dialog"),
    winTitle: document.getElementById("win-title"),
    winReason: document.getElementById("win-reason"),
    leave: document.getElementById("btn-leave"),
    combat: document.getElementById("combat-banner"),
    chatLog: document.getElementById("chat-log"),
    chatForm: document.getElementById("chat-form"),
    chatInput: document.getElementById("chat-input"),
    reactRow: document.getElementById("react-row"),
    reactFloat: document.getElementById("react-float"),
    historyLog: document.getElementById("history-log"),
    replay: document.getElementById("replay-slider"),
    leaderboard: document.getElementById("leaderboard"),
    confetti: document.querySelector(".confetti")
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

  function countsHtml(counts) {
    return config.TYPES.map(function (type) {
      return (
        '<li><img src="' +
        config.ASSET[type] +
        '" alt=""><span class="n">' +
        counts[type] +
        "</span><span>" +
        config.TYPE_LABEL[type] +
        "</span></li>"
      );
    }).join("");
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
      return;
    }
    els.combat.hidden = false;
    els.combat.textContent = text;
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
      }
      if (els["counts" + seat] && state) {
        els["counts" + seat].innerHTML = countsHtml(rules.countByType(state, seat));
      }
    });
    if (!state) return;
    const turnName = app.names[state.turn] || config.SEAT_LABEL[state.turn];
    els.turn.textContent = state.winner
      ? "Ván đã kết thúc"
      : isSpectator()
        ? "Đang xem · lượt " + turnName
        : "Lượt " + turnName;
    els.wait.hidden = app.status !== "waiting";
    if (app.roomId) {
      els.roomChip.textContent = (app.roomName || "Phòng") + " " + app.roomId;
    } else if (app.mode === "ai") {
      els.roomChip.textContent = "Đấu máy";
    } else {
      els.roomChip.textContent = "Cùng máy";
    }
    els.roleChip.hidden = !isSpectator();
    els.viewChip.hidden = app.mode !== "online";
    els.viewChip.textContent = app.viewers + " xem";
    renderClock();
  }

  function renderBoard() {
    const state = app.state;
    els.board.innerHTML = "";
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
    for (let y = 0; y < config.SIZE; y += 1) {
      for (let x = 0; x < config.SIZE; x += 1) {
        const btn = document.createElement("button");
        const odd = (x + y) % 2 === 1;
        btn.type = "button";
        btn.className = "cell" + (odd ? " odd" : "");
        btn.setAttribute("role", "gridcell");
        btn.dataset.x = String(x);
        btn.dataset.y = String(y);
        btn.setAttribute("aria-label", rules.formatSquare({ x: x, y: y }));
        SEATS.forEach(function (seat) {
          const g = goals[seat];
          if (g && g.x === x && g.y === y) btn.classList.add("goal-" + seat.toLowerCase());
        });
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
          token.innerHTML =
            '<img src="' +
            config.ASSET[piece.type] +
            '" alt="' +
            config.TYPE_LABEL[piece.type] +
            " " +
            piece.player +
            '">';
          wrap.appendChild(token);
          btn.appendChild(wrap);
        }
        if (app.selected && app.selected.x === x && app.selected.y === y) {
          btn.classList.add("is-selected");
        }
        if (app.legal.some(function (m) { return m.x === x && m.y === y; })) {
          btn.classList.add("is-legal");
        }
        if (burstAt[x + "," + y]) btn.classList.add("is-burst");
        els.board.appendChild(btn);
      }
    }
    if (slide && isLive()) {
      const token = els.board.querySelector('[data-id="' + slide.pieceId + '"]');
      const cell = els.board.querySelector(".cell");
      if (token && cell) {
        const size = cell.offsetWidth;
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
    const occ = rules.piecesAt(app.state, x, y);
    const mine = occ.find(function (p) {
      return canControl(p.player);
    });
    if (!mine) {
      app.selected = null;
      app.legal = [];
      render();
      return;
    }
    app.selected = { x: x, y: y, id: mine.id, player: mine.player };
    app.legal = rules.getLegalMoves(app.state, mine.id);
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
    app.replayAt = app.history.length;
    app.clockStamp = performance.now();
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
      return;
    }
    applyLocal(from, to);
  }

  function onBoardClick(ev) {
    const cell = ev.target.closest(".cell");
    if (!cell || !app.state) return;
    const x = Number(cell.dataset.x);
    const y = Number(cell.dataset.y);
    if (app.selected) attemptMove({ x: x, y: y });
    else selectAt(x, y);
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
    pf.on("error", function (msg) {
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
      li.textContent = "Chưa có phòng mở.";
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
      li.appendChild(card);
      els.list.appendChild(li);
    });
  }

  function resetTable(kind, gameMode) {
    app.mode = kind;
    app.gameMode = gameMode || "duel";
    app.reconnecting = false;
    app.selected = null;
    app.legal = [];
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

  function leaveTable() {
    if (app.leaving) return;
    app.leaving = true;
    if (app.pf && app.mode === "online") app.pf.leave();
    stopClock();
    app.mode = null;
    app.state = null;
    app.liveState = null;
    app.selected = null;
    app.legal = [];
    app.status = "idle";
    app.chat = [];
    app.history = [];
    if (els.win.open) els.win.close();
    showScreen("lobby");
    setNet("off", "Ngoại tuyến");
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
  els.leave.addEventListener("click", leaveTable);
  els.win.addEventListener("close", function () {
    leaveTable();
  });

  els.chatForm.addEventListener("submit", function (ev) {
    ev.preventDefault();
    if (app.mode !== "online" || !app.pf) return;
    const text = (els.chatInput.value || "").trim();
    if (!text) return;
    app.pf.chat(text);
    els.chatInput.value = "";
  });

  els.reactRow.addEventListener("click", function (ev) {
    const btn = ev.target.closest("[data-react]");
    if (!btn || app.mode !== "online" || !app.pf) return;
    app.pf.react(btn.getAttribute("data-react"));
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
  const saved = localStorage.getItem("ottv2-name");
  if (saved) els.name.value = saved;
  els.name.addEventListener("change", function () {
    localStorage.setItem("ottv2-name", playerName());
  });

  const params = new URLSearchParams(location.search);
  if (params.get("room")) els.room.value = params.get("room");
  if (params.get("name")) els.name.value = params.get("name");
  if (params.get("mode") === "arena") {
    const arena = document.querySelector('input[name="mode"][value="arena"]');
    if (arena) arena.checked = true;
  }

  loadLeaderboard();
  bindPlayfull()
    .connect()
    .then(function () {
      app.pf.list();
    })
    .catch(function () {
      setNet("off", "Ngoại tuyến");
    });
})();
