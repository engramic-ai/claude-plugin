import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HOOK = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "hooks", "engramic-hook.mjs");
let tmp;
let n = 0;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "engramic-test-"));
  n += 1;
});

function run(cmd, input, env = {}) {
  const r = spawnSync("node", [HOOK, cmd], {
    input: typeof input === "string" ? input : JSON.stringify({ session_id: `s${n}`, ...input }),
    env: { ...process.env, TMPDIR: tmp, TEMP: tmp, TMP: tmp, ...env },
    encoding: "utf8",
  });
  assert.equal(r.status, 0, "hook must always exit 0");
  return r.stdout ? JSON.parse(r.stdout) : null;
}

const bash = (command, extra = {}) => ({ tool_name: "Bash", tool_input: { command }, ...extra });

test("session-start injects orientation and repo defaults", () => {
  const repo = fs.mkdtempSync(path.join(tmp, "repo-"));
  fs.writeFileSync(path.join(repo, ".engramic.json"), JSON.stringify({ topic: "t_Example1", actor: "engramic-platform-agent" }));
  const out = run("session-start", { source: "startup", cwd: repo });
  const ctx = out.hookSpecificOutput.additionalContext;
  assert.match(ctx, /engramic_summary/);
  assert.match(ctx, /t_Example1/);
  assert.match(ctx, /engramic-platform-agent/);
});

test("session-start ignores a malformed topic id", () => {
  const repo = fs.mkdtempSync(path.join(tmp, "repo-"));
  fs.writeFileSync(path.join(repo, ".engramic.json"), JSON.stringify({ topic: "Engramic Platform" }));
  const out = run("session-start", { source: "startup", cwd: repo });
  assert.doesNotMatch(out.hookSpecificOutput.additionalContext, /anchor topic/);
});

test("milestone commands are flagged", () => {
  for (const c of [
    "gh pr merge 42 --squash",
    "gh release create v1.0.0",
    "gh issue close 9",
    "git push --tags",
    "git push origin v1.2.3",
    "git push origin refs/tags/v1",
    "git push origin tag v9",
    "git -C /tmp/r push origin --follow-tags",
    "git -c user.name=x push origin v2.0.1",
    'git -C /tmp/r push --tags; echo "exit=$?"',
    "npm publish",
    "npm publish --access public",
    "pnpm publish --no-git-checks",
    "yarn npm publish",
    "cd packages/lib && npm publish",
  ]) {
    n += 1;
    const out = run("post-tool", bash(c));
    assert.match(out.hookSpecificOutput.additionalContext, /Milestone flagged/, c);
  }
});

test("non-milestones are ignored: local tags, ordinary pushes, dry runs, tag deletion", () => {
  for (const c of [
    "git commit -m x",
    "git tag v1.0.0",
    "git tag -a v1.0.0 -m release",
    "git -C /tmp/guard-test tag delegate-guard-test",
    "git tag --list",
    "git push",
    "git push origin main",
    "git push origin feature/v2-work",
    "git push -u origin my-branch",
    "git push --tags --dry-run",
    "git push --delete origin v1.0",
    "git push origin main; git tag v1",
    "gh pr merge 1 --dry-run",
    "npm publish --dry-run",
    "npm run publish-docs",
    "npm help publish",
    "npm version patch",
    "npm pack",
  ]) {
    n += 1;
    assert.equal(run("post-tool", bash(c)), null, c);
  }
});

test("decision language is flagged once per cooldown window", () => {
  const first = run("user-prompt", { prompt: "Right, we\u2019ll go with the two-pass flow" });
  assert.match(first.hookSpecificOutput.additionalContext, /may settle a decision/);
  assert.equal(run("user-prompt", { prompt: "agreed, lock it in" }), null);
  assert.equal(run("user-prompt", { prompt: "what does this function do?" }), null);
});

test("stop blocks once for pending items, then not again", () => {
  run("post-tool", bash("gh pr merge 7"));
  const blocked = run("stop", {});
  assert.equal(blocked.decision, "block");
  assert.match(blocked.reason, /gh pr merge 7/);
  assert.equal(run("stop", {}), null);
});

test("stop never blocks when stop_hook_active or switched off", () => {
  run("post-tool", bash("gh pr merge 7"));
  assert.equal(run("stop", { stop_hook_active: true }), null);
  assert.equal(run("stop", {}, { ENGRAMIC_RECORDER_STOP: "off" }), null);
});

test("a successful publish clears pending; a failed one does not", () => {
  run("post-tool", bash("gh pr merge 7"));
  run("post-tool", { tool_name: "mcp__x__engramic_record_publish", tool_response: "VALIDATION_ERROR: bad" });
  assert.equal(run("stop", {}).decision, "block");

  n += 1;
  run("post-tool", bash("gh pr merge 8"));
  run("post-tool", { tool_name: "mcp__claude_ai_Engramic__engramic_record_publish", tool_response: "published e_abc" });
  assert.equal(run("stop", {}), null);
});

test("delegates are told not to record, and their milestone is queued for the parent", () => {
  const out = run("post-tool", bash("gh release create v2", { agent_id: "a1", agent_type: "server" }));
  assert.match(out.hookSpecificOutput.additionalContext, /Do not call Engramic write tools/);
  assert.match(out.hookSpecificOutput.additionalContext, /Records for Engramic/);
  const blocked = run("stop", {});
  assert.match(blocked.reason, /by delegate server/);
});

test("a delegate's publish call does not clear the parent's pending items", () => {
  run("post-tool", bash("gh pr merge 7"));
  run("post-tool", { agent_id: "a1", tool_name: "mcp__x__engramic_record_publish", tool_response: "ok" });
  assert.equal(run("stop", {}).decision, "block");
});

test("kill switch and garbage input are harmless", () => {
  assert.equal(run("session-start", { source: "startup" }, { ENGRAMIC_RECORDER: "off" }), null);
  assert.equal(run("stop", "not json"), null);
});

test("debug mode logs what the hook receives, without command or prompt text", () => {
  run("post-tool", bash("git -C /tmp/r tag secret-tag-name", { agent_id: "a9", agent_type: "general-purpose", hook_event_name: "PostToolUse" }), { ENGRAMIC_RECORDER_DEBUG: "1" });
  const log = fs.readFileSync(path.join(tmp, "engramic-plugin", "debug.log"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(log.length, 1);
  assert.equal(log[0].agent_id, "a9");
  assert.equal(log[0].agent_type, "general-purpose");
  assert.ok(log[0].keys.includes("tool_input"));
  assert.ok(!JSON.stringify(log[0]).includes("secret-tag-name"));
});

test("debug mode is off by default", () => {
  run("post-tool", bash("gh pr merge 1"));
  assert.ok(!fs.existsSync(path.join(tmp, "engramic-plugin", "debug.log")));
});
