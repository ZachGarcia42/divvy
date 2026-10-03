export class ApiError extends Error {}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    credentials: 'include',
    headers: {
      ...(init?.body ? { 'content-type': 'application/json' } : {}),
      ...(init?.headers ?? {}),
    },
  })
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as { error?: { message?: string; code?: string } }
    const error = new ApiError(body.error?.message ?? 'Something went wrong')
    ;(error as ApiError & { code?: string }).code = body.error?.code
    throw error
  }
  const type = response.headers.get('content-type') ?? ''
  if (type.includes('text/csv')) return (await response.text()) as T
  return response.json() as Promise<T>
}

export type Member = {
  id: string
  name: string
  email: string | null
  hasAccount: boolean
  removed: boolean
  defaultWeight: number | null
}

export type Expense = {
  id: string
  date: string
  description: string
  categoryId: string
  kind: 'expense' | 'reimbursement'
  originalMinor: number
  originalCurrency: string
  settlementMinor: number
  currency: string
  version: number
  payers: { participantId: string; name: string; minor: number }[]
  shares: { participantId: string; name: string; minor: number }[]
}

export type GroupDetail = {
  group: { id: string; name: string; currency: string; timezone: string; simplify: boolean; archived: boolean }
  members: Member[]
  yourParticipantId: string
  nets: { participantId: string; name: string; netMinor: number }[]
  payments: { fromId: string; toId: string; minor: number }[]
  expenses: Expense[]
  settlements: { id: string; date: string; fromId: string; toId: string; fromName: string; toName: string; minor: number; note: string; version: number }[]
  categories: { id: string; label: string; fixed: boolean }[]
  recurrences: { id: string; description: string; frequency: string; nextDate: string; paused: boolean; pauseReason: string | null; settlementMinor: number }[]
  currency: string
}
