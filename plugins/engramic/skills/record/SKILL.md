---
name: record
description: Record key decisions, milestones and discoveries from the current work to the Engramic workspace over MCP, using the two-pass draft then publish flow. Use when a decision has actually been reached, a PR is merged, a release is cut, an issue is closed, a feature ships, a contradiction, drift or stale fact is found, or when an Engramic recording reminder appears from a hook.
---

# Recording to Engramic

Engramic is the governed record of what was decided and done, written when it happened. This skill is how work in this session gets into it. The tools are the Engramic MCP tools (`engramic_search`, `engramic_topic`, `engramic_record_draft`, `engramic_record_publish`, `engramic_summary`, `engramic_timeline`). Tool names carry a prefix depending on how the server is connected; use whichever variant is available.

If the Engramic tools are missing or unauthenticated, say so once in a single line and carry on with the work. Never block the task on recording.

## First: are you a delegate?

If you were spawned as a subagent, or your brief says you are a delegate, **do not call the Engramic write tools** (`engramic_record_draft`, `engramic_record_publish`, `engramic_create_*`, `engramic_update_*`). Engramic allows one in-flight draft per operator, so a delegate drafting while its parent drafts returns the other draft's id (`reused: true`), and publishing it publishes someone else's content.

Instead, end your final report with a **Records for Engramic** section. For each item give the type (decision, discovery or action), a 2 to 10 word label, 2 to 4 sentences on why, and the anchor topic. "None" is a valid answer. The parent session records them, one at a time.

## What to record

Record things that have **actually happened**:

| What happened | Event type | Notes |
|---|---|---|
| A decision was reached, with reasoning | `decision` | Include options considered and which was chosen |
| Something was done or agreed (PR merged, deploy, migration run, issue closed) | `action` | Factual. Link the PR, issue or commit |
| A milestone or state change (release cut, feature shipped, incident closed) | `event` | Use for things that occurred rather than were chosen |
| A contradiction, drift, stale fact, pattern or insight was found | `discovery` | Set `subtype`: contradiction, violation, gap, drift, pattern, staleness or insight |

## What not to record

- Speculation, brainstorming, or options still under discussion. Record when the decision lands, not before.
- Routine commits, bug fixes, internal refactors, formatting, test runs, dependency bumps. Implementation detail belongs in the repo's own docs (ADRs), not in Engramic.
- Anything containing secrets, tokens, credentials or personal data. Describe it without including it.
- Substantive content that belongs **on a topic** (a description, researched facts). An event says that something happened. To enrich a topic, use the `engramic_update_*` tools and record at most a brief action event alongside.
- Open questions. Create a gap topic instead (`engramic_create_gap`); the `question` event type was removed.

## Procedure

Always the two-pass flow. The single-call `engramic_record` no longer exists and fails with `-32602 Tool not found`.

1. **Resolve the anchor topic to an id.** If session context names a default anchor topic (from `.engramic.json`), use it unless the subject clearly belongs to a different existing topic, in which case use that one. With no default, run `engramic_search`, then `engramic_topic` to confirm placement. Use the topic **id** (`t_xxxxxxxx`), not its label: label resolution has failed in practice even where an id worked. `topics[0]` must already exist or the draft fails with `ANCHOR_TOPIC_NOT_FOUND`, and drafting never creates topics. Search before creating anything, since duplicate topics fragment the record.
2. **Draft.** Call `engramic_record_draft` with `type`, `label`, `topics`, and `detail`, `optionsConsidered`, `references`, `occurredAt` where relevant, plus `actorId` if one is set (see below).
3. **Check `reused`.** If the response says `reused: true`, the draft is not yours. Publish or abandon the existing one before staging yours; do not publish it as if it were your content.
4. **Read the context bundle.** Look for:
   - a prior resolution on the same subject (do not re-litigate; reference it with `supersedes` if you are deliberately replacing it)
   - an open gap you are answering (add a `resolves` reference at publish)
   - an active contradiction you are touching (add `contradicts`, or record a discovery)
   If the bundle shows the record is redundant, abandon the draft.
5. **Gate, then publish.** See the next section. Publish with `engramic_record_publish` and the `draftId`, using `edits` for any changes from step 4. Arrays in `edits` replace, they do not append.
6. **Report in one line**: what was recorded, its type, and the event id.

Constraints:

- One in-flight draft per operator, globally. Record several items sequentially.
- Drafts expire silently after four hours and can only be published from the session that staged them.
- `type` and `actorId` cannot be changed at publish. To change either, let the draft expire and stage a new one.

## Gate

- **`decision` records**: always show the human the label, detail and options considered, and publish only after they agree. This holds even if they just stated the decision.
- **`action`, `event` and `discovery` records**: publish without pausing, and say what was recorded in your one-line report.

## Attribution

Records are credited to the human who owns the MCP session unless you pass `actorId`. If session context supplies an actor (from `.engramic.json`), pass it on every draft; names and ids both resolve. If none is supplied, omit it. Do not guess a name: an unresolvable one fails with `ATTRIBUTION_ACTOR_NOT_FOUND`.

## Depth and where things go

`detail` has two layers.

- **Lead**: the first paragraph, one or two sentences, **at most 280 characters** (tweet length). It must stand alone: the outcome first, then the main reason. Search and timeline results show only roughly the first 150 characters of a record, so the conclusion has to come first or the record is effectively invisible.
- **Body**: optional, after a blank line. Add it only when someone could misapply or reverse the decision from the lead alone: why, what it affects beyond this repo, what would change it. Up to about 150 words. Alternatives go in `optionsConsidered`, not the prose.

By type:

- **Action**: lead only, usually. What shipped, where, who is affected. Reference the PR or release.
- **Decision**: lead plus a short body, because a decision without its reason has lost the thing the record exists to keep.
- **Discovery**: the lead states the symptom and the standing rule; the body gives the cause and where it was fixed.

If the body wants to run past about 150 words, the detail belongs in the repo's ADR (or equivalent). Record the lead and link the ADR in `references`; once published, add the event id to the ADR in the form the ADR's own format uses (many have an Engramic field), so the link runs both ways. The `engramic://` form is for a record's `references`, not for an ADR.

Beyond-the-repo test: would an agent in another repo, or the person reviewing across repos, decide differently without knowing this? If not, it is an ADR, not a record. In a real working session expect zero to three records, not one per change.

## Writing the record

- **label**: 2 to 10 words, stating the outcome, not the activity. "Payments repo is payments-api, now public" not "Discussed repo naming".
- **detail**: two layers, described in the section above. Written so a person reading it in six months, without this session, can follow it. Plain sentences, no headings.
- **optionsConsidered** (decisions): each alternative with a short label; set `selected: true` on the one chosen.
- **references**: PR, issue, commit, release or doc URLs. For another Engramic event or topic, use the internal form `engramic://event/e_xxxxxxxx` (or `engramic://topic/t_xxxxxxxx`), as existing records do, not a bare id. Use `rel` honestly: `implements` for a PR that delivers a decision, `source` for evidence, `supersedes`, `contradicts` or `resolves` where they apply, otherwise `references`.
- **occurredAt**: leave it off if it happened now. If recording something from earlier, set the real time; do not make a late record look contemporaneous.
- British English and straight quotes.

## Example

The user says: "Right, we'll keep the two-pass record flow and not add a one-shot shortcut for agents." Nothing else is open on the subject.

1. `engramic_search` for "record flow draft publish", confirm the anchor with `engramic_topic`, take its id.
2. `engramic_record_draft`:
   - `type`: `decision`
   - `label`: "Keep two-pass recording, no one-shot shortcut"
   - `detail`: "Agents record through draft then publish only. A one-shot path was considered for speed and rejected: the draft step returns the context bundle that lets a recorder catch prior resolutions and contradictions before committing."
   - `optionsConsidered`: one-shot record tool (not selected), two-pass only (selected)
3. `reused` is not set. Read the bundle. It's a decision, so show it to the user and wait for a yes.
4. Publish, then reply: "Recorded decision e_xxxxxxxx: Keep two-pass recording, no one-shot shortcut."
