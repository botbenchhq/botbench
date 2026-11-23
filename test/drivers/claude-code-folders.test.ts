import assert from "node:assert/strict";
import { test } from "node:test";
import { toolResultsFolder } from "../../src/drivers/claude-code.ts";

// Where Claude Code saves a session's long tool output, named as the CLI names its own folders. A pure function.

const SESSION = "4c1d8a52-7d0e-4a8b-9f43-2a51d3b1c6e0";

test("the saved-output folder is under the projects folder, named by the copy's path with every other character a dash, then the session", () => {
  // As the CLI's own folders on this Mac are named: a dot and a slash both become a dash.
  assert.equal(toolResultsFolder({ cwd: "/Users/me/.botbench/worktrees/run-2/task-4", session: SESSION, home: "/Users/me", env: {} }), `/Users/me/.claude/projects/-Users-me--botbench-worktrees-run-2-task-4/${SESSION}/tool-results`);
  // A moved configuration folder, from the owner's setting or the CLI's own variable.
  assert.equal(toolResultsFolder({ cwd: "/w", session: SESSION, configDir: "/elsewhere/claude", env: { CLAUDE_CONFIG_DIR: "/ignored" } }), `/elsewhere/claude/projects/-w/${SESSION}/tool-results`);
  assert.equal(toolResultsFolder({ cwd: "/w", session: SESSION, env: { CLAUDE_CONFIG_DIR: "/moved" }, home: "/Users/me" }), `/moved/projects/-w/${SESSION}/tool-results`);
  assert.equal(toolResultsFolder({ cwd: "/w", session: SESSION, env: { CLAUDE_CONFIG_DIR: "relative" }, home: "/Users/me" }), `/Users/me/.claude/projects/-w/${SESSION}/tool-results`);
});

test("a session that could name anything but one folder names none", () => {
  for (const session of ["", "..", "../other", "a/b", "x y", "a\0b", "s".repeat(101)]) {
    assert.equal(toolResultsFolder({ cwd: "/w", session, home: "/Users/me", env: {} }), null, JSON.stringify(session));
  }
});
