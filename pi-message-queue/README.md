# @matheusbbarni/pi-message-queue

Persistent FIFO for [Pi](https://pi.dev). While Pi is working, Enter queues a follow-up here. Use Alt+Enter or `/steer` when you want to interrupt the current turn.

Queue state lives in the session as custom entries, so it survives `/reload`, resume, and tree navigation. It is not sent to the model.

## Install

```bash
pi install npm:@matheusbbarni/pi-message-queue
```

From this repo:

```bash
pi -e ./index.ts
```

Or as a local package:

```bash
pi install ./pi-message-queue
```

## While Pi is working

| Input | Where it goes |
| --- | --- |
| Enter | This queue |
| Alt+Enter | Native steer. Not this queue. |
| `/steer …`, `/queue steer …` | Native steer. Not this queue. |
| `/queue …`, `/q …`, Ctrl+Shift+Q | This queue |

Use this package when you want a follow-up that waits, persists, and can be edited. Use Alt+Enter or `/steer` when you want to interrupt the current turn.

`/q` is a short alias for `/queue add`. If you already have a prompt template named `q`, this command wins.

## Commands

| Command | What it does |
| --- | --- |
| `/queue <message>` | Append |
| `/queue add <message>` | Append. Same as `/q <message>` |
| `/queue next <message>` | Put at the front |
| `/queue list` | Show pending messages (`ls`, `status`) |
| `/queue remove <n>` | Remove 1-based position |
| `/queue remove #<id>` | Remove by id |
| `/queue edit-last` | Pull the last queued message back into the editor |
| `/queue pause` / `/queue resume` | Stop or start dispatch (`stop`, `start`) |
| `/queue clear` | Drop pending messages. An in-flight send is kept |
| `/queue show` / `/queue hide` | Toggle the below-editor widget |
| `/queue steer <message>` | Steer the current turn. Same as `/steer <message>` |
| `/queue help` | Compact help |

Keys:

- **Enter** queues a follow-up here while Pi is working
- **Alt+Enter** steers the current turn with the editor text
- **Ctrl+Shift+Q** queues the current editor text and clears the editor
- **Shift+Left** restores the last queued message to the editor (editor must be empty)

`/steer` with no arguments uses the current editor text. If Pi is idle, it sends immediately.

A footer status shows the count. The widget lists a short preview of the next few items, plus the steer and edit-last hints.

## Dispatch

The queue sends one message at a time, and only when Pi is idle with no native pending messages. After one finishes, the next goes out automatically unless you paused the queue.

A few special cases:

- `/skill:…` and prompt templates expand when dispatched
- queued `/new` and `/reload` run as Pi commands, not prompt text
- leftover items after a queued `/new` move into the new session
- unknown slash commands stay queued if the editor is busy, or get restored to the editor if it's empty
- a failed or unconfirmed send pauses the queue instead of leaving it stuck
- you cannot remove, edit, or clear the message currently being sent

## Development

```bash
npm install
npm test
npm run typecheck
```
