# @matheusbbarni/pi-message-queue

A [Pi](https://pi.dev) extension that keeps a session-local FIFO queue of user messages and sends them to the agent one at a time.

Pi already has native steering/follow-up keys in recent versions. This package adds an explicit, persistent queue with slash commands, a footer status, and an optional queue widget.

## Install / run

From this repository:

```bash
pi -e ./index.ts
```

Install from npm:

```bash
pi install npm:@matheusbbarni/pi-message-queue
```

Or install it as a local Pi package:

```bash
pi install ./pi-message-queue
```

## Commands

| Command | What it does |
| --- | --- |
| `/queue <message>` | Append a message to the queue. |
| `/queue add <message>` | Append a message to the queue. |
| `/q <message>` | Short alias for `/queue add`. |
| `/queue next <message>` | Put a message at the front of the queue. |
| `/queue list` | Show pending messages. |
| `/queue remove <n>` | Remove the 1-based queue position. |
| `/queue remove #<id>` | Remove by message id. |
| `/queue edit-last` | Pull the last queued message back into the editor. |
| `/queue pause` | Stop dispatching new queued messages. |
| `/queue resume` | Resume dispatching. |
| `/queue clear` | Clear all pending messages. |
| `/queue show` / `/queue hide` | Toggle the below-editor queue widget. |
| `/queue help` | Show a compact help summary. |

Shortcut:

- `Ctrl+Shift+Q` queues the current editor text and clears the editor.
- `Shift+Left` pulls the last queued message back into the editor for editing.

## Behavior

- Queued messages are shown in a compact below-editor widget similar to Pi's built-in follow-up queue display.
- Ordinary user messages submitted while Pi is working are captured into this persistent queue instead of Pi's native steering/follow-up queue.
- Typing `/new` or `/reload` while Pi is working also queues those commands instead of showing Pi's built-in wait warning.
- Queued messages are sent only when Pi is idle and there are no native Pi pending messages.
- Queued `/new` and `/reload` entries run Pi's built-in commands instead of being sent to the agent as prompt text.
- After a queued message completes, the next queued message is sent automatically.
- Queue state is stored as custom session entries, so it survives `/reload`, session resume, and tree navigation on the active branch.
- Custom state entries do not participate in LLM context.

## Package shape

Pi discovers the extension through `package.json`:

```json
{
  "pi": {
    "extensions": ["index.ts"]
  }
}
```

## Development

```bash
npm install
npm run typecheck
```
