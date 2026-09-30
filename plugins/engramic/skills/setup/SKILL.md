---
name: setup
description: Audit and patch a repo's Engramic setup for Claude Code. Use when the user asks to set up, check or fix Engramic recording in a repo or workspace, mentions stale Engramic permissions, missing actor attribution, broken anchor topics, or asks why records are credited to the wrong person.
---

# Engramic setup audit

Find what is wrong or missing in a repo's Engramic setup, show concrete patches, and apply them only when the user agrees. Never change a file without showing the diff first. Ask one question at a time.

The detection is deterministic: a scan script does the reading and rule-checking, and you interpret the result. Do not re-derive its findings by hand.

## Workspace mode

Run the scan from the folder you were asked about:

    node <skill-dir>/scan.mjs

At a workspace root the script switches to workspace mode by itself, so you do not have to decide. That means a folder that is not a git repo but has a child git repo, or a folder that is a git repo and has at least three child git repos. Only children with a real `.git` folder count; a child whose `.git` is a file is a worktree or submodule and is listed under `worktrees` without being scanned, so tell the user about them but do not audit them. You can also force it with `--workspace`. An explicit `--repo DIR` always means repo mode.

Workspace mode prints one summary: an entry for the **workspace root** itself (`root`: its own `CLAUDE.md`, agent files and `.engramic.json`) followed by each child repo (`repos`): actor, topic, whether its `CLAUDE.md` mentions Engramic, fallback version and finding counts. It also cross-checks the actors against the roster in the workspace `CLAUDE.md` (`ACTOR_NOT_IN_ROSTER`, `ACTOR_SHARED`, `ROSTER_ENTRY_WITHOUT_ID`, `ROSTER_ID_UNUSED`). Retired repos can be skipped with `"ignoredRepos": ["name"]` in the workspace `.engramic.json`.

Present it as a short table, root first, and say which entries need attention. For the **root**, you may then go through its findings with the user as in a normal audit. For **child repos**, stop at the summary: do not patch them from the workspace. Tell the user to run `engramic:setup` inside each repo that has findings.

## 1. Run the scan

Run `scan.mjs` from this skill's directory (the base directory shown when the skill loaded), from the repo root:

    node <skill-dir>/scan.mjs

It is read-only. It prints JSON with `findings`, `topicIdsToResolve`, `missingReadTools`, the parsed files and settings, and `.engramic.json` status. It also looks up to three directories above the repo, so a workspace `CLAUDE.md`, workspace agent files and workspace settings are included.

If `node` is not available (the scan command fails with "command not found"), tell the user that Node 20 or later is required for the setup scan and the hooks, and stop; do not try to reproduce the scan by hand. If Engramic tools are not available in this session (`engramic_summary` fails), stop and tell the user to connect Engramic first. Check the tool prefix actually in use (for example `mcp__claude_ai_Engramic__`); if it differs from `livePrefix` in the scan output, rerun with `--live-prefix`.

## 2. Resolve topic ids

For every id in `topicIdsToResolve`, call `engramic_topic`. Report any that do not resolve. An unresolvable anchor makes every record that uses it fail with `ANCHOR_TOPIC_NOT_FOUND`, so these are errors, not notes.

## 3. Interpret the findings

Group them as: already right, needs changing, and informational. Findings by code:

- `NO_ENGRAMIC_JSON`, `ENGRAMIC_JSON_BAD_TOPIC`, `ENGRAMIC_JSON_NO_ACTOR`: help create or fix `.engramic.json` (`actor` is a role name or id; `topic`, if present, is an existing topic id). **Ask whether this session records into one place or across several domains.** A repo session usually has one natural anchor, so set `topic`. A workspace or orchestrator session that records across domains (for example engineering, product and sales) should have **no `topic`**, so it resolves the anchor per record instead of defaulting everything to one domain. Find the topic with `engramic_search` and `engramic_topic`, and confirm it with the user. **Actor labels cannot be read through the API**, so you cannot confirm an actor name from Engramic. You can show evidence (for example, which topics an actor id's events were anchored on, via `engramic_timeline` with `actor`), but ask the user to confirm the name. Only suggest an actor that already exists; roles are created by hand today. Never invent one.
- `ENGRAMIC_JSON_GITIGNORED`: recommend committing `.engramic.json`. Worktrees and delegates otherwise will not see the defaults. It holds ids, not secrets.
- `RETIRED_TOOL_MENTIONED`: the removed single-call `engramic_record` (and the retired nominate and context-package tools). The scan matches the name anywhere, so read the line first. A note saying the tool was replaced or removed is not a defect; flag it only where the text tells the agent to use the tool, and then offer to replace the passage with the two-pass instructions.
- `BAD_ANCHOR`: a `topics` value that is not a `t_xxxxxxxx` id (a legacy hex prefix or a label). Anchors must be ids of topics that exist. Propose a replacement only after resolving a real topic; otherwise offer to remove the section.
- `WRITE_WITHOUT_ACTOR`: recording steps that pass no `actorId`, so records are credited to the human. Offer the `CLAUDE.md` snippet below with the actor filled in.
- `CONTRADICTS_WORKSPACE`: the repo's `CLAUDE.md` tells the agent to call draft and publish directly, while a workspace agent file (which reads this file and says "the file on disk wins") says delegates never call write tools. Explain the conflict and offer the snippet, which supports both direct mode and delegate mode.
- `AGENT_NO_RECORDS_SECTION`: an agent file that mentions Engramic but has no "Records for Engramic" section. Offer the delegate block below.
- `OTHER_RECORDING_DESTINATION`: an instruction in `CLAUDE.md` or an agent file to record, log, write or append something to a file or named log other than Engramic and the standard destinations (ADRs, `ARCHITECTURE.md`, `CHANGELOG.md`, `README.md`). Older instructions like this often quietly absorb records that should go to Engramic, so ask the user about each one, one at a time. Show the instruction (`instruction`, `file`, `line`), the target, and whether it exists and when it was last modified (`exists`, `lastModified`, `daysSinceModified`). A missing file, or one untouched for months, is evidence it is dead. Also report `gitignored`: if the target sits in an ignored folder, it exists on one machine only, so worktrees, other checkouts and CI never see it and the instruction cannot work there. Say so, but do not treat it as a reason to decide for the user. Offer three choices: **keep** it alongside Engramic (add it to `acknowledgedDestinations` in `.engramic.json`, so re-runs stay quiet; use the plain name, such as `"discovery log"`, which covers both the named-log and the file-path forms of the same thing, or a path like `"docs/notes.md"` to cover one exact file); **point it to Engramic** (rewrite the instruction to use the `engramic:record` skill, keeping any useful examples of what is worth recording); or **retire** it (remove the instruction; leave the file itself alone). Do not decide for the user. **Where to record a keep:** if the instruction is in a file inside this repo, use this repo's `.engramic.json`. If it is in a file above the repo (a workspace `CLAUDE.md` or agent file shared by several repos), record it in the `.engramic.json` in that folder, creating a file that holds only `acknowledgedDestinations` if there is none, so every repo below inherits it and the question is asked once.
- `FALLBACK_OUTDATED`: the `CLAUDE.md` carries an older version of the fallback text (see the snippet). Offer to replace it with the current one; nothing else changes.
- `WELFARE_SECTION`: a welfare check-in section. This is an experiment that is not part of the plugin and is off by default in the product; the user may want to reinstate it for their own use, so do not presume. Ask whether to **keep** or **remove** it. If keeping it, a `BAD_ANCHOR` inside it must still be fixed with a real topic id: the earlier per-agent welfare topics no longer exist, so point it at a topic that does (for example the agent's own root topic), and confirm the choice with the user.
- `SETTINGS_LEGACY_PREFIX`, `SETTINGS_RETIRED_TOOL`: allowlist entries that match nothing on the live server, or that name retired tools. Offer to delete them.
- `SETTINGS_MISSING_READ_TOOL`: read tools not pre-allowed. `engramic_topic` is needed for anchor resolution. Recommend pre-allowing the read tools (`engramic_search`, `engramic_summary`, `engramic_timeline`, `engramic_topic`, and `engramic_event`) at user level. Leave `engramic_record_draft` and `engramic_record_publish` off the allowlist, so the permission prompt acts as the publish gate, unless the user runs in auto mode.

## 4. Propose patches

Show each patch as a diff, grouped by file. Apply only what the user approves. **Match the file's existing style:** if the section being replaced has a bold label (`**Recording to Engramic:**`) keep a bold label; if it is a markdown heading, keep the same heading level. Do not change a file's outline just to fit the snippet, and keep any repo-specific examples of what is worth recording. One question at a time; a good first question is usually the actor confirmation, because other patches depend on it.

### The fallback question

The snippet's fallback paragraph (between the `engramic:fallback` markers) keeps recording working if the plugin is disabled or not installed. Ask once, before showing the snippet: "Include a fallback so recording still works without the plugin? It duplicates a few rules, so it can drift; the version marker lets this skill flag it when it does." **Default to yes.** If the user says no, leave the paragraph and both markers out. When the plugin is installed, the skill takes precedence and the fallback is ignored.

### What not to record (the `<WHAT_NOT_TO_RECORD>` line)

Do not assert where things go unless the repo says so. Routing differs between repos.

1. **Keep good existing wording.** If the repo's `CLAUDE.md` already has a working "what not to record" line, or the repo's own ADR rules say where bug fixes and refactors belong, keep that. Read the repo's ADR rules (the top of `ARCHITECTURE.md`, or the ADR folder's README) before proposing anything.
2. **Otherwise compose the line from what exists.** The scan reports `adr`:
   - ADRs found: "Routine commits and internal refactors belong in the ADRs (`<ADR_PATH>`), not Engramic. When you do record a decision, the ADR holds the detail: link it in `references`, and add the event id to the ADR in its own format."
   - No ADRs: "Never record routine commits, refactors or implementation detail."
3. If the user chose to **keep** another destination (see `OTHER_RECORDING_DESTINATION`), you may name it for the things the repo's rules send there.
4. **Never tell the agent to put detail somewhere that does not exist.**

### CLAUDE.md snippet

```markdown
## Recording to Engramic

Record key decisions and milestones using the `engramic:record` skill. Attribute records with `actorId: "<ACTOR>"`. Default anchor topic: `<TOPIC_ID>`. Decisions are shown to the user before publishing; actions, events and discoveries publish without pausing. <WHAT_NOT_TO_RECORD>

**When running as a delegate** (a subagent spawned by an orchestrator): never call Engramic write tools. End every non-trivial final report with a "Records for Engramic" section: for each item, the type (decision, discovery or action), a 2 to 10 word label, 2 to 4 sentences on why, and the anchor topic. "None" is valid.

<!-- engramic:fallback v1 -->
**If the `engramic:record` skill is not available** (the plugin is not installed): record with `engramic_record_draft`, then `engramic_record_publish` (two passes, never one). `topics[0]` must be the id of an existing topic; use the default anchor above. Pass `actorId`. Check the draft response for `reused: true` and never publish a draft that is not yours. Show decisions to the user before publishing.
<!-- /engramic:fallback -->
```

### Delegate block (for agent files and briefs)

```markdown
## Engramic

Never call Engramic write tools. End every non-trivial final report with a "Records for Engramic" section: for each item, the type (decision, discovery or action), a 2 to 10 word label, 2 to 4 sentences on why, and the anchor topic. "None" is valid.
```

## Output

Summarise as: what is already right, what needs changing (with the patches), and anything you could not verify. Do not create actors, edit topics, or record events as part of the audit.
