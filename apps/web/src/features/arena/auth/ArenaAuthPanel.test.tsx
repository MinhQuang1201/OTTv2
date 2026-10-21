// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ArenaAuthPanel } from "./ArenaAuthPanel";

describe("ArenaAuthPanel", () => {
  afterEach(cleanup);
  it("does not submit registration when passwords do not match", async () => {
    const user = userEvent.setup();
    const onRegister = vi.fn();
    render(<ArenaAuthPanel registrationEnabled onLogin={vi.fn()} onRegister={onRegister} />);

    await user.click(screen.getByRole("tab", { name: /Đăng ký/i }));
    await user.type(screen.getByLabelText(/Tên đăng nhập/i), "demo_user");
    await user.type(screen.getByLabelText(/^Mật khẩu$/i), "password123");
    await user.type(screen.getByLabelText(/Xác nhận mật khẩu/i), "different123");
    await user.click(screen.getByRole("button", { name: /Tạo tài khoản/i }));

    expect(onRegister).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent(/không khớp/i);
  });

  it("moves to login with the normalized username after token-free registration", async () => {
    const user = userEvent.setup();
    const onRegister = vi.fn().mockResolvedValue({
      user: { id: "u-1", username: "demo_user", role: "author" }
    });
    render(<ArenaAuthPanel registrationEnabled onLogin={vi.fn()} onRegister={onRegister} />);

    await user.click(screen.getByRole("tab", { name: /Đăng ký/i }));
    await user.type(screen.getByLabelText(/Tên đăng nhập/i), " Demo_User ");
    await user.type(screen.getByLabelText(/^Mật khẩu$/i), "password123");
    await user.type(screen.getByLabelText(/Xác nhận mật khẩu/i), "password123");
    await user.click(screen.getByRole("button", { name: /Tạo tài khoản/i }));

    expect(onRegister).toHaveBeenCalledWith({ username: "Demo_User", password: "password123" });
    expect(await screen.findByText(/Tài khoản đã tạo/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Tên đăng nhập/i)).toHaveValue("demo_user");
    expect(screen.getByRole("button", { name: /Đăng nhập/i })).toBeInTheDocument();
  });

  it("displays server error on registration failure without clearing username", async () => {
    const user = userEvent.setup();
    const onRegister = vi.fn().mockRejectedValue(new Error("Tên người dùng đã được sử dụng."));
    render(<ArenaAuthPanel registrationEnabled onLogin={vi.fn()} onRegister={onRegister} />);

    await user.click(screen.getByRole("tab", { name: /Đăng ký/i }));
    await user.type(screen.getByLabelText(/Tên đăng nhập/i), "existing_user");
    await user.type(screen.getByLabelText(/^Mật khẩu$/i), "password123");
    await user.type(screen.getByLabelText(/Xác nhận mật khẩu/i), "password123");
    await user.click(screen.getByRole("button", { name: /Tạo tài khoản/i }));

    expect(onRegister).toHaveBeenCalledWith({ username: "existing_user", password: "password123" });
    expect(await screen.findByText("Tên người dùng đã được sử dụng.")).toBeInTheDocument();
    expect(screen.getByLabelText(/Tên đăng nhập/i)).toHaveValue("existing_user");
  });

  it("does not display registration tab when registrationEnabled is false", () => {
    render(<ArenaAuthPanel registrationEnabled={false} onLogin={vi.fn()} onRegister={vi.fn()} />);

    expect(screen.getByRole("tab", { name: /Đăng nhập/i })).toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: /Đăng ký/i })).not.toBeInTheDocument();
  });

  it("submits login with trimmed username", async () => {
    const user = userEvent.setup();
    const onLogin = vi.fn();
    render(<ArenaAuthPanel onLogin={onLogin} onRegister={vi.fn()} />);

    await user.type(screen.getByLabelText(/Tên đăng nhập/i), "  alice  ");
    await user.type(screen.getByLabelText(/^Mật khẩu$/i), "secret456");
    await user.click(screen.getByRole("button", { name: /Đăng nhập/i }));

    expect(onLogin).toHaveBeenCalledWith({ username: "alice", password: "secret456" });
  });

  it("disables inputs and buttons during pending state", () => {
    render(<ArenaAuthPanel pending registrationEnabled onLogin={vi.fn()} onRegister={vi.fn()} />);

    expect(screen.getByLabelText(/Tên đăng nhập/i)).toBeDisabled();
    expect(screen.getByLabelText(/^Mật khẩu$/i)).toBeDisabled();
    expect(screen.getByRole("button", { name: /Đang xử lý\.\.\./i })).toBeDisabled();
  });

  it("disables controls and prevents multiple submissions during pending register", async () => {
    const user = userEvent.setup();
    let resolveRegister!: (val: any) => void;
    const registerPromise = new Promise((resolve) => { resolveRegister = resolve; });
    const onRegister = vi.fn().mockImplementation(() => registerPromise);

    render(<ArenaAuthPanel registrationEnabled onLogin={vi.fn()} onRegister={onRegister} />);

    await user.click(screen.getByRole("tab", { name: /Đăng ký/i }));
    await user.type(screen.getByLabelText(/Tên đăng nhập/i), "slow_user");
    await user.type(screen.getByLabelText(/^Mật khẩu$/i), "password123");
    await user.type(screen.getByLabelText(/Xác nhận mật khẩu/i), "password123");

    const submitBtn = screen.getByRole("button", { name: /Tạo tài khoản/i });
    await user.click(submitBtn);

    // Form inputs and button disabled
    expect(screen.getByLabelText(/Tên đăng nhập/i)).toBeDisabled();
    expect(screen.getByLabelText(/^Mật khẩu$/i)).toBeDisabled();
    expect(screen.getByRole("button", { name: /Đang xử lý\.\.\./i })).toBeDisabled();

    // Attempt second submit while pending
    await user.click(submitBtn);

    expect(onRegister).toHaveBeenCalledTimes(1);

    resolveRegister({ user: { id: "u-1", username: "slow_user", role: "author" } });
    expect(await screen.findByText(/Tài khoản đã tạo/i)).toBeInTheDocument();
  });
});
