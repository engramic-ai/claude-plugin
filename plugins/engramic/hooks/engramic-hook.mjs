#!/usr/bin/env node
// engramic plugin hook shim.
//
// Deterministic detection only. Hooks cannot call MCP tools, so this script
// never writes to Engramic itself: it spots milestones and decision language
// with plain rules, then nudges the model (via additionalContext or a Stop
// block) to record them with the engramic:record skill. The model does the
// interpretation and the two-pass draft/publish.
//
// Delegates: when a hook fires inside a subagent (input carries agent_id), this
// script never tells it to record. Engramic allows one in-flight draft per
// operator, so concurrent recording from delegates collides. A delegate's
// milestone is queued for the parent session instead, and the delegate is told
// to mention it in its final report.
//
// Kill switches (environment):
//   ENGRAMIC_RECORDER=off        disable everything
//   ENGRAMIC_RECORDER_STOP=off   disable the Stop safety net only
//   ENGRAMIC_RECORDER_DEBUG=1    append what each hook receives (event, tool, which
//                                fields are present, agent_id/agent_type) to
//                                <tmpdir>/engramic-plugin/debug.log. No prompt or
//                                command text is logged.
//
// Any error exits 0 silently so a bad hook can never wedge a session.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STATE_DIR = path.join(os.tmpdir(), "engramic-plugin");
const TOPIC_ID = /^t_[A-Za-z0-9_-]{8}$/;

const DEFAULT_CONFIG = {
  milestones: [
    { kind: "pull request merged", pattern: "\\bgh\\s+pr\\s+merge\\b" },
    { kind: "release created", pattern: "\\bgh\\s+release\\s+create\\b" },
    { kind: "issue closed", pattern: "\\bgh\\s+issue\\s+close\\b" },
  ],
  ignoreIfCommandMatches: "--dry-run",
  decisionPhrases: ["\\b(we'?ll|we will) (go with|use)\\b", "\\bdecided\\b", "\\bgoing with\\b"],
  maxPromptLengthForDecisionScan: 3000,
  hintCooldownMinutes: 10,
};

function loadJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

const CONFIG = { ...DEFAULT_CONFIG, ...(loadJson(path.join(HERE, "..", "config.json")) ?? {}) };

function readInput() {
  try {
    const raw = fs.readFileSync(0, "utf8");
    return raw.trim() ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function statePath(sessionId) {
  const safe = String(sessionId || "unknown").replace(/[^\w.-]/g, "_");
  return path.join(STATE_DIR, `${safe}.json`);
}

function loadState(sessionId) {
  return (
    loadJson(statePath(sessionId)) ?? { milestones: [], candidates: [], recorded: 0, lastHintAt: 0 }
  );
}

function saveState(sessionId, state) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(statePath(sessionId), JSON.stringify(state));
}

function emitContext(hookEventName, additionalContext) {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName, additionalContext } }));
}

function compile(sources, flags = "i") {
  const out = [];
  for (const s of sources) {
    try {
      out.push(new RegExp(s, flags));
    } catch {
      /* ignore a bad pattern rather than fail the hook */
    }
  }
  return out;
}

function repoDefaults(cwd) {
  const cfg = loadJson(path.join(cwd || process.cwd(), ".engramic.json"));
  if (!cfg) return null;
  const topic = typeof cfg.topic === "string" && TOPIC_ID.test(cfg.topic) ? cfg.topic : null;
  const actor = typeof cfg.actor === "string" && cfg.actor.trim() ? cfg.actor.trim() : null;
  return topic || actor ? { topic, actor } : null;
}

function describePending(state) {
  // Kinds and counts only. The hook never keeps prompt or command text: Claude already has it in context.
  const lines = [];
  for (const m of state.milestones) lines.push(`- milestone (${m.kind})${m.by ? ` (by delegate ${m.by})` : ""}`);
  if (state.candidates.length) {
    lines.push(`- ${state.candidates.length} user message${state.candidates.length === 1 ? "" : "s"} this session that may have settled a decision`);
  }
  return lines.join("\n");
}

// ── Handlers ────────────────────────────────────────────────────────────────

function sessionStart(input) {
  const source = input.source || "startup";
  const state = loadState(input.session_id);
  const defaults = repoDefaults(input.cwd);
  const parts = ["Engramic recording is active for this session."];

  if (source === "startup" || source === "resume") {
    const since = new Date(Date.now() - 7 * 864e5).toISOString();
    parts.push(
      "Orient once before substantive work: call engramic_summary with includeEvents true, " +
        `then engramic_timeline with type "decision" and since "${since}". ` +
        "If the Engramic tools are missing or unauthenticated, tell the user once and carry on without recording."
    );
  }

  parts.push(
    "When a key decision is reached or a milestone is hit, record it using the engramic:record skill. " +
      "Record only what has actually happened; never speculation, secrets or personal data."
  );

  if (defaults) {
    const bits = [];
    if (defaults.topic) bits.push(`default anchor topic ${defaults.topic}`);
    if (defaults.actor) bits.push(`attribute events to actor "${defaults.actor}"`);
    parts.push(`Repo defaults (.engramic.json): ${bits.join("; ")}.`);
  }

  if (source === "compact" && (state.milestones.length || state.candidates.length)) {
    parts.push(`Flagged before compaction and not yet recorded:\n${describePending(state)}`);
  }

  emitContext("SessionStart", parts.join("\n"));
}

function userPrompt(input) {
  const prompt = String(input.prompt || "").replace(/[\u2018\u2019]/g, "'");
  if (!prompt || prompt.length > CONFIG.maxPromptLengthForDecisionScan) return;
  if (!compile(CONFIG.decisionPhrases).some((re) => re.test(prompt))) return;

  const state = loadState(input.session_id);
  state.candidates.push({ at: Date.now() });
  state.candidates = state.candidates.slice(-20);

  const cooldown = CONFIG.hintCooldownMinutes * 60 * 1000;
  const due = Date.now() - state.lastHintAt >= cooldown;
  if (due) state.lastHintAt = Date.now();
  saveState(input.session_id, state);

  if (due) {
    emitContext(
      "UserPromptSubmit",
      "This message may settle a decision. If, and only if, a decision has actually been reached " +
        "(with its reasoning), record it with the engramic:record skill at the next natural pause. " +
        "Do not record options still under discussion."
    );
  }
}

function postTool(input) {
  const tool = String(input.tool_name || "");
  const state = loadState(input.session_id);

  // A publish call clears what was flagged, unless it clearly failed.
  if (/engramic_record_publish$/.test(tool)) {
    if (input.agent_id) return;
    const response = JSON.stringify(input.tool_response ?? "");
    if (!/(DRAFT_NOT_FOUND|FORBIDDEN_NOT_DRAFT_OWNER|IMMUTABLE_FIELD|VALIDATION_ERROR)/.test(response)) {
      state.recorded += 1;
      state.milestones = [];
      state.candidates = [];
      saveState(input.session_id, state);
    }
    return;
  }

  if (tool !== "Bash") return;
  const command = String(input.tool_input?.command || "");
  if (!command) return;
  if (CONFIG.ignoreIfCommandMatches && new RegExp(CONFIG.ignoreIfCommandMatches, "i").test(command)) return;

  const hit = CONFIG.milestones.find((m) => {
    try {
      return new RegExp(m.pattern, "i").test(command);
    } catch {
      return false;
    }
  });
  if (!hit) return;

  const byDelegate = Boolean(input.agent_id);
  state.milestones.push({
    kind: hit.kind,
    by: byDelegate ? input.agent_type || input.agent_id : null,
    at: Date.now(),
  });
  state.milestones = state.milestones.slice(-20);
  saveState(input.session_id, state);

  if (byDelegate) {
    emitContext(
      "PostToolUse",
      `Milestone flagged: ${hit.kind}. Do not call Engramic write tools from a delegate. ` +
        "Mention it in your final report under a 'Records for Engramic' heading (type, 2-10 word label, 2-4 sentence why, anchor topic) so the parent session can record it."
    );
    return;
  }

  emitContext(
    "PostToolUse",
    `Milestone flagged: ${hit.kind}. If that command succeeded, record it to Engramic now ` +
      "using the engramic:record skill (type action or event; include the PR, release or issue URL as a reference)."
  );
}

function stop(input) {
  if (input.stop_hook_active) return;
  if (process.env.ENGRAMIC_RECORDER_STOP === "off") return;

  const state = loadState(input.session_id);
  if (!state.milestones.length && !state.candidates.length) return;

  const reason =
    "Before finishing: the following were flagged this session and have not been recorded to Engramic:\n" +
    `${describePending(state)}\n` +
    "Use the engramic:record skill to record anything that genuinely qualifies (a decision actually reached, " +
    "or a milestone that actually happened). If nothing qualifies, reply with exactly one line saying so and stop.";

  // Clear before blocking so this fires at most once per batch.
  state.milestones = [];
  state.candidates = [];
  saveState(input.session_id, state);

  process.stdout.write(JSON.stringify({ decision: "block", reason }));
}

// ── Dispatch ────────────────────────────────────────────────────────────────

try {
  if (process.env.ENGRAMIC_RECORDER === "off") process.exit(0);
  const input = readInput();
  if (process.env.ENGRAMIC_RECORDER_DEBUG === "1") {
    try {
      fs.mkdirSync(STATE_DIR, { recursive: true });
      fs.appendFileSync(
        path.join(STATE_DIR, "debug.log"),
        JSON.stringify({
          at: new Date().toISOString(),
          handler: process.argv[2],
          event: input.hook_event_name ?? null,
          tool: input.tool_name ?? null,
          keys: Object.keys(input).sort(),
          agent_id: input.agent_id ?? null,
          agent_type: input.agent_type ?? null,
        }) + "\n"
      );
    } catch {
      /* debug must never affect the session */
    }
  }
  const handlers = {
    "session-start": sessionStart,
    "user-prompt": userPrompt,
    "post-tool": postTool,
    stop,
  };
  handlers[process.argv[2]]?.(input);
} catch {
  /* never wedge a session */
}
process.exit(0);
