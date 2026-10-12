/** One rate-limit window as the engine last reported it. */
export type Reading = { kind: string; percentUsed: number; resetsAt?: string }

/** What the bars are drawn from: the last measurement the engine pushed. */
export type Snapshot = {
  context: { tokens?: number; window: number; percent?: number }
  limits: Reading[]
  /** Where auto-compact starts, as a percent of the window; absent when off or unknown. */
  compactAt?: number
}

/** `full`: a row per bar; `compact`: all three on one row; `hidden`: nothing. */
export type Mode = 'full' | 'compact' | 'hidden'

declare module 'claude-code' {
  interface PluginState {
    'usage-bars': {
      snapshot: Snapshot | null
      mode: Mode
      /** Bars already toasted at 90%, by window (`kind@resetsAt`) or `context`. */
      toasted: string[]
      /** Every rate-limit kind seen this session, for `/usage-bars kinds`. */
      kinds: string[]
    }
  }
}
