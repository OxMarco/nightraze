import { Component, type ErrorInfo, type ReactNode } from "react";
import { reportRenderCrash } from "./telemetry.js";
import "./ui/modals.css";

export class CrashBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(_error: Error, _info: ErrorInfo) {
    reportRenderCrash();
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <main className="modalBackdrop">
        <div className="modalCore">
          <h1 className="modalTitle bad">the light went out</h1>
          <p>reload to return to the abyss.</p>
        </div>
      </main>
    );
  }
}
