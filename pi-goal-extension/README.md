# @matheusbbarni/pi-goal-extension

Interactive, resumable Codex `/goal` sessions for Pi. The extension calls Codex CLI directly, keeps Codex session metadata for resume, and renders a compact Codex-style live transcript in Pi.

## Install / test

From this repo:

```bash
pi -e .
# or load the single-file shim
pi -e ./codex-goal.ts
```

Install from npm:

```bash
pi install npm:@matheusbbarni/pi-goal-extension
```

Or install as a local Pi package:

```bash
pi install ./pi-goal-extension
```

If you still have an older global extension that registers `/goal`, Pi may suffix one command as `/goal:1`. Disable or remove the old extension if you want this one to own `/goal`.

## Commands

```text
/goal <text>                         Run one-shot Codex goal
/goal run <text> [options]           Run one-shot Codex goal
/goal start <name|path> [objective]  Create and run a managed goal
/goal resume [name] [prompt]         Resume a managed Codex session
/goal stop                           Abort/pause current goal
/goal status                         Show goals
/goal templates [query]              List reusable goal templates
/goal log [name]                     Show last output/log path
/goal edit [name]                    Edit the task file
/goal cancel <name> [--all]          Delete state
/goal archive <name>                 Archive state/task
/goal clean [--all]                  Remove completed goals
/goal nuke [--yes]                   Delete all .codex-goals data
```

Managed goals store lightweight state under `.codex-goals/` and Codex JSONL transcripts under `.codex-goals/logs/`. When a manually-run `/goal` finishes, the extension appends a compact result message to the Pi session so the next Pi turn has the Codex outcome in context.

## Reusable templates

Store Markdown or text goal templates under one of these workspace-root directories:

```text
.pi-goals/
.ai/.pi-goals/
.codex-goals/templates/
```

Templates support simple frontmatter plus `{{placeholder}}` and `{{args}}` substitution:

```markdown
---
description: Fix an issue with verification
aliases: fix, issue
---
Fix {{issue}}.

Extra context: {{args}}
```

Start a managed Codex goal from a template:

```text
/goal templates
/goal start fix-123 --template fix-issue --issue ISSUE-123 -- update docs too
```

## Agent tools

- `codex_goal_run` - one-shot Codex goal.
- `codex_goal_templates` - list reusable templates.
- `codex_goal_start` - create a managed goal and optionally launch Codex.
- `codex_goal_resume` - resume a managed goal by name.

The live widget shows recent Codex agent messages and command activity. Full unabridged JSONL output is kept in the log file shown by `/goal log`.
