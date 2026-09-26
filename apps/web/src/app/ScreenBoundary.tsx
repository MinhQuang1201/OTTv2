import { Component, type ErrorInfo, type ReactNode } from "react";
import type { SessionErrorView } from "../sessions/contract";
import { Button } from "../shared/ui/Button";
import styles from "./app.module.css";

interface ScreenBoundaryProps {
  readonly children: ReactNode;
  readonly error?: SessionErrorView | null;
  readonly onRetry?: () => void;
  readonly onLobby: () => void;
}

interface ScreenBoundaryState { readonly caught: boolean; }

export class ScreenBoundary extends Component<ScreenBoundaryProps, ScreenBoundaryState> {
  state: ScreenBoundaryState = { caught: false };
  static getDerivedStateFromError(): ScreenBoundaryState { return { caught: true }; }
  componentDidCatch(_error: Error, _info: ErrorInfo) { /* raw exceptions stay out of the UI */ }
  private retry = () => { this.setState({ caught: false }); this.props.onRetry?.(); };

  render() {
    const { error } = this.props;
    if (!this.state.caught && !error) return this.props.children;
    const canRetry = Boolean(error?.retryable) && Boolean(this.props.onRetry);
    return (
      <section className={styles.errorScreen} role="alert" aria-labelledby="screen-error-title">
        <h1 id="screen-error-title">Đã xảy ra sự cố</h1>
        <p>{error?.message ?? "Không thể hiển thị màn hình này."}</p>
        <div className={styles.actions}>
          {canRetry ? <Button variant="primary" onClick={this.retry}>Thử lại</Button> : null}
          <Button variant="secondary" onClick={this.props.onLobby}>Về sảnh</Button>
        </div>
      </section>
    );
  }
}
