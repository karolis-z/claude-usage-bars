import { atom, read, update } from 'claude-code'
import type {
  Elements,
  EngineInterface,
  Register,
  SessionContextUsage,
  SessionRateLimit,
  Timer,
} from 'claude-code'

import type { Mode, Reading, Snapshot } from '../types'
import {
  type Bar,
  type BarId,
  type Run,
  BAR_HEIGHT,
  TRACK,
  buildBars,
  cells,
  colorOf,
  levelOf,
  percentText,
  subline,
  svgBar,
} from './bars'

const snapshot = atom({ plugin: 'usage-bars', key: 'snapshot' } as const, null)
const mode = atom({ plugin: 'usage-bars', key: 'mode' } as const, 'full')
const toasted = atom({ plugin: 'usage-bars', key: 'toasted' } as const, [])
const kinds = atom({ plugin: 'usage-bars', key: 'kinds' } as const, [])

/** `$.store` key: the mode outlives the session, so hidden stays hidden. */
const MODE_KEY = 'mode'
const MODES: readonly Mode[] = ['full', 'compact', 'hidden']
const CYCLE: Record<Mode, Mode> = { full: 'compact', compact: 'hidden', hidden: 'full' }
const USAGE = 'Usage: /usage-bars [show | compact | hide | kinds]'

/** Cells to CSS pixels on the desktop surface: its monospace metric, roughly. */
const DESKTOP_CELL_PX = 7.5

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n))

const toReading = ({ kind, percentUsed, resetsAt }: SessionRateLimit): Reading =>
  resetsAt === undefined ? { kind, percentUsed } : { kind, percentUsed, resetsAt }

const toContext = ({ tokens, window, percent }: SessionContextUsage): Snapshot['context'] => ({
  window,
  ...(tokens === undefined ? {} : { tokens }),
  ...(percent === undefined ? {} : { percent }),
})

const withCompactAt = (snap: Snapshot, compactAt: number | undefined): Snapshot => {
  const { compactAt: _old, ...rest } = snap
  return compactAt === undefined ? rest : { ...rest, compactAt }
}

// The module's own variables start over on each reload; `$.state` keeps the rest.

/** What each bar last showed, so a desktop bar slides from there to its new value. */
const drawn: Partial<Record<BarId, number>> = {}
let ticker: Timer | undefined
let compactWindow = 0

/** Where auto-compact starts, estimated locally (`summary` sends no request). */
async function refreshCompactAt($: EngineInterface, window: number) {
  if (window === compactWindow) return
  compactWindow = window

  try {
    const { context } = await $.session.usage({ breakdown: 'summary' })
    const b = context.breakdown
    const at =
      b?.isAutoCompactEnabled && b.autoCompactThreshold !== undefined && context.window > 0
        ? clamp(Math.round((b.autoCompactThreshold / context.window) * 100), 0, 100)
        : undefined
    await update($, snapshot, prev => (prev === null ? prev : withCompactAt(prev, at)))
  } catch {
    compactWindow = 0
  }
}

async function toastPast90($: EngineInterface, snap: Snapshot) {
  const bars = buildBars(snap, await $.clock.now())
  const done = await read($, toasted)
  let keys = done

  for (const bar of bars) {
    if (bar.percent === null) continue
    // Context drops after a compaction: let it warn again next time.
    if (bar.id === 'context' && bar.percent < 80) keys = keys.filter(k => k !== 'context')
    if (bar.percent >= 90 && !keys.includes(bar.toastKey)) {
      $.ui.toast(`${bar.label} is at ${bar.percent}%`)
      keys = [...keys, bar.toastKey]
    }
  }

  if (keys !== done) await update($, toasted, () => keys.slice(-20))
}

async function take($: EngineInterface, context: SessionContextUsage, rateLimits: SessionRateLimit[]) {
  const limits = rateLimits.map(toReading)
  const prev = await read($, snapshot)
  const snap = withCompactAt({ context: toContext(context), limits }, prev?.compactAt)

  await update($, snapshot, () => snap)
  await update($, kinds, seen => {
    const all = [...new Set([...seen, ...limits.map(l => l.kind)])]
    return all.length === seen.length ? seen : all
  })
  await toastPast90($, snap)
  await refreshCompactAt($, context.window)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'usage-bars',
      description: 'Usage bars above the prompt: show, compact, hide, or list the limit kinds seen',
      argumentHint: 'show | compact | hide | kinds',
    })

    const stored = await $.store.get(MODE_KEY)
    if (typeof stored === 'string' && (MODES as readonly string[]).includes(stored)) {
      await update($, mode, () => stored as Mode)
    }

    const usage = await $.session.usage()
    await take($, usage.context, usage.rateLimits)

    // Redraw once a minute so the countdowns and pace ticks keep moving.
    ticker?.cancel()
    ticker = $.clock.every(60_000, () => $.ui.invalidate('ui.render'))

    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    await take($, e.context, e.rateLimits)

    return next(e)
  })

  on('command.run', { command: 'usage-bars' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()

    if (arg === 'kinds') {
      const seen = await read($, kinds)
      return {
        text: seen.length
          ? `Rate-limit kinds the engine reported: ${seen.join(', ')}`
          : 'No rate-limit readings yet. Send a message first.',
      }
    }

    const chosen: Mode | undefined =
      arg === '' ? CYCLE[await read($, mode)]
      : arg === 'show' || arg === 'full' ? 'full'
      : arg === 'compact' ? 'compact'
      : arg === 'hide' ? 'hidden'
      : undefined

    if (chosen === undefined) return { text: USAGE }

    await update($, mode, () => chosen)
    await $.store.set(MODE_KEY, chosen)

    return {
      text:
        chosen === 'hidden' ? 'Usage bars hidden. /usage-bars show brings them back.'
        : chosen === 'compact' ? 'Usage bars: compact.'
        : 'Usage bars: full.',
    }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const below = await next(e)
    if (e.props.hasSurvey) return below

    const shown = await read($, mode)
    const snap = await read($, snapshot)
    if (shown === 'hidden' || snap === null) return below

    const bars = buildBars(snap, await $.clock.now())
    const columns = e.props.bodyColumns

    let ours
    if (e.surface === 'terminal') {
      ours = terminalBand($.ui.resolve(e) as Elements['terminal'], bars, shown, columns)
    } else if (e.surface === 'desktop') {
      const from = { ...drawn }
      ours = desktopBand($.ui.resolve(e) as Elements['desktop'], bars, shown, columns, from)
    } else {
      return below
    }
    for (const bar of bars) drawn[bar.id] = bar.percent ?? 0

    if (!below) return ours
    const { Box } = $.ui.resolve(e)
    return (
      <Box flexDirection="column">
        {ours}
        {below}
      </Box>
    )
  })
}

// Terminal ---------------------------------------------------------------------

const terminalBand = (els: Elements['terminal'], bars: Bar[], shown: Mode, columns: number) => {
  const { Box, Text } = els

  const run = (r: Run, bar: Bar) => {
    const color = colorOf(bar)
    if (r.style === 'fill') return <Text color={color}>{r.text}</Text>
    if (r.style === 'track') return <Text dimColor>{r.text}</Text>
    if (r.style === 'tick') return <Text color={TRACK}>{r.text}</Text>
    return (
      <Text color="#ffffff" backgroundColor={color}>
        {r.text}
      </Text>
    )
  }

  const pct = (bar: Bar) =>
    levelOf(bar.percent) === 'ok' ? (
      <Text bold>{percentText(bar).padStart(4)}</Text>
    ) : (
      <Text bold color={colorOf(bar)}>
        {percentText(bar).padStart(4)}
      </Text>
    )

  if (shown === 'compact') {
    const width = clamp(Math.floor(columns / bars.length) - 13, 6, 16)
    return (
      <Box flexDirection="row" gap={2}>
        {bars.map(bar => (
          <Box key={bar.id} flexDirection="row" gap={1}>
            <Text dimColor>{bar.short}</Text>
            <Box flexDirection="row">{cells(bar.percent, bar.tick, width).map(r => run(r, bar))}</Box>
            {pct(bar)}
          </Box>
        ))}
      </Box>
    )
  }

  const width = clamp(columns - 44, 10, 40)
  return (
    <Box flexDirection="column">
      {bars.map(bar => (
        <Box key={bar.id} flexDirection="row" gap={1}>
          <Text dimColor>{bar.short.padEnd(4)}</Text>
          <Box flexDirection="row">{cells(bar.percent, bar.tick, width).map(r => run(r, bar))}</Box>
          {pct(bar)}
          <Text dimColor wrap="truncate">
            {subline(bar)}
          </Text>
        </Box>
      ))}
    </Box>
  )
}

// Desktop ----------------------------------------------------------------------

const desktopBand = (
  els: Elements['desktop'],
  bars: Bar[],
  shown: Mode,
  columns: number,
  from: Partial<Record<BarId, number>>,
) => {
  const { Box, Text, Svg } = els
  const alt = (bar: Bar) => `${bar.label}: ${percentText(bar)} used`

  const pct = (bar: Bar) =>
    levelOf(bar.percent) === 'ok' ? (
      <Text bold>{percentText(bar)}</Text>
    ) : (
      <Text bold color={colorOf(bar)}>
        {percentText(bar)}
      </Text>
    )

  if (shown === 'compact') {
    const px = 72
    return (
      <Box flexDirection="row" gap={3} alignItems="center">
        {bars.map(bar => (
          <Box key={bar.id} flexDirection="row" gap={1} alignItems="center">
            <Text dimColor>{bar.short}</Text>
            <Svg
              source={svgBar(bar, px, from[bar.id] ?? 0)}
              alt={alt(bar)}
              width={px}
              height={BAR_HEIGHT}
              isInteractive
            />
            {pct(bar)}
          </Box>
        ))}
      </Box>
    )
  }

  const gapPx = 24
  const px = Math.floor((columns * DESKTOP_CELL_PX - gapPx * (bars.length - 1)) / bars.length)
  return (
    <Box flexDirection="row" gap={3}>
      {bars.map(bar => (
        <Box key={bar.id} flexDirection="column" flexGrow={1} gap={0}>
          <Box flexDirection="row" justifyContent="space-between">
            <Text dimColor>{bar.label}</Text>
            {pct(bar)}
          </Box>
          <Svg
            source={svgBar(bar, px, from[bar.id] ?? 0)}
            alt={alt(bar)}
            width={px}
            height={BAR_HEIGHT}
            isInteractive
          />
          <Text dimColor wrap="truncate">
            {subline(bar)}
          </Text>
        </Box>
      ))}
    </Box>
  )
}
