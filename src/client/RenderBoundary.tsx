import { Component, type ErrorInfo, type ReactNode } from "react";
import { reportClientError } from "./telemetry";

export class RenderBoundary extends Component<
  {
    children: ReactNode;
    resetKey?: string | number;
    label?: string;
    onHistory?: () => void;
    onExport?: () => void;
    onRetry?: () => void;
  },
  { failed: boolean; resetKey: string | number | undefined }
> {
  state = { failed: false, resetKey: this.props.resetKey };
  static getDerivedStateFromProps(props: RenderBoundary["props"], state: RenderBoundary["state"]) {
    return props.resetKey !== state.resetKey ? { failed: false, resetKey: props.resetKey } : null;
  }
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error: Error, _info: ErrorInfo) {
    void reportClientError("client.render_failed", error);
  }
  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <section className="notice notice-danger" role="alert">
        <h2>{this.props.label ?? "This content could not be displayed"}</h2>
        <p>
          {this.props.onHistory || this.props.onExport
            ? "Your saved content is still available. Open history to restore a version, or download a recovery copy."
            : "Try again to reload this view."}
        </p>
        {this.props.onHistory && (
          <button type="button" onClick={this.props.onHistory}>
            Open version history
          </button>
        )}
        {this.props.onExport && (
          <button type="button" onClick={this.props.onExport}>
            Download recovery copy
          </button>
        )}
        <button
          type="button"
          onClick={() => {
            this.props.onRetry?.();
            this.setState({ failed: false });
          }}
        >
          Try again
        </button>
      </section>
    );
  }
}
