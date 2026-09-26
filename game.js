/* Sảnh, bàn, ba chế độ. Online chỉ gửi nước đi; luật do server. */
(function () {
  const rules = window.OTT_RULES;
  const config = window.OTT_CONFIG;
  const ai = window.OTT_AI;

  const app = {
    mode: null,
    pf: null,
    you: null,
    state: null,
    status: "idle",
    names: { A: config.SEAT_LABEL.A, B: config.SEAT_LABEL.B },
    selected: null,
    legal: [],
    lastEvents: [],
    roomId: null,
    leaving: false,
    reconnecting: false,
    clockStamp: 0,
    clockTimer: null,
    onlineStateAt: 0
  };

  const els = {
    app: document.getElementById("app"),
    lobby: document.getElementById("lobby"),
    table: document.getElementById("table"),
    form: document.getElementById("start-form"),
    name: document.getElementById("player-name"),
    room: document.getElementById("room-code"),
    list: document.getElementById("room-list"),
    board: document.getElementById("board"),
    ranks: document.getElementById("ranks"),
    files: document.getElementById("files"),
    turn: document.getElementById("turn-line"),
    wait: document.getElementById("wait-line"),
    nameA: document.getElementById("name-a"),
    nameB: document.getElementById("name-b"),
    countsA: document.getElementById("counts-a"),
    countsB: document.getElementById("counts-b"),
    clockA: document.getElementById("clock-a"),
    clockB: document.getElementById("clock-b"),
    hudA: document.querySelector(".hud-a"),
    hudB: document.querySelector(".hud-b"),
    roomChip: document.getElementById("room-chip"),
    netChip: document.getElementById("net-chip"),
    toast: document.getElementById("toast"),
    win: document.getElementById("win-dialog"),
    winTitle: document.getElementById("win-title"),
    winReason: document.getElementById("win-reason"),
    leave: document.getElementById("btn-leave")
  };

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
  }

  function hasOnlineConnection() {
    return typeof window.OTT_PLAYHTML_CONNECTION_FACTORY === "function" ||
      typeof window.OTT_PLAYHTML_RUNTIME === "object";
  }

  function controlRequest(action, body) {
    const host = window.OTT_PLAYHTML_CONTROL_ENDPOINT;
    if (!host || typeof window.fetch !== "function") return Promise.reject(new Error("Trực tuyến chưa sẵn sàng"));
    let endpoint;
    try { endpoint = new URL(host); } catch (_) { return Promise.reject(new Error("HTTPS required for control requests")); }
    if (endpoint.protocol !== "https:") return Promise.reject(new Error("HTTPS required for control requests"));
    return window.fetch(host.replace(/\/$/, "") + "/control/" + action, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body || {})
    }).then(function (response) {
      return response.json().then(function (value) {
        if (!response.ok) throw new Error(value.error || "Máy chủ từ chối yêu cầu");
        return value;
      });
    });
  }

  function playerName() {
    return (els.name.value || "Khách").trim().slice(0, config.NAME_MAX);
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
      const goal = config.GOAL[state.winner];
      return "Đưa quân vào ô thắng " + rules.formatSquare(goal).toUpperCase() + ".";
    }
    if (state.reason === "elimination") return "Đối phương không còn quân nào.";
    if (state.reason === "no_moves") return "Đối phương không còn nước đi hợp lệ.";
    if (state.reason === "timeout") return "Hết giờ.";
    if (state.reason === "leave") return "Đối thủ đã rời bàn.";
    if (state.reason === "disconnect_timeout") return "Đối thủ không kết nối lại trong thời gian cho phép.";
    return "";
  }

  function canControl(seat) {
    if (!app.state || app.state.winner || app.reconnecting) return false;
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
    let remaining = app.state.clock.remainingMs[seat];
    if (app.mode === "online" && !app.reconnecting && app.state.clock.runningSeat === seat && app.onlineStateAt) {
      remaining -= performance.now() - app.onlineStateAt;
    }
    return Math.max(0, remaining);
  }

  function renderClock() {
    if (!app.state || !app.state.clock) return;
    els.clockA.textContent = formatClock(currentClockMs("A"));
    els.clockB.textContent = formatClock(currentClockMs("B"));
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
      if (app.state.winner) openWin(app.state);
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

  function renderHud() {
    const state = app.state;
    els.nameA.textContent = app.names.A;
    els.nameB.textContent = app.names.B;
    if (!state) return;
    els.countsA.innerHTML = countsHtml(rules.countByType(state, "A"));
    els.countsB.innerHTML = countsHtml(rules.countByType(state, "B"));
    els.hudA.dataset.active = String(state.turn === "A" && !state.winner);
    els.hudB.dataset.active = String(state.turn === "B" && !state.winner);
    const turnName = app.names[state.turn] || config.SEAT_LABEL[state.turn];
    els.turn.textContent = state.winner
      ? "Ván đã kết thúc"
      : "Lượt " + turnName;
    els.wait.hidden = app.status !== "waiting";
    els.roomChip.textContent = app.roomId ? "Phòng " + app.roomId : app.mode === "ai" ? "Đấu máy" : "Cùng máy";
    renderClock();
  }

  function renderBoard() {
    const state = app.state;
    els.board.innerHTML = "";
    const burstAt = {};
    for (const ev of app.lastEvents) {
      if (ev.type === "capture" || ev.type === "strike_loss") {
        burstAt[ev.to.x + "," + ev.to.y] = true;
      }
    }
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
        if (x === config.GOAL.A.x && y === config.GOAL.A.y) {
          btn.classList.add("goal-a");
        }
        if (x === config.GOAL.B.x && y === config.GOAL.B.y) {
          btn.classList.add("goal-b");
        }
        const occ = state ? rules.piecesAt(state, x, y) : [];
        if (occ.length) {
          btn.classList.add("has-piece");
          const piece = occ[0];
          const token = document.createElement("span");
          token.className = "piece seat-" + piece.player;
          if (canControl(piece.player)) token.classList.add("is-mine");
          token.innerHTML =
            '<img src="' +
            config.ASSET[piece.type] +
            '" alt="' +
            config.TYPE_LABEL[piece.type] +
            " " +
            piece.player +
            '">';
          btn.appendChild(token);
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
  }

  function render() {
    renderHud();
    renderBoard();
    app.lastEvents = [];
  }

  function openWin(state) {
    if (!state || !state.winner) return;
    if (app.mode === "local") {
      els.winTitle.textContent = app.names[state.winner] + " thắng";
    } else if (app.you === state.winner) {
      els.winTitle.textContent = "Bạn thắng";
    } else {
      els.winTitle.textContent = "Bạn thua";
    }
    els.winReason.textContent = reasonText(state);
    if (typeof els.win.showModal === "function" && !els.win.open) els.win.showModal();
  }

  function selectAt(x, y) {
    if (!app.state || app.state.winner) return;
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
    app.state = result.state;
    app.lastEvents = result.events;
    app.selected = null;
    app.legal = [];
    render();
    if (app.state.winner) {
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

  function bindOnlineClient() {
    if (app.pf) return app.pf;
    if (!hasOnlineConnection()) {
      throw new Error("PlayHTML game connection is not configured");
    }
    const pf = new window.PlayhtmlGameClient({
      connectionFactory: function () {
        if (typeof window.OTT_PLAYHTML_CONNECTION_FACTORY !== "function") {
          throw new Error("PlayHTML game connection is not configured");
        }
        return window.OTT_PLAYHTML_CONNECTION_FACTORY();
      },
      controlRequest: controlRequest,
      playhtmlBootstrap: window.OTT_PLAYHTML_BOOTSTRAP || null,
      playhtmlHost: window.OTT_PLAYHTML_HOST || window.OTT_PLAYHTML_CONTROL_ENDPOINT
    });
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
    });
    pf.on("joined", function (msg) {
      app.mode = "online";
      stopClock();
      app.you = msg.you;
      app.roomId = msg.roomId;
      app.status = msg.status;
      app.reconnecting = false;
      if (msg.players && msg.players.A) app.names.A = msg.players.A.name;
      if (msg.players && msg.players.B) app.names.B = msg.players.B.name;
      showScreen("table");
      render();
    });
    pf.on("state", function (msg) {
      showScreen("table");
      app.state = msg.state;
      app.onlineStateAt = performance.now();
      app.lastEvents = msg.events || [];
      app.status = msg.status;
      app.roomId = msg.roomId;
      app.you = msg.you || app.you;
      app.reconnecting = false;
      if (msg.players && msg.players.A) app.names.A = msg.players.A.name;
      if (msg.players && msg.players.B) app.names.B = msg.players.B.name;
      if (app.status === "playing") setNet("on", "Đang chơi");
      if (app.status === "waiting") setNet("wait", "Chờ đối thủ");
      render();
      if (app.state && app.state.winner) {
        openWin(app.state);
      }
    });
    pf.on("gameover", function (msg) {
      openWin(app.state || msg);
    });
    return pf;
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
      const btn = document.createElement("button");
      btn.type = "button";
      const names = Array.isArray(room.names)
        ? room.names
        : [room.names && room.names.A, room.names && room.names.B].filter(Boolean);
      btn.innerHTML = "<span>" + room.id + "</span><span>" + names.join(", ") + "</span>";
      btn.addEventListener("click", function () {
        els.room.value = room.id;
        startOnline("join");
      });
      li.appendChild(btn);
      els.list.appendChild(li);
    });
  }

  function startLocal(kind) {
    app.mode = kind;
    app.reconnecting = false;
    app.you = "A";
    app.status = "playing";
    app.roomId = null;
    app.state = rules.createInitialState();
    app.names.A = playerName() || config.SEAT_LABEL.A;
    app.names.B = kind === "ai" ? "Máy" : config.SEAT_LABEL.B;
    app.selected = null;
    app.legal = [];
    setNet("off", kind === "ai" ? "Đấu máy" : "Cùng máy");
    showScreen("table");
    render();
    startClock();
  }

  async function startOnline(intent) {
    if (!hasOnlineConnection() || typeof window.OTT_PLAYHTML_CONTROL_ENDPOINT !== "string") {
      setNet("off", "Trực tuyến chưa sẵn sàng");
      toast("Trực tuyến chưa sẵn sàng: chưa có kết nối PlayHTML đã xác minh.", "error");
      return;
    }
    if (intent === "join" && !(els.room.value || "").trim()) {
      toast("Nhập mã phòng", "error");
      return;
    }
    let pf;
    try {
      pf = bindOnlineClient();
    } catch (err) {
      toast("Chưa cấu hình kết nối PlayHTML", "error");
      return;
    }
    app.mode = "online";
    app.reconnecting = false;
    stopClock();
    app.state = null;
    const result = intent === "create"
      ? pf.create(playerName())
      : pf.join((els.room.value || "").trim(), playerName());
    if (result && typeof result.catch === "function") result.catch(function () {
      toast("Không nối được máy chủ", "error");
    });
  }

  function leaveTable() {
    if (app.leaving) return;
    app.leaving = true;
    if (app.pf && app.mode === "online") app.pf.leave();
    stopClock();
    app.mode = null;
    app.state = null;
    app.selected = null;
    app.legal = [];
    app.status = "idle";
    if (els.win.open) els.win.close();
    showScreen("lobby");
    setNet("off", "Ngoại tuyến");
    if (app.pf) app.pf.list();
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

  buildChrome();
  const saved = localStorage.getItem("ottv2-name");
  if (saved) els.name.value = saved;
  els.name.addEventListener("change", function () {
    localStorage.setItem("ottv2-name", playerName());
  });

  const params = new URLSearchParams(location.search);
  if (params.get("room")) els.room.value = params.get("room");
  if (params.get("name")) els.name.value = params.get("name");

   if (hasOnlineConnection() && typeof window.OTT_PLAYHTML_CONTROL_ENDPOINT === "string") {
     const onlineClient = bindOnlineClient();
     onlineClient.listRooms()
       .then(function () {
         if (window.OTT_PLAYHTML_RUNTIME && !window.OTT_PLAYHTML_BOOTSTRAP && window.PlayhtmlBootstrap) {
           window.OTT_PLAYHTML_BOOTSTRAP = window.PlayhtmlBootstrap.createBootstrap({
             runtime: window.OTT_PLAYHTML_RUNTIME,
             globalObject: window
           });
         }
       })
      .catch(function () {
        setNet("off", "Ngoại tuyến");
      });
  } else {
    setNet("off", "Trực tuyến chưa sẵn sàng");
  }
})();
