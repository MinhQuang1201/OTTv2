import type { BotCupEvent } from "./BotCupApiGateway";
import { formatDateTime } from "./botCupFormat";
import styles from "./botCup.module.css";

/** Event description, rules, schedule and FAQ (plan §6.3, §7, §8). Content for players; keep it short and concrete. */

export function BotCupAbout({ event }: { readonly event: BotCupEvent }) {
  const demo = event.mode === "demo";
  return (
    <section className={styles.prose} aria-labelledby="bot-cup-about">
      <h2 id="bot-cup-about">Giới thiệu</h2>
      <p>
        Mỗi đội viết một <strong>bot</strong> chơi Oẳn Tù Tì 9×9. Ban tổ chức cho các bot đấu với nhau trên máy chủ của giải; không ai
        điều khiển nước đi bằng tay. Bot mạnh nhất vô địch.
      </p>
      <ul>
        <li>{demo ? "Bản thử nghiệm: sinh viên mọi khóa đều tham gia được." : "Dành cho sinh viên K71 UET (MSSV bắt đầu bằng 26), xác minh bằng email MSSV@vnu.edu.vn."}</li>
        <li>Thi cá nhân hoặc theo nhóm 2–3 người; mỗi sinh viên chỉ thuộc một đội.</li>
        <li>Bot viết bằng Python 3.12 hoặc JavaScript (Node 22), một file, tối đa 200 KB.</li>
        <li>Được dùng trợ lý AI khi viết code, nhưng đội phải hiểu và giải thích được code của mình.</li>
      </ul>
    </section>
  );
}

export function BotCupRules({ event }: { readonly event: BotCupEvent }) {
  const demo = event.mode === "demo";
  return (
    <section className={styles.prose} aria-labelledby="bot-cup-rules">
      <h2 id="bot-cup-rules">Thể lệ</h2>
      <h3>Các giai đoạn</h3>
      <ol>
        <li><strong>Đăng ký:</strong> lập đội, xác minh email.</li>
        <li><strong>Luyện tập:</strong> nộp bài (tối đa 10 lần/ngày), đấu thử với bot của Ban tổ chức.</li>
        <li><strong>Khóa code:</strong> Bản thi đấu của đội được niêm phong. <strong>Không được nộp lại</strong>, kể cả trước chung kết.</li>
        <li><strong>Vòng kiểm tra:</strong> mỗi bot đấu 6 ván với bot "Dễ"; cần ít nhất 4 điểm để vào vòng loại.</li>
        <li><strong>Vòng loại:</strong> {demo ? "vòng tròn, mỗi cặp đấu 6 ván (3 bản đồ × 2 màu)." : "hệ Thụy Sĩ 7–10 vòng, mỗi vòng một cặp đấu 2 ván đổi màu."}</li>
        <li><strong>Chung kết:</strong> {demo ? "Top 4" : "Top 16"} thi loại trực tiếp, mỗi cặp 6 ván. Top 4 phỏng vấn code với Ban tổ chức.</li>
      </ol>
      <h3>Một ván</h3>
      <ul>
        <li>Thắng 1 điểm, hòa 0,5, thua 0. Quá 300 nước chưa ai thắng thì hòa.</li>
        <li>Mỗi nước tối đa 500 ms, tổng quỹ 30 giây mỗi bot mỗi ván. Nước đầu tiên được tới 5 giây (gồm khởi động) và không trừ quỹ.</li>
        <li>Bot quá giờ, crash, in sai giao thức hoặc đi nước không hợp lệ thì thua ván đó.</li>
        <li>Lỗi do máy chủ (không phải do bot) thì ván được chạy lại.</li>
      </ul>
      <h3>Bot</h3>
      <ul>
        <li>Mỗi lượt bot nhận một dòng JSON gồm bàn cờ và danh sách nước hợp lệ, rồi trả một dòng JSON chọn nước. Log ghi ra stderr.</li>
        <li>Chỉ dùng thư viện chuẩn; bot chạy trong sandbox không có mạng, 1 CPU, 256 MiB RAM.</li>
        <li>Mã phải đọc được: cấm làm rối mã, cấm nhúng mã nhị phân hay payload mã hóa.</li>
      </ul>
      <h3>Chống gian lận</h3>
      <ul>
        <li>Cấm chép code của đội khác hoặc nộp lại bot có sẵn của trò chơi (<code>ai.js</code>, bot mẫu). Hệ thống so trùng mã và so cách chọn nước.</li>
        <li>Cấm thông đồng giữa các đội (ví dụ bot nhận ra nhau rồi cố ý thua), cấm một người đứng nhiều đội, cấm tấn công hệ thống.</li>
        <li>Vi phạm nặng bị loại khỏi giải. Khiếu nại trong 24 giờ sau khi công bố kết quả vòng.</li>
      </ul>
    </section>
  );
}

export function BotCupSchedule({ event }: { readonly event: BotCupEvent }) {
  const rows: Array<[string, number | null]> = [
    ["Mở đăng ký", event.registrationOpensAt],
    ["Đóng đăng ký", event.registrationClosesAt],
    ["Mở nộp bài và luyện tập", event.practiceOpensAt],
    ["Khóa code", event.codeFreezeAt],
    ["Chung kết", event.finalsAt],
  ];
  return (
    <section className={styles.prose} aria-labelledby="bot-cup-schedule">
      <h2 id="bot-cup-schedule">Lịch</h2>
      <table className={styles.schedule}>
        <tbody>
          {rows.map(([label, at]) => (
            <tr key={label}>
              <th scope="row">{label}</th>
              <td>{at ? formatDateTime(at) : "Sắp công bố"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

export function BotCupFaq() {
  const items: Array<[string, string]> = [
    ["Không nhận được mã xác minh?", "Xem cả mục Thư rác / Junk. Mã hết hạn sau 10 phút; bấm \"Gửi lại mã\" (tối đa 3 lần mỗi giờ)."],
    ["Cả đội dùng chung tài khoản?", "Đúng. Đội đăng nhập bằng một tên đăng nhập và mật khẩu chung. Mọi thành viên đã xác nhận đều đặt lại mật khẩu được."],
    ["Đổi thành viên được không?", "Được, cho tới khi đóng đăng ký. Sau đó thành viên đội bị khóa."],
    ["Python có thiệt so với JavaScript?", "Giới hạn tính theo thời gian, như nhau cho mọi ngôn ngữ. Bot Python chậm hơn nên cần thuật toán gọn hơn."],
    ["MSSV và email của tôi có bị công khai?", "Không. Trang giải chỉ hiện tên đội, và họ tên nếu bạn đồng ý."],
  ];
  return (
    <section className={styles.prose} aria-labelledby="bot-cup-faq">
      <h2 id="bot-cup-faq">Hỏi đáp</h2>
      <dl className={styles.faq}>
        {items.map(([question, answer]) => (
          <div key={question}>
            <dt>{question}</dt>
            <dd>{answer}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
