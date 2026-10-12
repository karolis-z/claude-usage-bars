import type { Reading, Snapshot } from '../types'

export type BarId = 'context' | 'session' | 'weekly'

export type Bar = {
  id: BarId
  label: string
  short: string
  /** 0 to 100; null before the engine has a reading. */
  percent: number | null
  detail: string
  /** The tick mark, 0 to 100: auto-compact on context, time elapsed on limits. */
  tick: number | null
  tickNote: string
  /** What a 90% toast is remembered by, so it fires once per window. */
  toastKey: string
}

export type Level = 'ok' | 'warn' | 'high'

const HOUR = 3_600_000
const WINDOW_MS: Record<string, number> = { five_hour: 5 * HOUR, seven_day: 7 * 24 * HOUR }

const HUES: Record<BarId, string> = { context: '#1D9E75', session: '#378ADD', weekly: '#7F77DD' }
const WARN = '#EF9F27'
const HIGH = '#E24B4A'
export const TRACK = '#888780'

export const levelOf = (percent: number | null): Level =>
  percent === null || percent < 60 ? 'ok' : percent < 85 ? 'warn' : 'high'

export const colorOf = (bar: Bar): string => {
  const level = levelOf(bar.percent)
  return level === 'high' ? HIGH : level === 'warn' ? WARN : HUES[bar.id]
}

export const formatTokens = (n: number): string => {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`
  return `${n}`
}

export const formatUntil = (ms: number): string => {
  const minutes = Math.max(0, Math.round(ms / 60_000))
  const days = Math.floor(minutes / 1440)
  const hours = Math.floor((minutes % 1440) / 60)
  const mins = minutes % 60
  if (days > 0) return `${days}d ${hours}h`
  if (hours > 0) return `${hours}h ${mins}m`
  return `${mins}m`
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n))

/** The Fable weekly window when the engine reports one, else the all-models one. */
export const pickWeekly = (limits: Reading[]): Reading | undefined =>
  limits.find(l => /fable/i.test(l.kind)) ?? limits.find(l => l.kind === 'seven_day')

const windowMs = (kind: string): number | undefined =>
  WINDOW_MS[kind] ?? (kind.startsWith('seven_day') ? WINDOW_MS.seven_day : undefined)

const paceNote = (percent: number, elapsed: number): string =>
  percent > elapsed + 5 ? 'over pace' : percent < elapsed - 5 ? 'under pace' : 'on pace'

const limitBar = (id: BarId, label: string, short: string, reading: Reading, now: number): Bar => {
  const percent = clamp(Math.round(reading.percentUsed), 0, 100)
  const resetsAt = reading.resetsAt ? Date.parse(reading.resetsAt) : NaN
  const length = windowMs(reading.kind)
  const hasReset = Number.isFinite(resetsAt)
  const elapsed =
    hasReset && length !== undefined
      ? clamp(Math.round((1 - (resetsAt - now) / length) * 100), 0, 100)
      : null

  return {
    id,
    label,
    short,
    percent,
    detail: hasReset ? `resets in ${formatUntil(resetsAt - now)}` : '',
    tick: elapsed,
    tickNote: elapsed === null ? '' : paceNote(percent, elapsed),
    toastKey: `${reading.kind}@${reading.resetsAt ?? ''}`,
  }
}

export const buildBars = (snap: Snapshot, now: number): Bar[] => {
  const { context, limits, compactAt } = snap
  const bars: Bar[] = [
    {
      id: 'context',
      label: 'Context',
      short: 'ctx',
      percent: context.percent === undefined ? null : clamp(Math.round(context.percent), 0, 100),
      detail: `${context.tokens === undefined ? '—' : formatTokens(context.tokens)} / ${formatTokens(context.window)}`,
      tick: compactAt ?? null,
      tickNote: compactAt === undefined ? '' : `compacts at ${compactAt}%`,
      toastKey: 'context',
    },
  ]

  const session = limits.find(l => l.kind === 'five_hour')
  if (session) bars.push(limitBar('session', '5h session', '5h', session, now))

  const weekly = pickWeekly(limits)
  if (weekly) {
    const isFable = /fable/i.test(weekly.kind)
    bars.push(
      limitBar(
        'weekly',
        isFable ? 'Fable weekly' : 'Weekly · all models',
        isFable ? 'wk·F' : 'wk',
        weekly,
        now,
      ),
    )
  }

  return bars
}

/** The line under a bar: its detail and what its tick means. */
export const subline = (bar: Bar): string => [bar.detail, bar.tickNote].filter(Boolean).join(' · ')

export const percentText = (bar: Bar): string => (bar.percent === null ? '—' : `${bar.percent}%`)

// Terminal bars ---------------------------------------------------------------

/** One run of same-styled cells; `onFill` marks a tick drawn over the filled part. */
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

// Desktop bars ----------------------------------------------------------------

const escapeXml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

export const BAR_HEIGHT = 14

/**
 * The bar as an SVG of `width` CSS pixels: a rounded track, its fill (sliding
 * from `from` when the value moved), the tick, and a hover title.
 */
export const svgBar = (bar: Bar, width: number, from?: number): string => {
  const w = Math.max(24, Math.round(width))
  const h = BAR_HEIGHT
  const y = 3
  const bh = 8
  const px = (p: number) => clamp((p / 100) * w, 0, w)
  const fillW = px(bar.percent ?? 0)
  const color = colorOf(bar)
  const slide =
    from !== undefined && from !== bar.percent
      ? `<animate attributeName="width" from="${px(from).toFixed(1)}" to="${fillW.toFixed(1)}" dur="0.7s" calcMode="spline" keyTimes="0;1" keySplines="0.2 0.8 0.2 1" fill="freeze"/>`
      : ''
  const tick =
    bar.tick === null
      ? ''
      : `<rect x="${clamp(px(bar.tick) - 1, 0, w - 2).toFixed(1)}" y="0" width="2" height="${h}" rx="1" fill="${TRACK}"/>`
  const title = escapeXml(`${bar.label}: ${percentText(bar)} used${subline(bar) ? ` · ${subline(bar)}` : ''}`)

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">` +
    `<title>${title}</title>` +
    `<clipPath id="r"><rect x="0" y="${y}" width="${w}" height="${bh}" rx="${bh / 2}"/></clipPath>` +
    `<g clip-path="url(#r)">` +
    `<rect x="0" y="${y}" width="${w}" height="${bh}" fill="${TRACK}" fill-opacity="0.22"/>` +
    `<rect x="0" y="${y}" width="${fillW.toFixed(1)}" height="${bh}" fill="${color}">${slide}</rect>` +
    `</g>${tick}</svg>`
  )
}
