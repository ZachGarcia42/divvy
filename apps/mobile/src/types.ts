// Shapes the mobile client reads from the API (additive: new fields are optional so older servers still work).
export type HomeGroup = {
  id: string
  name: string
  currency: string
  yourNetMinor: number
  archived: boolean
  members?: string[]
  latest?: { description: string; date: string } | null
}
export type Home = { you: { name: string }; groups: HomeGroup[] }
export type Member = { id: string; name: string; removed: boolean }
export type Expense = {
  id: string
  date: string
  description: string
  settlementMinor: number
  originalMinor?: number
  originalCurrency?: string
  kind?: string
  version?: number
  splitMethod?: string
  splitInputs?: unknown
  payers: { participantId: string; name: string; minor: number }[]
  shares?: { participantId: string; name?: string; minor: number }[]
}
export type Settlement = { id: string; fromId: string; toId: string; fromName: string; toName: string; minor: number }
export type Payment = { fromId: string; toId: string; minor: number }
export type GroupDetail = {
  group: { id: string; name: string }
  members: Member[]
  yourParticipantId: string
  nets: { participantId: string; netMinor: number }[]
  payments: Payment[]
  expenses: Expense[]
  settlements: Settlement[]
  currency: string
}
