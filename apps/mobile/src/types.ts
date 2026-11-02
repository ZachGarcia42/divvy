// Shapes the mobile client reads from the API (additive: new fields are optional so older servers still work).
import type { PayHandles } from '@divvy/domain'
export type HomeGroup = {
  id: string
  name: string
  emoji?: string | null
  currency: string
  yourNetMinor: number
  archived: boolean
  members?: string[]
  latest?: { description: string; date: string } | null
}
export type Home = { you: { name: string; pay?: PayHandles }; groups: HomeGroup[] }
/** Venmo / PayPal.me / Cash App names. Members only see these for people in their own groups. */
export type Member = { id: string; name: string; removed: boolean; pay?: PayHandles }
export type Expense = {
  id: string
  date: string
  /** When it was added (ISO); same-day expenses sort by it, then id. */
  createdAt?: string | null
  description: string
  settlementMinor: number
  originalMinor?: number
  originalCurrency?: string
  /** The rate used to convert it to the group currency (group currency per 1 original); null when it was entered in the group currency. */
  rate?: string | null
  rateSource?: string | null
  rateDate?: string | null
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
  group: { id: string; name: string; emoji?: string | null }
  members: Member[]
  yourParticipantId: string
  nets: { participantId: string; netMinor: number }[]
  payments: Payment[]
  expenses: Expense[]
  settlements: Settlement[]
  currency: string
}

/** A receipt photo on an expense (the picture itself is fetched separately, with the sign-in token). */
export type PhotoInfo = { id: string; contentType: string; bytes: number; at: string; byId?: string | null; byName?: string | null }
