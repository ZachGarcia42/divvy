import { formatMoney } from '@divvy/domain'
import { useState } from 'react'
import { Pressable, SafeAreaView, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native'

const API = process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:8787'

type Group = { id: string; name: string; currency: string; yourNetMinor: number }

export function App() {
  const [token, setToken] = useState<string | null>(null)
  const [email, setEmail] = useState('')
  const [groups, setGroups] = useState<Group[]>([])
  const [error, setError] = useState<string | null>(null)

  async function call<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetch(`${API}${path}`, {
      ...init,
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(init?.headers ?? {}),
      },
    })
    const body = await response.json()
    if (!response.ok) throw new Error(body.error?.message ?? 'Request failed')
    return body as T
  }

  if (!token) {
    return (
      <SafeAreaView style={styles.screen}>
        <Text style={styles.brand}>Divvy</Text>
        <Text style={styles.copy}>The same ledger as the web app. Sign in with your email.</Text>
        <TextInput style={styles.input} autoCapitalize="none" keyboardType="email-address" value={email} onChangeText={setEmail} placeholder="Email" />
        {error && <Text style={styles.error}>{error}</Text>}
        <Pressable style={styles.button} onPress={async () => {
          try {
            const session = await call<{ token: string }>('/api/dev/seed', { method: 'POST' })
            setToken(session.token)
            const home = await call<{ groups: Group[] }>('/api/home', { headers: { authorization: `Bearer ${session.token}` } })
            setGroups(home.groups)
          } catch (reason) {
            setError(reason instanceof Error ? reason.message : 'Could not open the sample')
          }
        }}>
          <Text style={styles.buttonText}>Open the sample apartment</Text>
        </Pressable>
        <Pressable style={[styles.button, styles.secondary]} onPress={async () => {
          try {
            const issued = await call<{ devToken?: string }>('/api/auth/magic-link', { method: 'POST', body: JSON.stringify({ email }) })
            if (!issued.devToken) {
              setError('Check your email for the sign-in link.')
              return
            }
            const session = await call<{ token: string }>('/api/auth/verify', { method: 'POST', body: JSON.stringify({ token: issued.devToken }) })
            setToken(session.token)
            const home = await call<{ groups: Group[] }>('/api/home', { headers: { authorization: `Bearer ${session.token}` } })
            setGroups(home.groups)
          } catch (reason) {
            setError(reason instanceof Error ? reason.message : 'Could not sign in')
          }
        }}>
          <Text style={styles.secondaryText}>Continue with email</Text>
        </Pressable>
      </SafeAreaView>
    )
  }

  return (
    <SafeAreaView style={styles.screen}>
      <Text style={styles.brand}>Your groups</Text>
      <ScrollView>
        {groups.map((group) => (
          <View key={group.id} style={styles.card}>
            <Text style={styles.group} testID={`group-${group.id}`}>{group.name}</Text>
            <Text testID={`balance-${group.id}`}>{group.yourNetMinor === 0 ? `Settled in ${group.currency}` : group.yourNetMinor > 0 ? `You are owed ${formatMoney(group.yourNetMinor, group.currency)}` : `You owe ${formatMoney(Math.abs(group.yourNetMinor), group.currency)}`}</Text>
          </View>
        ))}
      </ScrollView>
    </SafeAreaView>
  )
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#efe7d8', padding: 20 },
  brand: { fontSize: 42, marginBottom: 8 },
  copy: { marginBottom: 16, color: '#3d4741' },
  input: { backgroundColor: 'white', borderRadius: 12, padding: 14, marginBottom: 12 },
  button: { backgroundColor: '#1d6b4f', borderRadius: 999, padding: 14, alignItems: 'center', marginBottom: 10 },
  secondary: { backgroundColor: 'transparent', borderWidth: 1, borderColor: '#1d6b4f' },
  buttonText: { color: 'white', fontWeight: '600' },
  secondaryText: { color: '#1d6b4f', fontWeight: '600' },
  error: { color: '#8d2f39', marginBottom: 8 },
  card: { backgroundColor: '#fffdf8', borderRadius: 16, padding: 16, marginBottom: 10 },
  group: { fontSize: 18, marginBottom: 4 },
})
