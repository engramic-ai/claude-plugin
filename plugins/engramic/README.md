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

## Requirements

Node 20 or later (tested on 20, 22 and 24). Without Node the hooks exit quietly and do nothing, the setup scan cannot run, and `engramic:setup` says so; the `record` skill does not need Node.

## Licence

MIT, copyright Engramic Ltd (see `LICENSE`). The licence covers the code, not the ENGRAMIC name or logo. The icon (`.claude-plugin/icon.svg`) is the ENGRAMIC mark and is not licensed under MIT.
