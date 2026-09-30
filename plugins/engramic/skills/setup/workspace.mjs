#!/usr/bin/env node
// Workspace mode for the engramic:setup scan. Read-only. Run through scan.mjs:
//
//   node scan.mjs --workspace [DIR] [--home DIR]
//
// Lists the workspace root and each child git repo of it (DIR, default the current folder) with its
// Engramic setup, by running the normal repo scan on each, then cross-checks the actors against the roster in the
// workspace CLAUDE.md. It reports; it never changes anything and it does not patch child repos.
//
// Repos to skip (for example a retired one) go in the workspace .engramic.json:
//   { "ignoredRepos": ["legacy-tool"] }

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCAN = path.join(HERE, "scan.mjs");
const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : null;
};
const WORKSPACE = path.resolve(opt("workspace") ?? process.cwd());
const HOME = path.resolve(opt("home") ?? os.homedir());

const read = (p) => {
  try {
    return fs.readFileSync(p, "utf8");
  } catch {
    return null;
  }
};
const readJson = (p) => {
  const t = read(p);
  if (t === null) return null;
  try {
    return JSON.parse(t);
  } catch {
    return null;
  }
};

// ── Roster: agent names and their actor ids, from prose in the workspace CLAUDE.md ─────────────────
// A name counts if it starts with "engramic-" or has an actor id attached on the same line, so ordinary
// prose like "autonomous-agent loop" is not read as a roster entry. A name seen both with and without an
// id (for example in a later note) is one entry, keeping the id.
function parseRoster(text) {
  if (!text) return [];
  const NAME = /\b((?:[a-z][a-z0-9]*-)+agent)\b/g;
  const ID = /a_[A-Za-z0-9_-]{8}/g;
  const idsByName = new Map();
  for (const line of text.split(/\r?\n/)) {
    const names = [...line.matchAll(NAME)].map((m) => ({ name: m[1], at: m.index }));
    if (!names.length) continue;
    const ids = [...line.matchAll(ID)].map((m) => ({ id: m[0], at: m.index }));
    names.forEach((n, i) => {
      const next = names[i + 1]?.at ?? Infinity;
      const hit = ids.find((x) => x.at > n.at && x.at < next);
      if (!n.name.startsWith("engramic-") && !hit) return;
      if (!idsByName.has(n.name)) idsByName.set(n.name, new Set());
      if (hit) idsByName.get(n.name).add(hit.id);
    });
  }
  const roster = [];
  for (const [name, ids] of idsByName) {
    if (ids.size === 0) roster.push({ name, id: null });
    else for (const id of ids) roster.push({ name, id });
  }
  return roster;
}

// ── Children ────────────────────────────────────────────────────────────────────────────────────────
const rootConfig = readJson(path.join(WORKSPACE, ".engramic.json")) ?? {};
const ignored = new Set((Array.isArray(rootConfig.ignoredRepos) ? rootConfig.ignoredRepos : []).map((x) => String(x).toLowerCase()));

let entries = [];
try {
  entries = fs.readdirSync(WORKSPACE, { withFileTypes: true });
} catch {
  /* unreadable */
}
// A child with a .git FOLDER is a repo. A child with a .git FILE is a worktree or a submodule: it is listed
// but not scanned, since the main checkout is the place to set things up.
const childDirs = [];
const worktrees = [];
for (const e of entries.filter((x) => x.isDirectory() && !x.name.startsWith(".")).sort((a, b) => a.name.localeCompare(b.name))) {
  let st = null;
  try {
    st = fs.statSync(path.join(WORKSPACE, e.name, ".git"));
  } catch {
    continue;
  }
  if (st.isDirectory()) childDirs.push(e.name);
  else {
    const line = (read(path.join(WORKSPACE, e.name, ".git")) ?? "").split(/\r?\n/).find((l) => l.startsWith("gitdir:")) ?? null;
    worktrees.push({ name: e.name, gitdir: line ? line.slice(7).trim() : null });
  }
}

function summarise(name, dir) {
  const r = spawnSync(process.execPath, [SCAN, "--repo", dir, "--home", HOME], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  let scan;
  try {
    scan = JSON.parse(r.stdout);
  } catch {
    return { name, scanFailed: true };
  }
  const doc = scan.files.find((f) => f.kind === "claude-md" && f.distance === 0);
  const codes = {};
  for (const f of scan.findings) codes[f.code] = (codes[f.code] ?? 0) + 1;
  return {
    name,
    path: dir,
    engramicJson: { exists: scan.engramicJson.exists, actor: scan.engramicJson.actor ?? null, topic: scan.engramicJson.topic ?? null },
    hasClaudeMd: Boolean(doc),
    hasRecordingSection: Boolean(doc?.mentionsEngramic),
    fallbackVersion: doc?.fallbackVersion ?? null,
    findings: codes,
    errors: scan.findings.filter((f) => f.severity === "error").length,
    warnings: scan.findings.filter((f) => f.severity === "warn").length,
  };
}

// The workspace root is audited too: its own CLAUDE.md, agent files and .engramic.json.
const root = summarise("(workspace root)", WORKSPACE);

const repos = [];
const skipped = [];
for (const name of childDirs) {
  if (ignored.has(name.toLowerCase())) {
    skipped.push(name);
    continue;
  }
  repos.push(summarise(name, path.join(WORKSPACE, name)));
}

// ── Cross-repo checks ───────────────────────────────────────────────────────────────────────────────
const roster = parseRoster(read(path.join(WORKSPACE, "CLAUDE.md")));
const rosterIds = new Set(roster.map((r) => r.id).filter(Boolean));
const rosterNames = new Set(roster.map((r) => r.name));
const findings = [];
const add = (code, severity, message, extra = {}) => findings.push({ code, severity, message, ...extra });

if (!roster.length) add("NO_ROSTER", "info", "No agent roster found in the workspace CLAUDE.md, so actors cannot be cross-checked.");
for (const r of roster) {
  if (!r.id) add("ROSTER_ENTRY_WITHOUT_ID", "info", `Roster entry ${r.name} has no actor id.`, { agent: r.name });
}

const byActor = new Map();
for (const r of [root, ...repos]) {
  const actor = r.engramicJson?.actor;
  if (!actor) continue;
  if (!byActor.has(actor)) byActor.set(actor, []);
  byActor.get(actor).push(r.name);
  if (roster.length && !rosterIds.has(actor) && !rosterNames.has(actor)) {
    add("ACTOR_NOT_IN_ROSTER", "warn", `${r.name} uses actor ${actor}, which is not in the roster.`, { repo: r.name, actor });
  }
}
for (const [actor, names] of byActor) {
  if (names.length > 1) add("ACTOR_SHARED", "warn", `Actor ${actor} is used by more than one repo: ${names.join(", ")}.`, { actor, repos: names });
}
const usedIds = new Set(byActor.keys());
for (const r of roster) {
  if (r.id && !usedIds.has(r.id)) add("ROSTER_ID_UNUSED", "info", `Roster id ${r.id} (${r.name}) is not used by any repo's .engramic.json. Expected for an orchestrator or a retired agent.`, { agent: r.name, id: r.id });
}

process.stdout.write(JSON.stringify({ workspace: WORKSPACE, roster, ignoredRepos: skipped, worktrees, root, repos, findings }, null, 2));
