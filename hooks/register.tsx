import { atom, read, update } from 'claude-code'
import type {
  Elements,
  EngineInterface,
  Register,
  SessionContextUsage,
  SessionRateLimit,
  Timer,
} from 'claude-code'

import type { BarSettings, Category, History, Mode, Reading, UsageSettings, Snapshot } from '../types'
import {
  type Bar,
  type BarId,
  type Fact,
  type Inputs,
  type Run,
  BAR_HEIGHT,
  DEFAULT_SETTINGS,
  MINUTE,
  TRACK,
  WARN,
  buildBars,
  cells,
  clamp,
  clockSignature,
  colorOf,
  formatTokens,
  isSameWindow,
  layoutOf,
  normalizeSettings,
  parsePlan,
  parseTime,
  payloadOf,
  percentText,
  partColor,
  record,
  shareText,
  spark,
  stepThreshold,
  stripRuns,
  subline,
  svgBar,
  svgComposition,
  svgSpark,
  svgWaterfall,
  waterfallLines,
  windowKey,
  windowLength,
} from './bars'

const snapshot = atom({ plugin: 'usage-bars', key: 'snapshot' } as const, null)
const base = atom({ plugin: 'usage-bars', key: 'base' } as const, null)
const mode = atom({ plugin: 'usage-bars', key: 'mode' } as const, 'auto')
const settings = atom({ plugin: 'usage-bars', key: 'settings' } as const, DEFAULT_SETTINGS)
const history = atom({ plugin: 'usage-bars', key: 'history' } as const, {})
const contextTrail = atom({ plugin: 'usage-bars', key: 'contextTrail' } as const, [])
const toasted = atom({ plugin: 'usage-bars', key: 'toasted' } as const, [])
const kinds = atom({ plugin: 'usage-bars', key: 'kinds' } as const, [])
const isSplitOpen = atom({ plugin: 'usage-bars', key: 'isSplitOpen' } as const, false)
const isCompacting = atom({ plugin: 'usage-bars', key: 'isCompacting' } as const, false)

const PANE = 'usage-bars'
const PANE_TITLE = 'Usage'
/** The Claude Code release this mod was written and tested against. */
const BUILT_FOR = '2.1.295'

/** `$.store` keys: what outlives the session. */
const STORE = {
  mode: 'mode',
  settings: 'settings',
  history: 'history',
  notified: 'notified',
  warnedVersion: 'warnedVersion',
} as const

const MODES: readonly Mode[] = ['auto', 'full', 'compact', 'hidden']
const CYCLE: Record<Mode, Mode> = { auto: 'full', full: 'compact', compact: 'hidden', hidden: 'auto' }
const USAGE = 'Usage: /usage-bars [auto | show | compact | hide | details | kinds]'

/** Cells to CSS pixels on the desktop surface: its monospace metric, roughly. */
const DESKTOP_CELL_PX = 7.5
/** Proportional label and percent text, a little wider than a cell to be safe. */
const DESKTOP_CHAR_PX = 8.5
/** What the desktop draws `gap={3}` and `gap={1}` as, roughly. */
const ITEM_GAP_PX = 24
const INNER_GAP_PX = 8
/** The details button: its icon in a button's frame, roughly. */
const ICON_PX = 36
const DETAILS_ICON = '⤢'

const toReading = ({ kind, percentUsed, resetsAt }: SessionRateLimit): Reading =>
  resetsAt === undefined ? { kind, percentUsed } : { kind, percentUsed, resetsAt }

const toContext = ({ tokens, window, percent }: SessionContextUsage): Snapshot['context'] => ({
  window,
  ...(tokens === undefined ? {} : { tokens }),
  ...(percent === undefined ? {} : { percent }),
})

/** The snapshot with these extras, leaving out the ones not known (no undefined fields). */
const withExtras = (snap: Snapshot, compactAt?: number, categories?: Category[]): Snapshot => {
  const { compactAt: _compactAt, categories: _categories, ...rest } = snap
  return {
    ...rest,
    ...(compactAt === undefined ? {} : { compactAt }),
    ...(categories === undefined ? {} : { categories }),
  }
}

const sameReadings = (a: Reading[], b: Reading[]) =>
  a.length === b.length && a.every((r, i) => r.kind === b[i]?.kind && r.percentUsed === b[i]?.percentUsed)

/** `2.1.295` → [2, 1, 295]; a `-dev` suffix and the like are ignored. */
const versionParts = (v: string) => v.split(/[.-]/).slice(0, 3).map(n => Number.parseInt(n, 10) || 0)

const isStoredHistory = (v: unknown): v is History =>
  typeof v === 'object' &&
  v !== null &&
  !Array.isArray(v) &&
  Object.values(v).every(t => typeof t === 'object' && t !== null && Array.isArray((t as { samples?: unknown }).samples))

const appKindsOf = (snap: Snapshot | null): string[] => snap?.plan?.limits.map(l => l.kind) ?? []

/** Where each window comes from, and why the weekly bar is what it is. */
const kindsNote = (engine: string[], app: string[]) =>
  [
    engine.length ? `Claude Code reports: ${engine.join(', ')}.` : 'Claude Code has reported no limit windows yet.',
    app.length
      ? `The desktop app's usage card: ${app.join(', ')}.`
      : "The desktop app's usage card isn't available in this session.",
    [...engine, ...app].some(k => /fable/i.test(k)) ? '' : 'No Fable figure, so the weekly bar shows all models.',
  ]
    .filter(Boolean)
    .join(' ')

/** A Windows toast through PowerShell; the strings are quoted for PowerShell, no shell runs it. */
const windowsToast = (title: string, text: string) => {
  const quote = (s: string) => `'${s.replace(/'/g, "''")}'`
  return [
    '[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null',
    '$t = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)',
    "$n = $t.GetElementsByTagName('text')",
    `$n.Item(0).AppendChild($t.CreateTextNode(${quote(title)})) | Out-Null`,
    `$n.Item(1).AppendChild($t.CreateTextNode(${quote(text)})) | Out-Null`,
    "$id = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe'",
    '[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($id).Show([Windows.UI.Notifications.ToastNotification]::new($t))',
  ].join('; ')
}

// The module's own variables start over on each reload; `$.state` keeps the rest.

/** What each bar last showed, so a desktop bar grows from there to its new value. */
const drawn: Partial<Record<BarId, number>> = {}
/** What the clock-driven parts of the band showed when last drawn. */
let lastSignature = ''
let ticker: Timer | undefined
const resetTimers = new Map<string, Timer>()

/** The desktop app's usage card: read every 5 minutes, and after a measurement at most once a minute. */
const PLAN_EVERY = 5 * MINUTE
const PLAN_MIN_GAP = MINUTE
/** Failed asks in a row before it counts as no such tool here (a terminal, an SDK host) until the next reload. */
const PLAN_GIVE_UP = 3
let planTimer: Timer | undefined
let lastPlanAsk = 0
let planMisses = 0

/**
 * After a compaction, when to read the breakdown again: Claude Code installs the compacted
 * conversation only once the compaction's hooks are done, so the first read may be early.
 */
const SETTLE_AFTER = [250, 1_000, 3_000]
let settleTimer: Timer | undefined

async function inputs($: EngineInterface): Promise<Inputs> {
  return { base: await read($, base), history: await read($, history), settings: await read($, settings) }
}

/**
 * A system notification. A terminal's own channel when it has one with text;
 * else the OS's: `osascript` on macOS, a PowerShell toast on Windows,
 * `notify-send` on Linux. Each runs by its argument vector, never a shell.
 */
async function notifySystem($: EngineInterface, text: string) {
  const title = 'Claude usage'
  try {
    const sent = await $.ui.notify(text, { title })
    if (sent.isSent && sent.channel !== 'terminal_bell') return
  } catch {
    // Refused or failed: the OS's own way below.
  }

  try {
    if ((await $.env.get('OS')) === 'Windows_NT') {
      await $.process.run(['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', windowsToast(title, text)], {
        timeoutMs: 15_000,
      })
      return
    }
    const ran = await $.process.run(
      ['osascript', '-e', 'on run argv', '-e', 'display notification (item 2 of argv) with title (item 1 of argv)', '-e', 'end run', title, text],
      { timeoutMs: 15_000 },
    )
    if (ran.exitCode === 0) return
  } catch {
    // Not macOS, or it would not start: try Linux's.
  }
  try {
    await $.process.run(['notify-send', title, text], { timeoutMs: 15_000 })
  } catch {
    // No way to notify on this machine; the toast, if on, still showed.
  }
}

/**
 * Where auto-compact starts and what fills the context, estimated locally (`summary` sends no
 * request). Until the live window's first reply (a fresh session, or one just compacted), the
 * estimate's total stands in for the context's size.
 *
 * Answers whether the live window has a reply's reading yet; undefined with no breakdown.
 */
async function refreshBreakdown($: EngineInterface): Promise<boolean | undefined> {
  try {
    const { context } = await $.session.usage({ breakdown: 'summary' })
    const b = context.breakdown
    if (!b) return undefined

    const compactAt =
      b.isAutoCompactEnabled && b.autoCompactThreshold !== undefined && context.window > 0
        ? clamp(Math.round((b.autoCompactThreshold / context.window) * 100), 0, 100)
        : undefined
    const categories = b.categories
      .filter(c => c.kind === 'used' && c.tokens > 0)
      .map(c => ({ name: c.name, tokens: c.tokens }))
    const hasReading = context.tokens !== undefined
    const estimate: Snapshot['context'] | undefined =
      !hasReading && b.totalTokens > 0 && context.window > 0
        ? { window: context.window, tokens: b.totalTokens, percent: (b.totalTokens / context.window) * 100, isEstimate: true }
        : undefined

    await update($, snapshot, prev => {
      if (prev === null) return prev
      const next = withExtras(prev, compactAt, categories)
      return estimate ? { ...next, context: estimate } : next
    })
    return hasReading
  } catch {
    // The breakdown needs a bound session; the bars draw without it.
    return undefined
  }
}

/** Reads the breakdown after a compaction, again a little later while the old conversation still stands. */
function settleCompaction($: EngineInterface, attempt: number) {
  settleTimer?.cancel()
  const wait = SETTLE_AFTER[attempt]
  if (wait === undefined) return
  settleTimer = $.clock.after(wait, () => {
    void settleOnce($, attempt)
  })
}

async function settleOnce($: EngineInterface, attempt: number) {
  const hasReading = await refreshBreakdown($)
  if (hasReading === true) {
    // Still the conversation from before the compaction: ask again.
    settleCompaction($, attempt + 1)
    return
  }
  // The drop, in the pane's trail of the context over this session.
  if (hasReading === false) await addToTrail($, (await read($, snapshot))?.context.percent)
}

/** The context's percent, a point in the pane's trail of it over this session. */
async function addToTrail($: EngineInterface, percent: number | undefined) {
  if (percent === undefined) return
  await update($, contextTrail, trail => [...trail, Math.round(percent)].slice(-120))
}

/** New readings into each window's trail, kept across sessions. */
async function addToHistory($: EngineInterface, limits: Reading[], now: number) {
  const before = await read($, history)
  const after = record(before, limits, now)
  if (after === before) return
  await update($, history, () => after)
  await $.store.set(STORE.history, after)
}

/** After any new reading: the alerts it calls for, and the reset notifications to set. */
async function watchThresholds($: EngineInterface, snap: Snapshot, now: number) {
  const given = await inputs($)
  const bars = buildBars(snap, now, given)
  await alertCrossings($, bars, snap, given.settings)
  scheduleResets($, bars, now, given.settings)
}

/** Once per window (once until it drops back, for context): a toast, and a system notification if asked for. */
async function alertCrossings($: EngineInterface, bars: Bar[], snap: Snapshot, chosen: UsageSettings) {
  const done = await read($, toasted)
  const tokens = snap.context.tokens ?? 0
  let keys = done

  for (const bar of bars) {
    if (bar.percent === null || bar.isDim) continue
    // Context drops after a compaction: let it alert again when it climbs back.
    if (bar.id === 'context' && tokens < chosen.context.threshold * 0.9) keys = keys.filter(k => k !== 'context')
    if (!bar.isOver || keys.includes(bar.alertKey)) continue

    keys = [...keys, bar.alertKey]
    const text =
      bar.id === 'context'
        ? `Context is past your ${bar.thresholdText} line: ${formatTokens(tokens)} used.`
        : `${bar.label} is past your ${bar.thresholdText} line: ${bar.percent}% used, ${bar.detail}.`
    if (chosen.toasts) $.ui.toast(text)
    if (chosen[bar.id].notify) await notifySystem($, text)
  }

  if (keys !== done) await update($, toasted, () => keys.slice(-20))
}

async function announceReset($: EngineInterface, reading: Reading, key: string) {
  resetTimers.delete(key)
  $.ui.invalidate('ui.render')

  const stored = await $.store.get(STORE.notified)
  const done = Array.isArray(stored) ? stored.filter((k): k is string => typeof k === 'string') : []
  // Another session may have said it already.
  if (done.includes(key)) return
  await $.store.set(STORE.notified, [...done, key].slice(-20))

  const text = reading.kind === 'five_hour' ? 'Your 5-hour limit has reset.' : 'Your weekly limit has reset.'
  if ((await read($, settings)).toasts) $.ui.toast(text)
  await notifySystem($, text)
}

/** A notification when a window you went past your line on resets, for the bars that notify. */
function scheduleResets($: EngineInterface, bars: Bar[], now: number, chosen: UsageSettings) {
  for (const bar of bars) {
    const reading = bar.reading
    const at = parseTime(reading?.resetsAt)
    if (!reading || at === null || at <= now || !bar.isOver || !chosen[bar.id].notify) continue

    const key = windowKey(reading)
    if (resetTimers.has(key)) continue
    resetTimers.set(
      key,
      $.clock.after(at - now + 5_000, () => {
        void announceReset($, reading, key)
      }),
    )
  }
}

/**
 * Takes a measurement. `isFresh`: a response just came, so the limit readings
 * are current even where they did not move.
 */
async function take($: EngineInterface, context: SessionContextUsage, rateLimits: SessionRateLimit[], isFresh: boolean) {
  const now = await $.clock.now()
  const limits = rateLimits.map(toReading)
  const prev = await read($, snapshot)
  const freshAt =
    // `??`: a snapshot kept from 0.1.0 across the reload has no freshAt.
    prev && !isFresh && (limits.length === 0 || sameReadings(prev.limits, limits)) ? (prev.freshAt ?? now) : now
  // No reading since a compaction (or since the session began): keep the local estimate till one comes.
  const isKept = context.tokens === undefined && prev?.context.isEstimate === true && prev.context.window === context.window
  const snap: Snapshot = { ...(prev ?? {}), context: isKept ? prev.context : toContext(context), limits, freshAt }

  await update($, snapshot, () => snap)
  await addToHistory($, limits, now)
  await update($, kinds, seen => {
    const all = [...new Set([...seen, ...limits.map(l => l.kind)])]
    return all.length === seen.length ? seen : all
  })
  await watchThresholds($, snap, now)
}

/**
 * Reads the desktop app's usage card, the one place the Fable weekly figure
 * is: the app's own tool, called directly (no model, no prompt, no tokens).
 */
async function refreshPlan($: EngineInterface, isForced: boolean) {
  if (planMisses >= PLAN_GIVE_UP) return
  const now = await $.clock.now()
  if (!isForced && now - lastPlanAsk < PLAN_MIN_GAP) return
  lastPlanAsk = now

  let result
  try {
    result = await $.mcp.call('ccd_session_mgmt', 'get_usage', {})
  } catch {
    if (++planMisses >= PLAN_GIVE_UP) planTimer?.cancel()
    return
  }
  planMisses = 0
  // An error or "unavailable" card is passing: keep the last reading and ask again later.
  const limits = result.isError ? null : parsePlan(payloadOf(result))
  if (limits === null) return

  await update($, snapshot, prev => (prev === null ? prev : { ...prev, plan: { limits, at: now } }))
  await addToHistory($, limits, now)
  const snap = await read($, snapshot)
  if (snap !== null) await watchThresholds($, snap, now)
}

/** Redraws when something the clock moves (a countdown, a fade) would show differently. */
async function tick($: EngineInterface) {
  const snap = await read($, snapshot)
  if (snap === null) return
  const signature = clockSignature(buildBars(snap, await $.clock.now(), await inputs($)))
  if (signature === lastSignature) return
  lastSignature = signature
  $.ui.invalidate('ui.render')
}

/** Runs `/compact`, as typing it would: the Compact button's press. Once at a time. */
async function compactNow($: EngineInterface) {
  if (await read($, isCompacting)) return
  await update($, isCompacting, () => true)
  try {
    await $.command.run({ command: 'compact' })
  } catch {
    $.ui.toast("Couldn't compact right now. Try /compact once Claude is idle.")
  } finally {
    await update($, isCompacting, () => false)
  }
}

/** Changes the settings from the pane, and keeps them for the next session. */
async function changeSettings($: EngineInterface, change: (s: UsageSettings) => UsageSettings) {
  const next = normalizeSettings(change(await read($, settings)))
  await update($, settings, () => next)
  await $.store.set(STORE.settings, next)
}

/** One line when Claude Code has moved a minor release past the one this was built for. */
async function warnIfNewer($: EngineInterface) {
  const { version, base: release } = await $.session.version()
  const running = versionParts(release ?? version)
  const built = versionParts(BUILT_FOR)
  const newer = running.findIndex((n, i) => n !== built[i])
  if (newer === -1 || running[newer]! < built[newer]!) return

  const text =
    `usage-bars was built for Claude Code ${BUILT_FOR} and this is ${release ?? version}. ` +
    'The mod API is early access: if the bars look wrong, check for an update to the mod.'
  // Patch releases come often: those go to the debug log alone.
  if (newer === 2) return $.ui.log(text, { to: 'debug' })

  const line = running.slice(0, 2).join('.')
  if ((await $.store.get(STORE.warnedVersion)) === line) return
  await $.store.set(STORE.warnedVersion, line)
  $.ui.log(text)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'usage-bars',
      description: 'Usage bars above the prompt: auto, show, compact, hide, details, or the limit kinds seen',
      argumentHint: 'auto | show | compact | hide | details | kinds',
    })

    const storedMode = await $.store.get(STORE.mode)
    if (typeof storedMode === 'string' && (MODES as readonly string[]).includes(storedMode)) {
      await update($, mode, () => storedMode as Mode)
    }
    const storedSettings = await $.store.get(STORE.settings)
    if (storedSettings !== undefined) await update($, settings, () => normalizeSettings(storedSettings))
    const storedHistory = await $.store.get(STORE.history)
    if (isStoredHistory(storedHistory) && Object.keys(await read($, history)).length === 0) {
      await update($, history, () => storedHistory)
    }

    const usage = await $.session.usage()
    await take($, usage.context, usage.rateLimits, false)
    await refreshBreakdown($)

    ticker?.cancel()
    ticker = $.clock.every(60_000, () => {
      void tick($)
    })
    planTimer?.cancel()
    planTimer = $.clock.every(PLAN_EVERY, () => {
      void refreshPlan($, true)
    })
    void refreshPlan($, true)

    try {
      await warnIfNewer($)
    } catch {
      // Only a courtesy; never in the way of the bars.
    }

    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    // The per-turn change counts from here.
    const snap = await read($, snapshot)
    await update($, base, () => snap)

    return next(e)
  }).catch(($, e, next) => next(e))

  // Any compaction of the main conversation (the button, a typed /compact, auto-compact):
  // show its new size now. Claude Code reports the context again only with the next reply,
  // so until then the bar and the breakdown are the local estimate.
  on('session.compact', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId === undefined && e.trigger !== 'precompute' && result.messages) {
      const tokens = result.tokensAfter
      if (tokens !== undefined) {
        // The old breakdown is gone with the old conversation; the new one follows it in.
        await update($, snapshot, prev => {
          if (prev === null) return prev
          const { categories: _gone, ...rest } = prev
          const { window } = prev.context
          return { ...rest, context: { window, tokens, percent: window > 0 ? (tokens / window) * 100 : 0, isEstimate: true } }
        })
      }
      await update($, base, () => null)
      settleCompaction($, 0)
    }
    return result
    // Never in a compaction's way: a failure here lets it through as it was.
  }).catch(($, e, next) => next(e))

  on('session.measure', async ($, e, next) => {
    await take($, e.context, e.rateLimits, false)
    await refreshPlan($, false)

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const usage = await $.session.usage()
    await take($, usage.context, usage.rateLimits, true)
    await refreshBreakdown($)
    await refreshPlan($, false)
    await addToTrail($, usage.context.percent)

    return next(e)
  })

  on('command.run', { command: 'usage-bars' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()

    if (arg === 'kinds') {
      return { text: kindsNote(await read($, kinds), appKindsOf(await read($, snapshot))) }
    }

    if (arg === 'details') {
      await $.ui.open({ id: PANE, title: PANE_TITLE, focus: true })
      return { text: 'Usage details opened.' }
    }

    const chosen: Mode | undefined =
      arg === '' ? CYCLE[await read($, mode)]
      : arg === 'auto' ? 'auto'
      : arg === 'show' || arg === 'full' ? 'full'
      : arg === 'compact' ? 'compact'
      : arg === 'hide' ? 'hidden'
      : undefined

    if (chosen === undefined) return { text: USAGE }

    await update($, mode, () => chosen)
    await $.store.set(STORE.mode, chosen)

    return {
      text:
        chosen === 'hidden' ? 'Usage bars hidden. /usage-bars auto brings them back.'
        : chosen === 'auto' ? 'Usage bars: auto (compact until a bar passes your threshold).'
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

    const all = buildBars(snap, await $.clock.now(), await inputs($))
    const bars = all.filter(b => b.isShown)
    if (bars.length === 0) return below
    lastSignature = clockSignature(all)

    const layout = layoutOf(shown, bars)
    const columns = e.props.bodyColumns
    // Opened with the keyboard, so the first click in it presses rather than focuses.
    const open = () => {
      void $.ui.open({ id: PANE, title: PANE_TITLE, focus: true })
    }
    // Offered past your context line, between turns: /compact runs only then.
    const running = await read($, isCompacting)
    const compact: CompactOffer = {
      isOffered: running || (bars.some(b => b.id === 'context' && b.isOver) && !e.props.isWorking),
      isRunning: running,
      run: () => {
        void compactNow($)
      },
    }

    let ours
    if (e.surface === 'terminal') {
      ours = terminalBand($.ui.resolve(e) as Elements['terminal'], bars, layout, columns, open, compact)
    } else if (e.surface === 'desktop') {
      ours = desktopBand($.ui.resolve(e) as Rich, bars, layout, columns, { ...drawn }, open, compact)
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

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const snap = await read($, snapshot)
    // To the minute: a click redraws the pane, and a drawing that moved by a
    // fraction of a pixel since the last one would be painted afresh.
    const now = Math.floor((await $.clock.now()) / MINUTE) * MINUTE
    const given = await inputs($)
    const view: PaneView = {
      bars: snap === null ? [] : buildBars(snap, now, given),
      settings: given.settings,
      history: given.history,
      contextTrail: await read($, contextTrail),
      kinds: await read($, kinds),
      appKinds: appKindsOf(snap),
      isSplitOpen: await read($, isSplitOpen),
      isCompacting: await read($, isCompacting),
      now,
      columns: e.props.bodyColumns,
    }
    const act: Actions = {
      step: (id, direction) => {
        void changeSettings($, s => ({ ...s, [id]: { ...s[id], threshold: stepThreshold(id, s[id].threshold, direction) } }))
      },
      toggle: (id, field) => {
        void changeSettings($, s => ({ ...s, [id]: { ...s[id], [field]: !s[id][field] } }))
      },
      toggleToasts: () => {
        void changeSettings($, s => ({ ...s, toasts: !s.toasts }))
      },
      toggleSplit: () => {
        void update($, isSplitOpen, open => !open)
      },
      compact: () => {
        void compactNow($)
      },
    }

    if (e.surface === 'terminal') return terminalPane($.ui.resolve(e) as Elements['terminal'], view, act)
    return richPane($.ui.resolve(e) as Rich, view, act)
  })
}

// Drawing ----------------------------------------------------------------------

/** The elements the rich surfaces (desktop, editor, phone) share with each other. */
type Rich = Pick<Elements['desktop'], 'Box' | 'Text' | 'Button' | 'Svg'>

type Layout = 'full' | 'compact'

/** What the details pane draws from, read once per draw. */
type PaneView = {
  bars: Bar[]
  settings: UsageSettings
  history: History
  contextTrail: number[]
  kinds: string[]
  appKinds: string[]
  isSplitOpen: boolean
  isCompacting: boolean
  now: number
  columns: number
}

/** What the pane's buttons do. */
type Actions = {
  step: (id: BarId, direction: 1 | -1) => void
  toggle: (id: BarId, field: keyof Omit<BarSettings, 'threshold'>) => void
  toggleToasts: () => void
  toggleSplit: () => void
  compact: () => void
}

/** The Compact button: shown past your context line, between turns, or while it runs. */
type CompactOffer = { isOffered: boolean; isRunning: boolean; run: () => void }

// The pieces below draw on every surface: the terminal's elements take the same props.

const compactButton = ({ Button }: Pick<Rich, 'Button'>, isRunning: boolean, run: () => void) => (
  <Button key="compact" label={isRunning ? 'Compacting…' : 'Compact'} onPress={run} />
)

/** `Notify: on`, `In band: off`. */
const onOff = (name: string, isOn: boolean) => `${name}: ${isOn ? 'on' : 'off'}`

const alt = (bar: Bar) => `${bar.label}: ${percentText(bar)} used. ${bar.title}`

/** The percent: bold, in amber or red once it needs a look, faded with its reading. */
const percentEl = ({ Text }: Pick<Rich, 'Text'>, bar: Bar, pad = 0) => {
  const text = percentText(bar).padStart(pad)
  if (bar.isDim) return <Text dimColor>{text}</Text>
  if (bar.level === 'ok') return <Text bold>{text}</Text>
  return (
    <Text bold color={colorOf(bar)}>
      {text}
    </Text>
  )
}

/** A bar's name in the band, a way into the details pane. */
const openLabel = ({ Button }: Pick<Rich, 'Button'>, bar: Bar, text: string, open: () => void) => (
  <Button key={`open-${bar.id}`} plain dimColor onPress={open}>
    {text}
  </Button>
)

/** The line under a bar in the band's full layout; a warning reads in amber. */
const sublineEl = ({ Box, Text }: Pick<Rich, 'Box' | 'Text'>, bar: Bar) =>
  bar.isNoteWarning ? (
    <Box flexDirection="row">
      <Text dimColor>{bar.detail ? `${bar.detail} · ` : ''}</Text>
      <Text color={WARN}>{bar.note}</Text>
    </Box>
  ) : (
    <Text dimColor wrap="truncate">
      {subline(bar)}
    </Text>
  )

/** Facts on one line with dots between, the warnings in the theme's warning colour. */
const dotRow = ({ Box, Text }: Pick<Rich, 'Box' | 'Text'>, items: Fact[]) => (
  <Box flexDirection="row" flexWrap="wrap">
    {items.flatMap((f, i) => [
      ...(i > 0 ? [<Text dimColor> · </Text>] : []),
      f.tone === 'warn' ? <Text color="warning">{f.text}</Text> : <Text dimColor>{f.text}</Text>,
    ])}
  </Box>
)

/** A bar in terminal cells: the fill (faded with its reading), the track, and your line's tick. */
const cellRow = ({ Box, Text }: Pick<Elements['terminal'], 'Box' | 'Text'>, bar: Bar, width: number) => {
  const color = colorOf(bar)
  const run = (r: Run) => {
    if (r.style === 'track') return <Text dimColor>{r.text}</Text>
    if (r.style === 'tick') return <Text color={bar.isOver ? WARN : TRACK}>{r.text}</Text>
    if (r.style === 'tickOnFill') {
      return (
        <Text color="#ffffff" backgroundColor={color}>
          {r.text}
        </Text>
      )
    }
    return bar.isDim ? (
      <Text color={color} dimColor>
        {r.text}
      </Text>
    ) : (
      <Text color={color}>{r.text}</Text>
    )
  }
  return <Box flexDirection="row">{cells(bar.percent, bar.tick, width).map(run)}</Box>
}

/**
 * The band's way into the details pane: the expand icon at its right end, in
 * a button's own frame. Text takes no size here, so the frame is what makes
 * it about twice the bare glyph, and twice as easy to hit.
 */
const detailsButton = (
  { Box, Button }: Pick<Rich, 'Box' | 'Button'>,
  open: () => void,
  alignSelf: 'flex-start' | 'center' = 'center',
) => (
  <Box key="details-area" alignSelf={alignSelf}>
    <Button key="details" onPress={open}>
      {DETAILS_ICON}
    </Button>
  </Box>
)

const terminalBand = (
  els: Elements['terminal'],
  bars: Bar[],
  layout: Layout,
  columns: number,
  open: () => void,
  compact: CompactOffer,
) => {
  const { Box, Text } = els
  const offer = (bar: Bar) =>
    bar.id === 'context' && compact.isOffered ? compactButton(els, compact.isRunning, compact.run) : null

  if (layout === 'compact') {
    // Each bar takes what its share of the row leaves after its label, its
    // percent (at most `100%!`) and the gaps; the details button `[ ⤢ ]` and its gap take seven cells.
    // `[ Compact ]` and its gap, when offered, take fourteen more.
    const reserved =
      bars.reduce((sum, bar) => sum + bar.short.length + 7, 0) + 2 * bars.length + 5 + (compact.isOffered ? 14 : 0)
    const width = Math.max(6, Math.floor((columns - reserved) / bars.length))
    return (
      <Box flexDirection="row" gap={2}>
        {bars.map(bar => (
          <Box key={bar.id} flexDirection="row" gap={1} flexGrow={1}>
            {openLabel(els, bar, bar.short, open)}
            {cellRow(els, bar, width)}
            {percentEl(els, bar)}
            {offer(bar)}
          </Box>
        ))}
        {detailsButton(els, open)}
      </Box>
    )
  }

  // The bar takes the row less its label, percent, change, the longest line
  // under it, and the details icon in its own column at the right.
  const width = Math.max(10, columns - 63)
  return (
    <Box flexDirection="row" gap={2}>
      <Box flexDirection="column" flexGrow={1}>
        {bars.map(bar => (
          <Box key={bar.id} flexDirection="row" gap={1}>
            {openLabel(els, bar, bar.short.padEnd(4), open)}
            {cellRow(els, bar, width)}
            {percentEl(els, bar, 5)}
            <Text dimColor>{(bar.delta ?? '').padEnd(6)}</Text>
            {offer(bar)}
            {sublineEl(els, bar)}
          </Box>
        ))}
      </Box>
      {detailsButton(els, open, 'flex-start')}
    </Box>
  )
}

const desktopBand = (
  els: Rich,
  bars: Bar[],
  layout: Layout,
  columns: number,
  from: Partial<Record<BarId, number>>,
  open: () => void,
  compact: CompactOffer,
) => {
  const { Box, Text, Svg } = els
  const isOffered = (bar: Bar) => bar.id === 'context' && compact.isOffered

  if (layout === 'compact') {
    // Each bar takes what its share of the row leaves after its label, its
    // percent (at most `100%!`), a warning if any, the gaps and the details
    // icon; the items grow to share out what the estimate leaves over.
    const reserved = bars.reduce(
      (sum, bar) =>
        sum + (bar.short.length + 5 + (bar.isNoteWarning ? bar.note.length + 1 : 0)) * DESKTOP_CHAR_PX + 2 * INNER_GAP_PX,
      0,
    )
    // The Compact button, when offered, about 90px with its gap.
    const offered = compact.isOffered ? 90 : 0
    const px = Math.max(
      40,
      Math.floor((columns * DESKTOP_CELL_PX - ITEM_GAP_PX * bars.length - ICON_PX - offered - reserved) / bars.length),
    )
    return (
      <Box flexDirection="row" gap={3} alignItems="center">
        {bars.map(bar => (
          <Box key={bar.id} flexDirection="row" gap={1} alignItems="center" flexGrow={1}>
            {openLabel(els, bar, bar.short, open)}
            <Svg source={svgBar(bar, px, from[bar.id] ?? 0)} alt={alt(bar)} width={px} height={BAR_HEIGHT} isInteractive />
            {percentEl(els, bar)}
            {bar.isNoteWarning ? <Text color={WARN}>{bar.note}</Text> : null}
            {isOffered(bar) ? compactButton(els, compact.isRunning, compact.run) : null}
          </Box>
        ))}
        {detailsButton(els, open)}
      </Box>
    )
  }

  const px = Math.floor((columns * DESKTOP_CELL_PX - ITEM_GAP_PX * bars.length - ICON_PX) / bars.length)
  return (
    <Box flexDirection="row" gap={3}>
      {bars.map(bar => (
        <Box key={bar.id} flexDirection="column" flexGrow={1}>
          <Box flexDirection="row" justifyContent="space-between">
            {openLabel(els, bar, bar.label, open)}
            <Box flexDirection="row" gap={1}>
              {bar.delta ? <Text dimColor>{bar.delta}</Text> : null}
              {percentEl(els, bar)}
            </Box>
          </Box>
          <Svg source={svgBar(bar, px, from[bar.id] ?? 0)} alt={alt(bar)} width={px} height={BAR_HEIGHT} isInteractive />
          {sublineEl(els, bar)}
          {isOffered(bar) ? (
            <Box key="compact-area" flexDirection="row" marginTop={1}>
              {compactButton(els, compact.isRunning, compact.run)}
            </Box>
          ) : null}
        </Box>
      ))}
      {detailsButton(els, open, 'flex-start')}
    </Box>
  )
}

/** The current window's start and end, for a limit bar's trail. */
const windowSpan = (bar: Bar): [number, number] | null => {
  const end = parseTime(bar.reading?.resetsAt)
  const length = bar.reading ? windowLength(bar.reading.kind) : undefined
  return end === null || length === undefined ? null : [end - length, end]
}

const trailOf = (bar: Bar, history: History): [number, number][] => {
  const trail = bar.reading ? history[bar.reading.kind] : undefined
  const end = parseTime(bar.reading?.resetsAt)
  return trail && isSameWindow(trail.resetsAt, end) ? trail.samples : []
}

/** Where the readings come from, for the pane's last line. */
const sourceFacts = (view: PaneView): Fact[] => [
  { text: `Claude Code: ${view.kinds.length ? view.kinds.join(', ') : 'none yet'}`, tone: 'plain' },
  view.appKinds.length
    ? { text: `App card: ${view.appKinds.join(', ')}`, tone: 'plain' }
    : { text: 'No app card here: weekly is all models', tone: 'warn' },
]

const NO_READINGS = 'No usage readings yet. Send a message first.'

/** The hover group that reveals what In-app alerts means. */
const ALERTS_TIP = 'usage-bars-alerts-tip'
const ALERTS_TIP_TEXT =
  "A short message in Claude Code's own window when a bar crosses your threshold. " +
  'System notifications (macOS, Windows) are the Notify switch on each bar.'
const splitLabel = (isOpen: boolean) => (isOpen ? '▾ Hide breakdown' : '▸ Show breakdown')

const terminalPane = (els: Elements['terminal'], view: PaneView, act: Actions) => {
  const { Box, Text, Button } = els
  const width = clamp(view.columns - 4, 10, 80)

  if (view.bars.length === 0) return <Text dimColor>{NO_READINGS}</Text>

  return (
    <Box flexDirection="column" gap={1}>
      {view.bars.map(bar => {
        const s = view.settings[bar.id]
        const color = colorOf(bar)
        const span = windowSpan(bar)
        const trail =
          bar.id === 'context'
            ? spark(
                view.contextTrail.map((p, i): [number, number] => [i, p]),
                -1,
                view.contextTrail.length - 1,
                Math.min(width, view.contextTrail.length),
              )
            : span
              ? spark(trailOf(bar, view.history), span[0], view.now, width)
              : ''
        return (
          <Box key={bar.id} flexDirection="column">
            <Box flexDirection="row" gap={2}>
              <Text bold>{bar.label}</Text>
              <Text bold color={color}>
                {percentText(bar)}
              </Text>
            </Box>
            {cellRow(els, bar, width)}
            {dotRow(els, bar.facts)}
            {bar.id === 'context' && (bar.isOver || view.isCompacting) ? (
              <Box key="compact-area" flexDirection="row">
                {compactButton(els, view.isCompacting, act.compact)}
              </Box>
            ) : null}
            {trail ? <Text color={color}>{trail}</Text> : null}
            {bar.segments ? (
              <Box flexDirection="row">
                {stripRuns(bar.segments, width).map(r => (
                  <Text backgroundColor={partColor(bar.segments![r.index]!, r.index)} color="#ffffff">
                    {r.text}
                  </Text>
                ))}
              </Box>
            ) : null}
            {bar.parts ? (
              <Box flexDirection="row">
                <Button key="context-split" plain dimColor onPress={act.toggleSplit}>
                  {splitLabel(view.isSplitOpen)}
                </Button>
              </Box>
            ) : null}
            {bar.parts && view.isSplitOpen ? (
              <Box flexDirection="column">
                {waterfallLines(bar.parts, width).map(line => (
                  <Box flexDirection="row">
                    <Text dimColor>{line.label}</Text>
                    <Text>{' '.repeat(line.offset)}</Text>
                    <Text color={partColor(bar.parts![line.rank]!, line.rank)}>{line.bar}</Text>
                    <Text dimColor>{' '.repeat(line.after) + line.value}</Text>
                  </Box>
                ))}
              </Box>
            ) : null}
            <Box flexDirection="row" gap={1}>
              <Text dimColor>Threshold</Text>
              <Button key={`${bar.id}-down`} label="−" onPress={() => act.step(bar.id, -1)} />
              <Text bold>{bar.thresholdText}</Text>
              <Button key={`${bar.id}-up`} label="+" onPress={() => act.step(bar.id, 1)} />
              <Button key={`${bar.id}-notify`} label={onOff('Notify', s.notify)} onPress={() => act.toggle(bar.id, 'notify')} />
              <Button key={`${bar.id}-show`} label={onOff('In band', s.show)} onPress={() => act.toggle(bar.id, 'show')} />
            </Box>
          </Box>
        )
      })}
      {dotRow(els, sourceFacts(view))}
      <Box flexDirection="row">
        <Button key="toasts" label={onOff('In-app alerts', view.settings.toasts)} hover={{ scope: ALERTS_TIP }} onPress={act.toggleToasts} />
      </Box>
      <Box key="alerts-tip" display="none" hover={{ scope: ALERTS_TIP, display: 'flex' }}>
        <Text dimColor wrap="wrap">
          {ALERTS_TIP_TEXT}
        </Text>
      </Box>
    </Box>
  )
}

const richPane = (els: Rich, view: PaneView, act: Actions) => {
  const { Box, Text, Svg, Button } = els
  // Inside the card's border and padding.
  const px = clamp(Math.floor(view.columns * DESKTOP_CELL_PX) - 48, 160, 640)

  if (view.bars.length === 0) return <Text dimColor>{NO_READINGS}</Text>
  const turns = view.contextTrail.map((p, i): [number, number] => [i, p])

  return (
    <Box flexDirection="column" gap={2}>
      {view.bars.map(bar => {
        const s = view.settings[bar.id]
        const color = colorOf(bar)
        const span = windowSpan(bar)

        return (
          <Box key={bar.id} flexDirection="column" gap={1} borderStyle="round" borderColor="subtle" paddingX={2} paddingY={1}>
            <Box flexDirection="row" justifyContent="space-between" alignItems="center">
              <Text bold>{bar.label}</Text>
              <Text bold color={color}>
                {percentText(bar)}
              </Text>
            </Box>
            {/* Images, each in a keyed Box: the pane's text says what their hovers did, and a
                redraw (a click) keeps every drawing whose source is the same. */}
            <Box key={`${bar.id}-bar`}>
              <Svg source={svgBar(bar, px)} alt={alt(bar)} width={px} height={BAR_HEIGHT} />
            </Box>
            {dotRow(els, bar.facts)}
            {bar.id === 'context' && (bar.isOver || view.isCompacting) ? (
              <Box key="compact-area" flexDirection="row">
                {compactButton(els, view.isCompacting, act.compact)}
              </Box>
            ) : null}
            {span ? (
              <Box key={`${bar.id}-trail`}>
                <Svg
                  source={svgSpark(trailOf(bar, view.history), span[0], span[1], view.now, px, 44, color, bar.tick)}
                  alt={`${bar.label} over the current window, your line dashed`}
                  width={px}
                  height={44}
                />
              </Box>
            ) : null}
            {bar.id === 'context' && turns.length > 1 ? (
              <Box key="context-turns">
                <Svg
                  source={svgSpark(turns, 0, turns.length - 1, turns.length - 1, px, 44, color, bar.tick)}
                  alt="Context after each turn this session, your line dashed"
                  width={px}
                  height={44}
                />
              </Box>
            ) : null}
            {bar.segments ? (
              <Box key="context-strip">
                <Svg
                  source={svgComposition(bar.segments, px)}
                  alt={`What fills the context: ${bar.segments.map(seg => `${seg.name} ${formatTokens(seg.tokens)}`).join(', ')}`}
                  width={px}
                  height={22}
                />
              </Box>
            ) : null}
            {bar.parts ? (
              <Box key="split-area" flexDirection="row">
                <Button key="context-split" plain dimColor hover={{ dimColor: false }} onPress={act.toggleSplit}>
                  {splitLabel(view.isSplitOpen)}
                </Button>
              </Box>
            ) : null}
            {bar.parts && view.isSplitOpen ? (
              <Box key="context-waterfall">
                <Svg
                  source={svgWaterfall(bar.parts, px)}
                  alt={`The context breakdown: ${bar.parts.map(p => `${p.name} ${formatTokens(p.tokens)} (${shareText(p.share)})`).join(', ')}`}
                  width={px}
                />
              </Box>
            ) : null}
            <Box flexDirection="row" gap={1} alignItems="center" flexWrap="wrap">
              <Text dimColor>Threshold</Text>
              <Button key={`${bar.id}-down`} label="−" onPress={() => act.step(bar.id, -1)} />
              <Text bold>{bar.thresholdText}</Text>
              <Button key={`${bar.id}-up`} label="+" onPress={() => act.step(bar.id, 1)} />
              <Button
                key={`${bar.id}-notify`}
                label={onOff('Notify', s.notify)}
                variant={s.notify ? 'primary' : 'secondary'}
                onPress={() => act.toggle(bar.id, 'notify')}
              />
              <Button key={`${bar.id}-show`} label={onOff('In band', s.show)} onPress={() => act.toggle(bar.id, 'show')} />
            </Box>
          </Box>
        )
      })}
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="row" gap={2} alignItems="center" flexWrap="wrap">
          {dotRow(els, sourceFacts(view))}
          <Button key="toasts" label={onOff('In-app alerts', view.settings.toasts)} hover={{ scope: ALERTS_TIP }} onPress={act.toggleToasts} />
        </Box>
        {/* Shown while the pointer is on the switch: no hook runs for it. */}
        <Box key="alerts-tip" display="none" hover={{ scope: ALERTS_TIP, display: 'flex' }}>
          <Text dimColor wrap="wrap">
            {ALERTS_TIP_TEXT}
          </Text>
        </Box>
      </Box>
    </Box>
  )
}
