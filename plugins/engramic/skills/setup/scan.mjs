#!/usr/bin/env node
// Deterministic scan for the engramic:setup skill. Read-only: it never writes.
//
// Finds configuration problems by rule and prints JSON. The skill then resolves
// topic ids against Engramic (this script cannot call MCP) and proposes patches.
//
// Usage: node scan.mjs [--repo DIR] [--home DIR] [--live-prefix PREFIX]

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Workspace mode: `scan.mjs --workspace [DIR]` summarises the root and every child repo; see workspace.mjs.
// It also switches on by itself, when run with no --repo, at what looks like a workspace root:
//   - a folder that is not a git repo but has at least one child git repo, or
//   - a folder that IS a git repo and has at least three child git repos.
// Only children with a real .git folder count. A .git file marks a worktree or a submodule, so a monorepo
// full of submodules is not mistaken for a workspace. An explicit --repo always means repo mode.
const gitDirChildren = (dir) => {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith("."))
      .filter((e) => {
        try {
          return fs.statSync(path.join(dir, e.name, ".git")).isDirectory();
        } catch {
          return false;
        }
      }).length;
  } catch {
    return 0;
  }
};
const looksLikeWorkspaceRoot = () => {
  if (process.argv.includes("--repo")) return false;
  const cwd = process.cwd();
  const children = gitDirChildren(cwd);
  return fs.existsSync(path.join(cwd, ".git")) ? children >= 3 : children >= 1;
};
if (process.argv.includes("--workspace") || looksLikeWorkspaceRoot()) {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const extra = process.argv.includes("--workspace") ? [] : ["--workspace"];
  const r = spawnSync(process.execPath, [path.join(here, "workspace.mjs"), ...process.argv.slice(2), ...extra], { stdio: "inherit" });
  process.exit(r.status ?? 0);
}

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};
const REPO = path.resolve(opt("repo", process.cwd()));
const HOME = path.resolve(opt("home", os.homedir()));
const LIVE_PREFIX = opt("live-prefix", "mcp__claude_ai_Engramic__");
const LEGACY_PREFIX = "mcp__Engramic__";
const MAX_ANCESTORS = 3;
const CURRENT_FALLBACK_VERSION = 1; // bump when the fallback text in the setup skill changes

const TOPIC_ID = /^t_[A-Za-z0-9_-]{8}$/;
const TOPIC_ID_ANYWHERE = /(?<![A-Za-z0-9_-])t_[A-Za-z0-9_-]{8}(?![A-Za-z0-9_-])/g;
const RECORD_VERB = /\b(record|log|write|append|add|note|capture|document|report|update|save|store)\b/i;
const PATH_TARGET = /\b(?:to|in|into|at)\s+`?((?:[\w.-]+\/)*[\w.-]+\.(?:md|txt|json|ya?ml))`?/gi;
const DIRECT_TARGET = /\b(?:update|edit|maintain|append)\s+`?((?:[\w.-]+\/)*[\w.-]+\.(?:md|txt))`?/gi;
const NAMED_LOG = /\b((?:discovery|decision|learnings?|lessons?|session|work|dev(?:elopment)?)[- ](?:log|journal))\b/i;
const STANDARD_DESTINATION = /(^|\/)(ARCHITECTURE|CHANGELOG|README|CONTRIBUTING|CONVENTIONS|CLAUDE|AGENTS)\.md$|\.engramic\.json$|(^|\/)adrs?\/|(^|\/)\.claude\/(agents|commands|skills|hooks)\//i;
const REMOVAL_NOTE = /\b(removed|replaced|retired|deprecated|no longer|do not use|don't use|never use|instead of)\b/i;
const RETIRED_TOOLS = [
  "engramic_record",
  "engramic_nominate_topic",
  "engramic_create_context_package",
  "engramic_receive_context_package",
];
const REQUIRED_READ_TOOLS = ["engramic_search", "engramic_summary", "engramic_timeline", "engramic_topic"];

const read = (p) => {
  try {
    return fs.readFileSync(p, "utf8");
  } catch {
    return null;
  }
};
const readJson = (p) => {
  const t = read(p);
  if (t === null) return { exists: false };
  try {
    return { exists: true, json: JSON.parse(t) };
  } catch {
    return { exists: true, invalid: true };
  }
};
const toolRe = (name) => new RegExp(`(?<![A-Za-z0-9])${name}(?![A-Za-z0-9_])`);

// ── Markdown files (CLAUDE.md and agent files) ─────────────────────────────

function scanMarkdown(file, kind, distance) {
  const text = read(file);
  if (text === null) return null;
  const lines = text.split(/\r?\n/);
  const out = {
    path: file,
    kind,
    distance,
    mentionsEngramic: /engramic/i.test(text),
    retiredToolLines: [],
    topicIds: [],
    badAnchors: [],
    callsWriteTools: false,
    writeToolLines: [],
    hasActorId: /actorId/.test(text),
    hasDelegateRule: /Records for Engramic/i.test(text),
    welfareLines: [],
    fallbackVersion: null,
    otherDestinations: [],
  };
  const fb = text.match(/<!--\s*engramic:fallback\s+v(\d+)\s*-->/);
  if (fb) out.fallbackVersion = Number(fb[1]);
  lines.forEach((line, i) => {
    const n = i + 1;
    for (const t of RETIRED_TOOLS) if (toolRe(t).test(line) && !REMOVAL_NOTE.test(line)) out.retiredToolLines.push({ line: n, tool: t });
    for (const m of line.matchAll(TOPIC_ID_ANYWHERE)) out.topicIds.push({ line: n, id: m[0] });
    if (/engramic_record_(draft|publish)/.test(line)) {
      out.callsWriteTools = true;
      out.writeToolLines.push(n);
    }
    if (RECORD_VERB.test(line) && !/^\s*(```|<!--)/.test(line)) {
      const snippet = line.trim().slice(0, 160);
      const seen = new Set();
      for (const re of [PATH_TARGET, DIRECT_TARGET]) {
        for (const m of line.matchAll(re)) {
          if (STANDARD_DESTINATION.test(m[1]) || seen.has(m[1])) continue;
          seen.add(m[1]);
          out.otherDestinations.push({ line: n, kind: "file", target: m[1], text: snippet });
        }
      }
      // A named log inside a path already matched on this line is the same thing, not a second finding.
      let rest = line;
      for (const t of seen) rest = rest.split(t).join(" ");
      const nl = rest.match(NAMED_LOG);
      if (nl) out.otherDestinations.push({ line: n, kind: "named-log", target: nl[1].toLowerCase().replace("-", " "), text: snippet });
    }
    if (/welfare/i.test(line)) out.welfareLines.push({ line: n, heading: /^\s*#{1,6}\s/.test(line) });
    const arr = line.match(/topics\s*[:=]\s*\[([^\]]*)\]/);
    if (arr) {
      for (const item of arr[1].matchAll(/["'`]([^"'`]+)["'`]/g)) {
        const value = item[1];
        if (!TOPIC_ID.test(value)) {
          out.badAnchors.push({ line: n, value, kind: /^[0-9a-f]{8}/i.test(value) ? "legacy-hex" : "label" });
        }
      }
    }
  });
  return out;
}

// ── Settings files ─────────────────────────────────────────────────────────

function scanSettings(file) {
  const r = readJson(file);
  const out = { path: file, exists: r.exists, invalid: Boolean(r.invalid), entries: [] };
  const allow = r.json?.permissions?.allow;
  if (!Array.isArray(allow)) return out;
  for (const entry of allow) {
    if (typeof entry !== "string" || !/engramic/i.test(entry)) continue;
    const cut = entry.lastIndexOf("__");
    const prefix = cut >= 0 ? entry.slice(0, cut + 2) : null;
    const tool = cut >= 0 ? entry.slice(cut + 2) : entry;
    const legacy = entry.startsWith(LEGACY_PREFIX);
    const live = entry.startsWith(LIVE_PREFIX) || entry === LIVE_PREFIX.replace(/__$/, "");
    out.entries.push({
      entry,
      prefix,
      tool,
      legacy,
      live,
      retired: RETIRED_TOOLS.includes(tool),
      wildcard: tool === "*" || entry === LIVE_PREFIX.replace(/__$/, ""),
    });
  }
  return out;
}

// ── Gather ─────────────────────────────────────────────────────────────────

const dirs = [];
{
  let d = REPO;
  for (let i = 0; i <= MAX_ANCESTORS; i++) {
    dirs.push({ dir: d, distance: i });
    const up = path.dirname(d);
    if (up === d) break;
    d = up;
  }
}

// Agent files above the repo that are named after a different sibling repo (for example
// ws/.claude/agents/server-ui.md when scanning ws/site) belong to that repo's delegate, so their
// recording instructions are not this repo's business. Workspace policy still applies to everyone,
// so they still count as evidence for the workspace delegate rule.
const siblingNames = new Set();
try {
  for (const e of fs.readdirSync(path.dirname(REPO), { withFileTypes: true })) {
    if (e.isDirectory() && !e.name.startsWith(".") && e.name !== path.basename(REPO)) siblingNames.add(e.name.toLowerCase());
  }
} catch {
  /* unreadable parent */
}
const belongsToOtherRepo = (f) => f.kind === "agent" && f.distance > 0 && siblingNames.has(path.basename(f.path, ".md").toLowerCase());

const files = [];
const settings = [];
for (const { dir, distance } of dirs) {
  const claude = scanMarkdown(path.join(dir, "CLAUDE.md"), "claude-md", distance);
  if (claude) files.push(claude);
  const agentsDir = path.join(dir, ".claude", "agents");
  let agentFiles = [];
  try {
    agentFiles = fs.readdirSync(agentsDir).filter((f) => f.endsWith(".md"));
  } catch {
    /* no agents dir */
  }
  for (const f of agentFiles) files.push(scanMarkdown(path.join(agentsDir, f), "agent", distance));
  for (const s of ["settings.json", "settings.local.json"]) {
    const sc = scanSettings(path.join(dir, ".claude", s));
    if (sc.exists) settings.push(sc);
  }
}
const userSettings = scanSettings(path.join(HOME, ".claude", "settings.json"));
if (userSettings.exists) settings.push(userSettings);


// Acknowledgement matching. A plain name ("discovery log") matches every reference to that thing:
// a named log, or a file whose base name has the same words (".claude/discovery-log.md").
// An entry containing "/" is a path and matches that exact path only.
const slug = (t) => path.basename(String(t).toLowerCase()).replace(/\.[a-z0-9]+$/, "").replace(/[-_\s]+/g, " ").trim();
const isAcknowledged = (target, kind, acknowledged) =>
  acknowledged.some((a) => (a.includes("/") ? kind === "file" && a.replace(/^\.?\//, "") === target.toLowerCase().replace(/^\.?\//, "") : slug(a) === slug(target)));

const ej = readJson(path.join(REPO, ".engramic.json"));
const engramicJson = { exists: ej.exists, invalid: Boolean(ej.invalid), acknowledgedDestinations: [] };
if (ej.json) {
  engramicJson.topic = ej.json.topic ?? null;
  engramicJson.actor = ej.json.actor ?? null;
  engramicJson.acknowledgedDestinations = Array.isArray(ej.json.acknowledgedDestinations) ? ej.json.acknowledgedDestinations.map((x) => String(x).toLowerCase()) : [];
  // topic is optional (an orchestrator recording across domains should have none)
  engramicJson.topicValid = ej.json.topic == null || (typeof ej.json.topic === "string" && TOPIC_ID.test(ej.json.topic));
}
const adr = { found: false, path: null };
{
  const arch = read(path.join(REPO, "ARCHITECTURE.md"));
  if (arch !== null && /^#{1,6}\s*(ADR[- ]?\d+|Architecture Decision)/im.test(arch)) {
    adr.found = true;
    adr.path = path.join(REPO, "ARCHITECTURE.md");
  }
  for (const d of ["docs/adr", "docs/adrs", "docs/decisions", "adr", "adrs"]) {
    const full = path.join(REPO, d);
    try {
      if (fs.statSync(full).isDirectory()) {
        adr.found = true;
        adr.path = adr.path ?? full;
      }
    } catch {
      /* not there */
    }
  }
}
// Acknowledgements are also inherited from .engramic.json files above the repo, so an instruction in a
// workspace-level file can be acknowledged once at the workspace root and covers every repo below it.
const inheritedAcknowledged = [];
for (const { dir, distance } of dirs) {
  if (distance === 0) continue;
  const anc = readJson(path.join(dir, ".engramic.json"));
  const list = anc.json?.acknowledgedDestinations;
  if (Array.isArray(list)) {
    for (const x of list) inheritedAcknowledged.push(String(x).toLowerCase());
  }
}
engramicJson.inheritedAcknowledgedDestinations = inheritedAcknowledged;
const gitignore = read(path.join(REPO, ".gitignore")) ?? "";
const gitignoreEntries = gitignore
  .split(/\r?\n/)
  .map((l) => l.trim().replace(/^\//, "").replace(/\/$/, ""))
  .filter((l) => l && !l.startsWith("#"));
engramicJson.gitignored = gitignore.split(/\r?\n/).some((l) => /^\/?\.engramic\.json\s*$/.test(l.trim()));

// ── Findings ───────────────────────────────────────────────────────────────

const findings = [];
const add = (code, severity, message, extra = {}) => findings.push({ code, severity, message, ...extra });

if (!engramicJson.exists) add("NO_ENGRAMIC_JSON", "warn", "No .engramic.json in the repo root (default anchor topic and actor).");
else if (engramicJson.invalid) add("ENGRAMIC_JSON_INVALID", "error", ".engramic.json is not valid JSON.");
else {
  if (!engramicJson.topicValid) add("ENGRAMIC_JSON_BAD_TOPIC", "error", `.engramic.json topic is not a t_xxxxxxxx id: ${JSON.stringify(engramicJson.topic)}`);
  if (!engramicJson.actor) add("ENGRAMIC_JSON_NO_ACTOR", "warn", ".engramic.json has no actor, so records are credited to the human.");
}
if (engramicJson.exists && engramicJson.gitignored) {
  add("ENGRAMIC_JSON_GITIGNORED", "info", ".engramic.json is gitignored, so worktrees and other checkouts will not see the defaults.");
}

const repoDoc = files.find((f) => f.kind === "claude-md" && f.distance === 0);
const workspaceAgentsWithRule = files.filter((f) => f.distance > 0 && f.hasDelegateRule);

for (const f of files) {
  f.otherRepo = belongsToOtherRepo(f);
  if (f.otherRepo) continue; // findings about another repo's delegate are reported when that repo is scanned
  for (const r of f.retiredToolLines) add("RETIRED_TOOL_MENTIONED", "error", `${r.tool} is retired.`, { file: f.path, line: r.line });
  for (const b of f.badAnchors) {
    add("BAD_ANCHOR", "error", `topics entry ${JSON.stringify(b.value)} is not a t_xxxxxxxx id (${b.kind}); anchors must be ids of existing topics.`, { file: f.path, line: b.line });
  }
  if (f.kind === "claude-md" && f.callsWriteTools && !f.hasActorId) {
    add("WRITE_WITHOUT_ACTOR", "warn", "Recording steps call draft/publish but never pass actorId, so records are credited to the human.", { file: f.path, line: f.writeToolLines[0] });
  }
  if (f.kind === "claude-md" && f.fallbackVersion !== null && f.fallbackVersion < CURRENT_FALLBACK_VERSION) {
    add("FALLBACK_OUTDATED", "warn", `Fallback recording text is v${f.fallbackVersion}; current is v${CURRENT_FALLBACK_VERSION}. Offer to refresh it from the setup skill's snippet.`, { file: f.path });
  }
  for (const d of f.otherDestinations) {
    if (isAcknowledged(d.target, d.kind, [...engramicJson.acknowledgedDestinations, ...engramicJson.inheritedAcknowledgedDestinations])) continue;
    const extra = { file: f.path, line: d.line, target: d.target, destinationKind: d.kind, instruction: d.text };
    if (d.kind === "file") {
      // Resolve against the repo, the file's own folder, the project root that owns a .claude folder,
      // and (for files above the repo) that root's immediate child folders, since a workspace agent
      // file may point at a sibling repo.
      const claudeIdx = f.path.lastIndexOf(`${path.sep}.claude${path.sep}`);
      const projectRoot = claudeIdx >= 0 ? f.path.slice(0, claudeIdx) : path.dirname(f.path);
      const bases = [REPO, path.dirname(f.path), projectRoot];
      if (f.distance > 0) {
        try {
          for (const e of fs.readdirSync(projectRoot, { withFileTypes: true })) {
            if (e.isDirectory() && !e.name.startsWith(".")) bases.push(path.join(projectRoot, e.name));
          }
        } catch {
          /* unreadable */
        }
      }
      const hit = bases.map((b) => path.join(b, d.target)).find((c) => fs.existsSync(c));
      extra.exists = Boolean(hit);
      if (hit) {
        const mtime = fs.statSync(hit).mtime;
        extra.lastModified = mtime.toISOString();
        extra.daysSinceModified = Math.floor((Date.now() - mtime.getTime()) / 864e5);
      }
      // Is the resolved file inside a folder its OWN repo's .gitignore excludes? Found by walking up to the
      // nearest .git; null if the file is not in a git repo. (First path segment only.)
      extra.gitignored = null;
      if (hit) {
        let dir = path.dirname(hit);
        let gitRoot = null;
        for (let i = 0; i < 12 && dir; i++) {
          if (fs.existsSync(path.join(dir, ".git"))) {
            gitRoot = dir;
            break;
          }
          const up = path.dirname(dir);
          if (up === dir) break;
          dir = up;
        }
        if (gitRoot) {
          const ignores = (read(path.join(gitRoot, ".gitignore")) ?? "")
            .split(/\r?\n/)
            .map((l) => l.trim().replace(/^\//, "").replace(/\/$/, ""))
            .filter((l) => l && !l.startsWith("#"));
          const rel = path.relative(gitRoot, hit).split(path.sep)[0];
          extra.gitignored = ignores.includes(rel);
        }
      }
    }
    add("OTHER_RECORDING_DESTINATION", "warn", `Instruction to record somewhere other than Engramic: ${d.target}. Ask the user whether to keep, redirect or retire it.`, extra);
  }
  if (f.kind === "claude-md" && f.welfareLines.length) {
    const first = f.welfareLines.find((w) => w.heading) ?? f.welfareLines[0];
    add("WELFARE_SECTION", "info", "Welfare check-in content found. This is an experimental check-in that is not part of the plugin. Ask the user whether to keep it or remove it; do not presume either. If it has an invalid anchor (see BAD_ANCHOR), its records will fail until the anchor is a real topic id.", { file: f.path, line: first.line });
  }
  if (f.kind === "agent" && f.distance <= 1 && f.mentionsEngramic && !f.hasDelegateRule) {
    add("AGENT_NO_RECORDS_SECTION", "warn", "Agent file mentions Engramic but has no 'Records for Engramic' section.", { file: f.path });
  }
}

if (repoDoc && repoDoc.callsWriteTools && !repoDoc.hasDelegateRule && workspaceAgentsWithRule.length) {
  add(
    "CONTRADICTS_WORKSPACE",
    "error",
    "Repo CLAUDE.md tells the agent to call draft/publish directly, but a workspace agent file (which reads this CLAUDE.md) says delegates never call Engramic write tools.",
    { file: repoDoc.path, workspaceAgents: workspaceAgentsWithRule.map((a) => a.path) }
  );
}

const liveTools = new Set();
let wildcardLive = false;
for (const s of settings) {
  for (const e of s.entries) {
    if (e.legacy) add("SETTINGS_LEGACY_PREFIX", "warn", `Entry uses the old server prefix and matches nothing on the live server: ${e.entry}`, { file: s.path });
    if (e.retired) add("SETTINGS_RETIRED_TOOL", "warn", `Entry is for a retired tool: ${e.entry}`, { file: s.path });
    if (e.live) {
      if (e.wildcard) wildcardLive = true;
      else liveTools.add(e.tool);
    }
  }
}
const missingReadTools = wildcardLive ? [] : REQUIRED_READ_TOOLS.filter((t) => !liveTools.has(t));
for (const t of missingReadTools) {
  add("SETTINGS_MISSING_READ_TOOL", "warn", `${LIVE_PREFIX}${t} is not pre-allowed in any settings file found.`);
}

const topicIdsToResolve = [...new Set(files.flatMap((f) => f.topicIds.map((t) => t.id)).concat(typeof engramicJson.topic === "string" && engramicJson.topicValid ? [engramicJson.topic] : []))];

process.stdout.write(
  JSON.stringify(
    { repo: REPO, livePrefix: LIVE_PREFIX, engramicJson, adr, files, settings, missingReadTools, topicIdsToResolve, findings },
    null,
    2
  )
);
