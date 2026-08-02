import { Component, type ErrorInfo, type ReactNode } from 'react';
import { reportBrowserError } from '../report';

interface Props {
  children: ReactNode;
  /** Which part of the UI this guards; recorded with the fault. */
  where?: string;
}

interface State {
  error: Error | null;
}

/**
 * Keeps one broken page from taking the whole app with it.
 *
 * React unmounts the entire tree when a render throws and nothing catches it,
 * which leaves a blank window and a message in a console nobody has open. This
 * keeps the shell, says what happened, and — the point of it — writes the fault
 * to the error feed so it turns up in the list of bugs rather than only in the
 * head of whoever happened to be looking.
 */
export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    const componentStack = info.componentStack ?? '';
    reportBrowserError(
      Object.assign(error, { stack: `${error.stack ?? error.message}\n--- component stack ---${componentStack}` }),
      this.props.where ?? window.location.pathname,
    );
  }

  override render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="card">
        <h2>This page stopped working</h2>
        <p className="stat-note">
          The fault has been recorded — it is in <a href="/errors">Errors</a>, with its stack.
        </p>
        <pre className="log-body error" style={{ whiteSpace: 'pre-wrap', marginTop: 12 }}>
          {error.message}
        </pre>
        <div className="row" style={{ marginTop: 12 }}>
          <button className="primary" onClick={() => this.setState({ error: null })}>
            Try again
          </button>
          <button className="ghost" onClick={() => window.location.reload()}>
            Reload
          </button>
        </div>
      </div>
    );
  }
}
