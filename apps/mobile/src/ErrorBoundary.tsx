import { Component, type ReactNode } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'

type Props = { children: ReactNode; onError?: (error: unknown) => void; onSignOut?: () => void }
type State = { error: unknown }

/**
 * Last line of defence for the signed-in app. A render error used to be fatal in release builds (the app closed, and
 * because it reopens the last group at launch it closed again on every start). Now it shows a screen with a way out:
 * Try again re-renders from the Groups list (the host clears the remembered group in onError), Sign out leaves the session.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }
  static getDerivedStateFromError(error: unknown): State { return { error: error ?? new Error('Unknown error') } }
  componentDidCatch(error: unknown) {
    try { this.props.onError?.(error) } catch { /* never let the boundary itself throw */ }
  }
  render() {
    if (!this.state.error) return this.props.children
    return (
      <View style={s.wrap} testID="crash-screen">
        <Text style={s.h} accessibilityRole="header">Something went wrong</Text>
        <Text style={s.p}>Divvy hit a problem showing this screen. Your groups and balances are safe on the server.</Text>
        <Pressable style={s.btn} onPress={() => this.setState({ error: null })} accessibilityRole="button" testID="crash-retry"><Text style={s.btnText}>Back to Groups</Text></Pressable>
        {this.props.onSignOut && <Pressable style={[s.btn, s.ghost]} onPress={this.props.onSignOut} accessibilityRole="button" testID="crash-signout"><Text style={[s.btnText, { color: '#0f766e' }]}>Sign out</Text></Pressable>}
      </View>
    )
  }
}

const s = StyleSheet.create({
  wrap: { flex: 1, padding: 24, justifyContent: 'center', backgroundColor: '#f6f5f1' },
  h: { fontSize: 22, fontWeight: '800', color: '#16211d', marginBottom: 8 },
  p: { fontSize: 15, color: '#4b5a54', marginBottom: 20 },
  btn: { backgroundColor: '#0f766e', borderRadius: 14, paddingVertical: 14, alignItems: 'center', marginTop: 10 },
  ghost: { backgroundColor: 'transparent', borderWidth: 1, borderColor: '#0f766e' },
  btnText: { color: '#fff', fontWeight: '800', fontSize: 16 },
})
