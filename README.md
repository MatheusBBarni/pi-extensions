# pi-extensions

These are the Pi extensions I built for my own day-to-day workflow.

## packages

- `@matheusbbarni/pi-goal-extension` - run Codex `/goal` sessions from inside Pi, with start, resume, status, logs, and agent tools.
- `@matheusbbarni/pi-message-queue` - queue follow-up prompts and let Pi send them one at a time.

## install

```bash
pi install npm:@matheusbbarni/pi-goal-extension
pi install npm:@matheusbbarni/pi-message-queue
```

For local testing from this repo:

```bash
pi -e ./pi-goal-extension
pi -e ./pi-message-queue
```

## develop

```bash
npm install
npm run check
npm run pack:dry-run
```

