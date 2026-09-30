import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCAN = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "skills", "setup", "scan.mjs");

function tree(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "engramic-scan-"));
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(root, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, typeof content === "string" ? content : JSON.stringify(content));
  }
  return root;
}

function scan(root, repoRel, homeRel = "home") {
  const r = spawnSync("node", [SCAN, "--repo", path.join(root, repoRel), "--home", path.join(root, homeRel)], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

const codes = (out) => out.findings.map((f) => f.code);

const LIVE = "mcp__claude_ai_Engramic__";

// A tree shaped like the server-ui audit: workspace root above the repo, legacy user settings.
function platformUiTree() {
  return tree({
    "ws/CLAUDE.md": "# Workspace\nOrchestrator records.\n",
    "ws/.claude/agents/server-ui.md": "# UI agent\nNever call Engramic write tools. End with a Records for Engramic section.\n",
    "ws/.claude/settings.local.json": { permissions: { allow: [`${LIVE}engramic_search`, `${LIVE}engramic_summary`, `${LIVE}engramic_timeline`] } },
    "ws/server-ui/CLAUDE.md": [
      "# server-ui",
      "## Recording to Engramic",
      "Call engramic_record_draft then engramic_record_publish.",
      "Use engramic_record for one-shot records.",
      "## Welfare Check-ins",
      'Record with topics: ["1a2b3c4d"] and type event.',
      "Anchor t_Example1 is Engramic Platform.",
    ].join("\n"),
    "home/.claude/settings.json": {
      permissions: {
        allow: ["mcp__Engramic__engramic_search", "mcp__Engramic__engramic_record", "mcp__Engramic__engramic_nominate_topic", "Bash(ls:*)"],
      },
    },
  });
}

test("server-ui shaped tree produces the expected findings", () => {
  const root = platformUiTree();
  const out = scan(root, "ws/server-ui");
  const c = codes(out);
  for (const expected of [
    "NO_ENGRAMIC_JSON",
    "RETIRED_TOOL_MENTIONED",
    "BAD_ANCHOR",
    "WRITE_WITHOUT_ACTOR",
    "CONTRADICTS_WORKSPACE",
    "WELFARE_SECTION",
    "SETTINGS_LEGACY_PREFIX",
    "SETTINGS_RETIRED_TOOL",
    "SETTINGS_MISSING_READ_TOOL",
  ]) {
    assert.ok(c.includes(expected), `missing ${expected}; got ${c.join(", ")}`);
  }
});

test("bad anchor is classified and located", () => {
  const out = scan(platformUiTree(), "ws/server-ui");
  const bad = out.findings.find((f) => f.code === "BAD_ANCHOR");
  assert.match(bad.message, /legacy-hex/);
  assert.equal(bad.line, 6);
});

test("retired tool detection does not fire on draft or publish", () => {
  const root = tree({ "r/CLAUDE.md": "Use engramic_record_draft and engramic_record_publish with actorId.\n" });
  const out = scan(root, "r");
  assert.ok(!codes(out).includes("RETIRED_TOOL_MENTIONED"));
  assert.ok(!codes(out).includes("WRITE_WITHOUT_ACTOR"));
});

test("only engramic_topic is missing when the other read tools are allowed", () => {
  const out = scan(platformUiTree(), "ws/server-ui");
  assert.deepEqual(out.missingReadTools, ["engramic_topic"]);
});

test("a live server wildcard covers all read tools", () => {
  const root = tree({
    "r/CLAUDE.md": "x\n",
    "home/.claude/settings.json": { permissions: { allow: [`${LIVE}*`] } },
  });
  assert.deepEqual(scan(root, "r").missingReadTools, []);
});

test("topic ids are collected for the skill to resolve", () => {
  const out = scan(platformUiTree(), "ws/server-ui");
  assert.deepEqual(out.topicIdsToResolve, ["t_Example1"]);
});

test(".engramic.json checks: valid, bad topic, gitignored", () => {
  const good = tree({ "r/.engramic.json": { topic: "t_Example1", actor: "engramic-ui-agent" } });
  const g = scan(good, "r");
  assert.ok(!codes(g).includes("NO_ENGRAMIC_JSON") && !codes(g).includes("ENGRAMIC_JSON_BAD_TOPIC"));
  assert.ok(g.topicIdsToResolve.includes("t_Example1"));

  const bad = tree({ "r/.engramic.json": { topic: "Engramic Platform" }, "r/.gitignore": "node_modules\n.engramic.json\n" });
  const b = scan(bad, "r");
  assert.ok(codes(b).includes("ENGRAMIC_JSON_BAD_TOPIC"));
  assert.ok(codes(b).includes("ENGRAMIC_JSON_NO_ACTOR"));
  assert.ok(codes(b).includes("ENGRAMIC_JSON_GITIGNORED"));
});

test("a clean repo has no errors or warnings", () => {
  const root = tree({
    "r/.engramic.json": { topic: "t_Example1", actor: "engramic-ui-agent" },
    "r/CLAUDE.md": "Record with the engramic:record skill using actorId engramic-ui-agent.\n",
    "home/.claude/settings.json": { permissions: { allow: ["search", "summary", "timeline", "topic"].map((t) => `${LIVE}engramic_${t}`) } },
  });
  const out = scan(root, "r");
  assert.deepEqual(out.findings.filter((f) => f.severity !== "info"), []);
});

test("agent file that mentions Engramic without the Records section is flagged", () => {
  const root = tree({ "r/.claude/agents/a.md": "Record decisions to Engramic yourself.\n" });
  assert.ok(codes(scan(root, "r")).includes("AGENT_NO_RECORDS_SECTION"));
});

test("scan is read-only and tolerates missing or invalid files", () => {
  const root = tree({ "r/.claude/settings.json": "not json", "r/.engramic.json": "{" });
  const out = scan(root, "r");
  assert.ok(codes(out).includes("ENGRAMIC_JSON_INVALID"));
});

const SNIPPET_WITH_FALLBACK = (v) => [
  "## Recording to Engramic",
  'Record with the `engramic:record` skill. Attribute records with `actorId: "engramic-ui-agent"`. Default anchor topic: `t_Example1`.',
  'When running as a delegate: never call Engramic write tools. End with a "Records for Engramic" section.',
  `<!-- engramic:fallback v${v} -->`,
  "If the skill is not available: use engramic_record_draft then engramic_record_publish, pass actorId.",
  "<!-- /engramic:fallback -->",
].join("\n");

test("the current snippet with fallback is clean, even beside a workspace delegate rule", () => {
  const root = tree({
    "ws/.claude/agents/ui.md": "Never call Engramic write tools. Records for Engramic section.\n",
    "ws/ui/CLAUDE.md": SNIPPET_WITH_FALLBACK(1),
    "ws/ui/.engramic.json": { topic: "t_Example1", actor: "engramic-ui-agent" },
    "home/.claude/settings.json": { permissions: { allow: ["search", "summary", "timeline", "topic"].map((t) => `${LIVE}engramic_${t}`) } },
  });
  const out = scan(root, "ws/ui");
  assert.deepEqual(out.findings.filter((f) => f.severity !== "info"), []);
  assert.equal(out.files.find((f) => f.kind === "claude-md" && f.distance === 0).fallbackVersion, 1);
});

test("an older fallback version is flagged as outdated", () => {
  const root = tree({ "r/CLAUDE.md": SNIPPET_WITH_FALLBACK(0) });
  assert.ok(codes(scan(root, "r")).includes("FALLBACK_OUTDATED"));
});

test("no fallback marker means no fallback finding", () => {
  const root = tree({ "r/CLAUDE.md": "Record with actorId engramic-ui-agent.\n" });
  assert.ok(!codes(scan(root, "r")).includes("FALLBACK_OUTDATED"));
});

test("an actor-only .engramic.json is valid: topic is optional", () => {
  const root = tree({ "r/.engramic.json": { actor: "a_Actor000" } });
  const out = scan(root, "r");
  assert.ok(!codes(out).includes("ENGRAMIC_JSON_BAD_TOPIC"));
  assert.ok(!codes(out).includes("NO_ENGRAMIC_JSON"));
  assert.deepEqual(out.topicIdsToResolve, []);
});

test("ADR convention is detected from ARCHITECTURE.md headings or an adr folder", () => {
  const a = scan(tree({ "r/ARCHITECTURE.md": "# Arch\n## ADR-107: Elapsed clock\ntext\n" }), "r");
  assert.equal(a.adr.found, true);
  assert.match(a.adr.path, /ARCHITECTURE\.md$/);

  const b = scan(tree({ "r/docs/adr/0001-thing.md": "x\n" }), "r");
  assert.equal(b.adr.found, true);

  const c = scan(tree({ "r/ARCHITECTURE.md": "# Arch\nJust prose about the system.\n" }), "r");
  assert.equal(c.adr.found, false);

  const d = scan(tree({ "r/CLAUDE.md": "x\n" }), "r");
  assert.equal(d.adr.found, false);
});

test("an instruction to record to another file is flagged, with existence and age", () => {
  const root = tree({
    "r/CLAUDE.md": "Append findings to docs/learnings.md after each task.\n",
    "r/docs/learnings.md": "# learnings\n",
  });
  const old = new Date(Date.now() - 90 * 864e5);
  fs.utimesSync(path.join(root, "r/docs/learnings.md"), old, old);
  const f = scan(root, "r").findings.find((x) => x.code === "OTHER_RECORDING_DESTINATION");
  assert.equal(f.target, "docs/learnings.md");
  assert.equal(f.exists, true);
  assert.ok(f.daysSinceModified >= 89);
  assert.equal(f.line, 1);

  const missing = scan(tree({ "r/CLAUDE.md": "Log bug fixes to notes/fixes.md.\n" }), "r").findings.find((x) => x.code === "OTHER_RECORDING_DESTINATION");
  assert.equal(missing.exists, false);
});

test("a named log is flagged, and standard destinations are not", () => {
  const named = scan(tree({ "r/CLAUDE.md": "Log bug fixes in the discovery log.\n" }), "r");
  const f = named.findings.find((x) => x.code === "OTHER_RECORDING_DESTINATION");
  assert.equal(f.destinationKind, "named-log");
  assert.equal(f.target, "discovery log");

  const standard = scan(tree({
    "r/CLAUDE.md": ["Record decisions in ARCHITECTURE.md as ADRs.", "Update CHANGELOG.md for releases.", "Add notes to docs/adr/README.md.", "Write the anchor to .engramic.json."].join("\n"),
  }), "r");
  assert.ok(!codes(standard).includes("OTHER_RECORDING_DESTINATION"));
});

test("acknowledged destinations in .engramic.json are not flagged again", () => {
  const root = tree({
    "r/CLAUDE.md": "Append findings to docs/learnings.md. Log bug fixes in the discovery log.\n",
    "r/.engramic.json": { actor: "a_Actor001", acknowledgedDestinations: ["docs/learnings.md", "discovery-log"] },
  });
  assert.ok(!codes(scan(root, "r")).includes("OTHER_RECORDING_DESTINATION"));
});

test("Engramic-only recording instructions are not flagged", () => {
  const root = tree({ "r/CLAUDE.md": SNIPPET_WITH_FALLBACK(1) });
  assert.ok(!codes(scan(root, "r")).includes("OTHER_RECORDING_DESTINATION"));
});

test("a target referenced from a workspace agent file is found in a sibling repo", () => {
  const root = tree({
    "ws/.claude/agents/general.md": "Update CONVENTIONS.md if a convention changes. Append findings to docs/lessons.md.\n",
    "ws/server/docs/lessons.md": "# lessons\n",
    "ws/server-ui/CLAUDE.md": "x\n",
  });
  const out = scan(root, "ws/server-ui");
  const f = out.findings.filter((x) => x.code === "OTHER_RECORDING_DESTINATION");
  // CONVENTIONS.md is a standard destination, so it is not flagged at all
  assert.ok(!f.some((x) => /CONVENTIONS/.test(x.target)));
  // the sibling file is found, not reported missing
  const lessons = f.find((x) => x.target === "docs/lessons.md");
  assert.equal(lessons.exists, true);
});

test("a target under a gitignored folder is reported as gitignored", () => {
  const root = tree({
    "r/CLAUDE.md": "Update .claude/notes.md if you learned something.\n",
    "r/.claude/notes.md": "n\n",
    "r/.gitignore": ".claude/\nnode_modules\n",
    "r/.git/HEAD": "ref: refs/heads/main\n",
  });
  const f = scan(root, "r").findings.find((x) => x.code === "OTHER_RECORDING_DESTINATION");
  assert.equal(f.exists, true);
  assert.equal(f.gitignored, true);
  const committed = tree({ "r/CLAUDE.md": "Update docs/notes.md when relevant.\n", "r/docs/notes.md": "n\n", "r/.gitignore": "node_modules\n", "r/.git/HEAD": "x\n" });
  assert.equal(scan(committed, "r").findings.find((x) => x.code === "OTHER_RECORDING_DESTINATION").gitignored, false);
});

test("direct-object form is caught for md and txt, but not for config files or standard destinations", () => {
  const hit = scan(tree({ "r/CLAUDE.md": "Update docs/api-notes.md if you learned something worth keeping.\n" }), "r");
  assert.equal(hit.findings.find((x) => x.code === "OTHER_RECORDING_DESTINATION").target, "docs/api-notes.md");

  const quiet = scan(tree({ "r/CLAUDE.md": ["Update package.json when adding a dependency.", "Update README.md for user-facing changes.", "Maintain CHANGELOG.md."].join("\n") }), "r");
  assert.ok(!codes(quiet).includes("OTHER_RECORDING_DESTINATION"));

  const once = scan(tree({ "r/CLAUDE.md": "Append findings to docs/x.md.\n" }), "r").findings.filter((f) => f.code === "OTHER_RECORDING_DESTINATION");
  assert.equal(once.length, 1);
});

test("acknowledging a plain name covers both the named log and the path form", () => {
  const text = ["Update .claude/discovery-log.md if you learned something.", "Bug fixes go in the discovery log."].join("\n");
  const bare = scan(tree({ "r/CLAUDE.md": text }), "r").findings.filter((f) => f.code === "OTHER_RECORDING_DESTINATION");
  assert.equal(bare.length, 2);

  const byName = scan(tree({ "r/CLAUDE.md": text, "r/.engramic.json": { actor: "a_x", acknowledgedDestinations: ["discovery log"] } }), "r");
  assert.ok(!codes(byName).includes("OTHER_RECORDING_DESTINATION"));

  const byHyphen = scan(tree({ "r/CLAUDE.md": text, "r/.engramic.json": { actor: "a_x", acknowledgedDestinations: ["discovery-log"] } }), "r");
  assert.ok(!codes(byHyphen).includes("OTHER_RECORDING_DESTINATION"));
});

test("acknowledging a path covers that exact path only", () => {
  const root = tree({
    "r/CLAUDE.md": ["Update .claude/discovery-log.md.", "Update docs/other-log.md."].join("\n"),
    "r/.engramic.json": { actor: "a_x", acknowledgedDestinations: [".claude/discovery-log.md"] },
  });
  const f = scan(root, "r").findings.filter((x) => x.code === "OTHER_RECORDING_DESTINATION");
  assert.deepEqual(f.map((x) => x.target), ["docs/other-log.md"]);
});

test("editing agent, command or skill files is not a recording destination", () => {
  const root = tree({ "r/CLAUDE.md": ["Edit .claude/agents/server.md by hand when the roster changes.", "Update .claude/commands/deploy.md for new steps.", "Add to .claude/skills/x/notes.md when needed."].join("\n") });
  assert.ok(!codes(scan(root, "r")).includes("OTHER_RECORDING_DESTINATION"));
});

test("acknowledgements in a .engramic.json above the repo are inherited", () => {
  const files = {
    "ws/.claude/agents/ui.md": "Update .claude/discovery-log.md if you learned something.\n",
    "ws/server/CLAUDE.md": "x\n",
  };
  const without = scan(tree(files), "ws/server");
  assert.ok(codes(without).includes("OTHER_RECORDING_DESTINATION"));

  const withAck = scan(tree({ ...files, "ws/.engramic.json": { acknowledgedDestinations: ["discovery log"] } }), "ws/server");
  assert.ok(!codes(withAck).includes("OTHER_RECORDING_DESTINATION"));
  assert.deepEqual(withAck.engramicJson.inheritedAcknowledgedDestinations, ["discovery log"]);
});

test("gitignored is judged by the repo that owns the file, not the repo being scanned", () => {
  const root = tree({
    "ws/.claude/agents/ui.md": "Update .claude/discovery-log.md if you learned something.\n",
    "ws/server-ui/.git/HEAD": "x\n",
    "ws/server-ui/.gitignore": ".claude/\n",
    "ws/server-ui/.claude/discovery-log.md": "log\n",
    "ws/site/.git/HEAD": "x\n",
    "ws/site/.gitignore": "node_modules\n",
    "ws/site/CLAUDE.md": "x\n",
  });
  const f = scan(root, "ws/site").findings.find((x) => x.code === "OTHER_RECORDING_DESTINATION");
  assert.equal(f.exists, true);
  assert.equal(f.gitignored, true);
});

test("a note that a tool was removed is not flagged, but an instruction to use it is", () => {
  const note = scan(tree({ "r/CLAUDE.md": "engramic_record was removed; use the two-pass flow.\nDo not use engramic_record.\n" }), "r");
  assert.ok(!codes(note).includes("RETIRED_TOOL_MENTIONED"));
  const use = scan(tree({ "r/CLAUDE.md": "Call engramic_record with the payload.\n" }), "r");
  assert.ok(codes(use).includes("RETIRED_TOOL_MENTIONED"));
});

test("another repo's workspace agent file is not this repo's business, but the workspace policy still applies", () => {
  const files = {
    "ws/.claude/agents/server-ui.md": "Never call Engramic write tools. Records for Engramic section. Update .claude/discovery-log.md if you learned something.\n",
    "ws/.claude/agents/site.md": "Append findings to docs/site-notes.md.\n",
    "ws/server-ui/CLAUDE.md": "x\n",
    "ws/site/CLAUDE.md": "Use engramic_record_draft then engramic_record_publish, pass actorId.\n",
  };
  const web = scan(tree(files), "ws/site");
  const targets = web.findings.filter((f) => f.code === "OTHER_RECORDING_DESTINATION").map((f) => f.target);
  assert.deepEqual(targets, ["docs/site-notes.md"]); // site's own agent file, not server-ui's
  // policy from the other agent file still counts, so the repo's direct-write instruction still contradicts it
  assert.ok(codes(web).includes("CONTRADICTS_WORKSPACE"));

  const ui = scan(tree(files), "ws/server-ui");
  const uiTargets = ui.findings.filter((f) => f.code === "OTHER_RECORDING_DESTINATION").map((f) => f.target);
  assert.ok(uiTargets.includes(".claude/discovery-log.md") || uiTargets.includes("discovery log"));
  assert.ok(!uiTargets.includes("docs/site-notes.md"));
});

