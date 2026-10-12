# Changelog

## 0.3.0

- **Your thresholds:** each bar's tick is now your own line for a healthy session: 400k tokens for
  context, 80% for the 5h and weekly limits. Past it the bar turns amber; red at 95% of the hard limit.
  This replaces the time-gone-by and auto-compact ticks, and the fixed 60/85/90% levels.
- **Settings in the details pane:** `−`/`+` for each threshold, a per-bar **Notify** switch (off by
  default), **In band** to hide a bar from the band, and **In-app alerts** (hover it for what it
  does). Kept across sessions; the `/config` rows are gone.
- **System notifications** that work in the desktop app too: the terminal's own channel when it has
  one, else `osascript` on macOS, a PowerShell toast on Windows, `notify-send` on Linux.
- **Details pane redesign:** each bar is a card with its facts on one dotted line, its trail with
  your line dashed, and its settings in one row. What fills the context is one strip, a colour per
  part with its name and tokens inside when they fit; **▸ Show breakdown** under it opens a
  waterfall: a row per part, each bar starting where the one above ended, ending in the total.
- **Compact button:** past your context line, under the context bar in the band (and on the pane's
  context card): runs `/compact`, between turns only, and says "Compacting…" while it runs.
- **After any compaction** (the button, a typed `/compact`, auto-compact) the bar, the strip and the
  breakdown show the compacted conversation at once. Until the next reply the size is the local
  estimate, marked `~` (`~145k / 1M`), and the pane's trail shows the drop.
- **Icon:** the band's details button is the ⤢ icon alone in a button frame, about twice the size
  of the bare glyph, in both the compact and full layouts.
- **Fixes:** the pane no longer flickers on a click (its drawings are plain images, redrawn only
  when they change); its first click presses rather than only focusing the pane; the breakdown's
  names and values no longer overlap in a narrow pane; one failed read of the app's usage card no
  longer stops the Fable figure until a reload.

## 0.2.0

- **Fable weekly:** in the desktop app the weekly bar shows the Fable limit, read from the app's own
  usage tool (the figures its usage card shows) every 5 minutes and after replies; no model calls.
  Terminal sessions keep the all-models weekly bar.
- **Full width:** compact bars (and terminal bars) now share out the band's whole width instead of a
  fixed size.
- **Reset and staleness:** a limit whose window has reset shows empty and faded until the next
  reading, instead of the old figure; a reading over 30 minutes old fades and says how old it is.
- **Pace:** the "over/under pace" note is replaced by where you're heading at your recent pace:
  "limit in ~1h 45m" (in amber) when you'd hit it before the reset, otherwise "~11% at reset".
  The weekly bar shows the daily budget left ("~28%/day left").
- **Per-turn change:** "+1.2%" or "+20k" next to each bar shows what your last message added.
- **Context by category:** on the desktop the context bar is split into what fills it (messages,
  tools, MCP tools, skills, other); hover a segment for its tokens.
- **Auto mode** (the new default): compact until a bar reaches 60% or a limit is in sight, then full.
- **Reset notification:** a native notification and a toast when a limit you'd reached the alert
  level on resets.
- **Details pane:** click **⤢** at the right end of the band, a bar's label, or `/usage-bars details`: each bar in full, the window's
  usage over time, context after each turn, and the limit windows Claude Code reports.
- **Settings** in `/config`: thresholds, which bars show, toasts and reset notifications.
- **Accessibility:** a `!` at the red level so it reads without colour; the bars don't animate when
  the system asks for reduced motion.
- The band redraws only when something the clock moves would show differently; countdowns above an
  hour step by five minutes.
- One line in the transcript when Claude Code moves a minor release past the one the mod was built for.
- CI runs `claude plugin validate` and `claude plugin test`; `npm run typecheck` type-checks locally.

## 0.1.0

- Context, 5h and weekly bars above the prompt; pace and auto-compact ticks; a toast at 90%;
  `/usage-bars show | compact | hide | kinds`.
