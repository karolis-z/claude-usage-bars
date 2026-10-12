# claude-usage-bars

A Claude Code mod that shows three progress bars in the band above the prompt, each with a tick at
your own threshold:

| Bar | What it shows | Your threshold (default) |
| --- | --- | --- |
| **Context** | How full the context window is, split by what fills it | **400k tokens**: your line for a healthy session |
| **5h session** | How much of the current 5-hour limit is used, and when it resets | **80%** |
| **Fable weekly** | How much of the weekly Fable limit is used (all models in a terminal) | **80%** |

It works in the desktop app's Code tab (SVG bars) and in a terminal (block characters). It costs
no tokens.

## Install

You need Claude Code 2.1.295 or newer. Type this at the prompt of a Claude Code session in a
terminal:

```
/plugin install usage-bars --marketplace karolis-z/claude-usage-bars
```

Answer `y` to add the marketplace, then pick the **user** scope. The bars show up in that session
straight away, and in every session after.

The desktop app's Code tab doesn't take this command, but a user-scope install from a terminal loads
there too. The Fable weekly figure needs the desktop app; in a terminal the weekly bar shows all
models.

## How to use

**Read the band.** The context bar shows from the start. The limit bars appear with the first
reading: after your first message, or right away in the desktop app.

- A bar turns **amber** past your threshold, and **red** with a `!` at 95% of the hard limit.
- **+1.2%** or **+20k** next to a percent is what your last message added.
- Under a limit bar is where you're heading at your recent pace: **limit in ~1h 45m** in amber if
  you'd hit it before the reset, otherwise **~11% at reset**. The weekly bar shows **~28%/day left**.
- A **faded** bar is a reading over 30 minutes old: other sessions may have used more since. A
  window that has reset shows empty until the next reading.
- In **auto** view (the default) the band is one compact row, and it switches to a row per bar once
  something needs a look. In the desktop app, hover a bar for everything it knows.

**Compact when you're past your line.** Once the context passes your threshold, a **Compact** button
appears under the context bar between turns. It runs `/compact`, exactly as typing it does.

**Open the details pane.** Click **⤢** at the right end of the band, or a bar's name, or run
`/usage-bars details`. For each bar the pane shows:

- its facts on one line;
- its usage over the window, with your threshold dashed;
- for context, a strip of what fills it. **▸ Show breakdown** opens a waterfall of every part's
  tokens and share.

**Change the settings** in the pane, under each bar. They're kept across sessions.

| Setting | Default | Does |
| --- | --- | --- |
| **Threshold** `−` / `+` | 400k tokens; 80% | Moves your line by 50k tokens or 5% |
| **Notify** | Off | A system notification when the bar crosses your line, and when that limit resets |
| **In band** | On | Hides the bar from the band; it stays in the pane |
| **In-app alerts** (at the bottom) | On | A short message in Claude Code's own window when a bar crosses your line |

**Commands:**

| Command | Does |
| --- | --- |
| `/usage-bars` | Cycles the view: auto → full → compact → hidden |
| `/usage-bars auto` · `show` · `compact` · `hide` | Sets the view, remembered across sessions |
| `/usage-bars details` | Opens the details pane |
| `/usage-bars kinds` | Lists the limit windows each source reports |

## How it works

**No model calls.** The mod only reads figures Claude Code already has:

- the context size and rate limits that come back with every response (`$.session.usage()` and
  the `session.measure` event);
- a local estimate of what fills the context, the same one `/context` uses, which sends no request.

Nothing it draws is sent to the model. The Compact button is the one exception: it runs `/compact`,
which uses tokens for its summary, as it always does.

**Fable weekly comes from the desktop app.** Claude Code reports only the 5-hour and all-models
weekly windows to mods. In the desktop app the mod also calls the app's own usage tool
(`ccd_session_mgmt` / `get_usage`, the figures its usage card shows), every 5 minutes and after
replies. Each window is taken from whichever source read it last, so the bars stay current while
you're idle.

- In a terminal, where that tool doesn't exist, the weekly bar reads **Weekly · all models**.
- The app's labels aren't a documented format. If they stop matching, the bar falls back to all
  models.

**Pace** comes from the readings the mod keeps per window: your last hour of a 5-hour window, or
your last day of a week. Without enough of those, it uses the average so far, once a tenth of the
window has passed.

**After a compaction** the bar and the breakdown show the compacted conversation straight away.
Claude Code reports the real size only with your next reply, so until then the bar shows the local
estimate, marked `~` (`~145k / 1M`).

**Alerts** fire once per window. For context, an alert fires again only after the context has
dropped below 90% of your line (after a compaction, say). System notifications use the terminal's
own channel when it has one (iTerm2, kitty, Ghostty). Otherwise they use the OS:

- `osascript` on macOS (the first one may ask you to allow notifications from Script Editor);
- a PowerShell toast on Windows;
- `notify-send` on Linux.

## Developing

```
npm install
npm run validate
npm test
npm run typecheck
```

`npm run typecheck` needs the type files Claude Code writes into `.claude-plugin/types/` when it
loads the mod, so load it once first (for example `claude --plugin-dir .`). CI runs the validator
and the tests.

The mod API is early access and changes between releases. This was built against Claude Code
2.1.295, and the mod says so once in the transcript when Claude Code moves a minor release past it.

## License

MIT
