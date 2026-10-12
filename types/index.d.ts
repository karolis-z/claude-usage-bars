/** One rate-limit window as a source last reported it. */
export type Reading = { kind: string; percentUsed: number; resetsAt?: string }

/** One category of the context window, as the local `/context` estimate counts it. */
export type Category = { name: string; tokens: number }

/** What the bars are drawn from: the engine's last measurement, and when it came. */
export type Snapshot = {
  context: {
    tokens?: number
    window: number
    percent?: number
    /**
     * The size is the local estimate, not a reply's reading: after a compaction, or in a
     * fresh session, until the next reply reports the real figure.
     */
    isEstimate?: boolean
  }
  limits: Reading[]
  /** When the engine's limit readings were last refreshed by a response, in ms. */
  freshAt: number
  /** Where auto-compact starts, as a percent of the window; absent when off or unknown. */
  compactAt?: number
  /** What fills the context, largest first; absent until the first estimate. */
  categories?: Category[]
  /**
   * The desktop app's usage card (5-hour, weekly, weekly per model), and when it
   * was read; absent outside the desktop app. The only source of the Fable figure.
   */
  plan?: { limits: Reading[]; at: number }
}

/** One window's readings over time, `[ms, percent]`, for the pace estimate and the trail. */
export type Trail = { resetsAt: number; samples: [number, number][] }

/** Per limit kind (`five_hour`, `seven_day`). */
export type History = Record<string, Trail>

/**
 * `auto`: compact until a bar passes its threshold, then full;
 * `full`: a row per bar; `compact`: all bars on one row; `hidden`: nothing.
 */
export type Mode = 'auto' | 'full' | 'compact' | 'hidden'

/** One bar's settings, changed in the details pane. */
export type BarSettings = {
  /** Your line for a healthy session: tokens on the context bar, percent on the limits. */
  threshold: number
  /** A system notification when the bar crosses it (and, on a limit, when that window resets). */
  notify: boolean
  /** Shown in the band above the prompt. */
  show: boolean
}

export type UsageSettings = {
  context: BarSettings
  session: BarSettings
  weekly: BarSettings
  /** An in-app alert (a toast in Claude Code's window) when a bar crosses its threshold. */
  toasts: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'usage-bars': {
      snapshot: Snapshot | null
      /** The snapshot when the current turn began, for the per-turn change. */
      base: Snapshot | null
      mode: Mode
      settings: UsageSettings
      history: History
      /** Context percent after each turn this session, for the details pane. */
      contextTrail: number[]
      /** Alerts already raised, by window (`kind@window`) or `context`. */
      toasted: string[]
      /** Every rate-limit kind the engine reported this session, for `/usage-bars kinds`. */
      kinds: string[]
      /** The context breakdown in the details pane is open. */
      isSplitOpen: boolean
      /** `/compact` is running from the Compact button. */
      isCompacting: boolean
    }
  }
}
