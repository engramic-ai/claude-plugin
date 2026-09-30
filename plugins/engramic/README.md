# engramic

A Claude Code plugin that records key decisions and milestones to Engramic over MCP, and audits a repo's Engramic setup.

Assumes the Engramic MCP server is already connected in Claude Code. The plugin does not bundle its own copy, so you never get two sets of tools.

## Two skills

- **`engramic:record`** is when and how to record: decisions, actions, events and discoveries through the two-pass draft then publish flow, with the anchor, `reused`, attribution and gate rules built in. Decisions are always shown to the human before publishing; the rest publish without pausing.
- **`engramic:setup`** audits a repo. A read-only scan script (`skills/setup/scan.mjs`) checks by rule: `.engramic.json`, the permissions allowlist (stale `mcp__Engramic__*` entries, retired tools, missing read tools), `CLAUDE.md` and agent files (retired tools, anchors that are not topic ids, missing `actorId`, missing delegate rule, contradictions with a workspace above the repo, and instructions to record somewhere other than Engramic, which it asks the user to keep, redirect or retire). The skill then resolves every topic id against Engramic and proposes patches, applying them only on approval.

## Hooks

Hooks cannot call MCP tools, so they detect with plain rules and nudge; the skill does the recording.

| Event | What it does |
|---|---|
| `SessionStart` | Nudges orientation (`engramic_summary`, then the last 7 days of decisions) and injects `.engramic.json` defaults. After `compact`, re-surfaces anything flagged but unrecorded. |
| `UserPromptSubmit` | Flags possible decision language, with a soft reminder at most once per cooldown window. |
| `PostToolUse` (Bash) | On a milestone command (`gh pr merge`, `gh release create`, `gh issue close`, a pushed tag such as `git push --tags` or `git push origin v1.2.3`, or `npm publish` (also `pnpm` and `yarn`); local `git tag` and `npm version` are not counted), tells Claude to record it. Rules live in `config.json`. |
| `PostToolUse` (`engramic_record_publish`) | Clears flagged items, unless the publish visibly failed. |
| `Stop` | Safety net. Blocks once if flagged items are still unrecorded. |

**Delegates.** If a hook fires inside a subagent, it never tells the subagent to record. The milestone is queued for the parent session, and the subagent is told to list it under "Records for Engramic" in its final report. This avoids the one-draft-per-operator collision.

## Install

Try it locally:

    claude --plugin-dir ./plugins/engramic

Then check `/hooks` (four hooks listed) and `/help` (skills appear as `engramic:record` and `engramic:setup`). Run `engramic:setup` in a repo to get its defaults in place.

## Per-repo defaults (optional)

Copy `.engramic.example.json` to `.engramic.json` in a repo root:

    { "topic": "t_Example1", "actor": "engramic-platform-agent" }

`topic` is the default anchor topic id. It is optional, but leave it out only in a workspace root, where a session records across several areas and should choose the anchor per record. In an individual repo, set it: without a default, every record has to search for its anchor first. `actor` is passed as `actorId`; leave it out unless the actor exists. Optional `acknowledgedDestinations` lists other places the repo deliberately records to (for example `"docs/learnings.md"`), so `engramic:setup` does not ask about them again.

## Where it runs

| Surface | Skills | Hooks | Setup scan | Status |
|---|---|---|---|---|
| Claude Code (terminal, VS Code, desktop app Code tab) | Yes | Yes | Yes | Tested. Needs Node 20 or later on the machine. |
| Claude Desktop Chat tab, claude.ai | `record` only, with the Engramic connector on | No (hooks run in Cowork and Claude Code, not chat) | No (needs a local repo) | From the docs, untested |
| Cowork | Yes | Documented, but unverified | Unverified | Untested |

The value of the plugin is in Claude Code. Elsewhere, expect the recording skill and little else.

## Workspace mode

Run `node skills/setup/scan.mjs` (or `engramic:setup`) from a workspace root and it switches to workspace mode by itself: a folder that is not a git repo but has a child git repo, or a git repo with at least three child git repos. Only children with a real `.git` folder count. Worktrees and submodules (whose `.git` is a file) are listed but not scanned. It scans the workspace root and every child repo and prints one summary, with the actors cross-checked against the agent roster in the workspace `CLAUDE.md`. Pass `--workspace` to force it, or `--repo DIR` to force repo mode. To skip a retired repo, list it in the workspace `.engramic.json`: `{ "ignoredRepos": ["legacy-tool"] }`.

## Switches

- `ENGRAMIC_RECORDER=off` disables all hooks.
- `ENGRAMIC_RECORDER_STOP=off` disables only the Stop safety net (sensible for headless `claude -p` runs).
- `ENGRAMIC_RECORDER_DEBUG=1` appends one line per hook call (event, tool, which fields were present, `agent_id` and `agent_type`) to `debug.log` in the `engramic-plugin` folder of your OS temp directory. It never logs command or prompt text. Use it to check what the hooks actually receive, for example inside subagents.

## What it reads, keeps and sends

The plugin has no server, makes no network calls of its own and sends no telemetry. Records reach Engramic only when Claude calls the Engramic MCP tools that you have connected, through the `engramic:record` skill. Decisions are shown to you before they are published; actions, events and discoveries publish without pausing.

**The hooks** add short reminder text to Claude's context, and at most once per batch of unrecorded items the Stop hook asks Claude to continue before finishing. They never block a tool call and never change a file.

- **They read:** the hook input from Claude Code (the event, the tool name, the command being run and the message being sent, only to match milestone commands and decision phrases), the plugin's `config.json`, and `.engramic.json` in the working folder.
- **They keep:** one small state file per session in an `engramic-plugin` folder inside the OS temp directory. It holds counts, times and milestone kinds such as "pull request merged", and never the text of a prompt or a command.
- **Optional debug log** (off by default, `ENGRAMIC_RECORDER_DEBUG=1`): event names, tool names, which fields were present, and `agent_id` and `agent_type`. No prompt or command text.
- **They do not use** the network, child processes or dynamic code. The whole hook is one short file, `hooks/engramic-hook.mjs`, with a header comment explaining it.

**The setup scan** (`skills/setup/scan.mjs` and `workspace.mjs`) is read-only. It reads `CLAUDE.md` and agent files, the settings files that decide Engramic permissions (including `~/.claude/settings.json`) and `.engramic.json`. In workspace mode it runs itself once per child repo. It changes nothing: `engramic:setup` proposes patches and applies them only after you approve.

## Troubleshooting

- **No hooks listed.** `/hooks` should show four. Hooks load when a session starts, so restart Claude Code after installing or updating, and check the plugin is enabled in `/plugin`.
- **Claude says the Engramic tools are missing.** Check `/mcp`: the Engramic MCP server must be connected and signed in. The skills then tell Claude once and carry on without recording.
- **Nothing happens and there are no errors.** Node 20 or later may be missing. The hooks then do nothing, and `engramic:setup` tells you the scan needs Node.
- **Too many reminders.** `ENGRAMIC_RECORDER_STOP=off` disables only the Stop nudge; `ENGRAMIC_RECORDER=off` disables all the hooks.
- **See what the hooks receive.** Set `ENGRAMIC_RECORDER_DEBUG=1` and read `debug.log` in the `engramic-plugin` folder of your OS temp directory.
- **Records credited to the wrong person, or a repo that isn't set up.** Run `engramic:setup` in that repo; it checks the actor, anchor topic and recording instructions and proposes fixes.
- **Uninstall.** `/plugin uninstall engramic@engramic-ai`, and delete the `engramic-plugin` temp folder if you want the state files gone.

## Support

Questions and bug reports: open an issue at https://github.com/engramic-ai/claude-plugin/issues.

## Requirements

Node 20 or later (tested on 20, 22 and 24). Without Node the hooks exit quietly and do nothing, the setup scan cannot run, and `engramic:setup` says so; the `record` skill does not need Node.

## Licence

MIT, copyright Engramic Ltd (see `LICENSE`). The licence covers the code, not the ENGRAMIC name or logo. The icon (`.claude-plugin/icon.svg`) is the ENGRAMIC mark and is not licensed under MIT.
