import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On, SessionContextBreakdown, SessionContextUsage, SessionRateLimit } from 'claude-code'

import type { Snapshot } from '../types'
import {
  DEFAULT_SETTINGS,
  HOUR,
  MINUTE,
  buildBars,
  cells,
  formatTokens,
  formatUntil,
  kindOfLabel,
  layoutOf,
  mergedLimits,
  normalizeSettings,
  parsePlan,
  payloadOf,
  pickWeekly,
  project,
  record,
  stepThreshold,
  stripRuns,
  svgBar,
  svgComposition,
  svgWaterfall,
  toSegments,
  waterfallLines,
} from '../hooks/bars'

const NOW = Date.parse('2026-10-12T12:00:00Z')
const iso = (ms: number) => new Date(ms).toISOString()

/** Under the default 400k line. */
const CONTEXT = { tokens: 287_000, window: 1_000_000, percent: 29 }
const FIVE_RESETS = NOW + 2 * HOUR + 15 * MINUTE
const WEEK_RESETS = NOW + 3 * 24 * HOUR + 7 * HOUR
/** Under the default 80% lines. */
const LIMITS: SessionRateLimit[] = [
  { kind: 'five_hour', percentUsed: 68, resetsAt: iso(FIVE_RESETS) },
  { kind: 'seven_day', percentUsed: 23, resetsAt: iso(WEEK_RESETS) },
]
const QUIET: SessionRateLimit[] = [
  { kind: 'five_hour', percentUsed: 6, resetsAt: iso(FIVE_RESETS) },
  { kind: 'seven_day', percentUsed: 9, resetsAt: iso(WEEK_RESETS) },
]
const HOT: SessionRateLimit[] = [{ ...LIMITS[0]!, percentUsed: 91 }, LIMITS[1]!]

const SNAP: Snapshot = { context: CONTEXT, limits: LIMITS, freshAt: NOW }
const NONE = { base: null, history: {}, settings: DEFAULT_SETTINGS }

/** What the desktop app's get_usage tool answered in a real session. */
const CARD = {
  plan: {
    status: 'ok',
    plan: 'Team',
    windows: [
      { label: '5-hour limit', percentUsed: 68, resetsAt: iso(FIVE_RESETS), resetsIn: '2h 15m' },
      { label: 'Weekly · all models', percentUsed: 23, resetsAt: iso(WEEK_RESETS), resetsIn: '3d 7h' },
      { label: 'Weekly · Fable', percentUsed: 7, resetsAt: iso(WEEK_RESETS), resetsIn: '3d 7h' },
    ],
    extraUsage: { enabled: false, currency: 'USD' },
  },
  context: { session: 'self', status: 'ok', tokensUsed: 87627, contextWindow: 1000000, percentUsed: 9 },
}
const asToolResult = (payload: unknown) => ({
  content: [{ type: 'text', text: JSON.stringify(payload) }],
  isError: false,
})

const used = (name: string, tokens: number) => ({ name, tokens, color: '', isDeferred: false, kind: 'used' as const })
/** The local `/context` estimate, as `$.session.usage({ breakdown })` answers it. */
const BREAKDOWN = {
  categories: [
    used('Messages', 150_000),
    used('System tools', 60_000),
    used('MCP tools', 40_000),
    used('Skills', 20_000),
    used('System prompt', 12_000),
    used('Memory files', 5_000),
    { name: 'Free space', tokens: 713_000, color: '', isDeferred: false, kind: 'free' as const },
  ],
  totalTokens: 287_000,
  maxTokens: 1_000_000,
  rawMaxTokens: 1_000_000,
  autocompactSource: 'model-default',
  percentage: 29,
  gridRows: [],
  model: 'claude-opus-5-5',
  memoryFiles: [],
  mcpTools: [],
  agents: [],
  autoCompactThreshold: 970_000,
  isAutoCompactEnabled: true,
  apiUsage: null,
} as unknown as SessionContextBreakdown
/** The same once compacted: the conversation is a summary, and no reply has reported a size yet. */
const COMPACTED = {
  ...BREAKDOWN,
  categories: [used('Messages', 8_000), ...BREAKDOWN.categories.slice(1)],
  totalTokens: 145_000,
  percentage: 14,
} as unknown as SessionContextBreakdown
const COMPACTED_CONTEXT = { window: 1_000_000 }

const SITE = { scroll: { offset: 0, bodyRows: 19 }, view: {} }
const BAND = {
  plugin: 'usage-bars',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 20, bodyColumns: 100, ...SITE },
} as const
const PANE = {
  plugin: 'usage-bars',
  component: 'Pane',
  requestId: 'usage-bars',
  props: { title: 'Usage', isFocused: false, bodyColumns: 80, placement: 'dock', ...SITE },
} as const

const SURFACES = ['terminal', 'desktop'] as const

/**
 * The engine beneath the plugin: its figures, clock, store, environment,
 * toasts, notifications, processes, an empty band. `notify` answers
 * `$.ui.notify` as a terminal with a channel does, or as the desktop does (none).
 */
const engine = (on: On, notify: 'channel' | 'none' = 'channel') => {
  const said = {
    toasts: [] as string[],
    notices: [] as string[],
    opened: [] as string[],
    ran: [] as string[][],
    commands: [] as string[],
  }
  const clock = mock.clock(on, { now: NOW })
  mock.store(on)
  mock.env(on, {})
  let isCompacted = false
  on('session.usage', ($, e) => {
    const context = isCompacted ? COMPACTED_CONTEXT : CONTEXT
    const breakdown = isCompacted ? COMPACTED : BREAKDOWN
    return { value: { startedAt: NOW, context: e?.breakdown ? { ...context, breakdown } : context, rateLimits: LIMITS } }
  })
  on('turn.complete', ($, e) => ({ text: e.answer, reason: 'answer' as const }))
  on('session.measure', ($, e) => ({ changed: e.changed }))
  on('ui.toast', ($, e) => {
    said.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.notify', ($, e) => {
    if (notify === 'none') return { value: { isSent: false, reason: 'no-surface' } }
    said.notices.push(e.text)
    return { value: { isSent: true, channel: 'iterm2' } }
  })
  on('process.run', ($, e) => {
    said.ran.push([...e.argv])
    return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('command.run', { command: 'compact' }, ($, e) => {
    said.commands.push(`/${e.command}`)
    return { text: 'Compacted.' }
  })
  on('session.compact', () => {
    isCompacted = true
    return {
      messages: [{ role: 'user' as const, text: 'Summary of the conversation so far', toolUses: [] }],
      tokensBefore: 520_000,
      tokensAfter: 40_000,
    }
  })
  on('ui.open', ($, e) => {
    said.opened.push(e.id)
    return { value: { isPlaced: true } }
  })
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box />
  })
  return { said, clock }
}

const measure = ($: Engine, rateLimits: SessionRateLimit[], context: SessionContextUsage = CONTEXT) =>
  $.session.measure({ context, rateLimits, changed: ['context', 'rateLimits'] })

/** A turn ending: the plugin takes the figures and the local context estimate. */
const finishTurn = ($: Engine) =>
  $.turn.complete({ answer: 'ok', durationMs: 1_000, isAborted: false, turnId: 'turn-1', reason: 'answer' })

describe('formatting', () => {
  test('tokens and countdowns', () => {
    expect(formatTokens(420_000)).toBe('420k')
    expect(formatTokens(1_000_000)).toBe('1M')
    expect(formatTokens(1_500_000)).toBe('1.5M')
    expect(formatUntil(2 * HOUR + 15 * MINUTE)).toBe('2h 15m')
    // Above an hour, to five minutes, so the band redraws less.
    expect(formatUntil(3 * HOUR + 29 * MINUTE)).toBe('3h 30m')
    expect(formatUntil(3 * 24 * HOUR + 7 * HOUR)).toBe('3d 7h')
    expect(formatUntil(42 * MINUTE)).toBe('42m')
  })

  test('cells fill to an eighth and carry the tick', () => {
    const runs = cells(50, 25, 8)
    expect(runs.map(r => r.text).join('')).toBe('██│█░░░░')
    expect(runs.find(r => r.style === 'tickOnFill')?.text).toBe('│')
    expect(cells(6.25, null, 8).map(r => r.text).join('')).toBe('▌░░░░░░░')
  })
})

describe('settings', () => {
  test('defaults: 400k for context, 80% for the limits, notifications off', () => {
    expect(DEFAULT_SETTINGS.context).toEqual({ threshold: 400_000, notify: false, show: true })
    expect(DEFAULT_SETTINGS.session).toEqual({ threshold: 80, notify: false, show: true })
    expect(DEFAULT_SETTINGS.weekly).toEqual({ threshold: 80, notify: false, show: true })
  })

  test('stored settings are filled in and kept in range', () => {
    expect(normalizeSettings(undefined)).toEqual(DEFAULT_SETTINGS)
    const s = normalizeSettings({ context: { threshold: 10 }, session: { threshold: 500, notify: true }, toasts: false })
    expect(s.context.threshold).toBe(50_000)
    expect(s.session).toEqual({ threshold: 100, notify: true, show: true })
    expect(s.toasts).toBe(false)
  })

  test('thresholds step by 50k tokens and 5%', () => {
    expect(stepThreshold('context', 400_000, 1)).toBe(450_000)
    expect(stepThreshold('context', 50_000, -1)).toBe(50_000)
    expect(stepThreshold('session', 80, -1)).toBe(75)
    expect(stepThreshold('weekly', 100, 1)).toBe(100)
    expect(stepThreshold('session', 82, 1)).toBe(85)
  })
})

describe('bars', () => {
  test('the tick is your threshold', () => {
    const [context, session, weekly] = buildBars(SNAP, NOW, NONE)
    // 400k of a 1M window.
    expect(context?.tick).toBe(40)
    expect(context?.thresholdText).toBe('400k')
    expect(session?.tick).toBe(80)
    expect(weekly?.tick).toBe(80)
  })

  test('past the threshold a bar turns amber and says so; near the limit, red', () => {
    const over = buildBars({ ...SNAP, context: { tokens: 520_000, window: 1_000_000, percent: 52 }, limits: HOT }, NOW, NONE)
    expect(over[0]?.isOver).toBe(true)
    expect(over[0]?.level).toBe('warn')
    expect(over[0]?.note).toBe('past 400k')
    expect(over[1]?.isOver).toBe(true)
    expect(over[1]?.facts.some(f => f.tone === 'warn' && f.text === 'past 80%')).toBe(true)
    const full = buildBars({ ...SNAP, limits: [{ ...LIMITS[0]!, percentUsed: 97 }] }, NOW, NONE)
    expect(full[1]?.level).toBe('high')
  })

  test('the weekly bar prefers a Fable window, else all models', () => {
    expect(pickWeekly(LIMITS)?.kind).toBe('seven_day')
    expect(pickWeekly([...LIMITS, { kind: 'seven_day_fable', percentUsed: 3 }])?.kind).toBe('seven_day_fable')
    expect(buildBars(SNAP, NOW, NONE)[2]?.label).toBe('Weekly · all models')
  })

  test('a window that has reset shows empty and faded until the next reading', () => {
    const [, session] = buildBars(SNAP, FIVE_RESETS + 5 * MINUTE, NONE)
    expect(session?.percent).toBe(0)
    expect(session?.isDim).toBe(true)
    expect(session?.detail).toBe('reset 5m ago')
  })

  test('an old reading is faded and says how old', () => {
    const [context, session] = buildBars(SNAP, NOW + 40 * MINUTE, NONE)
    expect(session?.isDim).toBe(true)
    expect(session?.note).toBe('as of 40m ago')
    expect(context?.isDim).toBe(false)
  })

  test('warns when the recent pace hits the limit before the reset', () => {
    // 50% an hour ago, 68% now: 18% an hour, so 100% in about 1h 45m, before the 2h 15m reset.
    const history = record({}, [{ ...LIMITS[0]!, percentUsed: 50 }], NOW - HOUR)
    const [, session] = buildBars(SNAP, NOW, { ...NONE, history })
    expect(session?.isNoteWarning).toBe(true)
    expect(session?.note).toBe('limit in ~1h 45m')
  })

  test('projects the end of the window, and the weekly budget', () => {
    const history = record({}, [{ ...QUIET[0]!, percentUsed: 4 }], NOW - HOUR)
    const bars = buildBars({ ...SNAP, limits: QUIET }, NOW, { ...NONE, history })
    // 4% an hour ago, 6% now: 2% an hour for 2h 15m more.
    expect(bars[1]?.note).toBe('~11% at reset')
    expect(bars[2]?.note).toBe('~28%/day left')
  })

  test('says nothing about pace this early with no history', () => {
    const early = { kind: 'five_hour', percentUsed: 3, resetsAt: iso(NOW + 4 * HOUR + 50 * MINUTE) }
    expect(project(undefined, early, NOW)).toBeNull()
  })

  test('the change since the last message', () => {
    const before: Snapshot = {
      context: { tokens: 267_000, window: 1_000_000, percent: 27 },
      limits: [{ ...LIMITS[0]!, percentUsed: 66.8 }, LIMITS[1]!],
      freshAt: NOW - 5 * MINUTE,
    }
    const [context, session, weekly] = buildBars(SNAP, NOW, { ...NONE, base: before })
    expect(context?.delta).toBe('+20k')
    expect(session?.delta).toBe('+1.2%')
    expect(weekly?.delta).toBeNull()
  })

  test('the context fill is split by category, the rest as Other', () => {
    const segments = toSegments([
      { name: 'Messages', tokens: 50 },
      { name: 'System tools', tokens: 30 },
      { name: 'MCP tools', tokens: 10 },
      { name: 'Skills', tokens: 5 },
      { name: 'Memory files', tokens: 3 },
      { name: 'System prompt', tokens: 2 },
    ])
    expect(segments?.map(s => s.name)).toEqual(['Messages', 'System tools', 'MCP tools', 'Skills', 'Other'])
    expect(segments?.at(-1)?.tokens).toBe(5)
  })

  test('the composition strip labels each part as its room allows', () => {
    const parts = toSegments([
      { name: 'Messages', tokens: 600_000 },
      { name: 'System tools', tokens: 300_000 },
      { name: 'Skills', tokens: 20_000 },
    ])!
    const svg = svgComposition(parts, 400)
    // The large part has room for its name; the small one keeps it for the hover.
    expect(svg).toContain('>Messages 600k</text>')
    expect(svg).not.toContain('>Skills 20k</text>')
    expect(svg).toContain('<title>Skills: 20k (2%)</title>')

    const runs = stripRuns(parts, 40)
    expect(runs.map(r => r.text).join('')).toHaveLength(40)
    expect(runs[0]?.text.trim()).toBe('Messages 600k')
  })

  test('the breakdown is a waterfall: each part starts where the one above ended, then the total', () => {
    const parts = toSegments([
      { name: 'Messages', tokens: 500 },
      { name: 'System tools', tokens: 300 },
      { name: 'Skills', tokens: 200 },
    ])!
    const svg = svgWaterfall(parts, 500)
    const bars = [...svg.matchAll(/<rect x="([\d.]+)" y="\d+" width="([\d.]+)" height="14" rx="7" fill="#/g)].map(m => [Number(m[1]), Number(m[2])])
    // A bar per part, and the total's.
    expect(bars).toHaveLength(4)
    // Each part starts at the end of the one before (to the tenth of a pixel the SVG is written in).
    const [a, b, c] = bars as [number, number][]
    expect(Math.abs(b![0] - (a![0] + a![1])) < 0.2).toBe(true)
    expect(Math.abs(c![0] - (b![0] + b![1])) < 0.2).toBe(true)
    expect(svg).toContain('>Messages</text>')
    expect(svg).toContain('>500 · 50%</text>')
    expect(svg).toContain('>Total</text>')
    // The steps between rows: one fewer than the parts.
    expect(svg.match(/stroke-dasharray="2 2"/g)).toHaveLength(2)

    // Names, bars and values in their own columns: at any width no bar runs into the values.
    for (const width of [240, 330, 600]) {
      const narrow = svgWaterfall(parts, width)
      const valueLeft = Math.min(...[...narrow.matchAll(/text-anchor="end">([^<]+)</g)].map(m => width - m[1]!.length * 6.2))
      const ends = [...narrow.matchAll(/<rect x="([\d.]+)" y="\d+" width="([\d.]+)" height="14"/g)].map(m => Number(m[1]) + Number(m[2]))
      expect(Math.max(...ends) < valueLeft).toBe(true)
      expect(narrow).not.toContain('text-anchor="end">Messages')
    }

    const lines = waterfallLines(parts, 60)
    expect(lines.map(l => l.offset)).toEqual([0, lines[0]!.bar.length, lines[0]!.bar.length + lines[1]!.bar.length])
  })

  test('every drawing is well-formed XML, as an image needs, whatever the names and figures', () => {
    // An SVG drawn as an image is read as strict XML: a bare `<` (as in `<1%`) or `&` and it draws nothing.
    const isWellFormed = (svg: string) =>
      !/<(?![a-zA-Z/])/.test(svg) && !/&(?!(amp|lt|gt|quot|apos);)/.test(svg) && svg.startsWith('<svg') && svg.endsWith('</svg>')
    const parts = toSegments([
      { name: 'Messages', tokens: 900_000 },
      { name: 'MCP "tools" & co', tokens: 20_000 },
      { name: "Skills' <list>", tokens: 600 },
    ])!
    const bars = buildBars({ ...SNAP, categories: [...parts], limits: HOT }, NOW, NONE)
    const drawings = [
      svgWaterfall(toSegments([...parts], 7)!, 330),
      svgComposition(parts, 330),
      ...bars.map(bar => svgBar(bar, 240)),
      ...bars.map(bar => svgBar(bar, 240, 5)),
    ]
    expect(drawings.every(isWellFormed)).toBe(true)
    expect(svgWaterfall(parts, 330)).toContain('&lt;1%')
  })

  test('a hidden bar is still built, for the pane, but not shown', () => {
    const settings = { ...DEFAULT_SETTINGS, session: { ...DEFAULT_SETTINGS.session, show: false } }
    const bars = buildBars(SNAP, NOW, { ...NONE, settings })
    expect(bars.map(b => [b.id, b.isShown])).toEqual([
      ['context', true],
      ['session', false],
      ['weekly', true],
    ])
  })

  test('auto is compact until a bar passes its threshold', () => {
    expect(layoutOf('auto', buildBars({ ...SNAP, limits: QUIET }, NOW, NONE))).toBe('compact')
    expect(layoutOf('auto', buildBars({ ...SNAP, limits: HOT }, NOW, NONE))).toBe('full')
  })

  test('a new window starts a new trail', () => {
    const first = record({}, [LIMITS[0]!], NOW)
    expect(record(first, [LIMITS[0]!], NOW + MINUTE)).toBe(first)
    const next = record(first, [{ ...LIMITS[0]!, percentUsed: 1, resetsAt: iso(FIVE_RESETS + 5 * HOUR) }], NOW + 3 * HOUR)
    expect(next.five_hour?.samples).toHaveLength(1)
  })
})

describe("the desktop app's usage card", () => {
  test('labels name the windows', () => {
    expect(kindOfLabel('5-hour limit')).toBe('five_hour')
    expect(kindOfLabel('Weekly · all models')).toBe('seven_day')
    expect(kindOfLabel('Weekly · Fable')).toBe('seven_day_fable')
    expect(kindOfLabel('Weekly · Opus 4')).toBe('seven_day_opus_4')
    expect(kindOfLabel('Extra usage')).toBeNull()
  })

  test('the card reads as readings', () => {
    expect(parsePlan(payloadOf(asToolResult(CARD)))?.map(r => `${r.kind}=${r.percentUsed}`)).toEqual([
      'five_hour=68',
      'seven_day=23',
      'seven_day_fable=7',
    ])
    expect(parsePlan({ plan: { status: 'unavailable', note: 'try again' } })).toBeNull()
    expect(parsePlan(payloadOf({ content: [{ type: 'text', text: 'not json' }] }))).toBeNull()
  })

  test('each window comes from whichever source read it last', () => {
    const plan = { limits: [{ ...LIMITS[0]!, percentUsed: 70 }, { kind: 'seven_day_fable', percentUsed: 7 }], at: NOW + MINUTE }
    expect(mergedLimits({ ...SNAP, plan }).map(r => `${r.kind}=${r.percentUsed}`)).toEqual([
      'five_hour=70',
      'seven_day=23',
      'seven_day_fable=7',
    ])
    expect(mergedLimits({ ...SNAP, plan: { ...plan, at: NOW - MINUTE } }).find(r => r.kind === 'five_hour')?.percentUsed).toBe(68)
  })

  test('the weekly bar is Fable when the card has it', () => {
    const [, , weekly] = buildBars({ ...SNAP, plan: { limits: parsePlan(CARD)!, at: NOW } }, NOW, NONE)
    expect(weekly?.label).toBe('Fable weekly')
    expect(weekly?.percent).toBe(7)
  })
})

describe('band', () => {
  test('draws the bars on terminal and desktop, with the details icon', async ($, on) => {
    engine(on)
    await measure($, LIMITS)

    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ ...BAND, surface })
      expect(await ui.find({ type: 'Text', text: '29%' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: '68%' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: '23%' })).toBeDefined()
      const icon = await ui.find({ key: 'details' })
      // The icon alone: no words beside or instead of it.
      expect(icon?.text).toBe('⤢')
      expect(icon?.props.label ?? '⤢').toBe('⤢')
      await ui.unmount()
    }

    const desktop = await $.ui.mount({ ...BAND, surface: 'desktop' })
    expect(await desktop.findAll({ type: 'Svg' })).toHaveLength(3)
    await desktop.unmount()
  })

  test('the icon opens the details pane, in compact and full', async ($, on) => {
    const { said } = engine(on)
    for (const limits of [QUIET, HOT]) {
      await measure($, limits)
      for (const surface of SURFACES) {
        const ui = await $.ui.mount({ ...BAND, surface })
        await ui.press({ key: 'details' })
        await ui.unmount()
      }
    }
    expect(said.opened).toEqual(['usage-bars', 'usage-bars', 'usage-bars', 'usage-bars'])
  })

  test('auto mode stays compact while everything is under its threshold', async ($, on) => {
    engine(on)
    await measure($, QUIET)

    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    expect(await ui.find({ type: 'Button', text: 'ctx' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /resets in/ })).toBeUndefined()
    await ui.unmount()
  })

  test('compact bars take the width of the band', async ($, on) => {
    engine(on)
    await measure($, QUIET)

    const widths = async (bodyColumns: number) => {
      const ui = await $.ui.mount({ ...BAND, surface: 'desktop', props: { ...BAND.props, bodyColumns } })
      const svgs = await ui.findAll({ type: 'Svg' })
      await ui.unmount()
      return svgs.map(s => s.props.width as number)
    }

    const narrow = await widths(100)
    const wide = await widths(160)
    // 100 columns are about 750px: three bars of about 140px once labels, percents, gaps and the icon are out.
    expect(narrow.every(w => w > 130)).toBe(true)
    expect(new Set(narrow).size).toBe(1)
    expect(wide[0]! - narrow[0]!).toBe(150)
  })

  test("reads the Fable weekly figure from the desktop app's usage card", async ($, on) => {
    engine(on)
    const asked: string[] = []
    on('mcp.call', ($, e) => {
      asked.push(`${e.server}/${e.tool}`)
      return { value: asToolResult(CARD) }
    })
    await measure($, LIMITS)
    expect(asked).toEqual(['ccd_session_mgmt/get_usage'])

    const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
    expect(await ui.find({ type: 'Text', text: '7%' })).toBeDefined()
    await ui.unmount()
  })

  test('a failed read of the usage card is tried again; three in a row and it stops asking', async ($, on) => {
    const { clock } = engine(on)
    let failures = 1
    let asks = 0
    on('mcp.call', () => {
      asks++
      if (failures-- > 0) throw new Error('busy')
      return { value: asToolResult(CARD) }
    })
    await measure($, LIMITS)
    await clock.advance(MINUTE)
    await measure($, LIMITS)
    expect(asks).toBe(2)
    const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
    expect(await ui.find({ type: 'Text', text: '7%' })).toBeDefined()
    await ui.unmount()

    // No such tool here (a terminal): three failures, then no more asks.
    failures = Infinity
    for (let i = 0; i < 5; i++) {
      await clock.advance(MINUTE)
      await measure($, LIMITS)
    }
    expect(asks).toBe(5)
  })

  test('fades a reading that has grown old', async ($, on) => {
    const { clock } = engine(on)
    await measure($, HOT)
    await clock.advance(31 * MINUTE)

    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    expect(await ui.find({ type: 'Text', text: /as of 31m ago/ })).toBeDefined()
    await ui.unmount()
  })

  test('steps aside for a survey', async ($, on) => {
    engine(on)
    await measure($, LIMITS)

    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ ...BAND, surface, props: { ...BAND.props, hasSurvey: true } })
      expect(await ui.find({ type: 'Text', text: '29%' })).toBeUndefined()
      await ui.unmount()
    }
  })
})

describe('compact', () => {
  const PAST = { tokens: 520_000, window: 1_000_000, percent: 52 }

  test('past your context line, a Compact button runs /compact', async ($, on) => {
    const { said } = engine(on)
    await measure($, QUIET, PAST)

    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ ...BAND, surface })
      expect((await ui.find({ key: 'compact' }))?.props.label).toBe('Compact')
      await ui.press({ key: 'compact' })
      await ui.unmount()
    }
    expect(said.commands).toEqual(['/compact', '/compact'])

    const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
    await pane.press({ key: 'compact' })
    await pane.unmount()
    expect(said.commands).toHaveLength(3)
  })

  test('no Compact button under the line, or while Claude is working', async ($, on) => {
    engine(on)
    await measure($, QUIET)
    const under = await $.ui.mount({ ...BAND, surface: 'desktop' })
    expect(await under.find({ key: 'compact' })).toBeUndefined()
    await under.unmount()

    await measure($, QUIET, PAST)
    const working = await $.ui.mount({ ...BAND, surface: 'desktop', props: { ...BAND.props, isWorking: true } })
    expect(await working.find({ key: 'compact' })).toBeUndefined()
    await working.unmount()
  })

  test('after any compaction the context bar shows the new size at once', async ($, on) => {
    engine(on)
    await measure($, QUIET, PAST)
    await $.session.compact({
      trigger: 'manual',
      messages: [
        { role: 'user', text: 'Plan the mod', toolUses: [] },
        { role: 'assistant', text: 'Here is the plan', toolUses: [] },
      ],
    })

    const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
    expect(await ui.find({ type: 'Text', text: '4%' })).toBeDefined()
    expect(await ui.find({ key: 'compact' })).toBeUndefined()
    await ui.unmount()
  })

  test('once the compaction is in, the breakdown and the size are the new estimate', async ($, on) => {
    const { clock } = engine(on)
    await measure($, QUIET, PAST)
    await finishTurn($)
    await $.session.compact({ trigger: 'manual', messages: [{ role: 'user', text: 'Plan the mod', toolUses: [] }] })
    await clock.advance(250)

    const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
    expect(await band.find({ type: 'Text', text: '14%' })).toBeDefined()
    expect(await band.find({ type: 'Text', text: '~145k / 1M' })).toBeDefined()
    await band.unmount()

    const pane = await $.ui.mount({ ...PANE, surface: 'terminal' })
    await pane.press({ key: 'context-split' })
    expect(await pane.find({ type: 'Text', text: /\s8k 6%$/ })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: /\s150k / })).toBeUndefined()
    await pane.press({ key: 'context-split' })
    await pane.unmount()

    // No reply since: a measurement without a size keeps the estimate.
    await measure($, QUIET, COMPACTED_CONTEXT)
    const again = await $.ui.mount({ ...BAND, surface: 'desktop' })
    expect(await again.find({ type: 'Text', text: '14%' })).toBeDefined()
    await again.unmount()
  })

  test('a compaction computed ahead of time changes nothing', async ($, on) => {
    engine(on)
    await measure($, QUIET, PAST)
    await $.session.compact({ trigger: 'precompute', messages: [{ role: 'user', text: 'Plan the mod', toolUses: [] }] })
    const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
    expect(await ui.find({ type: 'Text', text: '52%' })).toBeDefined()
    await ui.unmount()
  })
})

describe('alerts', () => {
  test('crossing a threshold toasts once, with no system notification by default', async ($, on) => {
    const { said, clock } = engine(on)
    await measure($, HOT)
    await measure($, HOT)
    expect(said.toasts).toEqual(['5h session is past your 80% line: 91% used, resets in 2h 15m.'])
    expect(said.notices).toEqual([])

    await clock.advance(2 * HOUR + 16 * MINUTE)
    expect(said.notices).toEqual([])
  })

  test('with notifications on: one when crossing, one when that window resets', async ($, on) => {
    const { said, clock } = engine(on)
    await measure($, LIMITS)
    const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
    await pane.press({ key: 'session-notify' })
    await pane.unmount()

    await measure($, HOT)
    expect(said.notices).toEqual(['5h session is past your 80% line: 91% used, resets in 2h 15m.'])

    await clock.advance(2 * HOUR + 16 * MINUTE)
    expect(said.notices.at(-1)).toBe('Your 5-hour limit has reset.')
  })

  test('the context alert counts tokens against your line', async ($, on) => {
    const { said } = engine(on)
    await measure($, QUIET, { tokens: 410_000, window: 1_000_000, percent: 41 })
    expect(said.toasts).toEqual(['Context is past your 400k line: 410k used.'])
  })

  test("in the desktop app, where Claude Code has no notification channel, the OS's own shows it", async ($, on) => {
    const { said } = engine(on, 'none')
    await measure($, LIMITS)
    const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
    await pane.press({ key: 'session-notify' })
    await pane.unmount()

    await measure($, HOT)
    expect(said.ran).toHaveLength(1)
    expect(said.ran[0]?.[0]).toBe('osascript')
    // The text rides as an argument, never inside the script.
    expect(said.ran[0]?.at(-1)).toBe('5h session is past your 80% line: 91% used, resets in 2h 15m.')
  })
})

describe('command and pane', () => {
  const run = ($: Engine, args: string) =>
    $.command.run({
      command: 'usage-bars',
      args,
      origin: { kind: 'composer' },
      presentation: { isFullscreen: false, columns: 100 },
    })

  test('/usage-bars switches the view and lists the kinds seen', async ($, on) => {
    engine(on)
    await measure($, LIMITS)

    expect((await run($, 'kinds')).text).toBe(
      "Claude Code reports: five_hour, seven_day. The desktop app's usage card isn't available in this session. " +
        'No Fable figure, so the weekly bar shows all models.',
    )
    expect((await run($, 'bogus')).text).toMatch(/^Usage:/)

    await run($, 'hide')
    const hidden = await $.ui.mount({ ...BAND, surface: 'terminal' })
    expect(await hidden.find({ type: 'Text', text: '29%' })).toBeUndefined()
    await hidden.unmount()

    await run($, 'compact')
    const compact = await $.ui.mount({ ...BAND, surface: 'terminal' })
    expect(await compact.find({ type: 'Button', text: 'ctx' })).toBeDefined()
    await compact.unmount()
  })

  test('the pane shows each bar with its facts, trail and settings', async ($, on) => {
    engine(on)
    await measure($, LIMITS)
    expect((await run($, 'details')).text).toBe('Usage details opened.')

    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ ...PANE, surface })
      expect(await ui.find({ type: 'Text', text: '5h session' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /resets in 2h 15m/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /healthy ≤ 400k/ })).toBeDefined()
      expect(await ui.find({ key: 'context-up' })).toBeDefined()
      expect((await ui.find({ key: 'weekly-notify' }))?.props.label).toBe('Notify: off')
      await ui.unmount()
    }

    const desktop = await $.ui.mount({ ...PANE, surface: 'desktop' })
    // A bar for each, and a trail for each limit window.
    expect(await desktop.findAll({ type: 'Svg' })).toHaveLength(5)
    await desktop.unmount()
  })

  test('the breakdown opens under the context strip, and closes again', async ($, on) => {
    engine(on)
    await measure($, LIMITS)
    await finishTurn($)

    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ ...PANE, surface })
      expect((await ui.find({ key: 'context-split' }))?.text).toBe('▸ Show breakdown')
      await ui.press({ key: 'context-split' })
      expect((await ui.find({ key: 'context-split' }))?.text).toBe('▾ Hide breakdown')
      if (surface === 'terminal') {
        expect(await ui.find({ type: 'Text', text: /^Memory files/ })).toBeDefined()
      } else {
        // The bars, two trails, the strip, and the waterfall.
        expect(await ui.findAll({ type: 'Svg' })).toHaveLength(7)
      }
      await ui.press({ key: 'context-split' })
      await ui.unmount()
    }
  })

  test('the in-app alert switch says what it is, and explains itself on hover', async ($, on) => {
    engine(on)
    await measure($, LIMITS)
    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ ...PANE, surface })
      const button = await ui.find({ key: 'toasts' })
      expect(button?.props.label).toBe('In-app alerts: on')
      // The tip is drawn hidden; the surface shows it while the switch is hovered
      // (the hover group is the surface's own, so the kit does not report it).
      expect((await ui.find({ key: 'alerts-tip' }))?.props.display).toBe('none')
      expect(await ui.find({ type: 'Text', text: /short message in Claude Code's own window/ })).toBeDefined()
      await ui.press({ key: 'toasts' })
      expect((await ui.find({ key: 'toasts' }))?.props.label).toBe('In-app alerts: off')
      await ui.press({ key: 'toasts' })
      await ui.unmount()
    }
  })

  test('a click redraws the pane without changing the drawings it did not touch', async ($, on) => {
    const { clock } = engine(on)
    await measure($, LIMITS)
    await finishTurn($)

    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    const before = (await ui.findAll({ type: 'Svg' })).map(svg => svg.props.source)
    await clock.advance(20_000)
    await ui.press({ key: 'context-split' })
    const after = (await ui.findAll({ type: 'Svg' })).map(svg => svg.props.source)
    await ui.unmount()

    // Every drawing that was there is the same; the waterfall is added.
    expect(after).toHaveLength(before.length + 1)
    for (const source of before) expect(after).toContain(source)
    // Images, not live frames, in the pane.
    expect(after.length).toBeGreaterThan(0)
  })

  test('the pane changes the thresholds and what the band shows', async ($, on) => {
    engine(on)
    await measure($, LIMITS)

    const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
    await pane.press({ key: 'context-up' })
    await pane.press({ key: 'session-down' })
    await pane.press({ key: 'session-show' })
    expect(await pane.find({ type: 'Text', text: '450k' })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: '75%' })).toBeDefined()
    expect((await pane.find({ key: 'session-show' }))?.props.label).toBe('In band: off')
    await pane.unmount()

    const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
    expect(await band.find({ key: 'open-session' })).toBeUndefined()
    expect(await band.findAll({ type: 'Svg' })).toHaveLength(2)
    await band.unmount()
  })
})
