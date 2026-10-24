// Bot Cup admin page (plan §11.4). Plain DOM: every value from the API is set as text, never as HTML.
const API = "/admin-api";
const view = document.getElementById("view");
const statusLine = document.getElementById("status");
let me = null;
let currentTab = "overview";
let flagStatus = "open";

function h(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue;
    if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? "" : String(value));
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

const time = (ms) => (ms ? new Date(ms).toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" }) : "—");
const short = (text, n = 12) => (text ? String(text).slice(0, n) : "—");

function say(message, error = false) {
  statusLine.textContent = message;
  statusLine.className = error ? "status error" : "status";
}

/** Vietnamese text for the refusals organisers meet most; anything else shows its code. */
const ERRORS = {
  phase_mismatch: "Sai thứ tự: giai đoạn hiện tại không cho bước này.",
  freeze_too_early: "Chưa tới giờ khóa code.",
  games_pending: "Còn ván chưa chấm xong",
  not_enough_teams: "Không đủ đội qua vòng sơ loại để đấu vòng loại.",
  already_started: "Vòng loại đã bắt đầu.",
  not_started: "Vòng loại chưa bắt đầu.",
  not_swiss: "Vòng loại không phải Swiss.",
  swiss_complete: "Đã đủ số vòng Swiss.",
  swiss_unfinished: "Chưa đấu đủ số vòng Swiss.",
  interviews_pending: "Còn đội trong Top 4 chưa phỏng vấn.",
  knockout_not_possible: "Dưới 4 đội: không đấu loại trực tiếp, dùng \"Kết thúc không cần loại trực tiếp\".",
  knockout_expected: "Đủ đội để đấu loại trực tiếp: hãy bắt đầu loại trực tiếp.",
  already_answered: "Khiếu nại đã được trả lời.",
  reason_required: "Cần ghi lý do (ít nhất 3 ký tự).",
  read_only: "Tài khoản chỉ xem, không được ghi.",
  same_admin: "Người đề nghị không tự duyệt được.",
  already_notified: "Đã ghi nhận báo đội trước đó.",
  already_decided: "Việc này đã được quyết định.",
  forbidden_origin: "Yêu cầu bị chặn (origin). Hãy tải lại trang."
};

function errorText(error) {
  const base = ERRORS[error.message];
  if (!base) return `lỗi ${error.message}`;
  return error.detail?.pending ? `${base} (${error.detail.pending} ván).` : base;
}

async function api(method, path, body) {
  const response = await fetch(`${API}${path}`, {
    method,
    credentials: "same-origin",
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const type = response.headers.get("content-type") || "";
  const payload = type.includes("json") ? await response.json() : await response.text();
  if (!response.ok) {
    const error = new Error(payload?.error || `HTTP ${response.status}`);
    error.status = response.status;
    error.detail = typeof payload === "object" ? payload : null;
    throw error;
  }
  return payload;
}

/** Runs a write after asking for the reason that goes into the audit log. */
async function act(label, path, body = {}, { needsReason = true, confirmText } = {}) {
  if (confirmText && !window.confirm(confirmText)) return;
  let reason;
  if (needsReason) {
    reason = window.prompt(`${label}\nLý do (ghi vào audit log):`);
    if (!reason) return;
  }
  try {
    const result = await api("POST", path, { ...body, ...(reason ? { reason } : {}) });
    say(result?.pendingId ? `${label}: đã gửi, chờ admin thứ hai duyệt.` : `${label}: xong.`);
    await show(currentTab);
  } catch (error) {
    say(`${label}: ${errorText(error)}`, true);
  }
}

const writer = () => me?.role === "admin";

function table(headers, rows) {
  return h("div", { class: "table-wrap" }, h("table", {},
    h("thead", {}, h("tr", {}, headers.map((title) => h("th", { scope: "col" }, title)))),
    h("tbody", {}, rows.length ? rows : [h("tr", {}, h("td", { colspan: headers.length }, "Không có dữ liệu."))])
  ));
}

const badge = (text, kind) => h("span", { class: `badge ${kind ?? ""}` }, text);
const button = (label, onclick, kind) => (writer() ? h("button", { type: "button", class: kind, onclick }, label) : null);

// ---------- tabs ----------

const TABS = {
  async overview() {
    const data = await api("GET", "/overview");
    const card = (label, value, alert) => h("div", { class: `card${alert && value ? " alert" : ""}` }, h("strong", {}, value ?? 0), label);
    const sum = (object) => Object.values(object ?? {}).reduce((a, b) => a + b, 0);
    return h("section", {},
      h("h2", {}, data.event?.name ?? "Giải"),
      h("p", { class: "muted" }, `Chế độ: ${data.event?.mode} · Giờ máy chủ: ${time(data.serverTime)} · Khóa code: ${time(data.event?.codeFreezeAt)}`),
      h("div", { class: "cards" },
        card("Đội (mọi trạng thái)", sum(data.teams)),
        card("Đội đủ điều kiện", data.teams?.active ?? 0),
        card("Đội bị loại", data.disqualifiedTeams),
        card("Bài nộp 24 giờ qua", data.submissionsLast24h),
        card("Bài sẵn sàng", data.submissions?.ready ?? 0),
        card("Job đang chờ", data.jobs?.queued ?? 0),
        card("Job đang chạy", data.jobs?.leased ?? 0),
        card("Runner online", data.runnersOnline),
        card("Runner nghi vấn", data.alerts.suspectRunners, true),
        card("Job lỗi", data.alerts.failedJobs, true),
        card("Cờ chưa xử lý", data.alerts.openFlags, true),
        card("Chờ duyệt", data.alerts.pendingApprovals, true)
      ));
  },

  async teams() {
    const { teams } = await api("GET", "/teams");
    const detail = h("div");
    const open = async (id) => {
      const data = await api("GET", `/teams/${id}`);
      detail.replaceChildren(h("section", {},
        h("h2", {}, `${data.team.display_name} (${data.team.handle})`),
        data.team.disqualified_at ? h("p", {}, badge("Đã bị loại", "bad"), ` ${data.team.dq_reason}`) : null,
        table(["MSSV", "Họ tên", "Email", "Vai trò", "Trạng thái", ""], data.members.map((member) => h("tr", {},
          h("td", {}, member.mssv), h("td", {}, member.full_name), h("td", {}, member.email), h("td", {}, member.role),
          h("td", {}, member.status),
          h("td", {}, member.status === "pending" ? button("Xác minh tay", () => act("Xác minh thủ công", `/teams/${id}/members/${member.mssv}/confirm`)) : null)
        ))),
        h("h3", {}, "Bài nộp"),
        table(["Bản", "Ngôn ngữ", "Trạng thái", "SHA-256", "Nộp lúc"], data.submissions.map((s) => h("tr", {},
          h("td", {}, `v${s.seq}${s.id === data.finalSubmissionId ? " ★" : ""}`), h("td", {}, s.language), h("td", {}, s.status),
          h("td", {}, h("code", {}, s.sha256)), h("td", {}, time(s.created_at))
        )))
      ));
    };
    return h("div", {},
      h("section", {},
        h("h2", {}, `Đội (${teams.length})`),
        h("p", {}, h("a", { href: `${API}/export/teams.csv` }, "Xuất CSV đội và thành viên (có dữ liệu cá nhân, được ghi audit)")),
        table(["Tên đăng nhập", "Tên đội", "Loại", "Trạng thái", "TV", "Bài", ""], teams.map((team) => h("tr", {},
          h("td", {}, team.handle), h("td", {}, team.display_name), h("td", {}, team.kind),
          h("td", {}, team.disqualified_at ? badge("bị loại", "bad") : team.status), h("td", {}, team.members), h("td", {}, team.submissions),
          h("td", {}, h("div", { class: "row-actions" },
            h("button", { type: "button", class: "quiet", onclick: () => open(team.id) }, "Chi tiết"),
            button("Đổi tên", () => {
              const displayName = window.prompt("Tên đội mới:", team.display_name);
              if (displayName) act("Đổi tên đội", `/teams/${team.id}/rename`, { displayName });
            }, "quiet"),
            team.disqualified_at ? null : button("Loại đội", () => act("Loại đội (cần admin thứ hai duyệt)", `/teams/${team.id}/disqualify`, {}, { confirmText: `Đề nghị loại đội ${team.display_name}?` }), "danger")
          ))
        )))),
      detail);
  },

  async submissions() {
    const { submissions } = await api("GET", "/submissions");
    const source = h("div");
    return h("div", {}, h("section", {},
      h("h2", {}, `Bài nộp (${submissions.length} gần nhất)`),
      table(["Đội", "Bản", "File", "Trạng thái", "Cờ", "SHA-256", "Nộp lúc", ""], submissions.map((s) => h("tr", {},
        h("td", {}, s.display_name), h("td", {}, `v${s.seq}`), h("td", {}, s.filename),
        h("td", {}, s.status), h("td", {}, s.open_flags ? badge(String(s.open_flags), "bad") : "0"),
        h("td", {}, h("code", { title: s.sha256 }, short(s.sha256))), h("td", {}, time(s.created_at)),
        h("td", {}, h("div", { class: "row-actions" },
          h("button", { type: "button", class: "quiet", onclick: async () => {
            source.replaceChildren(h("section", {}, h("h2", {}, `${s.display_name} v${s.seq} — ${s.filename}`), h("pre", {}, await api("GET", `/submissions/${s.id}/source`))));
            source.scrollIntoView();
          } }, "Xem mã"),
          button("Kiểm tra lại", () => act("Kiểm tra lại bài nộp", `/submissions/${s.id}/recheck`), "quiet")
        ))
      )))), source);
  },

  async flags() {
    const status = flagStatus;
    const [{ flags }, { sets }, anomalies] = await Promise.all([api("GET", `/flags?status=${status}`), api("GET", "/anticheat/probes"), api("GET", "/anticheat/anomalies")]);
    const KIND = { hash: "Trùng chuẩn hóa", jplag: "JPlag", behavior: "Vân tay hành vi", collusion: "Thông đồng" };
    const percent = (value) => (value === null || value === undefined ? "—" : `${Math.round(value * 1000) / 10}%`);
    const detailsOf = (flag) => {
      try {
        return JSON.parse(flag.details || "{}");
      } catch {
        return {};
      }
    };
    const evidence = (flag) => {
      const details = detailsOf(flag);
      if (flag.kind === "behavior") return `${details.same}/${details.compared} thế cờ giống nhau`;
      if (flag.kind === "jplag") return `${details.tool || "JPlag"} · ${details.language || ""} · max ${percent(details.max)}`;
      if (flag.kind === "collusion") return details.note || "";
      return "Mã giống hệt sau khi bỏ chú thích, khoảng trắng và đổi tên";
    };
    const compare = h("div");
    const showCode = async (flag) => {
      const left = await api("GET", `/submissions/${flag.submission_id}/source`);
      const right = flag.other_submission_id ? await api("GET", `/submissions/${flag.other_submission_id}/source`) : `Kho tham chiếu công khai: ${flag.reference}`;
      const otherName = flag.other_team_name ? `${flag.other_team_name} v${flag.other_seq}` : flag.reference;
      compare.replaceChildren(h("section", {}, h("h2", {}, `So sánh: ${flag.team_name} v${flag.seq} ↔ ${otherName}`),
        h("div", { class: "compare" }, h("pre", {}, left), h("pre", {}, right))));
      compare.scrollIntoView();
    };
    const STATUS = { open: "Đang mở", confirmed: "Đã xác nhận", cleared: "Đã bỏ" };
    const filter = h("div", { class: "row-actions" }, Object.entries(STATUS).map(([value, label]) =>
      h("button", { type: "button", class: "quiet", "aria-pressed": String(value === status), onclick: () => { flagStatus = value; show("flags"); } }, label)));

    const jplagFile = h("input", { type: "file", accept: "application/json,.json", "aria-label": "Báo cáo JPlag (report.json)" });
    const importJplag = async () => {
      const file = jplagFile.files?.[0];
      if (!file) return say("Chọn file report.json do scripts/bot-cup/similarity.mjs tạo.", true);
      let report;
      try {
        report = JSON.parse(await file.text());
      } catch {
        return say("File không phải JSON.", true);
      }
      const reason = window.prompt("Nhập báo cáo JPlag\nLý do (ghi vào audit log):", "JPlag sau khóa code");
      if (!reason) return;
      try {
        const result = await api("POST", "/anticheat/jplag", { report, reason });
        say(`Đã nhập ${result.pairs} cặp: ${result.flags} cờ mới, ${result.skipped} cờ đã có.`);
        await show("flags");
      } catch (error) {
        say(`Nhập báo cáo: ${errorText(error)}`, true);
      }
    };
    const probeSet = h("input", { name: "probeSet", placeholder: "SHA-256 của file bộ thế cờ (64 ký tự hex)", "aria-label": "SHA-256 bộ thế cờ", size: 66 });
    const probeScope = h("select", { "aria-label": "Phạm vi" }, h("option", { value: "sealed" }, "Bài niêm phong"), h("option", { value: "final" }, "Bản thi đấu hiện tại"));
    const ANOMALY = { behaviour_twin: "Vân tay gần trùng", thrown_game: "Thua bất thường", practice_upset: "Lệch phong độ luyện tập" };
    const anomalyDetail = (row) => {
      if (row.kind === "behaviour_twin") return `${percent(row.ratio)} trên ${row.compared} thế cờ`;
      if (row.kind === "thrown_game") return `Trận ${row.matchId} (${row.stage}): thua do ${row.reason} sau ${row.plies} nước; với đối thủ khác đạt ${percent(row.shareElsewhere)} điểm (${row.gamesElsewhere} ván)`;
      return `Luyện tập ${percent(row.practiceRate)} so với ${percent(row.opponentPracticeRate)}, nhưng chỉ lấy ${percent(row.share)} điểm cặp này (${row.games} ván)`;
    };

    return h("div", {},
      h("section", {},
        h("h2", {}, `Cờ nghi vấn (${flags.length})`),
        h("p", { class: "muted" }, "Cờ chỉ là nghi vấn. Quy trình (plan §8.8): hai BTC xem mã và replay → báo đội, cho 48 giờ giải trình → quyết định có lý do. Xác nhận vi phạm cần admin thứ hai duyệt ở tab Chờ duyệt."),
        filter,
        table(["Loại", "Đội", "Trùng với", "Mức giống", "Bằng chứng", "Báo đội", ""], flags.map((flag) => h("tr", {},
          h("td", {}, KIND[flag.kind] ?? flag.kind), h("td", {}, `${flag.team_name} v${flag.seq}`),
          h("td", {}, flag.reference ? h("code", {}, flag.reference) : `${flag.other_team_name} v${flag.other_seq}`),
          h("td", {}, percent(flag.score), detailsOf(flag).priority ? [" ", badge("ưu tiên", "bad")] : null),
          h("td", {}, evidence(flag)),
          h("td", {}, flag.notified_at ? `${time(flag.notified_at)} · hạn giải trình ${time(flag.notified_at + 48 * 3600 * 1000)}` : "chưa"),
          h("td", {}, h("div", { class: "row-actions" },
            h("button", { type: "button", class: "quiet", onclick: () => showCode(flag).catch((error) => say(`Xem mã: ${errorText(error)}`, true)) }, "Xem mã"),
            flag.notified_at ? null : button("Đã báo đội", () => act("Đã báo đội (bắt đầu 48 giờ giải trình)", `/flags/${flag.id}/notify`), "quiet"),
            flag.status === "open" ? button("Bỏ cờ", () => act("Bỏ cờ", `/flags/${flag.id}`, { status: "cleared" }), "quiet") : null,
            flag.status === "open" ? button("Xác nhận vi phạm", () => act("Xác nhận vi phạm (cần admin thứ hai duyệt)", `/flags/${flag.id}`, { status: "confirmed" }), "danger") : null
          ))
        )))),
      compare,
      h("section", {},
        h("h2", {}, "JPlag (so mã cùng ngôn ngữ)"),
        h("ol", {},
          h("li", {}, "Tải gói mã: ", h("a", { href: `${API}/anticheat/export?scope=sealed` }, "bài niêm phong"), " · ",
            h("a", { href: `${API}/anticheat/export?scope=final` }, "Bản thi đấu hiện tại"), " (có ghi audit)."),
          h("li", {}, "Trên máy BTC: ", h("code", {}, "npm run bot-cup:similarity -- --bundle <file vừa tải>")),
          h("li", {}, "Nhập report.json: cặp ≥ 70% thành cờ, ≥ 85% đánh dấu ưu tiên.")),
        writer() ? h("div", { class: "row-actions" }, jplagFile, h("button", { type: "button", onclick: importJplag }, "Nhập báo cáo JPlag")) : null),
      h("section", {},
        h("h2", {}, "Vân tay hành vi (bắt cả bản dịch sang ngôn ngữ khác)"),
        h("p", { class: "muted" }, "Bộ thế cờ bí mật chỉ nằm trên máy runner (", h("code", {}, "npm run bot-cup:probe-set"),
          "); ở đây chỉ nhập SHA-256 của file. Runner cho từng bot và ai.js easy/medium/hard chọn nước; ≥ 90% nước giống nhau thì gắn cờ."),
        writer() ? h("div", { class: "row-actions" }, probeSet, probeScope, h("button", { type: "button", onclick: () => {
          if (!/^[0-9a-f]{64}$/.test(probeSet.value.trim())) return say("SHA-256 phải gồm 64 ký tự 0-9 a-f.", true);
          act("Xếp job vân tay hành vi", "/anticheat/probes", { probeSet: probeSet.value.trim(), scope: probeScope.value });
        } }, "Xếp job vân tay")) : null,
        table(["Bộ thế cờ", "Job", "Xong", "Đang chờ", "Lỗi", "Vân tay", "Bắt đầu"], sets.map((set) => h("tr", {},
          h("td", {}, h("code", { title: set.probe_set }, short(set.probe_set, 12))), h("td", {}, set.jobs), h("td", {}, set.done), h("td", {}, set.pending),
          h("td", {}, set.failed ? badge(String(set.failed), "bad") : "0"), h("td", {}, set.fingerprints), h("td", {}, time(set.started_at))
        )))),
      h("section", {},
        h("h2", {}, "Bất thường kết quả (§8.7)"),
        h("p", { class: "muted" }, `Gợi ý để xem replay, không phải kết luận. Vân tay theo bộ ${anomalies.probeSet ? short(anomalies.probeSet, 12) : "— (chưa có)"}.`),
        table(["Loại", "Đội", "Đối thủ", "Chi tiết", ""], anomalies.rows.map((row) => h("tr", {},
          h("td", {}, ANOMALY[row.kind] ?? row.kind), h("td", {}, row.teamName), h("td", {}, row.opponentName), h("td", {}, anomalyDetail(row)),
          h("td", {}, button("Gắn cờ thông đồng", () => act("Gắn cờ thông đồng", "/anticheat/collusion", { teamId: row.team, opponentId: row.opponent, note: `${ANOMALY[row.kind]}: ${anomalyDetail(row)}` }), "quiet"))
        )))));
  },

  async matches() {
    const { matches } = await api("GET", "/matches");
    return h("section", {},
      h("h2", {}, `Trận (${matches.length} gần nhất)`),
      h("p", {}, h("a", { href: `${API}/export/results.csv` }, "Xuất CSV kết quả")),
      table(["Giai đoạn", "Vòng", "Bản đồ", "Đỏ (A)", "Xanh (B)", "Trạng thái", "Kết quả", ""], matches.map((match) => h("tr", {},
        h("td", {}, match.stage), h("td", {}, match.round ?? "—"), h("td", {}, match.map_id),
        h("td", {}, match.a_name), h("td", {}, match.b_name), h("td", {}, match.status),
        h("td", {}, match.outcome ? `${match.outcome} ${match.winner ?? ""} · ${match.reason ?? ""} · ${match.plies ?? 0} nước` : "—"),
        h("td", {}, h("div", { class: "row-actions" },
          button("Chạy lại", () => act("Chạy lại trận", `/matches/${match.id}/rerun`), "quiet"),
          button("Sửa kết quả", () => {
            const answer = window.prompt("Kết quả mới: A (Đỏ thắng), B (Xanh thắng) hoặc D (hòa)");
            if (!answer) return;
            const value = answer.trim().toUpperCase();
            const body = value === "D" ? { outcome: "draw" } : { outcome: "win", winner: value === "A" ? "A" : "B" };
            act("Sửa kết quả (cần admin thứ hai duyệt)", `/matches/${match.id}/result`, body);
          }, "danger")
        ))
      ))));
  },

  async tournament() {
    const data = await api("GET", "/tournament");
    const PHASE_LABEL = { registration: "Đăng ký / luyện tập", practice: "Luyện tập", frozen: "Đã khóa code", gate: "Vòng sơ loại", qualifying: "Vòng loại", verification: "Phỏng vấn code", knockout: "Loại trực tiếp", finished: "Đã kết thúc" };
    const STEPS = {
      registration: [["freeze", "Khóa code và niêm phong"]],
      practice: [["freeze", "Khóa code và niêm phong"]],
      frozen: [["gate-start", "Bắt đầu vòng sơ loại"]],
      gate: [["gate-close", "Chốt vòng sơ loại"]],
      qualifying: [["qualifying-start", "Bắt đầu vòng loại"], ["swiss-next", "Tạo vòng Swiss kế tiếp"], ["qualifying-close", "Chốt vòng loại"]],
      verification: [["knockout-start", "Bắt đầu loại trực tiếp"], ["finish", "Kết thúc không cần loại trực tiếp"]],
      knockout: [["knockout-advance", "Chốt vòng loại trực tiếp hiện tại"]],
      finished: []
    };
    const steps = (STEPS[data.phase] ?? []).map(([step, label]) =>
      button(label, () => act(label, `/tournament/${step}`, {}, { confirmText: `${label}? Bước này ghi vào audit log và không hoàn tác được.` })));
    const sha = (value) => h("code", { title: value ?? "" }, short(value, 16));
    const interview = data.interviews;
    const waiting = new Set(interview?.waitingFor ?? []);
    const seeded = new Set(interview?.seeded ?? []);
    const sections = [
      h("section", {},
        h("h2", {}, "Điều phối giải"),
        h("p", {}, "Giai đoạn: ", badge(PHASE_LABEL[data.phase] ?? data.phase, "ok"), ` · Chế độ: ${data.mode} · Khóa code: ${time(data.codeFreezeAt)}`),
        steps.length ? h("div", { class: "row-actions" }, steps) : h("p", { class: "muted" }, "Không còn bước nào."),
        h("p", { class: "muted" }, "Mỗi bước kiểm tra giai đoạn và chờ mọi ván của giai đoạn trước kết thúc; máy chủ từ chối nếu chưa đủ điều kiện.")),
      h("section", {},
        h("h3", {}, `Bài niêm phong (${data.entrants.length})`),
        table(["Đội", "Bản", "Ngôn ngữ", "SHA-256", "Sơ loại", "Hạt giống", "Phỏng vấn"], data.entrants.map((entrant) => h("tr", {},
          h("td", {}, entrant.team, entrant.disqualified ? [" ", badge("bị loại", "bad")] : null), h("td", {}, entrant.version), h("td", {}, entrant.language),
          h("td", {}, sha(entrant.sha256)),
          h("td", {}, entrant.gateStatus ? `${entrant.gatePoints} điểm · ${entrant.gateStatus === "qualified" ? "đạt" : "không đạt"}` : "—"),
          h("td", {}, entrant.seed ?? "—"), h("td", {}, entrant.interview ?? "—")
        ))))
    ];
    if (data.gateProgress.length && data.phase === "gate") {
      sections.push(h("section", {}, h("h3", {}, "Tiến độ sơ loại"),
        table(["Đội", "Đã chơi", "Kết quả"], data.gateProgress.map((row) => h("tr", {},
          h("td", {}, row.team), h("td", {}, `${row.played}/6`),
          h("td", {}, row.verdict ? `${row.verdict.points} điểm · ${row.verdict.status === "qualified" ? "đạt" : "không đạt"}` : "đang chơi")
        )))));
    }
    if (data.standings.format) {
      sections.push(h("section", {}, h("h3", {}, `Bảng xếp hạng vòng loại (${data.standings.format === "round_robin" ? "vòng tròn" : "Swiss"})`),
        table(["Hạng", "Đội", "Điểm", "Ván thắng", "Số ván", "SB", "Buchholz-1", "Phỏng vấn", ""], data.standings.rows.map((row) => h("tr", {},
          h("td", {}, row.rank), h("td", {}, row.displayName), h("td", {}, row.points), h("td", {}, row.wins), h("td", {}, row.games),
          h("td", {}, row.sb ?? "—"), h("td", {}, row.buchholzCut1 ?? "—"),
          h("td", {}, seeded.has(row.teamId) ? badge("vào Top 4", "ok") : waiting.has(row.teamId) ? badge("cần phỏng vấn", "warn") : (data.entrants.find((e) => e.teamId === row.teamId)?.interview ?? "—")),
          h("td", {}, data.phase === "verification" ? h("div", { class: "row-actions" },
            button("Đạt", () => act(`Phỏng vấn ${row.displayName}: đạt`, "/tournament/interview", { teamId: row.teamId, result: "pass" })),
            button("Không đạt", () => act(`Phỏng vấn ${row.displayName}: không đạt`, "/tournament/interview", { teamId: row.teamId, result: "fail" }), "danger")
          ) : null)
        )))));
    }
    if (data.knockout.length) {
      sections.push(h("section", {}, h("h3", {}, "Loại trực tiếp"),
        table(["Vòng", "Cặp", "Đỏ (hạt giống)", "Xanh (hạt giống)", "Điểm", "Tie-break", "Ván", "Thắng"], data.knockout.map((pairing) => h("tr", {},
          h("td", {}, pairing.round), h("td", {}, pairing.slot),
          h("td", {}, `${pairing.red} (${pairing.seeds[0]})`), h("td", {}, `${pairing.blue} (${pairing.seeds[1]})`),
          h("td", {}, `${pairing.points[0]} – ${pairing.points[1]}`), h("td", {}, pairing.tiebreaks),
          h("td", {}, `${pairing.games.filter((game) => game.status === "finished").length}/${pairing.games.length}`),
          h("td", {}, pairing.winner ? `${pairing.winner}${pairing.decidedBySeed ? " (hạt giống cao hơn)" : ""}` : "—")
        )))));
    }
    sections.push(h("section", {}, h("h3", {}, "Kết quả đã công bố"),
      table(["Giai đoạn", "SHA-256", "Lúc", ""], data.documents.map((doc) => h("tr", {},
        h("td", {}, doc.stage), h("td", {}, h("code", {}, doc.sha256)), h("td", {}, time(doc.published_at)),
        h("td", {}, h("a", { href: `${API}/tournament/results/${doc.stage}`, target: "_blank", rel: "noopener" }, "Tải JSON"))
      )))));
    sections.push(h("section", {}, h("h3", {}, `Khiếu nại (${data.appeals.filter((item) => item.status === "open").length} chưa trả lời)`),
      table(["Đội", "Giai đoạn", "Nội dung", "Lúc", "Trả lời", ""], data.appeals.map((item) => h("tr", {},
        h("td", {}, item.display_name), h("td", {}, item.stage), h("td", {}, item.body), h("td", {}, time(item.created_at)),
        h("td", {}, item.response ? `${item.response} · ${item.answered_by}` : badge("chưa trả lời", "warn")),
        h("td", {}, item.status === "open" ? button("Trả lời", async () => {
          const response = window.prompt(`Trả lời khiếu nại của ${item.display_name}:`);
          if (!response) return;
          try {
            await api("POST", `/tournament/appeals/${item.id}/answer`, { response });
            say("Đã trả lời khiếu nại.");
            await show("tournament");
          } catch (error) {
            say(`Lỗi: ${error.message}`, true);
          }
        }) : null)
      )))));
    return h("div", {}, sections);
  },

  async pending() {
    const { pending } = await api("GET", "/pending");
    return h("section", {},
      h("h2", {}, "Chờ duyệt (quy tắc hai người)"),
      table(["Việc", "Đối tượng", "Lý do", "Người đề nghị", "Lúc", "Trạng thái", ""], pending.map((item) => h("tr", {},
        h("td", {}, item.action), h("td", {}, item.target), h("td", {}, item.reason), h("td", {}, item.requested_by),
        h("td", {}, time(item.requested_at)),
        h("td", {}, item.status === "pending" ? badge("chờ", "warn") : `${item.status} · ${item.decided_by}`),
        h("td", {}, item.status === "pending" && item.requested_by !== me.email ? h("div", { class: "row-actions" },
          button("Duyệt", () => act("Duyệt", `/pending/${item.id}/approve`, {}, { needsReason: false, confirmText: `Duyệt: ${item.action} ${item.target}?` })),
          button("Từ chối", () => act("Từ chối", `/pending/${item.id}/reject`), "quiet")
        ) : null)
      ))));
  },

  async runners() {
    const [{ runners }, { jobs }] = await Promise.all([api("GET", "/runners"), api("GET", "/jobs?status=failed")]);
    return h("div", {},
      h("section", {},
        h("h2", {}, "Runner"),
        table(["Tên", "Trạng thái", "Lần cuối", "Image", "Slot", "Nghi vấn", ""], runners.map((runner) => h("tr", {},
          h("td", {}, runner.name),
          h("td", {}, runner.revoked_at ? badge("thu hồi", "bad") : runner.online ? badge("online", "ok") : badge("offline", "warn")),
          h("td", {}, time(runner.last_seen_at)), h("td", {}, h("code", {}, short(runner.image_id, 19))),
          h("td", {}, `${runner.active ?? 0}/${runner.slots ?? 0}`), h("td", {}, runner.suspect_reason ?? "—"),
          h("td", {}, h("div", { class: "row-actions" },
            runner.suspect_at ? button("Bỏ nghi vấn", () => act("Bỏ nghi vấn runner", `/runners/${runner.id}/clear-suspect`), "quiet") : null,
            runner.revoked_at ? null : button("Thu hồi", () => act("Thu hồi runner", `/runners/${runner.id}/revoke`, {}, { confirmText: `Thu hồi token của ${runner.name}?` }), "danger")
          ))
        )))),
      h("section", {},
        h("h2", {}, `Job lỗi (${jobs.length})`),
        table(["Loại", "Giai đoạn", "Lần chạy", "Lỗi cuối", "Cập nhật", ""], jobs.map((job) => h("tr", {},
          h("td", {}, job.kind), h("td", {}, job.stage ?? "check"), h("td", {}, job.attempts), h("td", {}, h("code", {}, job.last_error ?? "")),
          h("td", {}, time(job.updated_at)), h("td", {}, button("Đưa lại hàng đợi", () => act("Đưa job lại hàng đợi", `/jobs/${job.id}/requeue`), "quiet"))
        )))));
  },

  async announcements() {
    const { announcements } = await api("GET", "/announcements");
    const form = writer() ? h("form", { onsubmit: async (event) => {
      event.preventDefault();
      const data = new FormData(event.target);
      try {
        await api("POST", "/announcements", { title: data.get("title"), body: data.get("body"), publish: data.get("publish") === "on" });
        say("Đã tạo thông báo.");
        await show("announcements");
      } catch (error) {
        say(`Lỗi: ${error.message}`, true);
      }
    } },
      h("label", {}, "Tiêu đề", h("input", { name: "title", required: true, maxlength: 120 })),
      h("label", {}, "Nội dung", h("textarea", { name: "body", required: true, rows: 4, maxlength: 4000 })),
      h("label", {}, h("input", { type: "checkbox", name: "publish" }), " Đăng ngay"),
      h("button", { type: "submit" }, "Tạo thông báo")) : null;
    return h("section", {},
      h("h2", {}, "Thông báo cho người chơi"), form,
      table(["Tiêu đề", "Nội dung", "Trạng thái", ""], announcements.map((item) => h("tr", {},
        h("td", {}, item.title), h("td", {}, item.body),
        h("td", {}, item.withdrawn_at ? "đã gỡ" : item.published_at ? `đăng ${time(item.published_at)}` : "nháp"),
        h("td", {}, item.published_at && !item.withdrawn_at
          ? button("Gỡ", () => act("Gỡ thông báo", `/announcements/${item.id}/withdraw`, {}, { needsReason: false }), "quiet")
          : button("Đăng", () => act("Đăng thông báo", `/announcements/${item.id}/publish`, {}, { needsReason: false })))
      ))));
  },

  async audit() {
    const [{ rows }, check] = await Promise.all([api("GET", "/audit"), api("GET", "/audit/verify")]);
    return h("section", {},
      h("h2", {}, "Audit log"),
      h("p", {}, check.ok ? badge(`Chuỗi băm hợp lệ · ${check.rows} dòng · đầu chuỗi ${short(check.head, 16)}`, "ok") : badge(`Chuỗi băm SAI ở dòng ${check.seq} (${check.error})`, "bad")),
      table(["#", "Lúc", "Ai", "Việc", "Đối tượng", "Lý do", "Hash"], rows.map((row) => h("tr", {},
        h("td", {}, row.seq), h("td", {}, time(row.at)), h("td", {}, row.actor_email), h("td", {}, row.action),
        h("td", {}, row.target ?? ""), h("td", {}, row.reason ?? ""), h("td", {}, h("code", { title: row.hash }, short(row.hash)))
      ))));
  }
};

async function show(tab) {
  currentTab = tab;
  for (const button of document.querySelectorAll("[data-tab]")) button.setAttribute("aria-pressed", String(button.dataset.tab === tab));
  try {
    view.replaceChildren(await TABS[tab]());
  } catch (error) {
    if (error.status === 401) return start();
    say(`Không tải được: ${error.message}`, true);
  }
}

async function start() {
  try {
    me = await api("GET", "/me");
  } catch (error) {
    if (error.status === 401 || error.status === 403) {
      document.getElementById("app").hidden = true;
      document.getElementById("login").hidden = false;
      say(error.status === 403 ? "Tài khoản này không phải BTC." : "");
      return;
    }
    say(`Không kết nối được API: ${error.message}`, true);
    return;
  }
  document.getElementById("login").hidden = true;
  document.getElementById("app").hidden = false;
  document.getElementById("who").textContent = `${me.email} · ${me.role === "admin" ? "admin" : "chỉ xem"}`;
  document.getElementById("logout").hidden = me.authMode !== "password";
  await show(currentTab);
}

document.getElementById("login-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const data = new FormData(event.target);
  try {
    await api("POST", "/login", { email: data.get("email"), password: data.get("password"), totp: data.get("totp") });
    event.target.reset();
    await start();
  } catch (error) {
    say(error.message === "login_locked" ? "Sai quá nhiều lần, thử lại sau 15 phút." : "Sai email, mật khẩu hoặc mã TOTP.", true);
  }
});
document.getElementById("logout").addEventListener("click", async () => {
  await api("POST", "/logout", {}).catch(() => {});
  me = null;
  await start();
});
for (const button of document.querySelectorAll("[data-tab]")) button.addEventListener("click", () => show(button.dataset.tab));

start();
