import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { gate, type GateRequest, type GateVerdict } from "../../src/approvals/gate.ts";
import type { Grant } from "../../src/approvals/grants.ts";
import { autoAccept, RUN_MODES, type RunMode } from "../../src/engine/modes.ts";

// The gate under the three modes (manual, semi-autonomous, fully autonomous). The gate is a pure function: the full
// matrix of mode × kind of request × confined or not × on the safety floor or not × allowed in advance or not is
// decided here without a process, a store or a model. What the broker does with each verdict, and broker failure, are
// tested in test/approvals/broker-modes.test.ts.

const WORKTREE = "/nonexistent-botbench/worktrees/run-1/task-1";
const HOME = "/nonexistent-botbench-home";
const REPO = "/nonexistent-botbench/repo";
const scope = { role: "implementer", repo: REPO, runId: 1 };
const grant = (words: string[]): Grant => ({ id: 7, kind: "preapproved", role: "implementer", repo: REPO, cwd: ".", words, runId: 1, taskId: 1, createdAt: "2026-11-22T10:00:00.000Z" });

/** The kinds of request, each with its input and what it is. */
const KINDS = {
  "plain command": { tool: "Bash", input: { command: "npm test", description: "Run the tests" }, shell: true, floor: false },
  "plain command on the floor": { tool: "Bash", input: { command: "git push origin main" }, shell: true, floor: true },
  "compound command": { tool: "Bash", input: { command: "ls src | head -5" }, shell: true, floor: false },
  "compound command on the floor": { tool: "Bash", input: { command: "cat notes.txt | sudo tee /etc/hosts" }, shell: true, floor: true },
  "command with a time limit": { tool: "Bash", input: { command: "npm test", timeout: 60_000 }, shell: true, floor: false },
  "command that asks to leave the sandbox": { tool: "Bash", input: { command: "npm test", dangerouslyDisableSandbox: true }, shell: true, floor: false, unconfinable: true },
  "delete outside the copy": { tool: "Bash", input: { command: "rm -rf ../other-task" }, shell: true, floor: true },
  "edit inside the copy": { tool: "Write", input: { file_path: path.join(WORKTREE, "src/a.ts"), content: "x" }, shell: false, floor: false, inside: true },
  "edit outside the copy": { tool: "Write", input: { file_path: "/tmp/elsewhere.txt", content: "x" }, shell: false, floor: false },
  "web fetch": { tool: "WebFetch", input: { url: "https://example.com", prompt: "read" }, shell: false, floor: false },
} as const satisfies Record<string, { tool: string; input: Record<string, unknown>; shell: boolean; floor: boolean; unconfinable?: boolean; inside?: boolean }>;
type Kind = keyof typeof KINDS;

const ask = (request: GateRequest, grants: Grant[] = []): GateVerdict => gate(request, grants, { home: HOME });

/** The rule the owner gave, written out once, independent of the gate's own code. */
function expected(mode: RunMode, kind: Kind, confined: boolean, preapproved: boolean): GateVerdict["verdict"] | "preapproved" | "mode" | "edit" {
  const k: { shell: boolean; floor: boolean; unconfinable?: boolean; inside?: boolean } = KINDS[kind];
  const nobody = mode === "full" ? "refuse" : "ask";
  if (k.inside) return "edit";
  if (!k.shell) return nobody;
  // The floor does not loosen: it asks in manual and semi-autonomous, and refuses in fully autonomous.
  if (k.floor) return nobody;
  // A grant matches only a plain command with nothing beside it.
  if (preapproved && kind === "plain command") return "preapproved";
  if (mode !== "manual" && confined && !k.unconfinable) return "mode";
  return nobody;
}

const outcome = (v: GateVerdict): string => (v.verdict === "allow" ? (v.rule === "preapproved" ? "preapproved" : v.rule === "mode_confined" ? "mode" : v.rule === "auto_worktree_edit" ? "edit" : v.rule) : v.verdict);

test("the matrix: every mode, kind of request, confinement, floor and pre-approval gets the verdict the modes promise", () => {
  let cases = 0;
  for (const mode of RUN_MODES) {
    for (const kind of Object.keys(KINDS) as Kind[]) {
      for (const confined of [true, false]) {
        for (const preapproved of [true, false]) {
          const { tool, input } = KINDS[kind];
          const grants = preapproved ? [grant(["npm", "test"]), grant(["git", "push", "origin", "main"]), grant(["ls"]), grant(["rm"])] : [];
          const verdict = ask({ tool, input, worktree: WORKTREE, cwd: WORKTREE, scope, mode, confined }, grants);
          assert.equal(outcome(verdict), expected(mode, kind, confined, preapproved), `${mode}, ${kind}, ${confined ? "confined" : "not confined"}, ${preapproved ? "allowed in advance" : "not allowed in advance"}: ${JSON.stringify(verdict)}`);
          cases++;
        }
      }
    }
  }
  assert.equal(cases, 3 * Object.keys(KINDS).length * 4);
});

test("without a mode the gate is the manual one: confinement alone lets nothing run", () => {
  for (const kind of ["plain command", "compound command"] as const) {
    const { tool, input } = KINDS[kind];
    assert.equal(ask({ tool, input, worktree: WORKTREE, cwd: WORKTREE, scope, confined: true }).verdict, "ask");
    assert.equal(ask({ tool, input, worktree: WORKTREE, cwd: WORKTREE, scope, mode: "manual", confined: true }).verdict, "ask");
  }
});

test("on the floor, semi-autonomous still names the rule it asks for, and fully autonomous refuses with a plain reason that names it", () => {
  const request = { tool: "Bash", input: { command: "git push origin main" }, worktree: WORKTREE, cwd: WORKTREE, scope, confined: true };
  assert.deepEqual(ask({ ...request, mode: "semi" }), { verdict: "ask", floor: "git-push" });
  const refused = ask({ ...request, mode: "full" });
  assert.equal(refused.verdict, "refuse");
  assert.ok(refused.verdict === "refuse" && refused.floor === "git-push");
  assert.match(refused.verdict === "refuse" ? refused.reason : "", /^This run is fully autonomous, so Botbench refuses what its safety rules would otherwise ask you about \(git-push\)\. It was not run\.$/);
});

test("fully autonomous refuses a tool that is not a command, and a command that cannot be shown to run confined, each saying so", () => {
  const web = ask({ tool: "WebFetch", input: { url: "https://example.com" }, worktree: WORKTREE, cwd: WORKTREE, scope, mode: "full", confined: true });
  assert.match(web.verdict === "refuse" ? web.reason : "", /^This run is fully autonomous, so nothing is put to you for approval, and WebFetch was refused\. It was not run\.$/);
  const loose = ask({ tool: "Bash", input: { command: "npm test" }, worktree: WORKTREE, cwd: WORKTREE, scope, mode: "full", confined: false });
  assert.match(loose.verdict === "refuse" ? loose.reason : "", /could not be shown to run kept away from your sign-ins and the network/);
});

test("a NUL in a command is refused as it always was, in every mode", () => {
  for (const mode of RUN_MODES) assert.equal(ask({ tool: "Bash", input: { command: "ls\0" }, worktree: WORKTREE, cwd: WORKTREE, scope, mode, confined: true }).verdict, "deny");
});

test("a fully autonomous run accepts only when every check passed, the review is satisfied or there is none, and nothing was refused", () => {
  assert.deepEqual(autoAccept({ checks: "passed", review: "none", refusals: [] }), { accept: true, reasons: "Accepted without you, as this run is fully autonomous: every check passed, this run has no reviewer, and nothing an agent asked for was refused." });
  assert.equal(autoAccept({ checks: "passed", review: "satisfied", refusals: [] }).accept, true);
  const no = (facts: Parameters<typeof autoAccept>[0]): string => {
    const verdict = autoAccept(facts);
    assert.equal(verdict.accept, false, JSON.stringify(facts));
    return verdict.accept ? "" : verdict.why;
  };
  assert.equal(no({ checks: "failed", review: "none", refusals: [] }), "It needs your review: A check failed.");
  assert.equal(no({ checks: "none", review: "none", refusals: [] }), "It needs your review: No checks ran on it.");
  assert.equal(no({ checks: null, review: "none", refusals: [] }), "It needs your review: No checks ran on it.");
  assert.equal(no({ checks: "passed", review: "unresolved", refusals: [] }), "It needs your review: The reviewer raised concerns.");
  assert.equal(no({ checks: "passed", review: "failed", refusals: [] }), "It needs your review: The review did not finish.");
  assert.equal(no({ checks: "passed", review: "none", refusals: ["git push origin HEAD"] }), "It needs your review: Botbench refused something an agent asked to do during this task (git push origin HEAD).");
  assert.equal(no({ checks: "failed", review: "unresolved", refusals: ["sudo ls", "WebFetch https://x"] }), "It needs your review: A check failed. The reviewer raised concerns. Botbench refused 2 things an agent asked to do during this task (sudo ls; WebFetch https://x).");
});
