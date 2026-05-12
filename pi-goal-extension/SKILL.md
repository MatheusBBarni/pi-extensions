---
name: pi-goal-extension
description: Interactive, resumable Codex /goal sessions from Pi. Use when the user asks to run a Codex goal, create a managed Codex task, or resume a Codex goal from Pi while preserving Codex CLI behavior.
---

# Pi Codex Goal

Use this package when the user wants Codex `/goal` work from inside Pi with persistent state and resume support.

## Commands

- `/goal <text>` - run a one-shot Codex goal.
- `/goal start <name|path> [objective]` - create `.codex-goals/<name>.md`, launch Codex, and save session metadata.
- `/goal resume [name] [prompt]` - continue a managed Codex session using `codex exec resume`.
- `/goal status` - list managed goals.
- `/goal templates [query]` - list reusable templates from `.pi-goals/`, `.ai/.pi-goals/`, and `.codex-goals/templates/`.
- `/goal log [name]` - show last output and log paths.
- `/goal stop` - pause/abort current goal when possible.
- `/goal edit [name]` - edit the task file.

Use `/goal start <name> --template <template> --key value -- extra args` to create a managed goal from a reusable template. Templates support simple frontmatter, `{{key}}` placeholders, and `{{args}}`.

## Agent tools

- `codex_goal_run` for one-shot Codex execution.
- `codex_goal_templates` for discovering reusable templates.
- `codex_goal_start` for new persistent goals.
- `codex_goal_resume` for existing persistent goals.

Prefer `codex_goal_start` when the user asks for an interactive or resumable Codex `/goal`. Prefer `codex_goal_resume` when a goal already exists.

## Logs and resume

Managed goals store lightweight state under `.codex-goals/`. Codex JSONL transcripts are written under `.codex-goals/logs/`, and resume uses the Codex session id through `codex exec resume`. Manual `/goal` runs also append a compact result message to Pi's session context so later Pi turns know what Codex accomplished.
