import { Component, type ReactNode } from 'react'

class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
	state = { error: null }
	static getDerivedStateFromError(error: Error) {
		return { error }
	}
	render() {
		if (this.state.error) {
			return (
				<div style={{ padding: '2rem', fontFamily: 'monospace', color: 'red' }}>
					<h2>Something went wrong</h2>
					<pre>{(this.state.error as Error).message}</pre>
					<pre>{(this.state.error as Error).stack}</pre>
				</div>
			)
		}
		return this.props.children
	}
}

export default ErrorBoundary
