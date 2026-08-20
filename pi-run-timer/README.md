# @matheusbbarni/pi-run-timer

Live elapsed time for the current [Pi](https://pi.dev) run.

A compact timer shows above the editor:

```text
Running • 3m9s
Worked • 3m9s
```

This is a widget, not Pi's built-in working row. Themes such as amp-themes hide that row and draw their own "Streaming" / "Thinking" chrome, so a working-message-only timer never appears.

The clock starts when you submit a prompt, keeps ticking across retries and compaction, and stays on the last duration when the run finishes. The next prompt starts it over.

## Install

```bash
pi install npm:@matheusbbarni/pi-run-timer
```

From this repo:

```bash
pi -e ./pi-run-timer
```

Or as a local package:

```bash
pi install ./pi-run-timer
```

If Pi is already open, run `/reload`.

## What it does

- Shows `Running • 3m9s` while a run is in progress, then `Worked • 3m9s` when it finishes
- Also writes the same label to the working message and footer status, for vanilla Pi
- Does not reset if Pi retries or auto-compacts mid-run
- Keeps the last duration on screen when the run finishes; the next prompt starts over
- No-ops in print/JSON mode, where there is no TUI

## Development

```bash
npm install
npm test
npm run typecheck
```
