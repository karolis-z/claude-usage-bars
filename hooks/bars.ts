import type { BarSettings, Category, History, Mode, Reading, UsageSettings, Snapshot, Trail } from '../types'

export const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n))
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null

// Settings ---------------------------------------------------------------------

export const DEFAULT_SETTINGS: UsageSettings = {
  context: { threshold: 400_000, notify: false, show: true },
  session: { threshold: 80, notify: false, show: true },
  weekly: { threshold: 80, notify: false, show: true },
  toasts: true,
}

/** The thresholds' ranges and steps: tokens for context, percent for the limits. */
const RANGE = {
  context: { min: 50_000, max: 2_000_000, step: 50_000 },
  limit: { min: 5, max: 100, step: 5 },
} as const

const rangeOf = (id: BarId) => (id === 'context' ? RANGE.context : RANGE.limit)

/** Stored settings, defaults filled in and every value back in its range. */
export const normalizeSettings = (raw: unknown): UsageSettings => {
  const bar = (id: BarId): BarSettings => {
    const d = DEFAULT_SETTINGS[id]
    const v = isObject(raw) && isObject(raw[id]) ? raw[id] : {}
    const { min, max } = rangeOf(id)
    return {
      threshold: typeof v.threshold === 'number' && Number.isFinite(v.threshold) ? clamp(v.threshold, min, max) : d.threshold,
      notify: typeof v.notify === 'boolean' ? v.notify : d.notify,
      show: typeof v.show === 'boolean' ? v.show : d.show,
    }
  }
  return {
    context: bar('context'),
    session: bar('session'),
    weekly: bar('weekly'),
    toasts: isObject(raw) && typeof raw.toasts === 'boolean' ? raw.toasts : DEFAULT_SETTINGS.toasts,
  }
}

/** The threshold one step up (`1`) or down (`-1`), snapped to the step. */
export const stepThreshold = (id: BarId, value: number, direction: 1 | -1): number => {
  const { min, max, step } = rangeOf(id)
  const snapped = direction > 0 ? Math.floor(value / step) * step + step : Math.ceil(value / step) * step - step
  return clamp(snapped, min, max)
}

export const thresholdText = (id: BarId, value: number): string =>
  id === 'context' ? formatTokens(value) : `${Math.round(value)}%`

// Time and numbers -------------------------------------------------------------

export const MINUTE = 60_000
export const HOUR = 60 * MINUTE
export const DAY = 24 * HOUR

/** A limit reading older than this is drawn faded: other sessions may have used more since. */
const STALE_MS = 30 * MINUTE

/** Red from here, whatever the threshold: the hard limit is close. */
const HIGH_AT = 95

const WINDOW_MS: Record<string, number> = { five_hour: 5 * HOUR, seven_day: 7 * DAY }

/** How far back "your recent pace" looks, and the least it needs to say anything. */
const PACE: Record<string, { lookback: number; minSpan: number }> = {
  five_hour: { lookback: HOUR, minSpan: 15 * MINUTE },
  seven_day: { lookback: DAY, minSpan: 3 * HOUR },
}

export const windowLength = (kind: string): number | undefined =>
  WINDOW_MS[kind] ?? (kind.startsWith('seven_day') ? WINDOW_MS.seven_day : undefined)

export const parseTime = (iso: string | undefined): number | null => {
  if (iso === undefined) return null
  const ms = Date.parse(iso)
  return Number.isFinite(ms) ? ms : null
}

/** Reset times wobble by milliseconds between readings: one window is anything within 10 minutes. */
export const isSameWindow = (a: number | null, b: number | null): boolean =>
  a !== null && b !== null && Math.abs(a - b) <= 10 * MINUTE

/** What an alert about this window is remembered by. */
export const windowKey = (reading: Reading): string =>
  `${reading.kind}@${Math.round((parseTime(reading.resetsAt) ?? 0) / (10 * MINUTE))}`

export const formatTokens = (n: number): string => {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2).replace(/\.?0+$/, '')}M`
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`
  return `${Math.round(n)}`
}

/** `3d 6h`, `3h 30m` (to five minutes above an hour, so it redraws less), `42m`. */
export const formatUntil = (ms: number): string => {
  const minutes = Math.max(0, Math.round(ms / MINUTE))
  if (minutes >= 1440) {
    const days = Math.floor(minutes / 1440)
    const hours = Math.round((minutes % 1440) / 60)
    return hours === 24 ? `${days + 1}d` : hours === 0 ? `${days}d` : `${days}d ${hours}h`
  }
  if (minutes >= 60) {
    const rounded = Math.round(minutes / 5) * 5
    const hours = Math.floor(rounded / 60)
    const mins = rounded % 60
    return mins === 0 ? `${hours}h` : `${hours}h ${mins}m`
  }
  return `${Math.max(1, minutes)}m`
}

const formatShare = (n: number): string => (n < 10 ? n.toFixed(1).replace(/\.0$/, '') : `${Math.round(n)}`)

/** A part's share of the whole as a whole percent; a sliver reads `<1%`, never `0%`. */
export const shareText = (share: number): string => (share > 0 && share < 0.005 ? '<1%' : `${Math.round(share * 100)}%`)

// The desktop app's usage card -------------------------------------------------

/**
 * The window a usage-card label names: `5-hour limit` → `five_hour`,
 * `Weekly · all models` → `seven_day`, `Weekly · Fable` → `seven_day_fable`.
 * Matched loosely: the labels are the app's wording, not a contract.
 */
export const kindOfLabel = (label: string): string | null => {
  const l = label.toLowerCase()
  if (/\b5[- ]?h(our)?\b/.test(l)) return 'five_hour'
  if (!/week/.test(l)) return null
  if (/all models/.test(l)) return 'seven_day'
  const model = (l.split(/[·:—–-]/).pop() ?? '').trim().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '')
  return model && !/week/.test(model) ? `seven_day_${model}` : 'seven_day'
}

/** What a tool returned: its structured result, else its first text block read as JSON. */
export const payloadOf = (result: { content: { type: string; text?: string }[]; structuredContent?: unknown }): unknown => {
  if (result.structuredContent !== undefined) return result.structuredContent
  const text = result.content.find(b => b.type === 'text' && b.text)?.text
  if (text === undefined) return undefined
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/** The usage card's windows as readings; null when the card had none to give. */
export const parsePlan = (payload: unknown): Reading[] | null => {
  const plan = isObject(payload) ? payload.plan : undefined
  if (!isObject(plan) || plan.status !== 'ok' || !Array.isArray(plan.windows)) return null

  const out: Reading[] = []
  for (const w of plan.windows) {
    if (!isObject(w) || typeof w.label !== 'string' || typeof w.percentUsed !== 'number') continue
    const kind = kindOfLabel(w.label)
    if (kind === null || out.some(r => r.kind === kind)) continue
    out.push(
      typeof w.resetsAt === 'string'
        ? { kind, percentUsed: w.percentUsed, resetsAt: w.resetsAt }
        : { kind, percentUsed: w.percentUsed },
    )
  }
  return out.length > 0 ? out : null
}

/** A reading, when it was taken, and from where. */
export type Timed = Reading & { at: number; isFromApp: boolean }

/** Both sources together, each window from whichever read it last. */
export const mergedLimits = (snap: Snapshot): Timed[] => {
  const out: Timed[] = snap.limits.map(r => ({ ...r, at: snap.freshAt, isFromApp: false }))
  for (const r of snap.plan?.limits ?? []) {
    const timed = { ...r, at: snap.plan!.at, isFromApp: true }
    const i = out.findIndex(o => o.kind === r.kind)
    if (i === -1) out.push(timed)
    else if (timed.at > out[i]!.at) out[i] = timed
  }
  return out
}

// History and pace -------------------------------------------------------------

/** Adds the readings to each window's trail; a new window starts a new trail. */
export const record = (history: History, limits: Reading[], at: number): History => {
  let out: History | null = null

  for (const reading of limits) {
    const resetsAt = parseTime(reading.resetsAt)
    if (resetsAt === null) continue

    const old = history[reading.kind]
    const trail: Trail = old && isSameWindow(old.resetsAt, resetsAt) ? old : { resetsAt, samples: [] }
    const last = trail.samples[trail.samples.length - 1]
    const isNew = !last || last[1] !== reading.percentUsed || at - last[0] >= 10 * MINUTE
    if (!isNew && trail === old) continue

    const length = windowLength(reading.kind) ?? 7 * DAY
    let samples = isNew ? [...trail.samples, [at, reading.percentUsed] as [number, number]] : trail.samples
    samples = samples.filter(([t]) => t >= resetsAt - length - HOUR)
    // Thin the older half once a week of readings piles up.
    if (samples.length > 400) samples = samples.filter((_, i) => i % 2 === 0 || i >= samples.length - 100)

    out = { ...(out ?? history), [reading.kind]: { resetsAt: trail.resetsAt, samples } }
  }

  return out ?? history
}

type Projection = {
  /** Percent per millisecond. */
  rate: number
  /** Where the window would end at this pace. */
  atReset: number
  /** How long until 100% at this pace, when that comes before the reset. */
  hitsIn: number | null
}

/**
 * Where this window is heading: the recent pace (the last hour of a 5h window,
 * the last day of a week) when there are readings enough, else the average so
 * far once a tenth of the window has gone; null when neither says anything.
 */
export const project = (trail: Trail | undefined, reading: Reading, now: number): Projection | null => {
  const length = windowLength(reading.kind)
  const resetsAt = parseTime(reading.resetsAt)
  if (length === undefined || resetsAt === null || resetsAt <= now) return null

  const remaining = resetsAt - now
  const percent = reading.percentUsed
  const pace = PACE[reading.kind] ?? PACE.seven_day!
  const samples = trail && isSameWindow(trail.resetsAt, resetsAt) ? trail.samples : []
  const first = samples.find(([t]) => t >= now - pace.lookback)

  let rate: number | null = null
  if (first && now - first[0] >= pace.minSpan) rate = Math.max(0, (percent - first[1]) / (now - first[0]))
  if (rate === null) {
    const elapsed = length - remaining
    if (elapsed >= length * 0.1) rate = percent / elapsed
  }
  if (rate === null) return null

  const atReset = percent + rate * remaining
  return {
    rate,
    atReset: Math.round(atReset),
    hitsIn: atReset >= 100 && rate > 0 ? Math.max(0, (100 - percent) / rate) : null,
  }
}

// Bars -------------------------------------------------------------------------

export type BarId = 'context' | 'session' | 'weekly'
export type Level = 'ok' | 'warn' | 'high'
export type Segment = { name: string; tokens: number; share: number }

/** A short fact about a bar, a few words, for the details pane's dotted line. */
export type Fact = { text: string; tone: 'plain' | 'warn' }

export type Bar = {
  id: BarId
  label: string
  short: string
  /** 0 to 100; null before there is a reading. */
  percent: number | null
  level: Level
  /** Past your threshold. */
  isOver: boolean
  /** Your threshold as a percent of the bar, where its tick is drawn; null with no window to put it in. */
  tick: number | null
  /** Your threshold as you set it: `400k`, `80%`. */
  thresholdText: string
  /** What the last message added: `+1.2%`, `+12k`. */
  delta: string | null
  /** Tokens, or when the window resets. */
  detail: string
  /** The pace, the budget, or why the figure may be out of date. */
  note: string
  isNoteWarning: boolean
  /** Faded: a reading that may be out of date, or a window that has reset. */
  isDim: boolean
  /** What fills the context, as shares of its fill: the four largest and Other. */
  segments: Segment[] | null
  /** The same, in more detail for the breakdown: the seven largest and Other. */
  parts: Segment[] | null
  /** The facts for the details pane, a few words each. */
  facts: Fact[]
  /** The hover text: everything the bar knows, in sentences. */
  title: string
  alertKey: string
  /** The limit window behind the bar, for the reset notification and the trail. */
  reading: Timed | null
  /** In the band above the prompt; the details pane shows every bar. */
  isShown: boolean
}

export type Inputs = { base: Snapshot | null; history: History; settings: UsageSettings }

const HUES: Record<BarId, string> = { context: '#1D9E75', session: '#378ADD', weekly: '#7F77DD' }
export const WARN = '#EF9F27'
const HIGH = '#E24B4A'
export const TRACK = '#888780'

/**
 * What fills the context, a colour per part by its rank (the largest first),
 * Other always grey: the same in the strip and the breakdown. Mid tones, which
 * read on the light and the dark theme alike.
 */
const PART_COLORS = ['#1D9E75', '#378ADD', '#7F77DD', '#D85A30', '#D4537E', '#BA7517', '#639922']
const OTHER_COLOR = '#888780'

export const partColor = (part: Segment, rank: number): string =>
  part.name === 'Other' ? OTHER_COLOR : (PART_COLORS[rank % PART_COLORS.length] ?? OTHER_COLOR)

/** A part's label as long as its room allows: `Messages 24k`, else `24k`, else nothing. */
const fitLabel = (s: Segment, room: number, charWidth: number, padding: number): string => {
  const full = `${s.name} ${formatTokens(s.tokens)}`
  const short = formatTokens(s.tokens)
  if (full.length * charWidth + padding <= room) return full
  if (short.length * charWidth + padding <= room) return short
  return ''
}

const levelOf = (percent: number | null, isOver: boolean): Level =>
  percent !== null && percent >= HIGH_AT ? 'high' : isOver ? 'warn' : 'ok'

export const colorOf = (bar: Bar): string =>
  bar.level === 'high' ? HIGH : bar.level === 'warn' ? WARN : HUES[bar.id]

/** The percent as text; a `!` once it is red, so it reads without the colour too. */
export const percentText = (bar: Bar): string =>
  bar.percent === null ? '—' : `${bar.percent}%${bar.level === 'high' ? '!' : ''}`

/** The line under a bar in the band. */
export const subline = (bar: Bar): string => [bar.detail, bar.note].filter(Boolean).join(' · ')

/** The Fable weekly window when a source reports one, else the all-models one. */
export const pickWeekly = <R extends Reading>(limits: R[]): R | undefined =>
  limits.find(l => /fable/i.test(l.kind)) ?? limits.find(l => l.kind === 'seven_day')

/** The categories that fill the context: the `top` largest, the rest as Other. */
export const toSegments = (categories: Category[] | undefined, top = 4): Segment[] | null => {
  const used = (categories ?? []).filter(c => c.tokens > 0).sort((a, b) => b.tokens - a.tokens)
  const total = used.reduce((sum, c) => sum + c.tokens, 0)
  if (total === 0) return null

  const largest = used.slice(0, top)
  const rest = used.slice(top).reduce((sum, c) => sum + c.tokens, 0)
  const parts = rest > 0 ? [...largest, { name: 'Other', tokens: rest }] : largest
  return parts.map(c => ({ name: c.name, tokens: c.tokens, share: c.tokens / total }))
}

const fact = (text: string, tone: Fact['tone'] = 'plain'): Fact => ({ text, tone })

const contextBar = (snap: Snapshot, { base, settings }: Inputs): Bar => {
  const { tokens, window, percent: raw, isEstimate } = snap.context
  const { threshold, show } = settings.context
  const percent = raw === undefined ? null : clamp(Math.round(raw), 0, 100)
  const isOver = tokens !== undefined && tokens >= threshold
  const grew = tokens !== undefined && base?.context.tokens !== undefined ? tokens - base.context.tokens : 0
  const delta = grew > 0 ? `+${formatTokens(grew)}` : null
  const { compactAt } = snap
  const used = tokens === undefined ? '—' : `${isEstimate ? '~' : ''}${formatTokens(tokens)}`
  const line = formatTokens(threshold)

  const facts = [
    fact(`${used} / ${formatTokens(window)}`),
    isOver ? fact(`past ${line}`, 'warn') : fact(`healthy ≤ ${line}`),
    ...(delta ? [fact(`${delta} this turn`)] : []),
    ...(compactAt === undefined ? [] : [fact(`compacts at ${compactAt}%`)]),
  ]

  const title = [
    percent === null
      ? 'Context: no reading yet; it comes with the first response.'
      : `Context: ${used} of ${formatTokens(window)} tokens (${percent}%).`,
    isEstimate ? 'Estimated locally; your next reply reports the real figure.' : '',
    isOver ? `Past your ${line} line for a healthy session.` : `Your line for a healthy session: ${line}.`,
    compactAt === undefined ? '' : `Auto-compacts at ${compactAt}%.`,
    delta ? `${delta} since your last message.` : '',
  ]

  return {
    id: 'context',
    label: 'Context',
    short: 'ctx',
    percent,
    level: levelOf(percent, isOver),
    isOver,
    tick: window > 0 ? clamp((threshold / window) * 100, 0, 100) : null,
    thresholdText: line,
    delta,
    detail: `${used} / ${formatTokens(window)}`,
    note: isOver ? `past ${line}` : '',
    isNoteWarning: isOver,
    isDim: false,
    segments: percent === null ? null : toSegments(snap.categories),
    parts: percent === null ? null : toSegments(snap.categories, 7),
    facts,
    title: title.filter(Boolean).join(' '),
    alertKey: 'context',
    reading: null,
    isShown: show,
  }
}

const limitBar = (id: BarId, label: string, short: string, reading: Timed, { base, history, settings }: Inputs, now: number): Bar => {
  const { threshold, show } = settings[id]
  const length = windowLength(reading.kind)
  const resetsAt = parseTime(reading.resetsAt)
  const isReset = resetsAt !== null && resetsAt <= now
  const isStale = !isReset && now - reading.at > STALE_MS
  const used = clamp(reading.percentUsed, 0, 100)
  const percent = isReset ? 0 : Math.round(used)
  const isFull = !isReset && reading.percentUsed >= 100
  const isOver = !isReset && reading.percentUsed >= threshold

  const elapsed =
    resetsAt !== null && length !== undefined && !isReset
      ? clamp(Math.round((1 - (resetsAt - now) / length) * 100), 0, 100)
      : null

  const before = base ? mergedLimits(base).find(l => l.kind === reading.kind) : undefined
  const added =
    before && !isReset && isSameWindow(parseTime(before.resetsAt), resetsAt) ? reading.percentUsed - before.percentUsed : 0
  const delta = added >= 0.1 ? `+${formatShare(added)}%` : null

  const pace = isReset || isStale || isFull ? null : project(history[reading.kind], reading, now)
  const daysLeft = resetsAt === null ? 0 : (resetsAt - now) / DAY
  const left = resetsAt === null ? '' : formatUntil(resetsAt - now)

  // Each phrase once: the most pressing is the band's note, the rest join it in the pane.
  const past = isOver ? `past ${threshold}%` : null
  const hits = pace?.hitsIn != null ? `limit in ~${formatUntil(pace.hitsIn)}` : null
  const atReset = pace && pace.hitsIn === null ? `~${Math.min(100, pace.atReset)}% at reset` : null
  const perDay = id === 'weekly' && daysLeft >= 1 && !isStale ? `~${Math.round((100 - used) / daysLeft)}%/day left` : null
  const [note, isNoteWarning]: [string, boolean] =
    isReset ? ['updates on your next message', false]
    : isFull ? ['limit reached', true]
    : isStale ? [`as of ${formatUntil(now - reading.at)} ago`, false]
    : hits ? [hits, true]
    : past ? [past, true]
    : perDay ? [perDay, false]
    : atReset ? [atReset, false]
    : ['', false]

  const detail = resetsAt === null ? '' : isReset ? `reset ${formatUntil(now - resetsAt)} ago` : `resets in ${left}`
  const besides = (text: string | null) => (text !== null && text !== note ? [fact(text)] : [])

  const facts = [
    ...(detail ? [fact(detail)] : []),
    ...(past !== null && past !== note ? [fact(past, 'warn')] : []),
    ...(note && !isReset ? [fact(note, isNoteWarning ? 'warn' : 'plain')] : []),
    ...besides(perDay),
    ...besides(atReset),
    ...(elapsed === null ? [] : [fact(`${elapsed}% of window gone`)]),
    ...(delta ? [fact(`${delta} this turn`)] : []),
    ...(reading.isFromApp ? [fact('from the app')] : []),
  ]

  const title = [
    isReset
      ? `${label}: this window reset ${formatUntil(now - (resetsAt ?? now))} ago. The bar updates with your next message.`
      : `${label}: ${formatShare(used)}% used${left ? `, resets in ${left}` : ''}.`,
    `Your line: ${threshold}%.`,
    pace === null ? ''
    : pace.hitsIn !== null ? `At your recent pace you'd hit the limit in about ${formatUntil(pace.hitsIn)}.`
    : `At your recent pace you'd end the window near ${Math.min(100, pace.atReset)}%.`,
    delta ? `${delta} since your last message.` : '',
    isStale ? `Last updated ${formatUntil(now - reading.at)} ago; other sessions may have used more since.` : '',
    id === 'weekly' && !/fable/i.test(reading.kind)
      ? "No Fable figure here (it comes from the desktop app's usage card), so this is the all-models limit."
      : '',
  ]

  return {
    id,
    label,
    short,
    percent,
    level: isReset ? 'ok' : levelOf(percent, isOver),
    isOver,
    tick: threshold,
    thresholdText: `${threshold}%`,
    delta,
    detail,
    note,
    isNoteWarning,
    isDim: isReset || isStale,
    segments: null,
    parts: null,
    facts,
    title: title.filter(Boolean).join(' '),
    alertKey: windowKey(reading),
    reading,
    isShown: show,
  }
}

/** Every bar there is a reading for, shown or not (`isShown` says); the band draws the shown ones. */
export const buildBars = (snap: Snapshot, now: number, inputs: Inputs): Bar[] => {
  const bars: Bar[] = [contextBar(snap, inputs)]
  const limits = mergedLimits(snap)

  const session = limits.find(l => l.kind === 'five_hour')
  if (session) bars.push(limitBar('session', '5h session', '5h', session, inputs, now))

  const weekly = pickWeekly(limits)
  if (weekly) {
    const isFable = /fable/i.test(weekly.kind)
    bars.push(limitBar('weekly', isFable ? 'Fable weekly' : 'Weekly · all models', isFable ? 'wk·F' : 'wk', weekly, inputs, now))
  }

  return bars
}

/** Auto picks full once any bar needs a look, compact otherwise. */
export const layoutOf = (mode: Exclude<Mode, 'hidden'>, bars: Bar[]): 'full' | 'compact' =>
  mode !== 'auto' ? mode : bars.some(b => b.isOver || b.isNoteWarning) ? 'full' : 'compact'

/** Everything about the bars that changes with the clock alone: redraw when it does. */
export const clockSignature = (bars: Bar[]): string =>
  bars.map(b => [b.percent, b.detail, b.note, b.isDim].join('|')).join('/')

// Terminal ---------------------------------------------------------------------

/** One run of same-styled cells; `tickOnFill` is a tick drawn over the filled part. */
export type Run = { text: string; style: 'fill' | 'track' | 'tick' | 'tickOnFill' }

const PARTIAL = ['', '▏', '▎', '▍', '▌', '▋', '▊', '▉']

/** The bar as runs of cells, at an eighth of a cell's precision. */
export const cells = (percent: number | null, tick: number | null, width: number): Run[] => {
  const eighths = Math.round(((percent ?? 0) / 100) * width * 8)
  const full = Math.floor(eighths / 8)
  const part = PARTIAL[eighths % 8] ?? ''
  const tickAt = tick === null ? -1 : clamp(Math.round((tick / 100) * (width - 1)), 0, width - 1)

  const out: Run[] = []
  const push = (text: string, style: Run['style']) => {
    const last = out[out.length - 1]
    if (last && last.style === style) last.text += text
    else out.push({ text, style })
  }

  for (let i = 0; i < width; i++) {
    if (i === tickAt) push('│', i < full ? 'tickOnFill' : 'tick')
    else if (i < full) push('█', 'fill')
    else if (i === full && part) push(part, 'fill')
    else push('░', 'track')
  }

  return out
}

const SPARK = '▁▂▃▄▅▆▇█'

/** Percent readings over a span as a row of block characters, `width` wide. */
export const spark = (samples: [number, number][], start: number, end: number, width: number): string => {
  if (samples.length === 0 || end <= start) return ''
  let out = ''
  let j = 0
  let level = -1
  for (let i = 0; i < width; i++) {
    const t = start + ((i + 1) / width) * (end - start)
    while (j < samples.length && samples[j]![0] <= t) level = samples[j++]![1]
    out += level < 0 ? ' ' : SPARK[clamp(Math.floor((level / 100) * SPARK.length), 0, SPARK.length - 1)]
  }
  return out.trimEnd()
}

// Desktop ----------------------------------------------------------------------

/** Text for an SVG drawn as an image, which is read as strict XML: one bare `<` (as in `<1%`) and it draws nothing. */
const escapeXml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;')

export const BAR_HEIGHT = 14

const FONT = "-apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif"
/** Secondary text inside an SVG, which cannot read the theme: a grey that reads on light and dark. */
const LABEL = '#8A8984'

const SEGMENT_OPACITY = [1, 0.78, 0.6, 0.45, 0.32]

/**
 * The bar as an SVG of `width` CSS pixels: a rounded track, its fill (split by
 * category on the context bar; growing from `from` when the value moved,
 * unless the system asks for reduced motion), your threshold's tick, and hover titles.
 */
export const svgBar = (bar: Bar, width: number, from?: number): string => {
  const w = Math.max(24, Math.round(width))
  const h = BAR_HEIGHT
  const y = 3
  const bh = 8
  const px = (p: number) => clamp((p / 100) * w, 0, w)
  const fillW = px(bar.percent ?? 0)
  const color = colorOf(bar)

  let x = 0
  const parts = bar.segments
    ? bar.segments.map((s, i) => {
        const sw = s.share * fillW
        const rect =
          `<rect x="${x.toFixed(1)}" y="${y}" width="${sw.toFixed(1)}" height="${bh}" fill="${color}" ` +
          `fill-opacity="${SEGMENT_OPACITY[i] ?? 0.3}"><title>${escapeXml(
            `${s.name}: ${formatTokens(s.tokens)} (${Math.round(s.share * 100)}% of what's used)`,
          )}</title></rect>`
        x += sw
        return rect
      })
    : [`<rect x="0" y="${y}" width="${fillW.toFixed(1)}" height="${bh}" fill="${color}"/>`]

  const grows = from !== undefined && bar.percent !== null && from !== bar.percent && fillW > 0
  const style = grows
    ? `<style>.f{transform-origin:0 0;animation:g .7s cubic-bezier(.2,.8,.2,1) both}` +
      `@keyframes g{from{transform:scaleX(${(px(from) / fillW).toFixed(3)})}}` +
      `@media (prefers-reduced-motion:reduce){.f{animation:none}}</style>`
    : ''
  const tick =
    bar.tick === null
      ? ''
      : `<rect x="${clamp(px(bar.tick) - 1, 0, w - 2).toFixed(1)}" y="0" width="2" height="${h}" rx="1" fill="${
          bar.isOver ? WARN : TRACK
        }"><title>${escapeXml(`Your line: ${bar.thresholdText}`)}</title></rect>`

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">` +
    style +
    `<title>${escapeXml(bar.title)}</title>` +
    `<clipPath id="r"><rect x="0" y="${y}" width="${w}" height="${bh}" rx="${bh / 2}"/></clipPath>` +
    `<g clip-path="url(#r)">` +
    `<rect x="0" y="${y}" width="${w}" height="${bh}" fill="${TRACK}" fill-opacity="0.22"/>` +
    `<g class="f"${bar.isDim ? ' opacity="0.45"' : ''}>${parts.join('')}</g>` +
    `</g>${tick}</svg>`
  )
}

/**
 * What fills the context as one strip: 100% is everything used, each part in
 * its colour, its name and tokens inside when they fit, all of it on hover.
 */
export const svgComposition = (segments: Segment[], width: number): string => {
  const w = Math.max(80, Math.round(width))
  const h = 22
  let x = 0
  const parts = segments.map((s, i) => {
    const sw = s.share * w
    const fill = partColor(s, i)
    const ink = '#ffffff'
    const label = fitLabel(s, sw, 6.4, 14)
    const tip = escapeXml(`${s.name}: ${formatTokens(s.tokens)} (${shareText(s.share)})`)
    const rect = `<rect x="${x.toFixed(1)}" y="0" width="${sw.toFixed(1)}" height="${h}" fill="${fill}"><title>${tip}</title></rect>`
    const text = label
      ? `<text x="${(x + 7).toFixed(1)}" y="15" font-size="11" font-weight="600" font-family="${FONT}" fill="${ink}" pointer-events="none">${escapeXml(label)}</text>`
      : ''
    // A hairline between parts, so two close shades still read apart.
    const seam = i === 0 ? '' : `<rect x="${(x - 0.5).toFixed(1)}" y="0" width="1" height="${h}" fill="#ffffff" fill-opacity="0.55"/>`
    x += sw
    return seam + rect + text
  })

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">` +
    `<clipPath id="c"><rect x="0" y="0" width="${w}" height="${h}" rx="5"/></clipPath>` +
    `<g clip-path="url(#c)">${parts.join('')}</g></svg>`
  )
}

/**
 * The breakdown as a waterfall: a row per part, largest first, each bar
 * starting where the one above ended, so the rows add up to the total in the
 * last row. Three columns that never overlap: names on the left, the bars in
 * the middle, tokens and share right-aligned on the right.
 */
export const svgWaterfall = (parts: Segment[], width: number): string => {
  const w = Math.max(240, Math.round(width))
  const rowH = 20
  const gap = 6
  const charW = 6.2
  const total = parts.reduce((sum, p) => sum + p.tokens, 0)
  const values = parts.map(p => `${formatTokens(p.tokens)} · ${shareText(p.share)}`)
  const valueW = Math.ceil(Math.max(formatTokens(total).length, ...values.map(v => v.length)) * charW)
  const labelW = clamp(Math.round(w * 0.3), 84, 160)
  const trackX = labelW + 10
  const trackW = Math.max(40, w - trackX - 12 - valueW)
  const valueX = w
  const rows = parts.length + 1
  const h = rows * rowH + (rows - 1) * gap
  const label = (text: string, room: number) => {
    const fits = Math.floor(room / charW)
    return text.length <= fits ? text : `${text.slice(0, Math.max(1, fits - 1))}…`
  }
  const font = `font-family="${FONT}"`

  let acc = 0
  const out: string[] = []
  parts.forEach((p, i) => {
    const y = i * (rowH + gap)
    // A sliver still shows as a pill, kept inside the track.
    const bw = Math.max(10, p.share * trackW)
    const x = Math.min(trackX + acc * trackW, trackX + trackW - bw)
    const tip = escapeXml(`${p.name}: ${formatTokens(p.tokens)} (${shareText(p.share)} of what's used)`)

    out.push(
      `<g><title>${tip}</title>` +
        `<text x="0" y="${y + 14}" font-size="12" ${font} fill="${LABEL}">${escapeXml(label(p.name, labelW))}</text>` +
        `<rect x="${x.toFixed(1)}" y="${y + 3}" width="${bw.toFixed(1)}" height="${rowH - 6}" rx="${(rowH - 6) / 2}" fill="${partColor(p, i)}"/>` +
        `<text x="${valueX}" y="${y + 14}" font-size="11" ${font} fill="${LABEL}" text-anchor="end">${escapeXml(values[i]!)}</text></g>`,
    )
    // The waterfall's step: from this bar's end down to where the next one starts.
    if (i < parts.length - 1) {
      const end = (x + bw).toFixed(1)
      out.push(
        `<line x1="${end}" y1="${y + rowH - 3}" x2="${end}" y2="${y + rowH + gap + 3}" stroke="${LABEL}" stroke-opacity="0.75" stroke-dasharray="2 2"/>`,
      )
    }
    acc += p.share
  })

  const y = parts.length * (rowH + gap)
  out.push(
    `<g><title>${escapeXml(`Total: ${formatTokens(total)}`)}</title>` +
      `<text x="0" y="${y + 14}" font-size="12" font-weight="600" ${font} fill="${LABEL}">Total</text>` +
      `<rect x="${trackX}" y="${y + 3}" width="${trackW}" height="${rowH - 6}" rx="${(rowH - 6) / 2}" fill="${TRACK}" fill-opacity="0.28"/>` +
      `<text x="${valueX}" y="${y + 14}" font-size="11" font-weight="600" ${font} fill="${LABEL}" text-anchor="end">${escapeXml(formatTokens(total))}</text></g>`,
  )

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${out.join('')}</svg>`
}

/**
 * The breakdown in terminal cells: a row per part, each bar starting where
 * the one above ended; `after` pads to the track's end so values line up right.
 */
export const waterfallLines = (
  parts: Segment[],
  width: number,
): { label: string; offset: number; bar: string; after: number; value: string; rank: number }[] => {
  const labelW = 16
  const values = parts.map(p => `${formatTokens(p.tokens)} ${shareText(p.share)}`)
  const valueW = Math.max(...values.map(v => v.length)) + 1
  const trackW = Math.max(10, width - labelW - valueW)
  let acc = 0
  return parts.map((p, rank) => {
    const offset = Math.min(trackW - 1, Math.round(acc * trackW))
    const len = Math.max(1, Math.min(trackW - offset, Math.round((acc + p.share) * trackW) - offset))
    acc += p.share
    const name = p.name.length > labelW - 1 ? `${p.name.slice(0, labelW - 2)}…` : p.name
    return {
      label: name.padEnd(labelW),
      offset,
      bar: '█'.repeat(len),
      after: trackW - offset - len,
      value: values[rank]!.padStart(valueW),
      rank,
    }
  })
}

/** The composition strip in terminal cells: each part a run `width`-wide in all, its label inside when it fits. */
export const stripRuns = (segments: Segment[], width: number): { text: string; index: number }[] => {
  let used = 0
  return segments
    .map((s, i) => {
      const end = i === segments.length - 1 ? width : Math.round(used + s.share * width)
      const room = Math.max(0, end - Math.round(used))
      used += s.share * width
      const label = fitLabel(s, room, 1, 2)
      return { text: (label ? ` ${label}` : '').padEnd(room).slice(0, room), index: i }
    })
    .filter(r => r.text.length > 0)
}

/** Readings over a span as an area chart: time across, 0 to 100% up, your line dashed, `now` marked. */
export const svgSpark = (
  samples: [number, number][],
  start: number,
  end: number,
  now: number,
  width: number,
  height: number,
  color: string,
  line: number | null,
): string => {
  const w = Math.max(40, Math.round(width))
  const h = height
  const x = (t: number) => clamp(((t - start) / (end - start)) * w, 0, w)
  const y = (p: number) => h - 1 - clamp(p / 100, 0, 1) * (h - 2)
  const points = samples.filter(([t]) => t >= start && t <= end)
  const nowX = x(now).toFixed(1)
  const mark =
    line === null
      ? ''
      : `<line x1="0" y1="${y(line).toFixed(1)}" x2="${w}" y2="${y(line).toFixed(1)}" stroke="${WARN}" stroke-opacity="0.8" stroke-dasharray="4 3"/>`
  const axis = `<line x1="0" y1="${h - 0.5}" x2="${w}" y2="${h - 0.5}" stroke="${TRACK}" stroke-opacity="0.4"/>`
  const nowLine = `<line x1="${nowX}" y1="0" x2="${nowX}" y2="${h}" stroke="${TRACK}" stroke-width="1.5"/>`
  const open = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">`

  if (points.length === 0) return `${open}${axis}${mark}${nowLine}</svg>`

  // A step line: usage holds until the next reading.
  let d = `M${x(start).toFixed(1)},${y(0).toFixed(1)}`
  for (const [t, p] of points) d += ` H${x(t).toFixed(1)} V${y(p).toFixed(1)}`
  d += ` H${nowX}`
  const area = `${d} V${y(0).toFixed(1)} Z`

  return (
    `${open}${axis}<path d="${area}" fill="${color}" fill-opacity="0.18"/>` +
    `<path d="${d}" fill="none" stroke="${color}" stroke-width="1.5"/>${mark}${nowLine}</svg>`
  )
}
