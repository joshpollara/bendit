import { Component, type ErrorInfo, type ReactNode } from 'react';

// What the app does when it breaks.
//
// React unmounts the whole tree when a render throws, and with nothing to catch
// it that is a white screen: no message, no way back, and nothing for the person
// to tell you afterwards beyond "it went blank". The bug that caused it is then
// the easy part; finding out it happened at all is the hard one.
//
// So: keep the failure on screen, keep it readable, and keep a way out that
// isn't force-quitting the app. The message is shown rather than hidden because
// the person reading it is the only one who can pass it on.

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // The console is where a browser's own error reporting looks, and where
    // someone walking a user through it over the phone will end up.
    console.error('Bend It! crashed while rendering:', error, info.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-4 px-6 py-10">
        <h1 className="text-lg font-semibold">Something broke on this screen</h1>
        <p className="text-sm text-ink-secondary">
          Nothing you logged has been lost. Reloading usually gets you moving again.
        </p>
        <pre className="overflow-x-auto rounded-xl bg-surface p-3 text-left text-xs text-ink-muted">
          {error.message || String(error)}
        </pre>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => window.location.assign('/')}
            className="flex-1 rounded-xl bg-accent py-3 font-semibold text-white"
          >
            Reload
          </button>
          <button
            type="button"
            onClick={() => this.setState({ error: null })}
            className="rounded-xl border border-line px-4 py-3 text-sm font-medium text-ink-secondary"
          >
            Try again
          </button>
        </div>
      </div>
    );
  }
}
