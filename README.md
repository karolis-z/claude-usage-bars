# claude-usage-bars

A Claude Code mod that draws three progress bars in the band above the prompt:

| Bar | What it shows | Tick mark |
| --- | --- | --- |
| **Context** | How much of the context window the last response used | Where auto-compact starts |
| **5h session** | How much of the current 5-hour limit is used, and when it resets | How far through the 5 hours you are |
| **Fable weekly** | How much of the weekly Fable limit is used, and when it resets | How far through the week you are |

On the limit bars, a fill past the tick means you're using the window faster than it lasts.
Bars turn amber at 60% and red at 85%, and a toast fires once per window when one passes 90%.

In the desktop app the bars are drawn as SVG (hover one for details); in a terminal they're
block characters at an eighth of a cell's precision.

## It costs no tokens

The mod makes no model calls. It reads the figures the engine already has from your normal
responses (`$.session.usage()` and the `session.measure` event), and estimates the auto-compact
point locally. Nothing it draws is sent to the model.

## The Fable bar

The plugin API documents the `five_hour` and `seven_day` limit windows. If the engine reports
a Fable-specific weekly window, the third bar uses it and reads **Fable weekly**. Otherwise it
falls back to the all-models weekly limit and says so: **Weekly · all models**.
`/usage-bars kinds` lists the windows the engine has reported in your session.

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
| `/usage-bars` | Cycles full → compact → hidden |
| `/usage-bars show` · `compact` · `hide` | Sets the view; it's remembered across sessions |
| `/usage-bars kinds` | Lists the rate-limit windows the engine has reported |

## Developing

```
claude plugin validate .
claude plugin test .
claude --plugin-dir .
```

The mod API is early access and changes between releases; this was built against Claude Code 2.1.295.

## License

MIT
