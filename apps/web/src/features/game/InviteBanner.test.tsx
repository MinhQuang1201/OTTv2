// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InviteBanner } from "./InviteBanner";

afterEach(() => cleanup());

describe("InviteBanner", () => {
  it("shows the short code and copies the code or the invite link", async () => {
    const user = userEvent.setup();
    const copyText = vi.fn(async () => undefined);
    const onCopied = vi.fn();
    render(<InviteBanner code="K7N-M4P" link="https://ottv2.example/?join=K7N-M4P" copyText={copyText} onCopied={onCopied} />);

    expect(screen.getByTestId("room-alias")).toHaveTextContent("K7N-M4P");
    await user.click(screen.getByRole("button", { name: "Sao chép mã" }));
    expect(copyText).toHaveBeenLastCalledWith("K7N-M4P");
    expect(onCopied).toHaveBeenLastCalledWith("Đã sao chép mã phòng.", true);

    await user.click(screen.getByRole("button", { name: "Sao chép link mời" }));
    expect(copyText).toHaveBeenLastCalledWith("https://ottv2.example/?join=K7N-M4P");
  });

  it("tells the player to copy by hand when the clipboard is blocked", async () => {
    const user = userEvent.setup();
    const onCopied = vi.fn();
    render(<InviteBanner code="K7N-M4P" link="https://ottv2.example/?join=K7N-M4P" copyText={async () => { throw new Error("denied"); }} onCopied={onCopied} />);

    await user.click(screen.getByRole("button", { name: "Sao chép mã" }));
    expect(onCopied).toHaveBeenLastCalledWith("Không sao chép được mã phòng. Hãy chép thủ công: K7N-M4P", false);
  });
});
