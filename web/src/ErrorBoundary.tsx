import { Component, type ErrorInfo, type ReactNode } from 'react';

// Confine une exception de rendu à sa zone : le reste de l'interface demeure utilisable.
export class ErrorBoundary extends Component<
  { zone: string; resetKey?: string; className?: string; children: ReactNode },
  { error: Error | null; resetKey: string | undefined }
> {
  state: { error: Error | null; resetKey: string | undefined } = { error: null, resetKey: this.props.resetKey };

  static getDerivedStateFromError(error: unknown): { error: Error } {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  // Changer de vue ou de machine retente le rendu.
  static getDerivedStateFromProps(
    props: { resetKey?: string },
    state: { error: Error | null; resetKey: string | undefined },
  ): { error: null; resetKey: string | undefined } | null {
    return props.resetKey === state.resetKey ? null : { error: null, resetKey: props.resetKey };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error(`Erreur d'affichage (${this.props.zone})`, error, info.componentStack);
  }

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className={`error-boundary${this.props.className ? ` ${this.props.className}` : ''}`} role="alert">
        <p>
          <strong>{this.props.zone} : affichage impossible.</strong> {error.message}
        </p>
        <div className="error-boundary-actions">
          <button type="button" className="btn" onClick={() => this.setState({ error: null })}>
            Réessayer
          </button>
          <button type="button" className="btn" onClick={() => window.location.reload()}>
            Recharger la page
          </button>
        </div>
      </div>
    );
  }
}
