import {
  DEFAULT_CATEGORY_ID,
  LedgerError,
  assertAmount,
  assertInvolved,
  assertNotFuture,
  assertPayers,
  calendarDateInTimeZone,
  canMove,
  canRemove,
  categoryTotals,
  chartEntries,
  monthlyTotals,
  checkVersion,
  computeShares,
  convertMinor,
  exponentOf,
  fillFromRate,
  formatMoney,
  settleItemizedBill,
  nextMoneyFields,
  nextOccurrence,
  participantNets,
  paymentBetween,
  personalChartShares,
  type ChartExpense,
  retargetSettlement,
  suggestedPayments,
  type Frequency,
  type LedgerExpense,
  type LedgerSettlement,
  type SplitSpec,
} from '@divvy/domain'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import type { Sql } from './db.ts'

type Actor = { userId: string; email: string; participantId: string; displayName: string; homeCurrency: string }

type ExpenseInput = {
  description?: string
  date?: string
  categoryId?: string
  kind?: 'expense' | 'reimbursement'
  originalMinor?: number
  originalCurrency?: string
  settlementMinor?: number
  payers?: { participantId: string; minor: number }[]
  split?: SplitSpec
  items?: { label: string; minor: number; participantIds: string[] }[]
  taxMinor?: number
  tipMinor?: number
  discountMinor?: number
  version?: number
}

const newId = () => randomUUID()
const newToken = () => randomBytes(32).toString('base64url')
const hashToken = (token: string) => createHash('sha256').update(token).digest('hex')

export class Repo {
  constructor(
    private sql: Sql,
    private deps: {
      now: () => Date
      rateFor: (from: string, to: string, date: string) => Promise<string>
      webOrigin: string
    },
  ) {}

  private async one<T>(text: string, params: unknown[] = []): Promise<T | null> {
    const rows = await this.sql.query<T>(text, params)
    return rows[0] ?? null
  }

  async requestMagicLink(email: string, purpose: 'login' | 'email_change' = 'login', userId?: string) {
    const normalized = normalizeEmail(email)
    const token = newToken()
    const expires = new Date(this.deps.now().getTime() + 15 * 60 * 1000)
    await this.sql.query(
      `insert into magic_links (token_hash, email, purpose, user_id, expires_at) values ($1,$2,$3,$4,$5)`,
      [hashToken(token), normalized, purpose, userId ?? null, expires.toISOString()],
    )
    const url = `${this.deps.webOrigin}/login?token=${encodeURIComponent(token)}`
    await this.sendEmail(normalized, 'Your Divvy sign-in link', `Open this link to sign in. It expires in 15 minutes.\n${url}`)
    return { token, url }
  }

  async verifyMagicLink(token: string) {
    const link = await this.one<{ email: string; purpose: string; user_id: string | null; expires_at: string; used_at: string | null }>(
      `select email, purpose, user_id, expires_at, used_at from magic_links where token_hash = $1`,
      [hashToken(token)],
    )
    if (!link || link.used_at || new Date(link.expires_at).getTime() < this.deps.now().getTime()) {
      throw new LedgerError('BAD_TOKEN', 'That sign-in link is no longer valid')
    }
    await this.sql.query(`update magic_links set used_at = now() where token_hash = $1`, [hashToken(token)])
    if (link.purpose === 'email_change') {
      if (!link.user_id) throw new LedgerError('BAD_TOKEN', 'That sign-in link is no longer valid')
      const taken = await this.one(`select id from users where email = $1 and id <> $2`, [link.email, link.user_id])
      if (taken) throw new LedgerError('BAD_EMAIL', 'That email is already on another account')
      await this.sql.query(`update users set email = $1 where id = $2`, [link.email, link.user_id])
    }
    const user = await this.ensureUser(link.purpose === 'email_change' ? link.email : link.email, undefined, link.purpose === 'email_change' ? link.user_id! : undefined)
    const session = await this.createSession(user.id)
    const claims = await this.claimRows(user.email)
    return { token: session, user: publicUser(user), claims }
  }

  async logout(token: string) {
    await this.sql.query(`delete from sessions where token_hash = $1`, [hashToken(token)])
  }

  async actorFromToken(token: string | null): Promise<Actor | null> {
    if (!token) return null
    const row = await this.one<{
      id: string
      email: string
      display_name: string
      home_currency: string
      suspended_at: string | null
      participant_id: string
      expires_at: string
    }>(
      `select u.id, u.email, u.display_name, u.home_currency, u.suspended_at, p.id as participant_id, s.expires_at
       from sessions s
       join users u on u.id = s.user_id
       join participants p on p.user_id = u.id
       where s.token_hash = $1`,
      [hashToken(token)],
    )
    if (!row || new Date(row.expires_at).getTime() < this.deps.now().getTime()) return null
    if (row.suspended_at) throw new LedgerError('SUSPENDED', 'This account is suspended')
    return {
      userId: row.id,
      email: row.email,
      participantId: row.participant_id,
      displayName: row.display_name,
      homeCurrency: row.home_currency,
    }
  }

  async updateMe(actor: Actor, patch: { displayName?: string; homeCurrency?: string }) {
    if (patch.displayName !== undefined) {
      const name = cleanName(patch.displayName)
      await this.sql.query(`update users set display_name = $1 where id = $2`, [name, actor.userId])
      await this.sql.query(`update participants set display_name = $1 where id = $2`, [name, actor.participantId])
    }
    if (patch.homeCurrency !== undefined) {
      exponentOf(patch.homeCurrency)
      await this.sql.query(`update users set home_currency = $1 where id = $2`, [patch.homeCurrency.toUpperCase(), actor.userId])
    }
    const user = await this.mustUser(actor.userId)
    return publicUser(user)
  }

  async claims(actor: Actor) {
    return this.claimRows(actor.email)
  }

  async resolveClaim(actor: Actor, participantId: string, action: 'claim' | 'reject') {
    const row = await this.one<{ id: string; email: string | null; user_id: string | null }>(
      `select id, email, user_id from participants where id = $1`,
      [participantId],
    )
    if (!row || row.user_id || row.email?.toLowerCase() !== actor.email) {
      throw new LedgerError('NOT_FOUND', 'There is nothing to claim')
    }
    if (action === 'reject') {
      await this.sql.query(`update participants set email = null where id = $1`, [participantId])
      return
    }
    await this.sql.tx((sql) => this.merge(sql, participantId, actor.participantId))
  }

  async linkParticipants(actor: Actor, sourceId: string, targetId: string) {
    if (sourceId === targetId) return
    const source = await this.mustParticipant(sourceId)
    const target = await this.mustParticipant(targetId)
    if (source.user_id || target.user_id) {
      throw new LedgerError('BAD_LINK', 'Use claim when someone already has an account. Linking is for name-only people.')
    }
    const groups = await this.sql.query<{ group_id: string }>(
      `select distinct group_id from memberships where participant_id in ($1, $2)`,
      [sourceId, targetId],
    )
    for (const group of groups) {
      await this.requireMember(actor, group.group_id)
    }
    await this.sql.tx((sql) => this.merge(sql, sourceId, targetId))
  }

  async home(actor: Actor) {
    const memberships = await this.sql.query<{ group_id: string }>(
      `select group_id from memberships where participant_id = $1 and removed_at is null`,
      [actor.participantId],
    )
    const groups = []
    let estimate = 0
    let approximate = false
    let counted = 0
    for (const membership of memberships) {
      const detail = await this.balanceSummary(membership.group_id, actor.participantId)
      groups.push(detail.summary)
      counted += 1
      if (detail.summary.currency === actor.homeCurrency) {
        estimate += detail.summary.yourNetMinor
      } else if (detail.summary.yourNetMinor !== 0) {
        try {
          const today = calendarDateInTimeZone(detail.summary.timezone, this.deps.now())
          const rate = await this.deps.rateFor(detail.summary.currency, actor.homeCurrency, today)
          const sign = detail.summary.yourNetMinor < 0 ? -1 : 1
          estimate += sign * convertMinor(Math.abs(detail.summary.yourNetMinor), detail.summary.currency, rate, actor.homeCurrency)
          approximate = true
        } catch {
          approximate = true
        }
      }
    }
    groups.sort((a, b) => Number(a.archived) - Number(b.archived) || a.name.localeCompare(b.name))
    const unread = await this.one<{ count: string }>(
      `select count(*) as count from notifications where user_id = $1 and read_at is null`,
      [actor.userId],
    )
    return {
      you: { id: actor.participantId, name: actor.displayName, email: actor.email, homeCurrency: actor.homeCurrency },
      groups,
      estimate: counted === 0 ? null : { homeCurrency: actor.homeCurrency, minor: estimate, approximate },
      unread: Number(unread?.count ?? 0),
    }
  }

  async createGroup(actor: Actor, input: { name: string; currency: string; timezone: string }) {
    const name = cleanName(input.name)
    const currency = input.currency.toUpperCase()
    exponentOf(currency)
    calendarDateInTimeZone(input.timezone, this.deps.now())
    const id = newId()
    await this.sql.query(
      `insert into groups (id, name, settlement_currency, timezone) values ($1,$2,$3,$4)`,
      [id, name, currency, input.timezone],
    )
    await this.sql.query(
      `insert into memberships (group_id, participant_id, default_weight) values ($1,$2,1)`,
      [id, actor.participantId],
    )
    await this.activity(this.sql, id, actor.participantId, 'group.created', `${actor.displayName} created the group`, {})
    return this.groupDetail(actor, id)
  }

  async groupDetail(actor: Actor, groupId: string) {
    await this.requireMember(actor, groupId)
    const group = await this.mustGroup(groupId)
    const members = await this.memberRows(groupId)
    const ledger = await this.loadLedger(groupId)
    const nets = participantNets(ledger.expenses, ledger.settlements)
    const payments = suggestedPayments(ledger.expenses, ledger.settlements, group.simplify)
    const categories = await this.sql.query<{ id: string; label: string; fixed: boolean; group_id: string | null }>(
      `select id, label, fixed, group_id from categories where group_id is null or group_id = $1 order by label`,
      [groupId],
    )
    const recurrences = await this.sql.query(
      `select id, description, category_id, frequency, next_date, end_date, paused, pause_reason, settlement_minor, payers, shares
       from recurrences where group_id = $1 order by description`,
      [groupId],
    )
    return {
      group: publicGroup(group),
      members: members.map(publicMember),
      yourParticipantId: actor.participantId,
      nets: members
        .filter((member) => !member.removed_at || (nets.get(member.id) ?? 0) !== 0)
        .map((member) => ({ participantId: member.id, name: member.display_name, netMinor: nets.get(member.id) ?? 0 })),
      payments,
      expenses: ledger.views.filter((expense) => !expense.deleted),
      settlements: ledger.settlementViews.filter((settlement) => !settlement.deleted),
      categories: categories.map((category) => ({ id: category.id, label: category.label, fixed: category.fixed })),
      recurrences: recurrences.map((row) => ({
        id: row.id,
        description: row.description,
        categoryId: row.category_id,
        frequency: row.frequency,
        nextDate: row.next_date,
        endDate: row.end_date,
        paused: row.paused === true,
        pauseReason: row.pause_reason,
        settlementMinor: Number(row.settlement_minor),
        payers: JSON.parse(String(row.payers)),
        shares: JSON.parse(String(row.shares)),
      })),
      currency: group.settlement_currency,
    }
  }

  async updateGroup(actor: Actor, groupId: string, patch: {
    name?: string
    timezone?: string
    simplify?: boolean
    confirm?: boolean
    currency?: string
    muted?: boolean
  }) {
    await this.requireMember(actor, groupId)
    const group = await this.mustGroup(groupId)
    if (patch.name) {
      await this.sql.query(`update groups set name = $1 where id = $2`, [cleanName(patch.name), groupId])
    }
    if (patch.timezone) {
      calendarDateInTimeZone(patch.timezone, this.deps.now())
      await this.sql.query(`update groups set timezone = $1 where id = $2`, [patch.timezone, groupId])
      await this.activity(this.sql, groupId, actor.participantId, 'group.timezone', `${actor.displayName} changed the timezone`, {})
    }
    if (patch.muted !== undefined) {
      await this.sql.query(
        `update memberships set muted = $1 where group_id = $2 and participant_id = $3`,
        [patch.muted, groupId, actor.participantId],
      )
    }
    if (patch.simplify !== undefined && patch.simplify !== group.simplify) {
      if (!patch.simplify) {
        const existing = await this.one<{ count: string }>(
          `select count(*) as count from settlements where group_id = $1 and deleted_at is null`,
          [groupId],
        )
        if (Number(existing?.count ?? 0) > 0 && !patch.confirm) {
          throw new LedgerError(
            'CONFIRM',
            'This group already has settlements. Turning simplify off can make those payments look like they went to the wrong person. Confirm to continue.',
          )
        }
      }
      await this.sql.query(`update groups set simplify = $1 where id = $2`, [patch.simplify, groupId])
      await this.activity(
        this.sql,
        groupId,
        actor.participantId,
        'group.simplify',
        `${actor.displayName} turned simplify ${patch.simplify ? 'on' : 'off'}`,
        {},
      )
      await this.notifyGroup(groupId, actor.participantId, 'Simplify debts', `${actor.displayName} turned simplify ${patch.simplify ? 'on' : 'off'}`)
    }
    if (patch.currency && patch.currency.toUpperCase() !== group.settlement_currency) {
      const nextCurrency = patch.currency.toUpperCase()
      exponentOf(nextCurrency)
      await this.changeCurrency(actor, group, nextCurrency)
    }
    return this.groupDetail(actor, groupId)
  }

  async archive(actor: Actor, groupId: string, archived: boolean) {
    await this.requireMember(actor, groupId)
    await this.sql.query(`update groups set archived_at = ${archived ? 'now()' : 'null'} where id = $1`, [groupId])
    await this.activity(this.sql, groupId, actor.participantId, archived ? 'group.archived' : 'group.unarchived', `${actor.displayName} ${archived ? 'archived' : 'unarchived'} the group`, {})
    return this.groupDetail(actor, groupId)
  }

  async deleteGroup(actor: Actor, groupId: string) {
    await this.requireMember(actor, groupId)
    const expenses = await this.one<{ count: string }>(`select count(*) as count from expenses where group_id = $1`, [groupId])
    const settlements = await this.one<{ count: string }>(`select count(*) as count from settlements where group_id = $1`, [groupId])
    if (Number(expenses?.count ?? 0) > 0 || Number(settlements?.count ?? 0) > 0) {
      throw new LedgerError('NOT_EMPTY', 'Only a group with no expenses and no settlements can be deleted')
    }
    await this.sql.query(`delete from groups where id = $1`, [groupId])
  }

  async addPerson(actor: Actor, groupId: string, input: { displayName?: string; email?: string }) {
    const { group } = await this.requireMember(actor, groupId)
    if (input.email) {
      const email = normalizeEmail(input.email)
      await this.assertInviteCap(actor.userId)
      const existing = await this.one<{ id: string }>(`select id from users where email = $1`, [email])
      if (existing) {
        if (await this.isBlocked(actor.userId, existing.id)) {
          throw new LedgerError('BLOCKED', 'You cannot invite this person')
        }
        const participant = await this.one<{ id: string }>(`select id from participants where user_id = $1`, [existing.id])
        if (!participant) throw new LedgerError('NOT_FOUND', 'Account is missing a profile')
        const membership = await this.membership(groupId, participant.id)
        if (membership && !membership.removed_at) throw new LedgerError('BAD_INVITE', 'They are already in this group')
        const token = await this.insertInvite(groupId, email, actor.userId)
        await this.sendEmail(email, `Join ${group.name} on Divvy`, `${actor.displayName} invited you to ${group.name}.\n${this.deps.webOrigin}/invite/${token}`)
        await this.sql.query(
          `insert into notifications (id, user_id, kind, title, body, group_id) values ($1,$2,'invite',$3,$4,$5)`,
          [newId(), existing.id, `Invite to ${group.name}`, `${actor.displayName} invited you`, groupId],
        )
        return { status: 'invited' as const }
      }
      const participantId = newId()
      const name = cleanName(input.displayName || email.split('@')[0] || 'New person')
      await this.sql.query(`insert into participants (id, display_name, email) values ($1,$2,$3)`, [participantId, name, email])
      await this.sql.query(`insert into memberships (group_id, participant_id) values ($1,$2)`, [groupId, participantId])
      await this.sendEmail(email, `You were added to ${group.name} on Divvy`, `${actor.displayName} added you to ${group.name}. Sign in with this email to claim the history.\n${this.deps.webOrigin}`)
      await this.activity(this.sql, groupId, actor.participantId, 'member.added', `${actor.displayName} added ${name}`, { participantId })
      return { status: 'added' as const, participantId, suggestDefault: true }
    }
    const name = cleanName(input.displayName ?? '')
    const participantId = newId()
    await this.sql.query(`insert into participants (id, display_name) values ($1,$2)`, [participantId, name])
    await this.sql.query(`insert into memberships (group_id, participant_id) values ($1,$2)`, [groupId, participantId])
    await this.activity(this.sql, groupId, actor.participantId, 'member.added', `${actor.displayName} added ${name}`, { participantId })
    return { status: 'added' as const, participantId, suggestDefault: true }
  }

  async previewInvite(actor: Actor, token: string) {
    const invite = await this.mustInvite(token)
    if (invite.email !== actor.email) throw new LedgerError('FORBIDDEN', 'This invite was sent to a different email')
    const members = await this.memberRows(invite.group_id)
    const blockedIds = new Set(
      (await this.sql.query<{ user_id: string }>(
        `select case when blocker_user_id = $1 then blocked_user_id else blocker_user_id end as user_id
         from blocks where blocker_user_id = $1 or blocked_user_id = $1`,
        [actor.userId],
      )).map((row) => row.user_id),
    )
    const group = await this.mustGroup(invite.group_id)
    return {
      group: { id: group.id, name: group.name },
      members: members.filter((member) => !member.removed_at).map((member) => ({
        id: member.id,
        name: member.display_name,
        blocked: member.user_id ? blockedIds.has(member.user_id) : false,
      })),
    }
  }

  async acceptInvite(actor: Actor, token: string) {
    const invite = await this.mustInvite(token)
    if (invite.email !== actor.email) throw new LedgerError('FORBIDDEN', 'This invite was sent to a different email')
    const ghost = await this.one<{ id: string }>(
      `select p.id from participants p
       join memberships m on m.participant_id = p.id
       where m.group_id = $1 and lower(p.email) = $2 and p.user_id is null`,
      [invite.group_id, actor.email],
    )
    if (ghost) {
      await this.sql.tx((sql) => this.merge(sql, ghost.id, actor.participantId))
    }
    const membership = await this.membership(invite.group_id, actor.participantId)
    if (!membership) {
      await this.sql.query(`insert into memberships (group_id, participant_id) values ($1,$2)`, [invite.group_id, actor.participantId])
    } else if (membership.removed_at) {
      await this.sql.query(`update memberships set removed_at = null where group_id = $1 and participant_id = $2`, [invite.group_id, actor.participantId])
    }
    await this.sql.query(`update invites set accepted_at = now() where id = $1`, [invite.id])
    await this.activity(this.sql, invite.group_id, actor.participantId, 'member.joined', `${actor.displayName} joined`, {})
    return this.groupDetail(actor, invite.group_id)
  }

  async removeMember(actor: Actor, groupId: string, participantId: string) {
    await this.requireMember(actor, groupId)
    const ledger = await this.loadLedger(groupId)
    const net = participantNets(ledger.expenses, ledger.settlements).get(participantId) ?? 0
    if (!canRemove(net)) {
      throw new LedgerError('OUTSTANDING', 'Settle their balance before removing them. Forgiveness is a settlement with a note.')
    }
    const accounts = await this.sql.query<{ participant_id: string }>(
      `select m.participant_id from memberships m
       join participants p on p.id = m.participant_id
       where m.group_id = $1 and m.removed_at is null and p.user_id is not null`,
      [groupId],
    )
    const target = await this.mustParticipant(participantId)
    const history = await this.one<{ count: string }>(
      `select (select count(*) from expenses where group_id = $1) + (select count(*) from settlements where group_id = $1) as count`,
      [groupId],
    )
    if (target.user_id && accounts.length === 1 && accounts[0]?.participant_id === participantId && Number(history?.count ?? 0) > 0) {
      throw new LedgerError('LAST_MEMBER', 'The last person with an account cannot leave a group that has history. Archive it instead.')
    }
    await this.sql.query(`update memberships set removed_at = now() where group_id = $1 and participant_id = $2`, [groupId, participantId])
    await this.pauseRecurrencesFor(groupId, participantId)
    await this.activity(this.sql, groupId, actor.participantId, 'member.removed', `${target.display_name} left the group`, { participantId })
  }

  async setDefaults(actor: Actor, groupId: string, weights: { participantId: string; weight: number | null }[]) {
    await this.requireMember(actor, groupId)
    for (const entry of weights) {
      if (entry.weight !== null && (!Number.isInteger(entry.weight) || entry.weight < 0)) {
        throw new LedgerError('BAD_SPLIT', 'Weights must be zero or a positive integer')
      }
      await this.sql.query(
        `update memberships set default_weight = $1 where group_id = $2 and participant_id = $3 and removed_at is null`,
        [entry.weight, groupId, entry.participantId],
      )
    }
    await this.activity(this.sql, groupId, actor.participantId, 'group.defaults', `${actor.displayName} updated the default split`, {})
  }

  async createCategory(actor: Actor, groupId: string, label: string) {
    await this.requireMember(actor, groupId)
    const id = newId()
    await this.sql.query(`insert into categories (id, group_id, label, fixed) values ($1,$2,$3,false)`, [id, groupId, cleanName(label)])
    return { id, label: cleanName(label), fixed: false }
  }

  async renameCategory(actor: Actor, groupId: string, categoryId: string, label: string) {
    await this.requireMember(actor, groupId)
    const category = await this.mustCategory(categoryId, groupId)
    await this.sql.query(`update categories set label = $1 where id = $2`, [cleanName(label), category.id])
  }

  async deleteCategory(actor: Actor, groupId: string, categoryId: string) {
    await this.requireMember(actor, groupId)
    const category = await this.mustCategory(categoryId, groupId)
    if (category.fixed) throw new LedgerError('BAD_CATEGORY', 'Built-in categories can be renamed, not deleted')
    const used = await this.one<{ count: string }>(
      `select (select count(*) from expenses where category_id = $1) + (select count(*) from recurrences where category_id = $1) as count`,
      [categoryId],
    )
    if (Number(used?.count ?? 0) > 0) {
      throw new LedgerError('IN_USE', 'Move expenses off this category before deleting it')
    }
    await this.sql.query(`delete from categories where id = $1`, [categoryId])
  }

  async createExpense(actor: Actor, groupId: string, input: ExpenseInput) {
    const prepared = await this.prepareExpense(actor, groupId, input, null)
    const id = newId()
    await this.sql.tx(async (sql) => {
      await this.insertExpense(sql, id, groupId, prepared, null)
      await this.activity(sql, groupId, actor.participantId, 'expense.created', `${actor.displayName} added ${prepared.description}`, {
        expenseId: id,
        settlementMinor: prepared.settlementMinor,
      })
    })
    await this.notifyGroup(groupId, actor.participantId, prepared.description, `${actor.displayName} added an expense for ${formatMoney(prepared.settlementMinor, prepared.groupCurrency)}`)
    return { id }
  }

  async updateExpense(actor: Actor, groupId: string, expenseId: string, input: ExpenseInput) {
    await this.requireMember(actor, groupId)
    const current = await this.mustExpense(groupId, expenseId)
    if (current.deleted_at) throw new LedgerError('NOT_FOUND', 'Expense not found')
    if (input.version === undefined) throw new LedgerError('STALE', 'Reload this expense and try again')
    checkVersion(current.version, input.version)
    const prepared = await this.prepareExpense(actor, groupId, { ...expenseToInput(current), ...input }, current)
    await this.sql.tx(async (sql) => {
      await sql.query(`delete from expense_lines where expense_id = $1`, [expenseId])
      await sql.query(`delete from expense_items where expense_id = $1`, [expenseId])
      await sql.query(`delete from expense_extras where expense_id = $1`, [expenseId])
      await sql.query(
        `update expenses set expense_date=$1, description=$2, category_id=$3, kind=$4, original_currency=$5, original_minor=$6,
         settlement_minor=$7, rate=$8, overridden=$9, version=version+1 where id=$10`,
        [
          prepared.date,
          prepared.description,
          prepared.categoryId,
          prepared.kind,
          prepared.originalCurrency,
          prepared.originalMinor,
          prepared.settlementMinor,
          prepared.rate,
          prepared.overridden,
          expenseId,
        ],
      )
      await this.insertLines(sql, expenseId, prepared)
      await this.activity(sql, groupId, actor.participantId, 'expense.updated', `${actor.displayName} edited ${prepared.description}`, {
        expenseId,
        previous: { settlementMinor: current.settlement_minor, description: current.description },
      })
    })
    await this.notifyGroup(groupId, actor.participantId, prepared.description, `${actor.displayName} edited an expense`)
  }

  async deleteExpense(actor: Actor, groupId: string, expenseId: string) {
    await this.requireMember(actor, groupId)
    const current = await this.mustExpense(groupId, expenseId)
    await this.sql.query(`update expenses set deleted_at = now(), version = version + 1 where id = $1`, [expenseId])
    await this.activity(this.sql, groupId, actor.participantId, 'expense.deleted', `${actor.displayName} deleted ${current.description}`, {
      expenseId,
      settlementMinor: current.settlement_minor,
      description: current.description,
    })
    await this.notifyGroup(groupId, actor.participantId, current.description, `${actor.displayName} deleted an expense`)
  }

  async restoreExpense(actor: Actor, groupId: string, expenseId: string) {
    await this.requireMember(actor, groupId)
    const current = await this.mustExpense(groupId, expenseId)
    await this.sql.query(`update expenses set deleted_at = null, version = version + 1 where id = $1`, [expenseId])
    await this.activity(this.sql, groupId, actor.participantId, 'expense.restored', `${actor.displayName} restored ${current.description}`, { expenseId })
  }

  async moveExpense(actor: Actor, groupId: string, expenseId: string, destinationGroupId: string) {
    const source = await this.requireMember(actor, groupId)
    const destination = await this.requireMember(actor, destinationGroupId)
    const expense = await this.mustExpense(groupId, expenseId)
    if (expense.deleted_at) throw new LedgerError('NOT_FOUND', 'Expense not found')
    const people = expense.lines.map((line) => line.participant_id)
    const destMembers = (await this.memberRows(destinationGroupId)).filter((member) => !member.removed_at).map((member) => member.id)
    if (!canMove({
      actorInSource: true,
      actorInDestination: true,
      participantIds: [...new Set(people)],
      destinationMemberIds: destMembers,
    })) {
      throw new LedgerError('BAD_MOVE', 'Everyone on this expense has to already be in the destination group')
    }
    if (source.group.settlement_currency !== destination.group.settlement_currency) {
      throw new LedgerError('MIXED_CURRENCY', 'Move this into a group that uses the same currency, or enter it again there')
    }
    await this.sql.query(`update expenses set group_id = $1, version = version + 1 where id = $2`, [destinationGroupId, expenseId])
    await this.activity(this.sql, groupId, actor.participantId, 'expense.moved', `${actor.displayName} moved ${expense.description} out`, { expenseId })
    await this.activity(this.sql, destinationGroupId, actor.participantId, 'expense.moved', `${actor.displayName} moved ${expense.description} in`, { expenseId })
  }

  async createSettlement(actor: Actor, groupId: string, input: { fromId: string; toId: string; minor: number; date?: string; note?: string }) {
    const { group } = await this.requireMember(actor, groupId)
    const today = calendarDateInTimeZone(group.timezone, this.deps.now())
    const date = input.date ?? today
    assertNotFuture(date, today)
    assertAmount(input.minor, 'Settlement')
    if (input.fromId === input.toId) throw new LedgerError('BAD_SETTLEMENT', 'A settlement needs two different people')
    await this.assertCurrentMembers(groupId, [input.fromId, input.toId])
    const id = newId()
    await this.sql.query(
      `insert into settlements (id, group_id, settlement_date, from_participant_id, to_participant_id, minor, note)
       values ($1,$2,$3,$4,$5,$6,$7)`,
      [id, groupId, date, input.fromId, input.toId, input.minor, (input.note ?? '').slice(0, 500)],
    )
    const summary = `${await this.participantName(input.fromId)} paid ${await this.participantName(input.toId)} ${formatMoney(input.minor, group.settlement_currency)}`
    await this.activity(this.sql, groupId, actor.participantId, 'settlement.created', summary, { settlementId: id, minor: input.minor })
    await this.notifyGroup(groupId, actor.participantId, 'Settlement', summary)
    return { id }
  }

  async deleteSettlement(actor: Actor, groupId: string, settlementId: string) {
    await this.requireMember(actor, groupId)
    await this.sql.query(`update settlements set deleted_at = now(), version = version + 1 where id = $1 and group_id = $2`, [settlementId, groupId])
    await this.activity(this.sql, groupId, actor.participantId, 'settlement.deleted', `${actor.displayName} deleted a settlement`, { settlementId })
  }

  async restoreSettlement(actor: Actor, groupId: string, settlementId: string) {
    await this.requireMember(actor, groupId)
    await this.sql.query(`update settlements set deleted_at = null, version = version + 1 where id = $1 and group_id = $2`, [settlementId, groupId])
    await this.activity(this.sql, groupId, actor.participantId, 'settlement.restored', `${actor.displayName} restored a settlement`, { settlementId })
  }

  async moveSettlement(actor: Actor, groupId: string, settlementId: string, destinationGroupId: string) {
    const source = await this.requireMember(actor, groupId)
    const destination = await this.requireMember(actor, destinationGroupId)
    const row = await this.one<{ from_participant_id: string; to_participant_id: string; minor: number }>(
      `select from_participant_id, to_participant_id, minor from settlements where id = $1 and group_id = $2 and deleted_at is null`,
      [settlementId, groupId],
    )
    if (!row) throw new LedgerError('NOT_FOUND', 'Settlement not found')
    const destMembers = (await this.memberRows(destinationGroupId)).filter((member) => !member.removed_at).map((member) => member.id)
    if (!canMove({
      actorInSource: true,
      actorInDestination: true,
      participantIds: [row.from_participant_id, row.to_participant_id],
      destinationMemberIds: destMembers,
    })) {
      throw new LedgerError('BAD_MOVE', 'Both people have to already be in the destination group')
    }
    if (source.group.settlement_currency !== destination.group.settlement_currency) {
      throw new LedgerError('MIXED_CURRENCY', 'Move this into a group that uses the same currency')
    }
    await this.sql.query(`update settlements set group_id = $1, version = version + 1 where id = $2`, [destinationGroupId, settlementId])
    await this.activity(this.sql, groupId, actor.participantId, 'settlement.moved', `${actor.displayName} moved a settlement out`, { settlementId })
    await this.activity(this.sql, destinationGroupId, actor.participantId, 'settlement.moved', `${actor.displayName} moved a settlement in`, { settlementId })
  }

  async settleAll(actor: Actor, otherParticipantId: string, lines: { groupId: string; fromId: string; toId: string; minor: number }[]) {
    if (lines.length === 0) throw new LedgerError('BAD_SETTLEMENT', 'Nothing to settle')
    const currencies = new Set<string>()
    for (const line of lines) {
      const { group } = await this.requireMember(actor, line.groupId)
      currencies.add(group.settlement_currency)
      assertAmount(line.minor, 'Settlement')
      const pair = new Set([line.fromId, line.toId])
      if (!pair.has(actor.participantId) || !pair.has(otherParticipantId) || line.fromId === line.toId) {
        throw new LedgerError('BAD_SETTLEMENT', 'Each settlement has to be between you and that person')
      }
      await this.assertCurrentMembers(line.groupId, [line.fromId, line.toId])
    }
    if (currencies.size > 1) {
      throw new LedgerError('MIXED_CURRENCY', 'Settle each currency on its own')
    }
    await this.sql.tx(async (sql) => {
      for (const line of lines) {
        const group = await this.mustGroup(line.groupId)
        const today = calendarDateInTimeZone(group.timezone, this.deps.now())
        const id = newId()
        await sql.query(
          `insert into settlements (id, group_id, settlement_date, from_participant_id, to_participant_id, minor, note)
           values ($1,$2,$3,$4,$5,$6,$7)`,
          [id, line.groupId, today, line.fromId, line.toId, line.minor, 'Settled across groups'],
        )
        await this.activity(sql, line.groupId, actor.participantId, 'settlement.created', `${actor.displayName} settled across groups`, { settlementId: id, minor: line.minor })
      }
    })
  }

  async person(actor: Actor, otherParticipantId: string) {
    const mine = await this.sql.query<{ group_id: string }>(
      `select group_id from memberships where participant_id = $1 and removed_at is null`,
      [actor.participantId],
    )
    const lines = []
    for (const membership of mine) {
      const other = await this.membership(membership.group_id, otherParticipantId)
      if (!other || other.removed_at) continue
      const group = await this.mustGroup(membership.group_id)
      const ledger = await this.loadLedger(membership.group_id)
      const edge = paymentBetween(
        suggestedPayments(ledger.expenses, ledger.settlements, group.simplify),
        actor.participantId,
        otherParticipantId,
      )
      lines.push({
        groupId: group.id,
        groupName: group.name,
        currency: group.settlement_currency,
        archived: Boolean(group.archived_at),
        fromId: edge?.fromId ?? null,
        toId: edge?.toId ?? null,
        minor: edge?.minor ?? 0,
      })
    }
    const nonzero = lines.filter((line) => line.minor > 0)
    const currencies = new Set(nonzero.map((line) => line.currency))
    const other = await this.mustParticipant(otherParticipantId)
    return {
      participant: { id: other.id, name: other.display_name },
      lines,
      canSettleAll: nonzero.length > 0 && currencies.size === 1,
    }
  }

  async charts(actor: Actor, groupId: string, from?: string, to?: string) {
    const { group } = await this.requireMember(actor, groupId)
    const today = calendarDateInTimeZone(group.timezone, this.deps.now())
    const start = from ?? `${today.slice(0, 7)}-01`
    const ledger = await this.loadLedger(groupId)
    const end = to ?? today
    return this.chartPayload(group.settlement_currency, start, end, ledger.chartExpenses, actor.participantId)
  }

  async personalCharts(actor: Actor, from: string, to: string) {
    const memberships = await this.sql.query<{ group_id: string }>(
      `select group_id from memberships where participant_id = $1 and removed_at is null`,
      [actor.participantId],
    )
    const home: ChartExpense[] = []
    for (const membership of memberships) {
      const ledger = await this.loadLedger(membership.group_id)
      for (const expense of ledger.chartExpenses) {
        if (expense.deleted || expense.date < from || expense.date > to) continue
        let rate: string | null = null
        if (expense.settlementCurrency !== actor.homeCurrency && (expense.overridden || expense.originalCurrency !== actor.homeCurrency)) {
          rate = await this.deps.rateFor(expense.settlementCurrency, actor.homeCurrency, expense.date)
        }
        const money = {
          originalMinor: expense.originalMinor,
          originalCurrency: expense.originalCurrency,
          settlementMinor: expense.settlementMinor,
          settlementCurrency: expense.settlementCurrency,
          homeCurrency: actor.homeCurrency,
          overridden: expense.overridden,
          rateHomePerSettlement: rate,
        }
        home.push({
          ...expense,
          shares: personalChartShares({ ...money, shares: expense.shares }),
          payers: personalChartShares({ ...money, shares: expense.payers }),
        })
      }
    }
    return this.chartPayload(actor.homeCurrency, from, to, home, actor.participantId)
  }

  private async chartPayload(currency: string, from: string, to: string, expenses: ChartExpense[], participantId: string) {
    const labels = new Map((await this.sql.query<{ id: string; label: string }>(`select id, label from categories`)).map((row) => [row.id, row.label]))
    const named = <T extends { categoryId: string }>(row: T) => ({ ...row, label: labels.get(row.categoryId) ?? 'Other' })
    return {
      currency,
      from,
      to,
      categories: categoryTotals(expenses, participantId, from, to).map(named),
      months: monthlyTotals(expenses, participantId, from, to),
      entries: chartEntries(expenses, participantId, from, to).map(named),
    }
  }

  async search(actor: Actor, query: string) {
    const q = query.trim()
    if (!q) return []
    const like = `%${q.replace(/[%_]/g, '')}%`
    const expenses = await this.sql.query(
      `select e.id, e.group_id, g.name as group_name, e.description, e.expense_date, e.settlement_minor, g.settlement_currency
       from expenses e
       join groups g on g.id = e.group_id
       join memberships m on m.group_id = e.group_id and m.participant_id = $1 and m.removed_at is null
       where e.deleted_at is null and (
         e.description ilike $2
         or exists (select 1 from categories c where c.id = e.category_id and c.label ilike $2)
         or exists (
           select 1 from expense_lines el
           join participants p on p.id = el.participant_id
           where el.expense_id = e.id and p.display_name ilike $2
         )
       )
       order by e.expense_date desc
       limit 50`,
      [actor.participantId, like],
    )
    return expenses.map((row) => ({
      type: 'expense' as const,
      id: String(row.id),
      groupId: String(row.group_id),
      groupName: String(row.group_name),
      description: String(row.description),
      date: String(row.expense_date),
      minor: Number(row.settlement_minor),
      currency: String(row.settlement_currency),
    }))
  }

  async comments(actor: Actor, groupId: string, targetId: string) {
    await this.requireMember(actor, groupId)
    const rows = await this.sql.query(
      `select c.id, c.body, c.created_at, c.author_participant_id, p.display_name
       from comments c join participants p on p.id = c.author_participant_id
       where c.group_id = $1 and c.target_id = $2 and c.deleted_at is null
       order by c.created_at`,
      [groupId, targetId],
    )
    return rows.map((row) => ({
      id: String(row.id),
      body: String(row.body),
      authorId: String(row.author_participant_id),
      authorName: String(row.display_name),
      createdAt: String(row.created_at),
      mine: row.author_participant_id === actor.participantId,
    }))
  }

  async addComment(actor: Actor, groupId: string, targetType: string, targetId: string, body: string) {
    await this.requireMember(actor, groupId)
    const text = body.trim()
    if (!text) throw new LedgerError('BAD_COMMENT', 'Write a comment first')
    const id = newId()
    await this.sql.query(
      `insert into comments (id, group_id, target_type, target_id, author_participant_id, body) values ($1,$2,$3,$4,$5,$6)`,
      [id, groupId, targetType, targetId, actor.participantId, text.slice(0, 2000)],
    )
    const involved = await this.sql.query<{ user_id: string; participant_id: string }>(
      `select distinct p.user_id, p.id as participant_id
       from expense_lines el
       join participants p on p.id = el.participant_id
       where el.expense_id = $1 and p.user_id is not null`,
      [targetId],
    )
    for (const person of involved) {
      if (person.participant_id === actor.participantId || !person.user_id) continue
      await this.sql.query(
        `insert into notifications (id, user_id, kind, title, body, group_id) values ($1,$2,'comment',$3,$4,$5)`,
        [newId(), person.user_id, 'Comment', `${actor.displayName}: ${text.slice(0, 140)}`, groupId],
      )
    }
    return { id }
  }

  async deleteComment(actor: Actor, groupId: string, commentId: string) {
    await this.requireMember(actor, groupId)
    const comment = await this.one<{ author_participant_id: string }>(`select author_participant_id from comments where id = $1 and group_id = $2`, [commentId, groupId])
    if (!comment || comment.author_participant_id !== actor.participantId) {
      throw new LedgerError('FORBIDDEN', 'You can delete your own comments')
    }
    await this.sql.query(`update comments set deleted_at = now() where id = $1`, [commentId])
  }

  async activity(sql: Sql, groupId: string, actorParticipantId: string | null, kind: string, summary: string, payload: unknown) {
    await sql.query(
      `insert into activity (id, group_id, actor_participant_id, kind, summary, payload) values ($1,$2,$3,$4,$5,$6)`,
      [newId(), groupId, actorParticipantId, kind, summary, JSON.stringify(payload)],
    )
  }

  async listActivity(actor: Actor, groupId: string) {
    await this.requireMember(actor, groupId)
    const rows = await this.sql.query(
      `select id, kind, summary, payload, created_at from activity where group_id = $1 order by created_at desc limit 100`,
      [groupId],
    )
    return rows.map((row) => ({
      id: String(row.id),
      kind: String(row.kind),
      summary: String(row.summary),
      payload: JSON.parse(String(row.payload)),
      createdAt: String(row.created_at),
    }))
  }

  async nudge(actor: Actor, groupId: string, toParticipantId: string) {
    const { group } = await this.requireMember(actor, groupId)
    const today = calendarDateInTimeZone(group.timezone, this.deps.now())
    const ledger = await this.loadLedger(groupId)
    const edge = paymentBetween(suggestedPayments(ledger.expenses, ledger.settlements, group.simplify), actor.participantId, toParticipantId)
    if (!edge || edge.minor <= 0) throw new LedgerError('BAD_NUDGE', 'There is no outstanding balance to nudge')
    try {
      await this.sql.query(
        `insert into nudges (id, group_id, from_user_id, to_participant_id, nudge_date) values ($1,$2,$3,$4,$5)`,
        [newId(), groupId, actor.userId, toParticipantId, today],
      )
    } catch {
      throw new LedgerError('BAD_NUDGE', 'You already nudged this person in this group today')
    }
    const target = await this.mustParticipant(toParticipantId)
    const text = `${actor.displayName} nudged you about ${formatMoney(edge.minor, group.settlement_currency)} in ${group.name}`
    if (target.user_id) {
      await this.sql.query(
        `insert into notifications (id, user_id, kind, title, body, group_id) values ($1,$2,'nudge',$3,$4,$5)`,
        [newId(), target.user_id, 'Nudge', text, groupId],
      )
      const user = await this.mustUser(target.user_id)
      await this.sendEmail(user.email, `Divvy nudge for ${group.name}`, text)
    } else if (target.email) {
      await this.sendEmail(target.email, `Divvy nudge for ${group.name}`, text)
    }
  }

  async block(actor: Actor, otherUserId: string) {
    if (otherUserId === actor.userId) throw new LedgerError('BAD_BLOCK', 'You cannot block yourself')
    await this.sql.query(
      `insert into blocks (blocker_user_id, blocked_user_id) values ($1,$2) on conflict do nothing`,
      [actor.userId, otherUserId],
    )
  }

  async report(actor: Actor, targetType: string, targetId: string, reason: string) {
    const text = reason.trim()
    if (!text) throw new LedgerError('BAD_REPORT', 'Add a short reason')
    await this.sql.query(
      `insert into reports (id, reporter_user_id, target_type, target_id, reason) values ($1,$2,$3,$4,$5)`,
      [newId(), actor.userId, targetType, targetId, text.slice(0, 2000)],
    )
  }

  async suspend(userId: string) {
    await this.sql.query(`update users set suspended_at = now() where id = $1`, [userId])
    await this.sql.query(`delete from sessions where user_id = $1`, [userId])
  }

  async notifications(actor: Actor) {
    const rows = await this.sql.query(
      `select id, kind, title, body, group_id, read_at, created_at from notifications
       where user_id = $1 order by created_at desc limit 50`,
      [actor.userId],
    )
    return rows.map((row) => ({
      id: String(row.id),
      kind: String(row.kind),
      title: String(row.title),
      body: String(row.body),
      groupId: row.group_id ? String(row.group_id) : null,
      read: Boolean(row.read_at),
      createdAt: String(row.created_at),
    }))
  }

  async readNotifications(actor: Actor) {
    await this.sql.query(`update notifications set read_at = now() where user_id = $1 and read_at is null`, [actor.userId])
  }

  async exportGroup(actor: Actor, groupId: string) {
    await this.requireMember(actor, groupId)
    const group = await this.mustGroup(groupId)
    const ledger = await this.loadLedger(groupId)
    const header = ['type', 'date', 'description', 'category', 'original_minor', 'original_currency', 'rate', 'settlement_minor', 'settlement_currency', 'people']
    const lines = [header.join(',')]
    for (const expense of ledger.views) {
      lines.push([
        expense.kind,
        expense.date,
        expense.description,
        expense.categoryId,
        String(expense.originalMinor),
        expense.originalCurrency,
        expense.rate ?? '',
        String(expense.settlementMinor),
        group.settlement_currency,
        expense.shares.map((share) => `${share.name}:${share.minor}`).join('|'),
      ].map(csv).join(','))
    }
    for (const settlement of ledger.settlementViews.filter((row) => !row.deleted)) {
      lines.push(['settlement', settlement.date, settlement.note, '', '', '', '', String(settlement.minor), group.settlement_currency, `${settlement.fromId}->${settlement.toId}`].map(csv).join(','))
    }
    return lines.join('\n')
  }

  async addImage(actor: Actor, groupId: string, expenseId: string, contentType: string, dataBase64: string) {
    await this.requireMember(actor, groupId)
    await this.mustExpense(groupId, expenseId)
    if (dataBase64.length > 2_800_000) throw new LedgerError('BAD_IMAGE', 'That image is too large')
    const count = await this.one<{ count: string }>(`select count(*) as count from images where expense_id = $1`, [expenseId])
    if (Number(count?.count ?? 0) >= 4) throw new LedgerError('BAD_IMAGE', 'An expense can hold four images')
    const id = newId()
    await this.sql.query(`insert into images (id, expense_id, content_type, data_base64) values ($1,$2,$3,$4)`, [id, expenseId, contentType, dataBase64])
    return { id }
  }

  async createRecurrence(actor: Actor, groupId: string, input: {
    description: string
    categoryId?: string
    frequency: Frequency
    startDate: string
    endDate?: string | null
    settlementMinor: number
    payers: { participantId: string; minor: number }[]
    shares: { participantId: string; minor: number }[]
  }) {
    const { group } = await this.requireMember(actor, groupId)
    const today = calendarDateInTimeZone(group.timezone, this.deps.now())
    const next = nextOccurrence(input.startDate, input.frequency, today, input.endDate)
    if (!next) throw new LedgerError('BAD_DATE', 'That recurrence has no upcoming date')
    assertAmount(input.settlementMinor, 'Amount')
    assertPayers(input.settlementMinor, input.payers)
    const shareSum = input.shares.reduce((sum, share) => sum + share.minor, 0)
    if (shareSum !== input.settlementMinor) throw new LedgerError('UNBALANCED', 'Shares must add up to the total')
    assertInvolved(input.payers, input.shares)
    await this.assertCurrentMembers(groupId, [...input.payers.map((row) => row.participantId), ...input.shares.map((row) => row.participantId)])
    const id = newId()
    await this.sql.query(
      `insert into recurrences (id, group_id, description, category_id, kind, settlement_minor, payers, shares, frequency, start_date, next_date, end_date)
       values ($1,$2,$3,$4,'expense',$5,$6,$7,$8,$9,$10,$11)`,
      [
        id,
        groupId,
        cleanName(input.description),
        input.categoryId ?? DEFAULT_CATEGORY_ID,
        input.settlementMinor,
        JSON.stringify(input.payers),
        JSON.stringify(input.shares),
        input.frequency,
        input.startDate,
        next,
        input.endDate ?? null,
      ],
    )
    return { id, nextDate: next }
  }

  async tickRecurrences() {
    const groups = await this.sql.query<{ id: string; timezone: string; settlement_currency: string }>(
      `select id, timezone, settlement_currency from groups`,
    )
    for (const group of groups) {
      let today = '1970-01-01'
      try {
        today = calendarDateInTimeZone(group.timezone, this.deps.now())
      } catch {
        continue
      }
      const due = await this.sql.query(
        `select * from recurrences where group_id = $1 and paused = false and next_date <= $2`,
        [group.id, today],
      )
      for (const recurrence of due) {
        await this.postRecurrence(group, recurrence, today)
      }
    }
  }

  async seed() {
    const alex = await this.ensureUser('alex@demo.divvy', 'Alex')
    const jordan = await this.ensureUser('jordan@demo.divvy', 'Jordan')
    const alexActor = await this.actorFor(alex)
    const existing = await this.one<{ id: string }>(
      `select g.id from groups g
       join memberships m on m.group_id = g.id
       where g.name = 'Apartment' and m.participant_id = $1 and m.removed_at is null`,
      [alexActor.participantId],
    )
    if (!existing) {
      const created = await this.createGroup(alexActor, { name: 'Apartment', currency: 'USD', timezone: 'America/New_York' })
      const casey = await this.addPerson(alexActor, created.group.id, { displayName: 'Casey' })
      const jordanParticipant = (await this.one<{ id: string }>(`select id from participants where user_id = $1`, [jordan.id]))!
      await this.sql.query(`insert into memberships (group_id, participant_id, default_weight) values ($1,$2,1)`, [created.group.id, jordanParticipant.id])
      const members = await this.memberRows(created.group.id)
      const byName = Object.fromEntries(members.map((member) => [member.display_name, member.id]))
      const alexId = byName.Alex!
      const jordanId = byName.Jordan!
      const caseyId = byName.Casey!
      await this.setDefaults(alexActor, created.group.id, [
        { participantId: alexId, weight: 1 },
        { participantId: jordanId, weight: 1 },
        { participantId: caseyId, weight: 1 },
      ])
      await this.createExpense(alexActor, created.group.id, {
        description: 'September rent',
        date: '2026-09-01',
        categoryId: 'cat_rent',
        originalMinor: 200000,
        originalCurrency: 'USD',
        payers: [{ participantId: alexId, minor: 200000 }],
        split: { type: 'equal', participantIds: [alexId, jordanId, caseyId] },
      })
      await this.createExpense(alexActor, created.group.id, {
        description: 'Groceries',
        date: '2026-09-12',
        categoryId: 'cat_groceries',
        originalMinor: 8640,
        originalCurrency: 'USD',
        payers: [{ participantId: jordanId, minor: 8640 }],
        split: { type: 'equal', participantIds: [alexId, jordanId, caseyId] },
      })
      await this.createExpense(alexActor, created.group.id, {
        description: 'Dinner',
        date: '2026-09-20',
        categoryId: 'cat_dining',
        originalMinor: 9000,
        originalCurrency: 'USD',
        payers: [{ participantId: alexId, minor: 9000 }],
        split: { type: 'equal', participantIds: [alexId, jordanId] },
      })
      const weekend = await this.createGroup(alexActor, { name: 'Weekend', currency: 'USD', timezone: 'America/New_York' })
      await this.sql.query(`insert into memberships (group_id, participant_id) values ($1,$2)`, [weekend.group.id, jordanId])
      await this.createExpense(alexActor, weekend.group.id, {
        description: 'Concert tickets',
        date: '2026-09-18',
        categoryId: 'cat_entertainment',
        originalMinor: 8000,
        originalCurrency: 'USD',
        payers: [{ participantId: jordanId, minor: 8000 }],
        split: { type: 'equal', participantIds: [alexId, jordanId] },
      })
      const trip = await this.createGroup(alexActor, { name: 'Lisbon', currency: 'EUR', timezone: 'Europe/Lisbon' })
      await this.sql.query(`insert into memberships (group_id, participant_id) values ($1,$2)`, [trip.group.id, jordanId])
      await this.createExpense(alexActor, trip.group.id, {
        description: 'Hotel',
        date: '2026-09-04',
        categoryId: 'cat_travel',
        originalMinor: 20000,
        originalCurrency: 'EUR',
        payers: [{ participantId: alexId, minor: 20000 }],
        split: { type: 'equal', participantIds: [alexId, jordanId] },
      })
      const hotelRate = await this.deps.rateFor('EUR', 'USD', '2026-09-04')
      const hotelMinor = convertMinor(20000, 'EUR', hotelRate, 'USD')
      await this.createExpense(alexActor, created.group.id, {
        description: 'Lisbon hotel share',
        date: '2026-09-04',
        categoryId: 'cat_travel',
        originalMinor: 20000,
        originalCurrency: 'EUR',
        payers: [{ participantId: alexId, minor: hotelMinor }],
        split: { type: 'equal', participantIds: [alexId, jordanId] },
      })
    }
    await this.ensureRichSample(alexActor)
    const session = await this.createSession(alex.id)
    return { token: session, user: publicUser(alex) }
  }

  private async ensureRichSample(actor: Actor) {
    const apartment = await this.groupIdFor(actor, 'Apartment')
    const weekend = await this.groupIdFor(actor, 'Weekend')
    const lisbon = await this.groupIdFor(actor, 'Lisbon')
    if (!apartment) return
    const priya = await this.ensureMember(actor, apartment.id, 'Priya')
    const sam = await this.ensureMember(actor, apartment.id, 'Sam')
    const riley = await this.ensureMember(actor, apartment.id, 'Riley')
    const members = await this.memberRows(apartment.id)
    const idOf = Object.fromEntries(members.map((member) => [member.display_name, member.id]))
    const alex = idOf.Alex!
    const jordan = idOf.Jordan!
    const casey = idOf.Casey!
    const everyone = [alex, jordan, casey, priya, sam, riley]
    await this.ensureSampleExpense(actor, apartment.id, {
      description: 'July power bill',
      date: '2026-07-18',
      categoryId: 'cat_utilities',
      originalMinor: 15000,
      originalCurrency: 'USD',
      payers: [{ participantId: alex, minor: 6000 }, { participantId: priya, minor: 9000 }],
      split: { type: 'equal', participantIds: everyone },
    })
    await this.ensureSampleExpense(actor, apartment.id, {
      description: 'August train',
      date: '2026-08-08',
      categoryId: 'cat_transport',
      originalMinor: 8400,
      originalCurrency: 'USD',
      payers: [{ participantId: sam, minor: 8400 }],
      split: { type: 'equal', participantIds: [alex, sam, riley] },
    })
    await this.ensureSampleExpense(actor, apartment.id, {
      description: 'Birthday dinner',
      date: '2026-08-22',
      categoryId: 'cat_dining',
      originalMinor: 24000,
      originalCurrency: 'USD',
      payers: [{ participantId: riley, minor: 24000 }],
      split: {
        type: 'percent',
        parts: [
          { participantId: alex, bps: 2500 },
          { participantId: jordan, bps: 1500 },
          { participantId: casey, bps: 2000 },
          { participantId: priya, bps: 1500 },
          { participantId: sam, bps: 1500 },
          { participantId: riley, bps: 1000 },
        ],
      },
    })
    await this.ensureSampleExpense(actor, apartment.id, {
      description: 'September internet',
      date: '2026-09-08',
      categoryId: 'cat_utilities',
      originalMinor: 7200,
      originalCurrency: 'USD',
      payers: [{ participantId: casey, minor: 7200 }],
      split: {
        type: 'shares',
        parts: [
          { participantId: alex, weight: 2 },
          { participantId: jordan, weight: 2 },
          { participantId: casey, weight: 1 },
          { participantId: priya, weight: 1 },
          { participantId: sam, weight: 1 },
          { participantId: riley, weight: 1 },
        ],
      },
    })
    await this.ensureSampleExpense(actor, apartment.id, {
      description: 'Market run',
      date: '2026-09-15',
      categoryId: 'cat_groceries',
      originalMinor: 5400,
      originalCurrency: 'USD',
      payers: [{ participantId: jordan, minor: 5400 }],
      split: {
        type: 'exact',
        amounts: [
          { participantId: alex, minor: 1500 },
          { participantId: jordan, minor: 900 },
          { participantId: casey, minor: 900 },
          { participantId: priya, minor: 900 },
          { participantId: sam, minor: 600 },
          { participantId: riley, minor: 600 },
        ],
      },
    })
    await this.ensureSampleExpense(actor, apartment.id, {
      description: 'Airport shuttle',
      date: '2026-09-03',
      categoryId: 'cat_transport',
      originalMinor: 3600,
      originalCurrency: 'USD',
      payers: [{ participantId: priya, minor: 3600 }],
      split: { type: 'equal', participantIds: everyone },
    })
    await this.ensureSampleExpense(actor, apartment.id, {
      description: 'Security deposit back',
      date: '2026-09-21',
      categoryId: 'cat_rent',
      kind: 'reimbursement',
      originalMinor: 12000,
      originalCurrency: 'USD',
      payers: [{ participantId: alex, minor: 12000 }],
      split: { type: 'equal', participantIds: [alex, jordan, casey] },
    })
    const settled = await this.one<{ id: string }>(
      `select id from settlements where group_id = $1 and note = 'Sample settlement from Sam' and deleted_at is null`,
      [apartment.id],
    )
    if (!settled) {
      await this.createSettlement(actor, apartment.id, {
        fromId: sam,
        toId: alex,
        minor: 5000,
        date: '2026-09-10',
        note: 'Sample settlement from Sam',
      })
    }
    const rentRepeat = await this.one<{ id: string }>(
      `select id from recurrences where group_id = $1 and description = 'Monthly rent'`,
      [apartment.id],
    )
    if (!rentRepeat) {
      const share = 30000
      await this.createRecurrence(actor, apartment.id, {
        description: 'Monthly rent',
        categoryId: 'cat_rent',
        frequency: 'monthly',
        startDate: '2026-09-01',
        settlementMinor: share * everyone.length,
        payers: [{ participantId: alex, minor: share * everyone.length }],
        shares: everyone.map((participantId) => ({ participantId, minor: share })),
      })
    }
    if (weekend) {
      await this.ensureMembership(weekend.id, sam)
      await this.ensureSampleExpense(actor, weekend.id, {
        description: 'Cabin deposit',
        date: '2026-08-14',
        categoryId: 'cat_travel',
        originalMinor: 30000,
        originalCurrency: 'USD',
        payers: [{ participantId: alex, minor: 30000 }],
        split: { type: 'equal', participantIds: [alex, jordan, sam] },
      })
      await this.ensureSampleExpense(actor, weekend.id, {
        description: 'Gas',
        date: '2026-09-18',
        categoryId: 'cat_transport',
        originalMinor: 4500,
        originalCurrency: 'USD',
        payers: [{ participantId: jordan, minor: 4500 }],
        split: { type: 'shares', parts: [{ participantId: alex, weight: 1 }, { participantId: jordan, weight: 1 }, { participantId: sam, weight: 2 }] },
      })
    }
    if (lisbon) {
      const ines = await this.ensureMember(actor, lisbon.id, 'Ines')
      await this.ensureSampleExpense(actor, lisbon.id, {
        description: 'Pastelaria',
        date: '2026-09-05',
        categoryId: 'cat_dining',
        originalMinor: 8600,
        originalCurrency: 'EUR',
        payers: [{ participantId: alex, minor: 8600 }],
        split: {
          type: 'percent',
          parts: [
            { participantId: alex, bps: 5000 },
            { participantId: jordan, bps: 3000 },
            { participantId: ines, bps: 2000 },
          ],
        },
      })
      await this.ensureSampleExpense(actor, lisbon.id, {
        description: 'Museum tickets',
        date: '2026-09-06',
        categoryId: 'cat_entertainment',
        originalMinor: 2400,
        originalCurrency: 'EUR',
        payers: [{ participantId: jordan, minor: 1600 }, { participantId: ines, minor: 800 }],
        split: { type: 'equal', participantIds: [alex, jordan, ines] },
      })
    }
  }

  private async groupIdFor(actor: Actor, name: string) {
    return this.one<{ id: string }>(
      `select g.id from groups g
       join memberships m on m.group_id = g.id
       where m.participant_id = $1 and m.removed_at is null and g.name = $2`,
      [actor.participantId, name],
    )
  }

  private async ensureMember(actor: Actor, groupId: string, displayName: string) {
    const existing = await this.one<{ id: string }>(
      `select p.id from participants p
       join memberships m on m.participant_id = p.id
       where m.group_id = $1 and m.removed_at is null and p.display_name = $2`,
      [groupId, displayName],
    )
    if (existing) return existing.id
    const added = await this.addPerson(actor, groupId, { displayName })
    if (!('participantId' in added) || !added.participantId) throw new LedgerError('BAD_MEMBER', `Could not add ${displayName}`)
    return added.participantId
  }

  private async ensureMembership(groupId: string, participantId: string) {
    await this.sql.query(
      `insert into memberships (group_id, participant_id) values ($1,$2) on conflict do nothing`,
      [groupId, participantId],
    )
  }

  private async ensureSampleExpense(actor: Actor, groupId: string, input: ExpenseInput & { description: string }) {
    const found = await this.one<{ id: string }>(
      `select id from expenses where group_id = $1 and description = $2 and deleted_at is null`,
      [groupId, input.description],
    )
    if (found) return
    await this.createExpense(actor, groupId, input)
  }

  async outbox() {
    const rows = await this.sql.query(`select to_email, subject, body, created_at from outbound_emails order by created_at desc limit 20`)
    return rows
  }

  private async postRecurrence(
    group: { id: string; timezone: string; settlement_currency: string },
    recurrence: Record<string, unknown>,
    today: string,
  ) {
    const nextDate = String(recurrence.next_date)
    const start = String(recurrence.start_date)
    const frequency = String(recurrence.frequency) as Frequency
    const end = recurrence.end_date ? String(recurrence.end_date) : null
    if (nextDate < today) {
      const upcoming = nextOccurrence(start, frequency, today, end)
      await this.sql.query(`update recurrences set next_date = $1, paused = $2, pause_reason = $3 where id = $4`, [
        upcoming ?? nextDate,
        upcoming ? false : true,
        upcoming ? 'skipped_missed_dates' : 'ended',
        recurrence.id,
      ])
      return
    }
    const payers = JSON.parse(String(recurrence.payers)) as { participantId: string; minor: number }[]
    const shares = JSON.parse(String(recurrence.shares)) as { participantId: string; minor: number }[]
    const current = new Set((await this.memberRows(group.id)).filter((member) => !member.removed_at).map((member) => member.id))
    const needed = [...payers.map((row) => row.participantId), ...shares.map((row) => row.participantId)]
    if (needed.some((id) => !current.has(id)) || new Set(needed).size < 2) {
      await this.sql.query(`update recurrences set paused = true, pause_reason = $1 where id = $2`, ['member_removed', recurrence.id])
      return
    }
    const actor = await this.one<{ user_id: string; id: string }>(
      `select p.user_id, p.id from participants p
       join memberships m on m.participant_id = p.id
       where m.group_id = $1 and m.removed_at is null and p.user_id is not null limit 1`,
      [group.id],
    )
    if (!actor?.user_id) return
    const actorUser = await this.actorFor(await this.mustUser(actor.user_id))
    const created = await this.createExpense(actorUser, group.id, {
      description: String(recurrence.description),
      date: nextDate,
      categoryId: String(recurrence.category_id),
      originalMinor: Number(recurrence.settlement_minor),
      originalCurrency: group.settlement_currency,
      payers,
      split: { type: 'exact', amounts: shares.map((share) => ({ participantId: share.participantId, minor: share.minor })) },
    })
    await this.sql.query(`update expenses set recurrence_id = $1 where id = $2`, [recurrence.id, created.id])
    const upcoming = nextOccurrence(start, frequency, nextDate, end)
    await this.sql.query(`update recurrences set next_date = $1, paused = $2, pause_reason = null where id = $3`, [
      upcoming ?? nextDate,
      !upcoming,
      recurrence.id,
    ])
  }

  private async pauseRecurrencesFor(groupId: string, participantId: string) {
    const rows = await this.sql.query<{ id: string; payers: string; shares: string }>(
      `select id, payers, shares from recurrences where group_id = $1 and paused = false`,
      [groupId],
    )
    for (const row of rows) {
      const ids = [
        ...(JSON.parse(row.payers) as { participantId: string }[]),
        ...(JSON.parse(row.shares) as { participantId: string }[]),
      ].map((entry) => entry.participantId)
      if (ids.includes(participantId)) {
        await this.sql.query(`update recurrences set paused = true, pause_reason = 'member_removed' where id = $1`, [row.id])
      }
    }
  }

  private async changeCurrency(actor: Actor, group: GroupRow, nextCurrency: string) {
    const ledger = await this.loadLedger(group.id)
    const updates: { id: string; settlementMinor: number; rate: string | null; overridden: boolean }[] = []
    for (const expense of ledger.raw) {
      if (expense.deleted_at) continue
      const next = retargetSettlement({
        originalMinor: expense.original_minor,
        originalCurrency: expense.original_currency,
        settlementMinor: expense.settlement_minor,
        overridden: expense.overridden,
        rate: expense.rate,
        fromCurrency: group.settlement_currency,
        toCurrency: nextCurrency,
        rateOriginalToTarget: expense.original_currency === nextCurrency ? null : await this.deps.rateFor(expense.original_currency, nextCurrency, expense.expense_date),
        rateSettlementToTarget: await this.deps.rateFor(group.settlement_currency, nextCurrency, expense.expense_date),
      })
      const payers = scaleParts(expense.lines.filter((line) => line.role === 'payer').map((line) => ({ participantId: line.participant_id, minor: line.minor })), expense.settlement_minor, next.settlementMinor)
      const shares = scaleParts(expense.lines.filter((line) => line.role === 'share').map((line) => ({ participantId: line.participant_id, minor: line.minor })), expense.settlement_minor, next.settlementMinor)
      updates.push({ id: expense.id, ...next, })
      expense.scaledPayers = payers
      expense.scaledShares = shares
    }
    await this.sql.tx(async (sql) => {
      await sql.query(`update groups set settlement_currency = $1 where id = $2`, [nextCurrency, group.id])
      for (const update of updates) {
        const expense = ledger.raw.find((row) => row.id === update.id)!
        await sql.query(
          `update expenses set settlement_minor = $1, rate = $2, overridden = $3, version = version + 1 where id = $4`,
          [update.settlementMinor, update.rate, update.overridden, update.id],
        )
        await sql.query(`delete from expense_lines where expense_id = $1`, [update.id])
        for (const payer of expense.scaledPayers ?? []) {
          await sql.query(`insert into expense_lines (expense_id, participant_id, role, minor) values ($1,$2,'payer',$3)`, [update.id, payer.participantId, payer.minor])
        }
        for (const share of expense.scaledShares ?? []) {
          await sql.query(`insert into expense_lines (expense_id, participant_id, role, minor) values ($1,$2,'share',$3)`, [update.id, share.participantId, share.minor])
        }
      }
      await this.activity(sql, group.id, actor.participantId, 'group.currency', `${actor.displayName} changed the currency to ${nextCurrency}`, {})
    })
    await this.notifyGroup(group.id, actor.participantId, 'Currency change', `${actor.displayName} changed the group currency to ${nextCurrency}`)
  }

  private async prepareExpense(actor: Actor, groupId: string, input: ExpenseInput, current: ExpenseRecord | null) {
    const { group } = await this.requireMember(actor, groupId)
    const today = calendarDateInTimeZone(group.timezone, this.deps.now())
    const description = cleanName(input.description ?? current?.description ?? '')
    const date = input.date ?? current?.expense_date ?? today
    assertNotFuture(date, today)
    const kind = input.kind ?? current?.kind ?? 'expense'
    if (kind !== 'expense' && kind !== 'reimbursement') throw new LedgerError('BAD_EXPENSE', 'Unknown expense type')
    const originalCurrency = (input.originalCurrency ?? current?.original_currency ?? group.settlement_currency).toUpperCase()
    const originalMinor = input.originalMinor ?? current?.original_minor
    if (originalMinor === undefined) throw new LedgerError('BAD_AMOUNT', 'Enter an amount')
    assertAmount(originalMinor, 'Amount')
    const categoryId = input.categoryId ?? current?.category_id ?? DEFAULT_CATEGORY_ID
    await this.mustCategory(categoryId, groupId)
    const marketRate = originalCurrency === group.settlement_currency ? null : await this.deps.rateFor(originalCurrency, group.settlement_currency, date)
    const base = current
      ? {
          originalMinor: current.original_minor,
          originalCurrency: current.original_currency,
          settlementMinor: current.settlement_minor,
          overridden: current.overridden,
          date: current.expense_date,
          rate: current.rate,
        }
      : {
          ...fillFromRate({ originalMinor, originalCurrency, groupCurrency: group.settlement_currency, rate: marketRate }),
          originalMinor,
          originalCurrency,
          date,
        }
    const fields = nextMoneyFields({
      current: base,
      patch: {
        ...(input.originalMinor !== undefined ? { originalMinor: input.originalMinor } : {}),
        ...(input.originalCurrency !== undefined ? { originalCurrency } : {}),
        ...(input.date !== undefined ? { date } : {}),
        ...(input.settlementMinor !== undefined ? { settlementMinor: input.settlementMinor } : {}),
      },
      groupCurrency: group.settlement_currency,
      rateFor: () => marketRate,
    })
    let settlementMinor = fields.settlementMinor
    let shares = input.split ? computeShares(settlementMinor, input.split) : current?.lines.filter((line) => line.role === 'share').map((line) => ({ participantId: line.participant_id, minor: line.minor }))
    let itemRows: { label: string; minor: number; participantIds: string[] }[] | null = null
    let extras = { taxMinor: input.taxMinor ?? 0, tipMinor: input.tipMinor ?? 0, discountMinor: input.discountMinor ?? 0 }
    if (input.items) {
      const itemized = settleItemizedBill({
        items: input.items,
        ...extras,
        originalCurrency,
        groupCurrency: group.settlement_currency,
        rate: marketRate,
      })
      fields.originalMinor = itemized.originalMinor
      fields.originalCurrency = itemized.originalCurrency
      fields.settlementMinor = itemized.settlementMinor
      fields.rate = itemized.rate
      fields.overridden = false
      shares = itemized.shares
      itemRows = input.items
    }
    if (!shares || shares.length === 0) throw new LedgerError('BAD_SPLIT', 'Choose how to split this')
    const payers = input.payers ?? current?.lines.filter((line) => line.role === 'payer').map((line) => ({ participantId: line.participant_id, minor: line.minor }))
    if (!payers) throw new LedgerError('BAD_SPLIT', 'Choose who paid')
    if (payers.length === 1 && payers[0]) {
      payers[0] = { participantId: payers[0].participantId, minor: fields.settlementMinor }
    }
    assertPayers(fields.settlementMinor, payers)
    assertInvolved(payers, shares)
    await this.assertCurrentMembers(groupId, [...payers.map((row) => row.participantId), ...shares.map((row) => row.participantId)])
    return {
      description,
      date,
      kind,
      categoryId,
      originalCurrency: fields.originalCurrency,
      originalMinor: fields.originalMinor,
      settlementMinor: fields.settlementMinor,
      rate: fields.rate,
      overridden: fields.overridden,
      payers,
      shares,
      itemRows,
      extras,
      groupCurrency: group.settlement_currency,
    }
  }

  private async insertExpense(sql: Sql, id: string, groupId: string, prepared: Awaited<ReturnType<Repo['prepareExpense']>>, recurrenceId: string | null) {
    await sql.query(
      `insert into expenses (id, group_id, expense_date, description, category_id, kind, original_currency, original_minor, settlement_minor, rate, overridden, recurrence_id)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [
        id,
        groupId,
        prepared.date,
        prepared.description,
        prepared.categoryId,
        prepared.kind,
        prepared.originalCurrency,
        prepared.originalMinor,
        prepared.settlementMinor,
        prepared.rate,
        prepared.overridden,
        recurrenceId,
      ],
    )
    await this.insertLines(sql, id, prepared)
  }

  private async insertLines(sql: Sql, expenseId: string, prepared: { payers: { participantId: string; minor: number }[]; shares: { participantId: string; minor: number }[]; itemRows: { label: string; minor: number; participantIds: string[] }[] | null; extras: { taxMinor: number; tipMinor: number; discountMinor: number } }) {
    for (const payer of prepared.payers) {
      await sql.query(`insert into expense_lines (expense_id, participant_id, role, minor) values ($1,$2,'payer',$3)`, [expenseId, payer.participantId, payer.minor])
    }
    for (const share of prepared.shares) {
      await sql.query(`insert into expense_lines (expense_id, participant_id, role, minor) values ($1,$2,'share',$3)`, [expenseId, share.participantId, share.minor])
    }
    if (prepared.itemRows) {
      for (let index = 0; index < prepared.itemRows.length; index += 1) {
        const item = prepared.itemRows[index]!
        const itemId = newId()
        await sql.query(`insert into expense_items (id, expense_id, label, minor, position) values ($1,$2,$3,$4,$5)`, [itemId, expenseId, item.label, item.minor, index])
        for (const participantId of item.participantIds) {
          await sql.query(`insert into expense_item_people (item_id, participant_id) values ($1,$2)`, [itemId, participantId])
        }
      }
      await sql.query(
        `insert into expense_extras (expense_id, tax_minor, tip_minor, discount_minor) values ($1,$2,$3,$4)`,
        [expenseId, prepared.extras.taxMinor, prepared.extras.tipMinor, prepared.extras.discountMinor],
      )
    }
  }

  private async loadLedger(groupId: string) {
    const expenses = await this.sql.query(
      `select * from expenses where group_id = $1`,
      [groupId],
    )
    const lines = await this.sql.query<{ expense_id: string; participant_id: string; role: string; minor: number }>(
      `select el.expense_id, el.participant_id, el.role, el.minor
       from expense_lines el join expenses e on e.id = el.expense_id
       where e.group_id = $1`,
      [groupId],
    )
    const settlements = await this.sql.query(
      `select * from settlements where group_id = $1`,
      [groupId],
    )
    const names = await this.sql.query<{ id: string; display_name: string }>(
      `select distinct p.id, p.display_name from participants p
       join memberships m on m.participant_id = p.id where m.group_id = $1`,
      [groupId],
    )
    const nameOf = new Map(names.map((row) => [row.id, row.display_name]))
    const group = await this.mustGroup(groupId)
    const raw: ExpenseRecord[] = expenses.map((row) => ({
      id: String(row.id),
      group_id: groupId,
      expense_date: String(row.expense_date),
      description: String(row.description),
      category_id: String(row.category_id),
      kind: String(row.kind) as 'expense' | 'reimbursement',
      original_currency: String(row.original_currency),
      original_minor: Number(row.original_minor),
      settlement_minor: Number(row.settlement_minor),
      rate: row.rate ? String(row.rate) : null,
      overridden: row.overridden === true || row.overridden === 't' || row.overridden === 'true',
      version: Number(row.version),
      deleted_at: row.deleted_at ? String(row.deleted_at) : null,
      lines: lines.filter((line) => line.expense_id === row.id).map((line) => ({
        participant_id: line.participant_id,
        role: line.role,
        minor: Number(line.minor),
      })),
    }))
    const domainExpenses: LedgerExpense[] = raw.map(toDomainExpense)
    const domainSettlements: LedgerSettlement[] = settlements.map((row) => ({
      id: String(row.id),
      deleted: Boolean(row.deleted_at),
      fromId: String(row.from_participant_id),
      toId: String(row.to_participant_id),
      minor: Number(row.minor),
    }))
    return {
      raw,
      expenses: domainExpenses,
      settlements: domainSettlements,
      views: raw.map((expense) => ({
        id: expense.id,
        date: expense.expense_date,
        description: expense.description,
        categoryId: expense.category_id,
        kind: expense.kind,
        originalMinor: expense.original_minor,
        originalCurrency: expense.original_currency,
        settlementMinor: expense.settlement_minor,
        currency: group.settlement_currency,
        rate: expense.rate,
        overridden: expense.overridden,
        version: expense.version,
        deleted: Boolean(expense.deleted_at),
        payers: expense.lines.filter((line) => line.role === 'payer').map((line) => ({
          participantId: line.participant_id,
          name: nameOf.get(line.participant_id) ?? 'Unknown',
          minor: line.minor,
        })),
        shares: expense.lines.filter((line) => line.role === 'share').map((line) => ({
          participantId: line.participant_id,
          name: nameOf.get(line.participant_id) ?? 'Unknown',
          minor: line.minor,
        })),
      })),
      settlementViews: settlements.map((row) => ({
        id: String(row.id),
        date: String(row.settlement_date),
        fromId: String(row.from_participant_id),
        toId: String(row.to_participant_id),
        fromName: nameOf.get(String(row.from_participant_id)) ?? 'Unknown',
        toName: nameOf.get(String(row.to_participant_id)) ?? 'Unknown',
        minor: Number(row.minor),
        note: String(row.note),
        version: Number(row.version),
        deleted: Boolean(row.deleted_at),
      })),
      chartExpenses: raw.map((expense) => ({
        ...toDomainExpense(expense),
        categoryId: expense.category_id,
        date: expense.expense_date,
        originalMinor: expense.original_minor,
        originalCurrency: expense.original_currency,
        settlementMinor: expense.settlement_minor,
        settlementCurrency: group.settlement_currency,
        overridden: expense.overridden,
      })),
    }
  }

  private async balanceSummary(groupId: string, participantId: string) {
    const group = await this.mustGroup(groupId)
    const ledger = await this.loadLedger(groupId)
    const net = participantNets(ledger.expenses, ledger.settlements).get(participantId) ?? 0
    const members = (await this.memberRows(groupId)).filter((member) => !member.removed_at).map((member) => member.display_name)
    const latest = ledger.views
      .filter((expense) => !expense.deleted)
      .sort((a, b) => b.date.localeCompare(a.date))[0]
    return {
      summary: {
        id: group.id,
        name: group.name,
        currency: group.settlement_currency,
        timezone: group.timezone,
        archived: Boolean(group.archived_at),
        yourNetMinor: net,
        simplify: group.simplify,
        members,
        latest: latest ? { description: latest.description, date: latest.date } : null,
      },
    }
  }

  private async ensureUser(email: string, displayName?: string, existingUserId?: string) {
    if (existingUserId) {
      const current = await this.mustUser(existingUserId)
      return { ...current, email }
    }
    const found = await this.one<{ id: string; email: string; display_name: string; home_currency: string; suspended_at: string | null }>(
      `select id, email, display_name, home_currency, suspended_at from users where email = $1`,
      [email],
    )
    if (found) return found
    const id = newId()
    const local = email.split('@')[0] ?? 'friend'
    const name = cleanName(displayName || local.charAt(0).toUpperCase() + local.slice(1))
    await this.sql.query(`insert into users (id, email, display_name) values ($1,$2,$3)`, [id, email, name])
    await this.sql.query(`insert into participants (id, display_name, email, user_id) values ($1,$2,$3,$4)`, [newId(), name, email, id])
    return (await this.mustUser(id))
  }

  private async createSession(userId: string) {
    const token = newToken()
    const expires = new Date(this.deps.now().getTime() + 30 * 24 * 60 * 60 * 1000)
    await this.sql.query(`insert into sessions (token_hash, user_id, expires_at) values ($1,$2,$3)`, [hashToken(token), userId, expires.toISOString()])
    return token
  }

  private async actorFor(user: { id: string; email: string; display_name: string; home_currency: string }): Promise<Actor> {
    const participant = await this.one<{ id: string }>(`select id from participants where user_id = $1`, [user.id])
    if (!participant) throw new LedgerError('NOT_FOUND', 'Profile missing')
    return { userId: user.id, email: user.email, participantId: participant.id, displayName: user.display_name, homeCurrency: user.home_currency }
  }

  private async claimRows(email: string) {
    const rows = await this.sql.query<{ id: string; display_name: string; group_name: string }>(
      `select p.id, p.display_name, g.name as group_name
       from participants p
       join memberships m on m.participant_id = p.id
       join groups g on g.id = m.group_id
       where lower(p.email) = $1 and p.user_id is null and m.removed_at is null`,
      [email],
    )
    return rows.map((row) => ({ participantId: row.id, name: row.display_name, groupName: row.group_name }))
  }

  private async requireMember(actor: Actor, groupId: string) {
    const group = await this.mustGroup(groupId)
    const membership = await this.membership(groupId, actor.participantId)
    if (!membership || membership.removed_at) throw new LedgerError('FORBIDDEN', 'You are not in this group')
    return { group, membership }
  }

  private async mustGroup(groupId: string): Promise<GroupRow> {
    const group = await this.one<GroupRow>(
      `select id, name, settlement_currency, timezone, simplify, archived_at from groups where id = $1`,
      [groupId],
    )
    if (!group) throw new LedgerError('NOT_FOUND', 'Group not found')
    return { ...group, simplify: group.simplify === true, archived_at: group.archived_at ? String(group.archived_at) : null }
  }

  private async mustUser(userId: string) {
    const user = await this.one<{ id: string; email: string; display_name: string; home_currency: string; suspended_at: string | null }>(
      `select id, email, display_name, home_currency, suspended_at from users where id = $1`,
      [userId],
    )
    if (!user) throw new LedgerError('NOT_FOUND', 'Account not found')
    return user
  }

  private async mustParticipant(participantId: string) {
    const row = await this.one<{ id: string; display_name: string; email: string | null; user_id: string | null }>(
      `select id, display_name, email, user_id from participants where id = $1`,
      [participantId],
    )
    if (!row) throw new LedgerError('NOT_FOUND', 'Person not found')
    return row
  }

  private async participantName(participantId: string) {
    return (await this.mustParticipant(participantId)).display_name
  }

  private async membership(groupId: string, participantId: string) {
    return this.one<{ removed_at: string | null; default_weight: number | null }>(
      `select removed_at, default_weight from memberships where group_id = $1 and participant_id = $2`,
      [groupId, participantId],
    )
  }

  private async memberRows(groupId: string) {
    return this.sql.query<{ id: string; display_name: string; email: string | null; user_id: string | null; removed_at: string | null; default_weight: number | null; muted: boolean }>(
      `select p.id, p.display_name, p.email, p.user_id, m.removed_at, m.default_weight, m.muted
       from memberships m join participants p on p.id = m.participant_id
       where m.group_id = $1 order by p.display_name`,
      [groupId],
    )
  }

  private async mustExpense(groupId: string, expenseId: string) {
    const ledger = await this.loadLedger(groupId)
    const expense = ledger.raw.find((row) => row.id === expenseId)
    if (!expense) throw new LedgerError('NOT_FOUND', 'Expense not found')
    return expense
  }

  private async mustCategory(categoryId: string, groupId: string) {
    const category = await this.one<{ id: string; fixed: boolean; group_id: string | null }>(
      `select id, fixed, group_id from categories where id = $1 and (group_id is null or group_id = $2)`,
      [categoryId, groupId],
    )
    if (!category) throw new LedgerError('BAD_CATEGORY', 'Pick a category')
    return category
  }

  private async assertCurrentMembers(groupId: string, participantIds: string[]) {
    const members = new Set((await this.memberRows(groupId)).filter((member) => !member.removed_at).map((member) => member.id))
    for (const participantId of new Set(participantIds)) {
      if (!members.has(participantId)) throw new LedgerError('BAD_MEMBER', 'Everyone on this entry has to be in the group')
    }
  }

  private async assertInviteCap(userId: string) {
    const count = await this.one<{ count: string }>(
      `select count(*) as count from invites where created_by_user_id = $1 and created_at > now() - interval '1 day'`,
      [userId],
    )
    if (Number(count?.count ?? 0) >= 50) throw new LedgerError('RATE_LIMIT', 'Invite limit reached for today')
  }

  private async insertInvite(groupId: string, email: string, userId: string) {
    const token = newToken()
    const expires = new Date(this.deps.now().getTime() + 14 * 24 * 60 * 60 * 1000)
    await this.sql.query(
      `insert into invites (id, group_id, email, token_hash, expires_at, created_by_user_id) values ($1,$2,$3,$4,$5,$6)`,
      [newId(), groupId, email, hashToken(token), expires.toISOString(), userId],
    )
    return token
  }

  private async mustInvite(token: string) {
    const invite = await this.one<{ id: string; group_id: string; email: string; expires_at: string; accepted_at: string | null }>(
      `select id, group_id, email, expires_at, accepted_at from invites where token_hash = $1`,
      [hashToken(token)],
    )
    if (!invite || invite.accepted_at || new Date(invite.expires_at).getTime() < this.deps.now().getTime()) {
      throw new LedgerError('BAD_TOKEN', 'That invite is no longer valid')
    }
    return invite
  }

  private async isBlocked(a: string, b: string) {
    const row = await this.one(
      `select 1 as ok from blocks where (blocker_user_id = $1 and blocked_user_id = $2) or (blocker_user_id = $2 and blocked_user_id = $1)`,
      [a, b],
    )
    return Boolean(row)
  }

  private async notifyGroup(groupId: string, actorParticipantId: string, title: string, body: string) {
    const group = await this.mustGroup(groupId)
    if (group.archived_at) return
    const members = await this.sql.query<{ user_id: string; participant_id: string; muted: boolean }>(
      `select p.user_id, p.id as participant_id, m.muted
       from memberships m join participants p on p.id = m.participant_id
       where m.group_id = $1 and m.removed_at is null and p.user_id is not null`,
      [groupId],
    )
    for (const member of members) {
      if (member.participant_id === actorParticipantId || member.muted || !member.user_id) continue
      await this.sql.query(
        `insert into notifications (id, user_id, kind, title, body, group_id) values ($1,$2,'group',$3,$4,$5)`,
        [newId(), member.user_id, title, body, groupId],
      )
    }
  }

  private async sendEmail(to: string, subject: string, body: string) {
    await this.sql.query(`insert into outbound_emails (id, to_email, subject, body) values ($1,$2,$3,$4)`, [newId(), to, subject, body])
  }

  private async merge(sql: Sql, sourceId: string, targetId: string) {
    if (sourceId === targetId) return
    const source = await sql.query<{ email: string | null }>(`select email from participants where id = $1`, [sourceId])
    const memberships = await sql.query<{ group_id: string; removed_at: string | null; default_weight: number | null }>(
      `select group_id, removed_at, default_weight from memberships where participant_id = $1`,
      [sourceId],
    )
    for (const membership of memberships) {
      const existing = await sql.query<{ removed_at: string | null }>(
        `select removed_at from memberships where group_id = $1 and participant_id = $2`,
        [membership.group_id, targetId],
      )
      if (existing[0]) {
        if (existing[0].removed_at && !membership.removed_at) {
          await sql.query(`update memberships set removed_at = null where group_id = $1 and participant_id = $2`, [membership.group_id, targetId])
        }
        await sql.query(`delete from memberships where group_id = $1 and participant_id = $2`, [membership.group_id, sourceId])
      } else {
        await sql.query(`update memberships set participant_id = $1 where group_id = $2 and participant_id = $3`, [targetId, membership.group_id, sourceId])
      }
    }
    const lines = await sql.query<{ expense_id: string; role: string; minor: number }>(
      `select expense_id, role, minor from expense_lines where participant_id = $1`,
      [sourceId],
    )
    for (const line of lines) {
      const clash = await sql.query(`select 1 as ok from expense_lines where expense_id = $1 and participant_id = $2 and role = $3`, [line.expense_id, targetId, line.role])
      if (clash[0]) {
        await sql.query(`update expense_lines set minor = minor + $1 where expense_id = $2 and participant_id = $3 and role = $4`, [Number(line.minor), line.expense_id, targetId, line.role])
        await sql.query(`delete from expense_lines where expense_id = $1 and participant_id = $2 and role = $3`, [line.expense_id, sourceId, line.role])
      } else {
        await sql.query(`update expense_lines set participant_id = $1 where expense_id = $2 and participant_id = $3 and role = $4`, [targetId, line.expense_id, sourceId, line.role])
      }
    }
    await sql.query(`update settlements set from_participant_id = $1 where from_participant_id = $2`, [targetId, sourceId])
    await sql.query(`update settlements set to_participant_id = $1 where to_participant_id = $2`, [targetId, sourceId])
    await sql.query(`update settlements set deleted_at = now() where from_participant_id = to_participant_id and deleted_at is null`)
    await sql.query(`update comments set author_participant_id = $1 where author_participant_id = $2`, [targetId, sourceId])
    await sql.query(`update activity set actor_participant_id = $1 where actor_participant_id = $2`, [targetId, sourceId])
    const email = source[0]?.email
    if (email) {
      const target = await sql.query<{ email: string | null }>(`select email from participants where id = $1`, [targetId])
      if (target[0] && !target[0].email) {
        await sql.query(`update participants set email = $1 where id = $2`, [email, targetId])
      }
    }
    await sql.query(`delete from participants where id = $1`, [sourceId])
  }
}

type GroupRow = {
  id: string
  name: string
  settlement_currency: string
  timezone: string
  simplify: boolean
  archived_at: string | null
}

type ExpenseRecord = {
  id: string
  group_id: string
  expense_date: string
  description: string
  category_id: string
  kind: 'expense' | 'reimbursement'
  original_currency: string
  original_minor: number
  settlement_minor: number
  rate: string | null
  overridden: boolean
  version: number
  deleted_at: string | null
  lines: { participant_id: string; role: string; minor: number }[]
  scaledPayers?: { participantId: string; minor: number }[]
  scaledShares?: { participantId: string; minor: number }[]
}

function toDomainExpense(expense: ExpenseRecord): LedgerExpense {
  return {
    id: expense.id,
    deleted: Boolean(expense.deleted_at),
    kind: expense.kind,
    payers: expense.lines.filter((line) => line.role === 'payer').map((line) => ({ participantId: line.participant_id, minor: line.minor })),
    shares: expense.lines.filter((line) => line.role === 'share').map((line) => ({ participantId: line.participant_id, minor: line.minor })),
  }
}

function expenseToInput(expense: ExpenseRecord): ExpenseInput {
  return {
    description: expense.description,
    date: expense.expense_date,
    categoryId: expense.category_id,
    kind: expense.kind,
    originalMinor: expense.original_minor,
    originalCurrency: expense.original_currency,
    settlementMinor: expense.settlement_minor,
    payers: expense.lines.filter((line) => line.role === 'payer').map((line) => ({ participantId: line.participant_id, minor: line.minor })),
    split: {
      type: 'exact',
      amounts: expense.lines.filter((line) => line.role === 'share').map((line) => ({ participantId: line.participant_id, minor: line.minor })),
    },
  }
}

function scaleParts(parts: { participantId: string; minor: number }[], fromTotal: number, toTotal: number) {
  if (fromTotal === toTotal) return parts
  if (fromTotal === 0) return parts.map((part, index) => ({ ...part, minor: index === 0 ? toTotal : 0 }))
  const weights = parts.map((part) => ({ id: part.participantId, weight: part.minor }))
  const allocated = computeShares(toTotal, { type: 'shares', parts: weights.map((row) => ({ participantId: row.id, weight: row.weight })) })
  return allocated
}

function publicGroup(group: GroupRow) {
  return {
    id: group.id,
    name: group.name,
    currency: group.settlement_currency,
    timezone: group.timezone,
    simplify: group.simplify,
    archived: Boolean(group.archived_at),
  }
}

function publicMember(member: { id: string; display_name: string; email: string | null; user_id: string | null; removed_at: string | null; default_weight: number | null; muted: boolean }) {
  return {
    id: member.id,
    name: member.display_name,
    email: member.email,
    hasAccount: Boolean(member.user_id),
    removed: Boolean(member.removed_at),
    defaultWeight: member.default_weight,
    muted: member.muted === true,
  }
}

function publicUser(user: { id: string; email: string; display_name: string; home_currency: string }) {
  return { id: user.id, email: user.email, displayName: user.display_name, homeCurrency: user.home_currency }
}

function normalizeEmail(email: string) {
  const normalized = email.trim().toLowerCase()
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) throw new LedgerError('BAD_EMAIL', 'Enter a valid email')
  return normalized
}

function cleanName(value: string) {
  const name = value.trim()
  if (!name || name.length > 80) throw new LedgerError('BAD_NAME', 'Use a name under 80 characters')
  return name
}

function csv(value: string) {
  if (/[",\n]/.test(value)) return `"${value.replaceAll('"', '""')}"`
  return value
}
