import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { gate } from "../../src/approvals/gate.ts";
import { REFUSAL_KINDS, refusalBlocksAccept, refusalKind, readOnlyCommand, type RefusalKind } from "../../src/approvals/refusals.ts";

// Which refusals of a fully autonomous run block its accept. Pure functions, no process or store: each request is put to
// the real gate in a fully autonomous run, its refusal is read for its kind, and the kind decides. What the broker
// records, and the engine's accept, are tested in test/approvals/broker-modes.test.ts and test/engine/modes.test.ts.

const WORKTREE = "/nonexistent-botbench/worktrees/run-1/task-1";
const HOME = "/nonexistent-botbench-home";

/** One refused request of each shape: the tool, its input, whether its attempt runs commands confined, the kind it is, and whether it blocks. */
const MATRIX: { name: string; tool: string; input: Record<string, unknown>; confined: boolean; cwd?: string; kind: RefusalKind; blocks: boolean }[] = [
  // On the safety floor.
  { name: "a push", tool: "Bash", input: { command: "git push origin main" }, confined: true, kind: "floor", blocks: true },
  { name: "a read of a sign-in folder", tool: "Bash", input: { command: "cat ~/.ssh/id_ed25519" }, confined: true, kind: "floor", blocks: true },
  { name: "a harmless read chained with sudo", tool: "Bash", input: { command: "ls src; sudo ls" }, confined: false, kind: "floor", blocks: true },
  // Network to a host that is not allowed: an agent's own network tool reaches any host, outside the confinement.
  { name: "a web fetch", tool: "WebFetch", input: { url: "https://example.com", prompt: "read" }, confined: true, kind: "network", blocks: true },
  { name: "a web search", tool: "WebSearch", input: { query: "botbench" }, confined: true, kind: "network", blocks: true },
  // A path outside the copy.
  { name: "a write outside the copy", tool: "Write", input: { file_path: "/tmp/elsewhere.txt", content: "x" }, confined: true, kind: "outside_copy", blocks: true },
  { name: "a read through ~", tool: "Read", input: { file_path: "~/.zshrc" }, confined: true, kind: "outside_copy", blocks: true },
  { name: "a write to git's own files in the copy", tool: "Write", input: { file_path: path.join(WORKTREE, ".git/hooks/pre-commit"), content: "x" }, confined: true, kind: "outside_copy", blocks: true },
  { name: "a search reaching out of the copy", tool: "Glob", input: { pattern: "../**/*.pem" }, confined: true, kind: "outside_copy", blocks: true },
  { name: "a file tool the gate does not name", tool: "MultiEdit", input: { file_path: "/etc/hosts", edits: [] }, confined: true, kind: "outside_copy", blocks: true },
  // An unconfined request.
  { name: "a command asking to leave the sandbox", tool: "Bash", input: { command: "npm test", dangerouslyDisableSandbox: true }, confined: true, kind: "unconfined", blocks: true },
  { name: "a read-only command asking to leave the sandbox", tool: "Bash", input: { command: "ls src", dangerouslyDisableSandbox: true }, confined: true, kind: "unconfined", blocks: true },
  { name: "a command of an attempt that is not confined", tool: "Bash", input: { command: "npm test" }, confined: false, kind: "unconfined", blocks: true },
  { name: "a read of a file outside the copy", tool: "Bash", input: { command: "cat ../other-task/notes.txt" }, confined: false, kind: "unconfined", blocks: true },
  { name: "a read that writes its output to a file", tool: "Bash", input: { command: "ls src > listing.txt" }, confined: false, kind: "unconfined", blocks: true },
  { name: "a read of a variable's path", tool: "Bash", input: { command: "cat $FILE" }, confined: false, kind: "unconfined", blocks: true },
  { name: "a git command that writes", tool: "Bash", input: { command: "git commit -m x" }, confined: false, kind: "unconfined", blocks: true },
  { name: "a search that runs a program on each file", tool: "Bash", input: { command: "rg --pre ./x.sh foo" }, confined: false, kind: "unconfined", blocks: true },
  { name: "a read after a cd", tool: "Bash", input: { command: "cd sub && ls" }, confined: false, kind: "unconfined", blocks: true },
  // A harmless read-only command, refused only because it could not be shown to run confined.
  { name: "ls of a folder", tool: "Bash", input: { command: "ls src", description: "List" }, confined: false, kind: "read_only", blocks: false },
  { name: "grep with a quoted ( and a glob, errors sent nowhere", tool: "Bash", input: { command: `grep -n "admit(" src/engine/*.ts 2>/dev/null` }, confined: false, kind: "read_only", blocks: false },
  { name: "git log piped to head", tool: "Bash", input: { command: "git log --oneline -5 | head -3" }, confined: false, kind: "read_only", blocks: false },
  { name: "cat of a file from a sub-folder", tool: "Bash", input: { command: "cat ../README.md" }, confined: false, cwd: path.join(WORKTREE, "sub"), kind: "read_only", blocks: false },
  // Any other refusal.
  { name: "a question for the owner", tool: "AskUserQuestion", input: { questions: [] }, confined: true, kind: "other", blocks: false },
  { name: "a to-do list", tool: "TodoWrite", input: { todos: [] }, confined: true, kind: "other", blocks: false },
];

test("the refusal matrix: each kind of refused request blocks the accept only when it was on the floor or would have left the confinement", () => {
  const seen = new Set<RefusalKind>();
  for (const row of MATRIX) {
    const cwd = row.cwd ?? WORKTREE;
    const verdict = gate({ tool: row.tool, input: row.input, worktree: WORKTREE, cwd, mode: "full", confined: row.confined }, [], { home: HOME });
    assert.equal(verdict.verdict, "refuse", `${row.name}: ${JSON.stringify(verdict)}`);
    if (verdict.verdict !== "refuse") continue;
    const kind = refusalKind({ tool: row.tool, input: row.input, worktree: WORKTREE, cwd, why: verdict.why, ...(verdict.floor === undefined ? {} : { floor: verdict.floor }) });
    assert.equal(kind, row.kind, `${row.name}: ${JSON.stringify(verdict)}`);
    assert.equal(refusalBlocksAccept(kind), row.blocks, row.name);
    seen.add(kind);
  }
  assert.deepEqual([...seen].sort(), [...REFUSAL_KINDS].sort(), "every kind has a row");
});

test("the rule itself: floor, network, outside the copy and unconfined block; read-only and any other do not; a refusal of no known kind blocks", () => {
  const blocks = Object.fromEntries(REFUSAL_KINDS.map((kind) => [kind, refusalBlocksAccept(kind)]));
  assert.deepEqual(blocks, { floor: true, network: true, outside_copy: true, unconfined: true, read_only: false, other: false });
  assert.equal(refusalBlocksAccept(null), true);
});

test("a request Botbench could not check or place is not harmless, whatever it says", () => {
  assert.equal(refusalKind({ tool: "Bash", input: { command: "ls" }, worktree: WORKTREE, cwd: WORKTREE, why: "unknown" }), "unconfined");
  assert.equal(refusalKind({ tool: "Bash", input: { command: "ls" }, worktree: null, cwd: "", why: "not_checked" }), "unconfined");
  assert.equal(refusalKind({ tool: "SomeTool", input: {}, worktree: null, cwd: "", why: "unknown" }), "unconfined");
  // A file tool whose folder was not reported is not known to stay inside the copy.
  assert.equal(refusalKind({ tool: "Write", input: { file_path: "a.txt" }, worktree: WORKTREE, cwd: WORKTREE, why: "not_checked" }), "outside_copy");
});

test("a read-only command is read from the folder the agent stood in, and only inside the copy", () => {
  assert.equal(readOnlyCommand("ls", WORKTREE, path.dirname(WORKTREE)), false, "standing outside the copy");
  assert.equal(readOnlyCommand("cat ../../x", WORKTREE, path.join(WORKTREE, "sub")), false);
  assert.equal(readOnlyCommand("git diff --output=/tmp/x", WORKTREE, WORKTREE), false);
  assert.equal(readOnlyCommand("git -C /etc status", WORKTREE, WORKTREE), false);
  assert.equal(readOnlyCommand("diff --to-file=/etc/hosts a", WORKTREE, WORKTREE), false);
  assert.equal(readOnlyCommand("echo $(id)", WORKTREE, WORKTREE), false);
  assert.equal(readOnlyCommand("FOO=1 ls", WORKTREE, WORKTREE), false);
  assert.equal(readOnlyCommand("git status --short && git diff --stat", WORKTREE, WORKTREE), true);
});
