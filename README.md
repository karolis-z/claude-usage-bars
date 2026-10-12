# claude-usage-bars

A Claude Code mod that draws progress bars in the band above the prompt:

| Bar | What it shows | Tick mark: your threshold |
| --- | --- | --- |
| **Context** | How much of the context window the last response used, split by what fills it | Your line for a healthy session: **400k tokens** by default |
| **5h session** | How much of the current 5-hour limit is used, and when it resets | **80%** by default |
| **Fable weekly** | How much of the weekly Fable limit is used, and when it resets (all models in a terminal) | **80%** by default |

Under each limit bar is where you're heading at your recent pace: **limit in ~1h 45m** (amber)
when you'd hit it before the reset, otherwise **~11% at reset**. The weekly bar shows the daily
budget left instead (**~28%/day left**). Next to each percent, **+1.2%** or **+20k** is what your
last message added.

- A bar turns amber once it passes your threshold, and red (with a `!`) at 95% of the hard limit.
- Crossing a threshold shows a toast in Claude Code, once per window (for context, once until it
  drops back). A system notification (macOS, Windows, Linux) is opt-in per bar; with it on, you're
  also notified when a limit you crossed resets.
- A limit reading over 30 minutes old fades and says how old it is, because other sessions may have
  used more since. A window that has reset shows empty until the next reading.
- Past your context line, a **Compact** button appears under the context bar (between turns): it
  runs `/compact`, exactly as typing it does, so the summary it writes uses tokens as `/compact`
  always does. After any compaction the bar and the breakdown show the compacted conversation at
  once: a local estimate, marked `~` (`~145k / 1M`), until your next reply reports the real size.
- In **auto** mode (the default) the band stays on one compact row until a bar passes its threshold
  or a limit is in sight.
- Click **⤢** at the right end of the band (or a bar's label, or run `/usage-bars details`) for the
  details pane: each bar with its facts on one dotted line, usage over the window with your line
  dashed, a strip of what fills the context with **▸ Show breakdown** under it for a waterfall of
  every part's tokens and share, and the settings.

In the desktop app the band's bars are SVG (hover one for details); in a terminal they're block characters.

## It costs no tokens

The mod makes no model calls. It reads the figures Claude Code already has from your normal
responses (`$.session.usage()` and the `session.measure` event) and estimates the context
breakdown locally. Nothing it draws is sent to the model.

## The weekly bar and Fable

Claude Code reports only the `five_hour` and `seven_day` (all models) windows to mods. The Fable
weekly figure comes from the desktop app instead: the mod calls the app's own usage tool
(`ccd_session_mgmt` / `get_usage`, the figures its usage card shows) directly, every 5 minutes and
after replies. No model, no prompt, no tokens. Each window is taken from whichever source read it
last, so the bars also stay current while you're idle.

- In the desktop app the weekly bar reads **Fable weekly**.
- In a terminal, where that tool doesn't exist, it reads **Weekly · all models**.
- The app's labels aren't a documented format: if they stop matching, the bar falls back to all models.

`/usage-bars kinds` lists what each source reports.

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install usage-bars --marketplace karolis-z/claude-usage-bars
```

Answer `y` to add the marketplace, then pick the user scope. A user-scope install also loads in
the desktop app's Code tab. The repository is private, so installing needs a GitHub login with
access to it.

## Commands

| Command | Does |
| --- | --- |
| `/usage-bars` | Cycles auto → full → compact → hidden |
| `/usage-bars auto` · `show` · `compact` · `hide` | Sets the view; it's remembered across sessions |
| `/usage-bars details` | Opens the details pane |
| `/usage-bars kinds` | Lists the limit windows Claude Code and the desktop app report |

## Settings

In the details pane, under each bar:

| Setting | Default | Step |
| --- | --- | --- |
| **Threshold** (`−` / `+`) | Context 400k tokens; 5h and weekly 80% | 50k tokens; 5% |
| **Notify** | Off | A system notification on crossing, and when that limit resets |
| **In band** | On | Hide a bar from the band; it stays in the pane |

And at the bottom, **In-app alerts** (on): the small message Claude Code shows in its own window
when a bar crosses your threshold. Settings are kept across sessions.

System notifications go through the terminal's own channel when it has one (iTerm2, kitty,
Ghostty), else the OS: `osascript` on macOS (the first one may ask to allow notifications from
Script Editor), a PowerShell toast on Windows, `notify-send` on Linux.

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
