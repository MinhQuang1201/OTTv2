import { Button } from "../../shared/ui/Button";
import { Dialog } from "../../shared/ui/Dialog";

export function ConfirmLeaveDialog({ open, onCancel, onConfirm }: { readonly open: boolean; readonly onCancel: () => void; readonly onConfirm: () => void }) {
  return <Dialog open={open} title="Rời bàn?" ariaLabel="Rời bàn" closeLabel="Đóng xác nhận rời bàn" onClose={onCancel}>
    <p>Rời bàn có thể khiến bạn thua ngay lập tức. Bạn vẫn muốn rời ván đấu?</p>
    <div style={{ display: "flex", gap: "var(--ui-space-3)", justifyContent: "flex-end" }}><Button variant="quiet" onClick={onCancel}>Ở lại</Button><Button variant="danger" onClick={onConfirm}>Xác nhận rời bàn</Button></div>
  </Dialog>;
}
