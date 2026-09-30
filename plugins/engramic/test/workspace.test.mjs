import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCAN = path.join(HERE, "..", "skills", "setup", "scan.mjs");
const HOOKS = path.join(HERE, "..", "hooks", "hooks.json");

function tree(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "engramic-ws-"));
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(root, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, typeof content === "string" ? content : JSON.stringify(content));
  }
  return root;
}

const workspaceScan = (root) => {
  const r = spawnSync("node", [SCAN, "--workspace", path.join(root, "ws"), "--home", path.join(root, "home")], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
};

const ROSTER = [
  "## Agents",
  "- engramic-root-agent (`a_Actor000`), the orchestrator",
  "- engramic-platform-agent (`a_Actor001`)",
  "- engramic-ui-agent (`a_Actor002`)",
  "- engramic-cli-agent",
].join("\n");

const REC = "Record with the engramic:record skill. Attribute records with actorId. Never record routine detail.\n";

function workspace(extra = {}) {
  return tree({
    "ws/CLAUDE.md": ROSTER + "\n",
    "ws/server/.git/HEAD": "x\n",
    "ws/server/CLAUDE.md": REC,
    "ws/server/.engramic.json": { actor: "a_Actor001", topic: "t_Example1" },
    "ws/server-ui/.git/HEAD": "x\n",
    "ws/server-ui/CLAUDE.md": REC,
    "ws/server-ui/.engramic.json": { actor: "a_Actor002", topic: "t_Example1" },
    "ws/app-cli/.git/HEAD": "x\n",
    "ws/app-cli/CLAUDE.md": "Nothing about recording here.\n",
    "ws/notes/README.md": "not a git repo\n",
    ...extra,
  });
}

test("workspace mode lists child git repos only, with each repo's setup", () => {
  const out = workspaceScan(workspace());
  assert.deepEqual(out.repos.map((r) => r.name), ["app-cli", "server", "server-ui"]);
  const ui = out.repos.find((r) => r.name === "server-ui");
  assert.equal(ui.engramicJson.actor, "a_Actor002");
  assert.equal(ui.hasRecordingSection, true);
  const appCli = out.repos.find((r) => r.name === "app-cli");
  assert.equal(appCli.engramicJson.exists, false);
  assert.equal(appCli.hasRecordingSection, false);
  assert.ok(appCli.findings.NO_ENGRAMIC_JSON >= 1);
});

test("the roster is parsed, including an entry with no id", () => {
  const out = workspaceScan(workspace());
  const byName = Object.fromEntries(out.roster.map((r) => [r.name, r.id]));
  assert.equal(byName["engramic-root-agent"], "a_Actor000");
  assert.equal(byName["engramic-platform-agent"], "a_Actor001");
  assert.equal(byName["engramic-ui-agent"], "a_Actor002");
  assert.equal(byName["engramic-cli-agent"], null);
  assert.ok(out.findings.some((f) => f.code === "ROSTER_ENTRY_WITHOUT_ID" && f.agent === "engramic-cli-agent"));
});

test("an actor that is not in the roster, and an actor shared by two repos, are flagged", () => {
  const out = workspaceScan(
    workspace({
      "ws/app-cli/.engramic.json": { actor: "a_Actor001" }, // shared with server
      "ws/site/.git/HEAD": "x\n",
      "ws/site/CLAUDE.md": REC,
      "ws/site/.engramic.json": { actor: "a_Actor003" }, // not in the roster
    })
  );
  const shared = out.findings.find((f) => f.code === "ACTOR_SHARED");
  assert.deepEqual(shared.repos.sort(), ["app-cli", "server"]);
  const missing = out.findings.find((f) => f.code === "ACTOR_NOT_IN_ROSTER");
  assert.equal(missing.repo, "site");
});

test("ignoredRepos in the workspace .engramic.json skips a retired repo", () => {
  const out = workspaceScan(workspace({ "ws/.engramic.json": { ignoredRepos: ["app-cli"] } }));
  assert.deepEqual(out.repos.map((r) => r.name), ["server", "server-ui"]);
  assert.deepEqual(out.ignoredRepos, ["app-cli"]);
});

test("a workspace with no roster says so, and the orchestrator's id is only informational", () => {
  const none = workspaceScan(tree({ "ws/CLAUDE.md": "No roster.\n", "ws/a/.git/HEAD": "x\n", "ws/a/CLAUDE.md": REC }));
  assert.ok(none.findings.some((f) => f.code === "NO_ROSTER"));
  const out = workspaceScan(workspace());
  const unused = out.findings.find((f) => f.code === "ROSTER_ID_UNUSED" && f.id === "a_Actor000");
  assert.equal(unused.severity, "info");
});

test("every hook command exits quietly when node is not installed", () => {
  const hooks = JSON.parse(fs.readFileSync(HOOKS, "utf8")).hooks;
  const commands = Object.values(hooks).flatMap((groups) => groups.flatMap((g) => g.hooks.map((h) => h.command)));
  assert.equal(commands.length, 4);
  for (const cmd of commands) {
    const r = spawnSync("/bin/sh", ["-c", cmd], { env: { PATH: "/nonexistent", CLAUDE_PLUGIN_ROOT: path.join(HERE, "..") }, input: "{}", encoding: "utf8" });
    assert.equal(r.status, 0, cmd);
    assert.equal(r.stdout, "");
    assert.equal(r.stderr, "", `no error output expected for: ${cmd}`);
  }
});

test("the hook commands still run the hook when node is present", () => {
  const hooks = JSON.parse(fs.readFileSync(HOOKS, "utf8")).hooks;
  const cmd = hooks.SessionStart[0].hooks[0].command;
  const r = spawnSync("sh", ["-c", cmd], {
    env: { ...process.env, CLAUDE_PLUGIN_ROOT: path.join(HERE, ".."), TMPDIR: fs.mkdtempSync(path.join(os.tmpdir(), "engramic-nd-")) },
    input: JSON.stringify({ session_id: "n1", source: "startup", cwd: os.tmpdir() }),
    encoding: "utf8",
  });
  assert.equal(r.status, 0);
  assert.match(JSON.parse(r.stdout).hookSpecificOutput.additionalContext, /engramic_summary/);
});

const run = (args, cwd) => {
  const r = spawnSync("node", [SCAN, ...args], { cwd, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
};

test("the workspace root is scanned too, and its actor counts in the roster checks", () => {
  const root = workspace({ "ws/.engramic.json": { actor: "a_Actor000", ignoredRepos: ["app-cli"] } });
  const out = workspaceScan(root);
  assert.equal(out.root.name, "(workspace root)");
  assert.equal(out.root.engramicJson.actor, "a_Actor000");
  assert.ok(!out.findings.some((f) => f.code === "ROSTER_ID_UNUSED" && f.id === "a_Actor000"));

  const noRootActor = workspaceScan(workspace());
  assert.equal(noRootActor.root.engramicJson.actor, null);
  assert.ok(noRootActor.root.findings.NO_ENGRAMIC_JSON >= 1);
});

test("running with no arguments at a workspace root switches to workspace mode by itself", () => {
  const root = workspace();
  const out = run(["--home", path.join(root, "home")], path.join(root, "ws"));
  assert.ok(Array.isArray(out.repos) && out.root);
  assert.deepEqual(out.repos.map((r) => r.name), ["app-cli", "server", "server-ui"]);
});

test("inside a git repo, or with an explicit --repo, it stays in repo mode", () => {
  const root = workspace();
  const inRepo = run(["--home", path.join(root, "home")], path.join(root, "ws", "server"));
  assert.ok(Array.isArray(inRepo.findings) && !inRepo.repos);

  const explicit = run(["--repo", path.join(root, "ws"), "--home", path.join(root, "home")], path.join(root, "ws"));
  assert.ok(Array.isArray(explicit.findings) && !explicit.repos);
});

test("a folder with no child git repos stays in repo mode", () => {
  const root = tree({ "plain/CLAUDE.md": REC, "plain/sub/notes.md": "x\n" });
  const out = run(["--home", path.join(root, "home")], path.join(root, "plain"));
  assert.ok(Array.isArray(out.findings) && !out.repos);
});

test("roster parsing ignores ordinary prose and merges a name seen with and without an id", () => {
  const claude = [
    "The autonomous-agent loop runs every hour.",
    "- engramic-root-agent (`a_Actor000`), the orchestrator",
    "- engramic-cli-agent",
    "Note: substitute the engramic-root-agent when the orchestrator is unavailable.",
    "- extension-agent (`a_Ex7en510`) retired",
    "The review-agent is not a roster entry.",
  ].join("\n");
  const out = workspaceScan(tree({ "ws/CLAUDE.md": claude + "\n", "ws/a/.git/HEAD": "x\n", "ws/a/CLAUDE.md": REC }));
  const names = out.roster.map((r) => r.name).sort();
  assert.deepEqual(names, ["engramic-cli-agent", "engramic-root-agent", "extension-agent"]);
  assert.equal(out.roster.filter((r) => r.name === "engramic-root-agent").length, 1);
  assert.equal(out.roster.find((r) => r.name === "engramic-root-agent").id, "a_Actor000");
  assert.equal(out.roster.find((r) => r.name === "engramic-cli-agent").id, null);
  assert.equal(out.roster.find((r) => r.name === "extension-agent").id, "a_Ex7en510");
});

const gitFile = (target) => `gitdir: ${target}\n`;

test("children whose .git is a file (worktrees, submodules) are listed but not scanned", () => {
  const out = workspaceScan(workspace({ "ws/server-wt/.git": gitFile("/elsewhere/server/.git/worktrees/wt"), "ws/server-wt/CLAUDE.md": REC }));
  assert.ok(!out.repos.some((r) => r.name === "server-wt"));
  assert.deepEqual(out.worktrees, [{ name: "server-wt", gitdir: "/elsewhere/server/.git/worktrees/wt" }]);
});

test("a workspace root that is itself a git repo switches once it has three child git repos", () => {
  const three = tree({
    "ws/.git/HEAD": "x\n",
    "ws/CLAUDE.md": "x\n",
    "ws/a/.git/HEAD": "x\n", "ws/a/CLAUDE.md": REC,
    "ws/b/.git/HEAD": "x\n", "ws/b/CLAUDE.md": REC,
    "ws/c/.git/HEAD": "x\n", "ws/c/CLAUDE.md": REC,
  });
  const out = run(["--home", path.join(three, "home")], path.join(three, "ws"));
  assert.ok(Array.isArray(out.repos));
  assert.deepEqual(out.repos.map((r) => r.name), ["a", "b", "c"]);
});

test("a git repo with fewer than three child repos, or with submodules, stays in repo mode", () => {
  const two = tree({ "ws/.git/HEAD": "x\n", "ws/CLAUDE.md": REC, "ws/a/.git/HEAD": "x\n", "ws/b/.git/HEAD": "x\n" });
  const out = run(["--home", path.join(two, "home")], path.join(two, "ws"));
  assert.ok(Array.isArray(out.findings) && !out.repos);

  const subs = tree({
    "ws/.git/HEAD": "x\n",
    "ws/CLAUDE.md": REC,
    "ws/s1/.git": gitFile("../.git/modules/s1"),
    "ws/s2/.git": gitFile("../.git/modules/s2"),
    "ws/s3/.git": gitFile("../.git/modules/s3"),
    "ws/s4/.git": gitFile("../.git/modules/s4"),
  });
  const out2 = run(["--home", path.join(subs, "home")], path.join(subs, "ws"));
  assert.ok(Array.isArray(out2.findings) && !out2.repos);
});

test("a folder with only worktree children does not count as a workspace", () => {
  const root = tree({ "ws/CLAUDE.md": REC, "ws/wt/.git": gitFile("/x/.git/worktrees/wt") });
  const out = run(["--home", path.join(root, "home")], path.join(root, "ws"));
  assert.ok(Array.isArray(out.findings) && !out.repos);
});
