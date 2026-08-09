import { Component, type ErrorInfo, type ReactNode } from "react";

interface ErrorBoundaryState {
  readonly error: Error | null;
}

export class ErrorBoundary extends Component<{ readonly children: ReactNode }, ErrorBoundaryState> {
  override state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("Sideral Editor interface failure", error, info.componentStack);
  }

  override render(): ReactNode {
    if (this.state.error !== null) {
      return (
        <main className="startup-state" role="alert">
          <div className="startup-mark">A</div>
          <h1>Sideral Editor encountered an interface error</h1>
          <p>{this.state.error.message}</p>
          <button type="button" className="primary-button" onClick={() => window.location.reload()}>
            Reload
          </button>
        </main>
      );
    }
    return this.props.children;
  }
}
