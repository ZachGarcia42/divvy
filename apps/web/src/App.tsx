import { calendarDateInTimeZone, computeShares, formatMoney, parseMajor, startingSplit, type SplitSpec } from '@divvy/domain'
import { useEffect, useState, type FormEvent } from 'react'
import { Link, NavLink, Navigate, Route, Routes, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { api, ApiError, type GroupDetail } from './api.ts'
import { SpendingChart, categoryColor, entriesOf, type ChartResponse } from './charts.tsx'
import { DebtFlow } from './debt-flow.tsx'
import { chooseTheme, themeChoice, type ThemeChoice } from './theme.ts'

type Me = { userId: string; email: string; participantId: string; displayName: string; homeCurrency: string }

export function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/invite/:token" element={<InvitePage />} />
      <Route path="/*" element={<Authed />} />
    </Routes>
  )
}

function Authed() {
  const [me, setMe] = useState<Me | null | undefined>(undefined)
  useEffect(() => {
    api<Me | null>('/api/me').then((user) => setMe(user ?? null)).catch(() => setMe(null))
  }, [])
  if (me === undefined) return <p className="wrap">Loading…</p>
  if (!me) return <Navigate to="/login" replace />
  return (
    <div className="app">
      <header className="top">
        <Link className="brand" to="/"><span className="brand-mark" aria-hidden="true">D</span>Divvy</Link>
        <nav className="nav">
          <NavLink to="/" end>Groups</NavLink>
          <NavLink to="/charts">Charts</NavLink>
          <NavLink to="/search">Search</NavLink>
          <NavLink to="/settings">Settings</NavLink>
          <button className="text-button" onClick={async () => { await api('/api/auth/logout', { method: 'POST' }); location.href = '/login' }}>Sign out</button>
        </nav>
      </header>
      <Routes>
        <Route path="/" element={<HomePage me={me} />} />
        <Route path="/charts" element={<ChartsPage />} />
        <Route path="/groups/:id" element={<GroupPage />} />
        <Route path="/groups/:id/expenses/new" element={<ExpensePage />} />
        <Route path="/people/:id" element={<PersonPage />} />
        <Route path="/search" element={<SearchPage />} />
        <Route path="/settings" element={<SettingsPage me={me} />} />
      </Routes>
    </div>
  )
}

function LoginPage() {
  const navigate = useNavigate()
  const [email, setEmail] = useState('')
  const [devToken, setDevToken] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const token = new URLSearchParams(location.search).get('token')

  useEffect(() => {
    if (!token) return
    api('/api/auth/verify', { method: 'POST', body: JSON.stringify({ token }) })
      .then(() => navigate('/'))
      .catch((reason: Error) => setError(reason.message))
  }, [token, navigate])

  return (
    <div className="login">
      <form className="panel stack" onSubmit={async (event) => {
        event.preventDefault()
        setError(null)
        try {
          const result = await api<{ devToken?: string }>('/api/auth/magic-link', { method: 'POST', body: JSON.stringify({ email }) })
          setDevToken(result.devToken ?? null)
        } catch (reason) {
          setError(reason instanceof Error ? reason.message : 'Could not send the link')
        }
      }}>
        <h1><span className="brand-mark" aria-hidden="true">D</span>Divvy</h1>
        <p className="lede">A shared ledger for rent, trips, and the dinners in between. It records who paid. It never moves the money.</p>
        <label>Email<input value={email} onChange={(event) => setEmail(event.target.value)} type="email" required /></label>
        {error && <div className="error">{error}</div>}
        <button className="primary" type="submit">Email me a sign-in link</button>
        {devToken && <button className="secondary" type="button" onClick={async () => {
          await api('/api/auth/verify', { method: 'POST', body: JSON.stringify({ token: devToken }) })
          navigate('/')
        }}>Continue</button>}
        <button className="secondary" type="button" onClick={async () => {
          await api('/api/dev/seed', { method: 'POST' })
          navigate('/')
        }}>Open the sample apartment</button>
      </form>
    </div>
  )
}

function HomePage({ me }: { me: Me }) {
  const [data, setData] = useState<Awaited<ReturnType<typeof loadHome>> | null>(null)
  const [charts, setCharts] = useState<ChartResponse | null>(null)
  const [chartError, setChartError] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [currency, setCurrency] = useState(me.homeCurrency)
  const [error, setError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const navigate = useNavigate()
  useEffect(() => {
    if (!creating) return
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') setCreating(false) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [creating])
  const today = calendarDateInTimeZone(Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC', new Date())
  useEffect(() => {
    loadHome().then(setData).catch((reason: Error) => setError(reason.message))
    api<ChartResponse>('/api/me/charts?from=0001-01-01&to=9999-12-31').then(setCharts).catch((reason: Error) => setChartError(reason.message))
  }, [])
  if (!data) return <p className="wrap">{error ?? 'Loading…'}</p>
  const active = data.groups.filter((group) => !group.archived)
  const archived = data.groups.filter((group) => group.archived)
  const monthShare = charts ? shareThisMonth(charts, today) : null
  return (
    <div className="wrap">
      <div className="stage stack">
        <section className="hero">
          <p className="kicker">Groups</p>
          <h1 className={tone(data.estimate?.minor ?? 0)}>{me.displayName.split(' ')[0]}, {headline(data.estimate)}</h1>
          {data.estimate?.approximate && <p className="muted">That total mixes currencies at today’s rate. It is an estimate, not something you settle.</p>}
        </section>
        <Link className="spend-teaser" to="/charts">
          <span>Spending this month</span>
          <strong className="money">{monthShare == null ? (chartError ? 'Charts' : '…') : formatMoney(monthShare, charts?.currency ?? me.homeCurrency)}</strong>
        </Link>
        {chartError && <div className="error">{chartError}</div>}
        <div className="group-list">
          {active.map((group) => <GroupCard key={group.id} group={group} />)}
          {active.length === 0 && <p className="muted empty">No groups yet.</p>}
        </div>
        {archived.length > 0 && <section className="stack"><h2>Archived</h2><div className="group-list">{archived.map((group) => <GroupCard key={group.id} group={group} />)}</div></section>}
      </div>
      <button className="fab" type="button" onClick={() => { setError(null); setCreating(true) }}>New group</button>
      {creating && (
        <div className="sheet-backdrop" onMouseDown={() => setCreating(false)}>
          <form className="panel stack sheet" role="dialog" aria-labelledby="new-group-title" onMouseDown={(event) => event.stopPropagation()} onSubmit={async (event) => {
            event.preventDefault()
            setError(null)
            try {
              const created = await api<GroupDetail>('/api/groups', {
                method: 'POST',
                body: JSON.stringify({ name, currency, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC' }),
              })
              navigate(`/groups/${created.group.id}`)
            } catch (reason) {
              setError(reason instanceof Error ? reason.message : 'Could not create the group')
            }
          }}>
            <div className="row">
              <h2 id="new-group-title">Start a group</h2>
              <button className="text-button" type="button" onClick={() => setCreating(false)}>Close</button>
            </div>
            <label>Name<input value={name} onChange={(event) => setName(event.target.value)} required autoFocus placeholder="Apartment, trip, dinner…" /></label>
            <label>Currency<select value={currency} onChange={(event) => setCurrency(event.target.value)}>{['USD', 'EUR', 'GBP', 'CAD', 'JPY'].map((code) => <option key={code}>{code}</option>)}</select></label>
            {error && <div className="error">{error}</div>}
            <button className="primary" type="submit">Create group</button>
          </form>
        </div>
      )}
    </div>
  )
}

function GroupCard({ group }: { group: HomeGroup }) {
  const balance = balanceParts(group.yourNetMinor, group.currency)
  return (
    <Link className="card group-row" to={`/groups/${group.id}`}>
      <span className="avatar" style={avatarStyle(group.name)} aria-hidden="true">{group.name.slice(0, 1).toUpperCase()}</span>
      <span className="group-copy">
        <span className="group-name">{group.name}</span>
        <span className="group-sub">{peopleLine(group.members ?? [])}</span>
        {group.latest && <span className="group-latest">{shortDate(group.latest.date)} · {group.latest.description}</span>}
      </span>
      <span className={`group-balance ${tone(group.yourNetMinor)}`}>
        <span>{balance.label}</span>
        <strong>{balance.amount}</strong>
      </span>
    </Link>
  )
}

function ChartsPage() {
  const [charts, setCharts] = useState<ChartResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const today = calendarDateInTimeZone(Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC', new Date())
  useEffect(() => {
    api<ChartResponse>('/api/me/charts?from=0001-01-01&to=9999-12-31').then(setCharts).catch((reason: Error) => setError(reason.message))
  }, [])
  return (
    <div className="wrap stack">
      <section className="hero">
        <p className="kicker">Insights</p>
        <h1>Where the money went</h1>
        <p className="muted">Your share across every group, including archived ones.</p>
      </section>
      {error && <div className="error">{error}</div>}
      {charts ? (
        <SpendingChart currency={charts.currency} entries={entriesOf(charts, today)} today={today} scope="across your groups" note="Other currencies are converted into your home currency. The ring is your share, not the full bill." />
      ) : (
        !error && <section className="chart-card"><h2>Spending</h2><p className="muted">Loading charts…</p></section>
      )}
    </div>
  )
}

function GroupPage() {
  const { id = '' } = useParams()
  const [detail, setDetail] = useState<GroupDetail | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [personName, setPersonName] = useState('')
  const [chartBody, setChartBody] = useState<ChartResponse | null>(null)
  const [chartError, setChartError] = useState<string | null>(null)
  const [tab, setTab] = useState<'activity' | 'charts' | 'settings'>('activity')
  const reload = () => {
    api<ChartResponse>(`/api/groups/${id}/charts?from=0001-01-01&to=9999-12-31`).then(setChartBody).catch((reason: Error) => setChartError(reason.message))
    return api<GroupDetail>(`/api/groups/${id}`).then(setDetail)
  }
  useEffect(() => {
    setChartBody(null)
    setChartError(null)
    reload().catch((reason: Error) => setError(reason.message))
  }, [id])
  if (!detail) return <p className="wrap">{error ?? 'Loading…'}</p>
  const you = detail.nets.find((net) => net.participantId === detail.yourParticipantId)
  const names = new Map(detail.members.map((member) => [member.id, member.name]))
  const today = calendarDateInTimeZone(detail.group.timezone, new Date())
  return (
    <div className="wrap">
      <div className="stage stack">
      <div className="row">
        <div>
          <p className="kicker">{detail.group.currency} · {detail.group.simplify ? 'Simplified' : 'Direct debts'}</p>
          <h1>{detail.group.name}</h1>
          <p className={((you?.netMinor ?? 0) >= 0) ? 'ahead money balance' : 'owed money balance'}>{signed(you?.netMinor ?? 0, detail.currency)}</p>
        </div>
        <Link className="button" to={`/groups/${id}/expenses/new`}>Add expense</Link>
      </div>
      <div className="tabs" role="tablist">
        {(['activity', 'charts', 'settings'] as const).map((choice) => (
          <button key={choice} type="button" role="tab" aria-selected={tab === choice} className={tab === choice ? 'on' : ''} onClick={() => setTab(choice)}>{choice[0]!.toUpperCase() + choice.slice(1)}</button>
        ))}
      </div>
      {tab === 'activity' && <>
      <div className="chips">
        {detail.nets.map((net) => (
          <div className={net.netMinor < 0 ? 'chip owe' : net.netMinor > 0 ? 'chip ahead' : 'chip'} key={net.participantId}>
            <span>{net.name}</span>
            <strong>{net.netMinor === 0 ? 'Settled' : formatMoney(net.netMinor, detail.currency)}</strong>
          </div>
        ))}
      </div>
      {error && <div className="error">{error}</div>}
      <section className="panel stack">
        <h2>Who pays whom</h2>
        {detail.payments.length === 0 && <p className="muted">This group is settled.</p>}
        {detail.payments.map((payment) => (
          <div className="row" key={`${payment.fromId}-${payment.toId}`}>
            <span>{names.get(payment.fromId)} pays {names.get(payment.toId)}</span>
            <span className="actions">
              <strong className="money">{formatMoney(payment.minor, detail.currency)}</strong>
              <button className="secondary" onClick={async () => {
                await api(`/api/groups/${id}/settlements`, { method: 'POST', body: JSON.stringify({ fromId: payment.fromId, toId: payment.toId, minor: payment.minor, note: 'Recorded in Divvy' }) })
                await reload()
              }}>Record</button>
              <Link to={`/people/${payment.fromId === detail.yourParticipantId ? payment.toId : payment.fromId}`}>All groups</Link>
            </span>
          </div>
        ))}
        <button className="secondary" onClick={async () => {
          try {
            await api(`/api/groups/${id}`, { method: 'PATCH', body: JSON.stringify({ simplify: !detail.group.simplify }) })
          } catch (reason) {
            if (reason instanceof ApiError && (reason as ApiError & { code?: string }).code === 'CONFIRM' && confirm(reason.message)) {
              await api(`/api/groups/${id}`, { method: 'PATCH', body: JSON.stringify({ simplify: false, confirm: true }) })
            } else {
              setError(reason instanceof Error ? reason.message : 'Could not update simplify')
              return
            }
          }
          await reload()
        }}>{detail.group.simplify ? 'Show direct debts' : 'Simplify debts'}</button>
        {detail.payments.length > 0 && <button className="linkish" type="button" onClick={() => setTab('charts')}>Show the debt flow</button>}
      </section>
      <section className="panel stack">
        <h2>Expenses</h2>
        {detail.expenses.map((expense) => (
          <div className="row" key={expense.id}>
            <div className="expense-title">
              <span className="swatch" style={{ background: categoryColor(expense.categoryId) }} />
              <div><strong>{expense.description}</strong><div className="muted">{expense.date} · {labelOf(detail, expense.categoryId)} · {expense.payers.map((payer) => payer.name).join(', ')} paid</div></div>
            </div>
            <span className="actions">
              <span className="money">
                {formatMoney(expense.settlementMinor, detail.currency)}
                {expense.originalCurrency !== detail.currency && <div className="muted">{formatMoney(expense.originalMinor, expense.originalCurrency)}</div>}
              </span>
              <button className="secondary" onClick={async () => {
                await api(`/api/groups/${id}/expenses/${expense.id}`, { method: 'DELETE' })
                await reload()
              }}>Delete</button>
            </span>
          </div>
        ))}
        {detail.settlements.map((settlement) => (
          <div className="row" key={settlement.id}>
            <div><strong>{settlement.fromName} paid {settlement.toName}</strong><div className="muted">{settlement.date}{settlement.note ? ` · ${settlement.note}` : ''}</div></div>
            <span className="money">{formatMoney(settlement.minor, detail.currency)}</span>
          </div>
        ))}
      </section>
      </>}
      {tab === 'charts' && <>
        <DebtFlow payments={detail.payments} names={names} currency={detail.currency} simplified={detail.group.simplify} />
        {chartError && <div className="error">{chartError}</div>}
        {chartBody ? (
          <SpendingChart currency={chartBody.currency} entries={entriesOf(chartBody, today)} today={today} scope={detail.group.name} />
        ) : (
          !chartError && <section className="chart-card"><h2>Spending</h2><p className="muted">Loading charts…</p></section>
        )}
      </>}
      {tab === 'settings' && <>
      <DefaultSplit detail={detail} onSaved={reload} />
      <section className="panel stack">
        <h2>People</h2>
        {detail.members.filter((member) => !member.removed).map((member) => (
          <div className="row" key={member.id}><span>{member.name}{member.id === detail.yourParticipantId ? ' (you)' : ''}</span></div>
        ))}
        <form className="actions" onSubmit={async (event) => {
          event.preventDefault()
          await api(`/api/groups/${id}/people`, { method: 'POST', body: JSON.stringify(personName.includes('@') ? { email: personName } : { displayName: personName }) })
          setPersonName('')
          await reload()
        }}>
          <input placeholder="Name or email" value={personName} onChange={(event) => setPersonName(event.target.value)} />
          <button className="secondary" type="submit">Add</button>
        </form>
        <div className="actions">
          <a className="button secondary" href={`/api/groups/${id}/export.csv`}>Export</a>
          <button className="secondary" onClick={async () => { await api(`/api/groups/${id}/${detail.group.archived ? 'unarchive' : 'archive'}`, { method: 'POST' }); await reload() }}>{detail.group.archived ? 'Unarchive' : 'Archive'}</button>
        </div>
      </section>
      </>}
      </div>
    </div>
  )
}

function DefaultSplit({ detail, onSaved }: { detail: GroupDetail; onSaved: () => Promise<unknown> }) {
  const people = detail.members.filter((member) => !member.removed)
  const [weights, setWeights] = useState<Record<string, string>>(() => Object.fromEntries(people.map((member) => [member.id, member.defaultWeight == null ? '' : String(member.defaultWeight)])))
  const [message, setMessage] = useState<string | null>(null)
  return (
    <form className="panel stack" onSubmit={async (event) => {
      event.preventDefault()
      await api(`/api/groups/${detail.group.id}/defaults`, {
        method: 'POST',
        body: JSON.stringify({
          weights: people.map((member) => ({
            participantId: member.id,
            weight: weights[member.id]?.trim() ? Number(weights[member.id]) : null,
          })),
        }),
      })
      setMessage('New expenses will start from this split.')
      await onSaved()
    }}>
      <h2>Default split</h2>
      <p className="muted">Weights for the usual way this group shares a bill. 60 and 40 stays 60/40. Leave someone blank and new expenses start even until you fill them in.</p>
      {people.map((member) => (
        <label key={member.id}>{member.name}
          <input inputMode="numeric" value={weights[member.id] ?? ''} onChange={(event) => setWeights({ ...weights, [member.id]: event.target.value })} placeholder="Even" />
        </label>
      ))}
      <button className="secondary" type="submit">Save default</button>
      {message && <p>{message}</p>}
    </form>
  )
}

function ExpensePage() {
  const { id = '' } = useParams()
  const navigate = useNavigate()
  const [search] = useSearchParams()
  const [detail, setDetail] = useState<GroupDetail | null>(null)
  const [repeat, setRepeat] = useState(search.get('repeat') === '1')
  const [frequency, setFrequency] = useState('monthly')
  const [startDate, setStartDate] = useState('')
  const [description, setDescription] = useState('')
  const [amount, setAmount] = useState('')
  const [currency, setCurrency] = useState('USD')
  const [date, setDate] = useState('')
  const [categoryId, setCategoryId] = useState('cat_general')
  const [payerId, setPayerId] = useState('')
  const [secondPayerId, setSecondPayerId] = useState('')
  const [secondAmount, setSecondAmount] = useState('')
  const [selected, setSelected] = useState<string[]>([])
  const [mode, setMode] = useState<'equal' | 'exact' | 'percent' | 'shares'>('equal')
  const [values, setValues] = useState<Record<string, string>>({})
  const [kind, setKind] = useState<'expense' | 'reimbursement'>('expense')
  const [itemize, setItemize] = useState(false)
  const [items, setItems] = useState<{ label: string; amount: string; people: string[] }[]>([{ label: '', amount: '', people: [] }])
  const [tax, setTax] = useState('')
  const [tip, setTip] = useState('')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    api<GroupDetail>(`/api/groups/${id}`).then((group) => {
      const active = group.members.filter((member) => !member.removed)
      const start = startingSplit(active.map((member) => ({ id: member.id, weight: member.defaultWeight })))
      setDetail(group)
      setCurrency(group.currency)
      const today = calendarDateInTimeZone(group.group.timezone, new Date())
      setDate(today)
      setStartDate(today)
      setPayerId(group.yourParticipantId)
      const memberIds = active.map((member) => member.id)
      setSelected(memberIds)
      setItems([{ label: '', amount: '', people: memberIds }])
      if (start.type === 'shares') {
        setMode('shares')
        setValues(Object.fromEntries(start.parts.map((part) => [part.participantId, String(part.weight)])))
      }
    })
  }, [id])
  if (!detail) return <p className="wrap">Loading…</p>
  const names = new Map(detail.members.map((member) => [member.id, member.name]))
  const spec = splitSpec(mode, selected, values, currency)
  let preview: { participantId: string; minor: number }[] | null = null
  let previewNote: string | null = null
  if (!itemize && amount.trim()) {
    try {
      const total = parseMajor(amount, currency)
      if (spec) preview = computeShares(total, spec)
    } catch (reason) {
      previewNote = reason instanceof Error ? reason.message : null
    }
  }

  const save = async (event: FormEvent) => {
    event.preventDefault()
    setError(null)
    try {
      if (repeat) {
        const minor = parseMajor(amount, currency)
        if (!spec) throw new ApiError('Finish the split so the shares add up')
        const shares = computeShares(minor, spec)
        await api(`/api/groups/${id}/recurrences`, {
          method: 'POST',
          body: JSON.stringify({
            description,
            categoryId,
            frequency,
            startDate,
            settlementMinor: minor,
            payers: [{ participantId: payerId, minor }],
            shares,
          }),
        })
        navigate(`/groups/${id}`)
        return
      }
      const minor = itemize ? 1 : parseMajor(amount, currency)
      const itemPayload = items
        .filter((item) => item.label.trim() && item.amount.trim())
        .map((item) => ({
          label: item.label.trim(),
          minor: parseMajor(item.amount, currency),
          participantIds: item.people,
        }))
      if (itemize && itemPayload.length === 0) throw new ApiError('Add at least one item')
      if (itemize && itemPayload.some((item) => item.participantIds.length === 0)) {
        throw new ApiError('Assign each item to the people who had it')
      }
      const taxMinor = itemize && tax.trim() ? parseMajor(tax, currency) : 0
      const tipMinor = itemize && tip.trim() ? parseMajor(tip, currency) : 0
      if (!itemize && !spec) throw new ApiError('Finish the split so the shares add up')
      const payers = payerList(payerId, secondPayerId, secondAmount, minor, currency, detail.currency, itemize)
      await api(`/api/groups/${id}/expenses`, {
        method: 'POST',
        body: JSON.stringify({
          description,
          date,
          categoryId,
          kind,
          originalMinor: itemize ? itemPayload.reduce((sum, item) => sum + item.minor, 0) + taxMinor + tipMinor : minor,
          originalCurrency: currency,
          payers,
          ...(itemize
            ? { items: itemPayload, taxMinor, tipMinor, discountMinor: 0 }
            : { split: spec }),
        }),
      })
      navigate(`/groups/${id}`)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not save')
    }
  }

  return (
    <form className="wrap panel stack" onSubmit={save}>
      <p className="kicker">{detail.group.name}</p>
      <h1>{repeat ? 'Repeating expense' : 'Add an expense'}</h1>
      <div className="pills" role="group" aria-label="What kind of expense">
        <button type="button" className={repeat ? 'pill' : 'pill on'} onClick={() => setRepeat(false)}>One time</button>
        <button type="button" className={repeat ? 'pill on' : 'pill'} onClick={() => { setRepeat(true); setItemize(false); setCurrency(detail.currency) }}>Repeating</button>
      </div>
      {repeat && <p className="muted">This repeats in {detail.currency}. The next one is posted when it comes due. Months that already passed are not filled in.</p>}
      {repeat && (detail.recurrences ?? []).map((recurrence) => (
        <div className="row" key={recurrence.id}>
          <span>{recurrence.description} · {recurrence.frequency}</span>
          <span className="muted">{recurrence.paused ? recurrence.pauseReason ?? 'Paused' : `Next ${recurrence.nextDate}`}</span>
        </div>
      ))}
      <label>Description<input value={description} onChange={(event) => setDescription(event.target.value)} required placeholder="Dinner, rent, groceries…" /></label>
      <div className="cards">
        {!itemize && <label>Amount<input inputMode="decimal" value={amount} onChange={(event) => setAmount(event.target.value)} required /></label>}
        {!repeat && <label>Currency<select value={currency} onChange={(event) => setCurrency(event.target.value)}>{[detail.currency, 'USD', 'EUR', 'GBP', 'JPY'].filter((code, index, list) => list.indexOf(code) === index).map((code) => <option key={code}>{code}</option>)}</select></label>}
      </div>
      {!repeat && currency !== detail.currency && <p className="muted">This is converted into {detail.currency} at the rate on the date you pick, and that converted amount is what people owe.</p>}
      {repeat ? <label>Starting<input type="date" value={startDate} onChange={(event) => setStartDate(event.target.value)} /></label> : <label>Date<input type="date" value={date} onChange={(event) => setDate(event.target.value)} /></label>}
      {repeat && <label>How often
        <select value={frequency} onChange={(event) => setFrequency(event.target.value)}>
          <option value="weekly">Every week</option>
          <option value="biweekly">Every two weeks</option>
          <option value="monthly">Every month</option>
          <option value="yearly">Every year</option>
        </select>
      </label>}
      <label>Category<select value={categoryId} onChange={(event) => setCategoryId(event.target.value)}>{detail.categories.map((category) => <option key={category.id} value={category.id}>{category.label}</option>)}</select></label>
      <label>Who paid<select value={payerId} onChange={(event) => setPayerId(event.target.value)}>{detail.members.filter((member) => !member.removed).map((member) => <option key={member.id} value={member.id}>{member.name}</option>)}</select></label>
      {!repeat && !itemize && currency === detail.currency && (
        <div className="stack">
          <label>Someone else also paid
            <select value={secondPayerId} onChange={(event) => setSecondPayerId(event.target.value)}>
              <option value="">Just one payer</option>
              {detail.members.filter((member) => !member.removed && member.id !== payerId).map((member) => <option key={member.id} value={member.id}>{member.name}</option>)}
            </select>
          </label>
          {secondPayerId && <label>Their amount<input inputMode="decimal" value={secondAmount} onChange={(event) => setSecondAmount(event.target.value)} /></label>}
        </div>
      )}
      <div className="pills" role="group" aria-label="How to split">
        {(['equal', 'exact', 'percent', 'shares'] as const).map((choice) => (
          <button key={choice} type="button" className={mode === choice && !itemize ? 'pill on' : 'pill'} onClick={() => {
            setItemize(false)
            setMode(choice)
            if (choice === 'percent') {
              const parts = computeShares(10000, { type: 'equal', participantIds: selected })
              setValues(Object.fromEntries(parts.map((part) => [part.participantId, (part.minor / 100).toFixed(2)])))
            }
            if (choice === 'shares') {
              setValues(Object.fromEntries(selected.map((personId) => [personId, values[personId] && mode === 'shares' ? values[personId] : '1'])))
            }
          }}>{choice === 'percent' ? '%' : choice[0]!.toUpperCase() + choice.slice(1)}</button>
        ))}
      </div>
      <fieldset className="stack">
        <legend>{itemize ? 'On the bill' : 'Include'}</legend>
        {detail.members.filter((member) => !member.removed).map((member) => (
          <label className="check" key={member.id}>
            <input type="checkbox" checked={selected.includes(member.id)} onChange={(event) => {
              setSelected(event.target.checked ? [...selected, member.id] : selected.filter((value) => value !== member.id))
            }} />
            {member.name}
            {!itemize && mode !== 'equal' && (
              <input className="inline" inputMode="decimal" aria-label={`${member.name} ${mode}`} value={values[member.id] ?? ''} onChange={(event) => setValues({ ...values, [member.id]: event.target.value })} />
            )}
          </label>
        ))}
      </fieldset>
      {preview && (
        <p className="preview">{preview.map((share) => `${names.get(share.participantId) ?? 'Someone'} ${formatMoney(share.minor, currency)}`).join(' · ')}</p>
      )}
      {previewNote && <p className="muted">{previewNote}</p>}
      {!repeat && <label className="check"><input type="checkbox" checked={itemize} onChange={(event) => setItemize(event.target.checked)} /> Itemize the bill</label>}
      {itemize && (
        <div className="stack">
          {items.map((item, index) => (
            <div className="stack" key={index}>
              <div className="cards">
                <label>Item<input value={item.label} onChange={(event) => setItems(items.map((row, rowIndex) => rowIndex === index ? { ...row, label: event.target.value } : row))} /></label>
                <label>Amount<input value={item.amount} onChange={(event) => setItems(items.map((row, rowIndex) => rowIndex === index ? { ...row, amount: event.target.value } : row))} /></label>
              </div>
              <div className="chips">
                {detail.members.filter((member) => !member.removed).map((member) => (
                  <label className="check" key={member.id}>
                    <input type="checkbox" checked={item.people.includes(member.id)} onChange={(event) => {
                      const people = event.target.checked ? [...item.people, member.id] : item.people.filter((personId) => personId !== member.id)
                      setItems(items.map((row, rowIndex) => rowIndex === index ? { ...row, people } : row))
                    }} />
                    {member.name}
                  </label>
                ))}
              </div>
            </div>
          ))}
          <button className="secondary" type="button" onClick={() => setItems([...items, { label: '', amount: '', people: [...selected] }])}>Add item</button>
          <label>Tax<input value={tax} onChange={(event) => setTax(event.target.value)} /></label>
          <label>Tip<input value={tip} onChange={(event) => setTip(event.target.value)} /></label>
          <p className="muted">Each line is only for the people checked on it. Tax and tip follow those shares. Amounts are in {currency}{currency !== detail.currency ? `, then converted into ${detail.currency}` : ''}.</p>
        </div>
      )}
      <label className="check"><input type="checkbox" checked={kind === 'reimbursement'} onChange={(event) => setKind(event.target.checked ? 'reimbursement' : 'expense')} /> This is a refund coming back into the group</label>
      {error && <div className="error">{error}</div>}
      <button className="primary" type="submit">{repeat ? 'Save repeat' : 'Save expense'}</button>
    </form>
  )
}

function PersonPage() {
  const { id = '' } = useParams()
  const [data, setData] = useState<{ participant: { name: string }; lines: { groupId: string; groupName: string; currency: string; minor: number; fromId: string; toId: string }[]; canSettleAll: boolean } | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  useEffect(() => { api<NonNullable<typeof data>>(`/api/people/${id}`).then(setData) }, [id])
  if (!data) return <p className="wrap">Loading…</p>
  const lines = data.lines.filter((line) => line.minor > 0)
  return (
    <div className="wrap stack">
      <h1>{data.participant.name}</h1>
      {lines.map((line) => (
        <div className="card" key={line.groupId}>
          <div className="row"><span>{line.groupName}</span><strong className="money">{formatMoney(line.minor, line.currency)}</strong></div>
        </div>
      ))}
      {lines.length === 0 && <p className="muted">You are settled with {data.participant.name}.</p>}
      {data.canSettleAll && <button className="primary" onClick={async () => {
        await api('/api/settle-all', {
          method: 'POST',
          body: JSON.stringify({
            otherParticipantId: id,
            lines: lines.map((line) => ({ groupId: line.groupId, fromId: line.fromId, toId: line.toId, minor: line.minor })),
          }),
        })
        setMessage('Recorded a settlement in each group.')
        setData(await api(`/api/people/${id}`))
      }}>Record all of these</button>}
      {!data.canSettleAll && lines.length > 1 && <p className="muted">These groups use different currencies, so record each settlement inside its group.</p>}
      {message && <p>{message}</p>}
    </div>
  )
}

function SearchPage() {
  const [q, setQ] = useState('')
  const [results, setResults] = useState<{ id: string; groupId: string; groupName: string; description: string; date: string; minor: number; currency: string }[]>([])
  return (
    <div className="wrap stack">
      <form className="row" onSubmit={async (event) => { event.preventDefault(); setResults(await api(`/api/search?q=${encodeURIComponent(q)}`)) }}>
        <input value={q} onChange={(event) => setQ(event.target.value)} placeholder="Search expenses" />
        <button className="primary" type="submit">Search</button>
      </form>
      {results.map((result) => (
        <Link className="card" key={result.id} to={`/groups/${result.groupId}`}>
          <div className="row"><strong>{result.description}</strong><span className="money">{formatMoney(result.minor, result.currency)}</span></div>
          <div className="muted">{result.groupName} · {result.date}</div>
        </Link>
      ))}
    </div>
  )
}

function SettingsPage({ me }: { me: Me }) {
  const [name, setName] = useState(me.displayName)
  const [currency, setCurrency] = useState(me.homeCurrency)
  const [saved, setSaved] = useState(false)
  const [theme, setTheme] = useState<ThemeChoice>(() => themeChoice())
  useEffect(() => {
    const sync = () => setTheme(themeChoice())
    window.addEventListener('divvy-theme', sync)
    return () => window.removeEventListener('divvy-theme', sync)
  }, [])
  return (
    <form className="wrap panel stack" onSubmit={async (event) => {
      event.preventDefault()
      await api('/api/me', { method: 'PATCH', body: JSON.stringify({ displayName: name, homeCurrency: currency }) })
      setSaved(true)
    }}>
      <h1>Settings</h1>
      <div className="stack">
        <span>Appearance</span>
        <div className="pills" role="group" aria-label="Appearance">
          {(['light', 'dark', 'system'] as const).map((choice) => (
            <button key={choice} type="button" className={theme === choice ? 'pill on' : 'pill'} onClick={() => { chooseTheme(choice); setTheme(choice) }}>{choice === 'system' ? 'Match device' : choice[0]!.toUpperCase() + choice.slice(1)}</button>
          ))}
        </div>
      </div>
      <label>Name<input value={name} onChange={(event) => setName(event.target.value)} /></label>
      <label>Home currency<select value={currency} onChange={(event) => setCurrency(event.target.value)}>{['USD', 'EUR', 'GBP', 'CAD', 'JPY'].map((code) => <option key={code}>{code}</option>)}</select></label>
      <button className="primary" type="submit">Save</button>
      {saved && <p>Saved. Charts in other currencies convert into this one.</p>}
    </form>
  )
}

function InvitePage() {
  const { token = '' } = useParams()
  const navigate = useNavigate()
  const [preview, setPreview] = useState<{ group: { name: string }; members: { name: string; blocked: boolean }[] } | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    api<NonNullable<typeof preview>>(`/api/invites/${token}`).then(setPreview).catch((reason: Error) => setError(reason.message))
  }, [token])
  return (
    <div className="login">
      <div className="panel stack">
        <h2>Join {preview?.group.name ?? 'a group'}</h2>
        {error && <div className="error">{error}</div>}
        {preview?.members.map((member) => <div key={member.name}>{member.name}{member.blocked ? ' · blocked' : ''}</div>)}
        <p className="muted">Joining shows the group’s whole history.</p>
        <button className="primary" onClick={async () => {
          const joined = await api<GroupDetail>(`/api/invites/${token}/accept`, { method: 'POST' })
          navigate(`/groups/${joined.group.id}`)
        }}>Accept</button>
      </div>
    </div>
  )
}

function splitSpec(
  mode: 'equal' | 'exact' | 'percent' | 'shares',
  selected: string[],
  values: Record<string, string>,
  currency: string,
): SplitSpec | null {
  if (selected.length < 2) return null
  if (mode === 'equal') return { type: 'equal', participantIds: selected }
  if (mode === 'percent') {
    const parts = selected.map((id) => ({ participantId: id, bps: Math.round(Number(values[id] || '0') * 100) }))
    if (parts.some((part) => !Number.isInteger(part.bps) || part.bps < 0)) return null
    return { type: 'percent', parts }
  }
  if (mode === 'shares') {
    const parts = selected.map((id) => ({ participantId: id, weight: Number(values[id] || '0') }))
    if (parts.some((part) => !Number.isInteger(part.weight) || part.weight < 0)) return null
    return { type: 'shares', parts }
  }
  try {
    return {
      type: 'exact',
      amounts: selected.map((id) => ({ participantId: id, minor: parseShare(values[id] ?? '', currency) })),
    }
  } catch {
    return null
  }
}

function parseShare(input: string, currency: string) {
  if (/^0+(\.0+)?$/.test(input.trim())) return 0
  return parseMajor(input, currency)
}

function payerList(primary: string, second: string, secondAmount: string, total: number, currency: string, groupCurrency: string, itemize: boolean) {
  if (itemize || !second || currency !== groupCurrency) return [{ participantId: primary, minor: itemize ? 1 : total }]
  const extra = parseShare(secondAmount, currency)
  if (extra <= 0 || extra >= total) throw new ApiError('The second payer needs an amount smaller than the total')
  return [
    { participantId: primary, minor: total - extra },
    { participantId: second, minor: extra },
  ]
}

function loadHome() {
  return api<{
    estimate: { homeCurrency: string; minor: number; approximate: boolean } | null
    groups: HomeGroup[]
  }>('/api/home')
}

type HomeGroup = {
  id: string
  name: string
  currency: string
  yourNetMinor: number
  archived: boolean
  members: string[]
  latest: { description: string; date: string } | null
}

function shareThisMonth(body: ChartResponse, today: string) {
  const month = today.slice(0, 7)
  return entriesOf(body, today).filter((entry) => entry.month === month).reduce((sum, entry) => sum + entry.shareMinor, 0)
}

function tone(minor: number) {
  if (minor > 0) return 'ahead'
  if (minor < 0) return 'owed'
  return ''
}

function avatarStyle(name: string) {
  const pairs = [
    ['#e0e7ff', '#3730a3'],
    ['#d1fae5', '#047857'],
    ['#ffe4e6', '#be123c'],
    ['#fef3c7', '#b45309'],
    ['#e0f2fe', '#0369a1'],
    ['#fae8ff', '#a21caf'],
  ] as const
  let hash = 0
  for (const char of name) hash = (hash + char.charCodeAt(0)) % pairs.length
  const pair = pairs[hash] ?? pairs[0]
  return { background: pair[0], color: pair[1] }
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

function shortDate(iso: string) {
  const [, month, day] = iso.split('-')
  return `${MONTHS[Number(month) - 1] ?? iso} ${Number(day)}`
}

function peopleLine(names: string[]) {
  if (names.length === 0) return 'No one else yet'
  return names.join(', ')
}

function balanceParts(minor: number, currency: string) {
  if (minor === 0) return { label: 'Settled', amount: currency }
  if (minor > 0) return { label: 'You are owed', amount: formatMoney(minor, currency) }
  return { label: 'You owe', amount: formatMoney(Math.abs(minor), currency) }
}

function signed(minor: number, currency: string) {
  if (minor === 0) return `Settled in ${currency}`
  if (minor > 0) return `You are owed ${formatMoney(minor, currency)}`
  return `You owe ${formatMoney(Math.abs(minor), currency)}`
}

function headline(estimate: { homeCurrency: string; minor: number } | null) {
  if (!estimate || estimate.minor === 0) return 'you are settled up'
  if (estimate.minor > 0) return `you are owed about ${formatMoney(estimate.minor, estimate.homeCurrency)}`
  return `you owe about ${formatMoney(Math.abs(estimate.minor), estimate.homeCurrency)}`
}

function labelOf(detail: GroupDetail, categoryId: string) {
  return detail.categories.find((category) => category.id === categoryId)?.label ?? categoryId
}

