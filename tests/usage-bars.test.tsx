import { describe, expect, mock, test } from 'claude-code/testing'
import type { On, SessionRateLimit } from 'claude-code'

import { buildBars, cells, formatTokens, formatUntil, pickWeekly } from '../hooks/bars'

const NOW = Date.parse('2026-10-12T12:00:00Z')
const iso = (ms: number) => new Date(ms).toISOString()
const HOUR = 3_600_000

const CONTEXT = { tokens: 420_000, window: 1_000_000, percent: 42 }
const LIMITS: SessionRateLimit[] = [
  { kind: 'five_hour', percentUsed: 68, resetsAt: iso(NOW + 2 * HOUR + 15 * 60_000) },
  { kind: 'seven_day', percentUsed: 23, resetsAt: iso(NOW + 3 * 24 * HOUR + 7 * HOUR) },
]

const BAND = {
  plugin: 'usage-bars',
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 20,
    bodyColumns: 100,
    scroll: { offset: 0, bodyRows: 19 },
    view: {},
  },
} as const

const SURFACES = ['terminal', 'desktop'] as const

/** The engine beneath the plugin: the figures it measures, toasts, an empty band. */
const engine = (on: On, toasts: string[] = []) => {
  mock.clock(on, { now: NOW })
  on('session.usage', () => ({ value: { startedAt: NOW, context: CONTEXT, rateLimits: LIMITS } }))
  on('session.measure', ($, e) => ({ changed: e.changed }))
  on('ui.toast', ($, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box />
  })
  return toasts
}

describe('bars', () => {
  test('formats tokens and countdowns', () => {
    expect(formatTokens(420_000)).toBe('420k')
    expect(formatTokens(1_000_000)).toBe('1M')
    expect(formatTokens(1_500_000)).toBe('1.5M')
    expect(formatUntil(2 * HOUR + 15 * 60_000)).toBe('2h 15m')
    expect(formatUntil(3 * 24 * HOUR + 7 * HOUR)).toBe('3d 7h')
  })

  test('fills cells to an eighth and places the tick', () => {
    const runs = cells(50, 25, 8)
    expect(runs.map(r => r.text).join('')).toBe('██│█░░░░')
    expect(runs.find(r => r.style === 'tickOnFill')?.text).toBe('│')
    expect(cells(6.25, null, 8).map(r => r.text).join('')).toBe('▌░░░░░░░')
  })

  test('prefers a Fable weekly window, else falls back to all models', () => {
    expect(pickWeekly(LIMITS)?.kind).toBe('seven_day')
    const withFable = [...LIMITS, { kind: 'seven_day_fable', percentUsed: 3 }]
    expect(pickWeekly(withFable)?.kind).toBe('seven_day_fable')
  })

  test('puts the pace tick where the window is', () => {
    const [, session, weekly] = buildBars({ context: CONTEXT, limits: LIMITS }, NOW)
    // 2h15m left of 5h: 55% elapsed, 68% used.
    expect(session?.tick).toBe(55)
    expect(session?.tickNote).toBe('over pace')
    expect(weekly?.label).toBe('Weekly · all models')
    expect(weekly?.tickNote).toBe('under pace')
  })

  test('shows only the context bar off a subscription', () => {
    const bars = buildBars({ context: CONTEXT, limits: [] }, NOW)
    expect(bars.map(b => b.id)).toEqual(['context'])
  })
})

describe('band', () => {
  test('draws the three bars on terminal and desktop', async ($, on) => {
    engine(on)
    await $.session.measure({ context: CONTEXT, rateLimits: LIMITS, changed: ['context', 'rateLimits'] })

    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ ...BAND, surface })
      expect(await ui.find({ type: 'Text', text: '42%' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: '68%' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: '23%' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /resets in 2h 15m/ })).toBeDefined()
      await ui.unmount()
    }

    const desktop = await $.ui.mount({ ...BAND, surface: 'desktop' })
    expect(await desktop.findAll({ type: 'Svg' })).toHaveLength(3)
    expect(await desktop.find({ type: 'Text', text: 'Weekly · all models' })).toBeDefined()
    await desktop.unmount()
  })

  test('labels the bar Fable weekly when the engine reports it', async ($, on) => {
    engine(on)
    const rateLimits = [...LIMITS, { kind: 'seven_day_fable', percentUsed: 3, resetsAt: LIMITS[1]?.resetsAt }]
    await $.session.measure({ context: CONTEXT, rateLimits, changed: ['rateLimits'] })

    const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
    expect(await ui.find({ type: 'Text', text: 'Fable weekly' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '3%' })).toBeDefined()
    await ui.unmount()
  })

  test('steps aside for a survey', async ($, on) => {
    engine(on)
    await $.session.measure({ context: CONTEXT, rateLimits: LIMITS, changed: ['context'] })

    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ ...BAND, surface, props: { ...BAND.props, hasSurvey: true } })
      expect(await ui.find({ type: 'Text', text: '42%' })).toBeUndefined()
      await ui.unmount()
    }
  })

  test('/usage-bars hides the band and lists the kinds seen', async ($, on) => {
    engine(on)
    mock.store(on)
    await $.session.measure({ context: CONTEXT, rateLimits: LIMITS, changed: ['rateLimits'] })
    const run = (args: string) =>
      $.command.run({
        command: 'usage-bars',
        args,
        origin: { kind: 'composer' },
        presentation: { isFullscreen: false, columns: 100 },
      })

    expect((await run('kinds')).text).toBe('Rate-limit kinds the engine reported: five_hour, seven_day')
    expect((await run('bogus')).text).toMatch(/^Usage:/)

    await run('hide')
    const hidden = await $.ui.mount({ ...BAND, surface: 'terminal' })
    expect(await hidden.find({ type: 'Text', text: '42%' })).toBeUndefined()
    await hidden.unmount()

    await run('compact')
    const compact = await $.ui.mount({ ...BAND, surface: 'terminal' })
    expect(await compact.find({ type: 'Text', text: '42%' })).toBeDefined()
    await compact.unmount()
  })

  test('toasts once when a window passes 90%', async ($, on) => {
    const toasts = engine(on)
    const hot = [{ ...LIMITS[0]!, percentUsed: 91 }, LIMITS[1]!]
    await $.session.measure({ context: CONTEXT, rateLimits: hot, changed: ['rateLimits'] })
    await $.session.measure({ context: CONTEXT, rateLimits: hot, changed: ['rateLimits'] })

    expect(toasts).toEqual(['5h session is at 91%'])
  })
})
