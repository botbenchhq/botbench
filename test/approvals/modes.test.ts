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
/** Where the CLI saves this attempt's long tool output (src/drivers/claude-code.ts). */
const SESSION_OUTPUT = path.join(HOME, ".claude", "projects", "-nonexistent-botbench-worktrees-run-1-task-1", "4c1d8a52-7d0e-4a8b-9f43-2a51d3b1c6e0", "tool-results");
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
  // Shapes the builder used in run 3 of the self-review, each asked about there (by a round of fixes admitted unconfined).
  "loop over files with a pipe": { tool: "Bash", input: { command: "for f in docs/a.md docs/b.md; do sed -n 23p,32p $f | cut -c1-600; echo ----; done; sed -n 90,110p src/push.ts", description: "Read flagged lines" }, shell: true, floor: false },
  "perl editing a file in place, then counting": { tool: "Bash", input: { command: "perl -0pi -e 's/old/new/' docs/review.md; f=docs/review.md; wc -l $f; awk '/^## 1/{f=1;next}f&&NF' $f | wc -l; git status --short", description: "Apply corrections" }, shell: true, floor: false },
  "python editing a file from a here-document": { tool: "Bash", input: { command: "python3 - <<'PY'\np='docs/review.md'\ns=open(p).read().replace('a','b')\nopen(p,'w').write(s)\nPY\nwc -l docs/review.md; git status --short", description: "Apply the three review fixes" }, shell: true, floor: false },
  "sed into grep": { tool: "Bash", input: { command: "sed -n 1,40p README.md | grep -n Botbench" }, shell: true, floor: false },
  "chained command with a push in it": { tool: "Bash", input: { command: "sed -n 1,5p README.md; git push origin HEAD" }, shell: true, floor: true },
  "chained command that reads a guarded place": { tool: "Bash", input: { command: "for f in ~/.ssh/*; do cat $f; done" }, shell: true, floor: true },
  "subagent": { tool: "Agent", input: { description: "audit", prompt: "Audit the code", run_in_background: true }, shell: false, floor: false },
  "wakeup": { tool: "ScheduleWakeup", input: { delaySeconds: 1200, reason: "fallback", prompt: "continue" }, shell: false, floor: false },
  // Shapes the owner saw asked about in a Semi-autonomous run that read an issue, each read-only and confined.
  "grep with \\| alternation": { tool: "Bash", input: { command: `grep -n "startServer\\|createBroker" src/server.ts`, description: "Find" }, shell: true, floor: false },
  "grep with a quoted ( and a glob": { tool: "Bash", input: { command: `grep -n "admit(" src/engine/*.ts` }, shell: true, floor: false },
  "command ending in 2>/dev/null": { tool: "Bash", input: { command: "ls src 2>/dev/null" }, shell: true, floor: false },
  "for loop testing that paths exist": { tool: "Bash", input: { command: `for f in src/a.ts docs/b.md; do test -e "$f" && echo "$f yes" || echo "$f no"; done` }, shell: true, floor: false },
  "sed -n": { tool: "Bash", input: { command: "sed -n '1,40p' src/approvals/gate.ts" }, shell: true, floor: false },
  // One plain command that begins with a word the matrix allows in advance (`ls`): a grant covers it.
  "ls of a folder named security": { tool: "Bash", input: { command: "ls docs/security" }, shell: true, floor: false, granted: true },
  "the keychain tool by its name": { tool: "Bash", input: { command: "security find-generic-password -s x" }, shell: true, floor: true },
  "a program named by a quoted variable": { tool: "Bash", input: { command: `ls; "$PROGRAM" src` }, shell: true, floor: true },
  "a substitution inside double quotes": { tool: "Bash", input: { command: `echo "$(sudo ls)" | wc -l` }, shell: true, floor: true },
  "edit inside the copy from a sub-folder": { tool: "Edit", input: { file_path: "deeper/a.ts", old_string: "a", new_string: "b" }, cwd: path.join(WORKTREE, "sub"), shell: false, floor: false, inside: true },
  "edit outside the copy from a sub-folder": { tool: "Write", input: { file_path: "../../elsewhere.txt", content: "x" }, cwd: path.join(WORKTREE, "sub"), shell: false, floor: false },
  "read of this session's saved output": { tool: "Read", input: { file_path: path.join(SESSION_OUTPUT, "toolu_01.txt") }, shell: false, floor: false, savedOutput: true },
  "read of another session's saved output": { tool: "Read", input: { file_path: path.join(SESSION_OUTPUT, "..", "..", "other-session", "tool-results", "toolu_01.txt") }, shell: false, floor: false },
  "read elsewhere in the CLI's folder": { tool: "Read", input: { file_path: path.join(HOME, ".claude", "settings.json") }, shell: false, floor: false },
} as const satisfies Record<string, { tool: string; input: Record<string, unknown>; shell: boolean; floor: boolean; unconfinable?: boolean; inside?: boolean; cwd?: string; savedOutput?: boolean; granted?: boolean }>;
type Kind = keyof typeof KINDS;

const ask = (request: GateRequest, grants: Grant[] = []): GateVerdict => gate(request, grants, { home: HOME });

/** The rule the owner gave, written out once, independent of the gate's own code. */
function expected(mode: RunMode, kind: Kind, confined: boolean, preapproved: boolean): GateVerdict["verdict"] | "preapproved" | "mode" | "edit" | "saved output" {
  const k: { shell: boolean; floor: boolean; unconfinable?: boolean; inside?: boolean; savedOutput?: boolean; granted?: boolean } = KINDS[kind];
  const nobody = mode === "full" ? "refuse" : "ask";
  // An edit inside the copy and a read of the session's own saved output run in every mode, confined or not.
  if (k.inside) return "edit";
  if (k.savedOutput) return "saved output";
  if (!k.shell) return nobody;
  // The floor does not loosen: it asks in manual and semi-autonomous, and refuses in fully autonomous.
  if (k.floor) return nobody;
  // A grant matches only a plain command with nothing beside it.
  if (preapproved && (kind === "plain command" || k.granted === true)) return "preapproved";
  if (mode !== "manual" && confined && !k.unconfinable) return "mode";
  return nobody;
}

const outcome = (v: GateVerdict): string => (v.verdict === "allow" ? (v.rule === "preapproved" ? "preapproved" : v.rule === "mode_confined" ? "mode" : v.rule === "auto_worktree_edit" ? "edit" : v.rule === "session_output_read" ? "saved output" : v.rule) : v.verdict);
/** The request of a kind, as the matrix puts it: from the folder the kind names, with the session's saved-output folder known. */
const requestOf = (kind: Kind) => {
  const k: { tool: string; input: Record<string, unknown>; cwd?: string } = KINDS[kind];
  return { tool: k.tool, input: k.input, worktree: WORKTREE, cwd: k.cwd ?? WORKTREE, sessionOutput: SESSION_OUTPUT };
};

test("the matrix: every mode, kind of request, confinement, floor and pre-approval gets the verdict the modes promise", () => {
  let cases = 0;
  for (const mode of RUN_MODES) {
    for (const kind of Object.keys(KINDS) as Kind[]) {
      for (const confined of [true, false]) {
        for (const preapproved of [true, false]) {
          const grants = preapproved ? [grant(["npm", "test"]), grant(["git", "push", "origin", "main"]), grant(["ls"]), grant(["rm"])] : [];
          const verdict = ask({ ...requestOf(kind), scope, mode, confined }, grants);
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
  assert.deepEqual(ask({ ...request, mode: "semi" }), { verdict: "ask", floor: "git-push", why: "floor" });
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

// A run that read outside text (a GitHub issue, engine/intake.ts): no pre-approved command and no standing permission
// applies to it, in any mode; what a mode lets run because it is confined still runs; the floor still asks (or refuses).
const standing = (words: string[]): Grant => ({ id: 8, kind: "standing", role: "implementer", repo: REPO, cwd: ".", words, runId: null, taskId: 3, createdAt: "2026-11-22T10:00:00.000Z" });

function expectedOutside(mode: RunMode, kind: Kind, confined: boolean): ReturnType<typeof expected> {
  // Exactly the rule without any grant: whatever was allowed in advance counts for nothing.
  return expected(mode, kind, confined, false);
}

test("the matrix for a run that read outside text: no grant of either kind applies in any mode, confinement still lets a mode run a command, the floor still holds", () => {
  let cases = 0;
  for (const mode of RUN_MODES) {
    for (const kind of Object.keys(KINDS) as Kind[]) {
      for (const confined of [true, false]) {
        for (const grants of [[], [grant(["npm", "test"]), grant(["ls"])], [standing(["npm", "test"]), standing(["ls"])]] as Grant[][]) {
          const request = { ...requestOf(kind), scope, mode, confined };
          const verdict = ask({ ...request, outsideText: true }, grants);
          assert.equal(outcome(verdict), expectedOutside(mode, kind, confined), `outside text, ${mode}, ${kind}, ${confined ? "confined" : "not confined"}, ${grants[0]?.kind ?? "no grant"}: ${JSON.stringify(verdict)}`);
          cases++;
        }
      }
    }
  }
  assert.equal(cases, 3 * Object.keys(KINDS).length * 6);
  // The same request and grants without the mark: the grants do apply, so the mark is what made the difference.
  const plain = { tool: "Bash", input: { command: "npm test" }, worktree: WORKTREE, cwd: WORKTREE, scope, mode: "manual" as const, confined: false };
  assert.equal(outcome(ask(plain, [standing(["npm", "test"])])), "standing");
  assert.equal(outcome(ask(plain, [grant(["npm", "test"])])), "preapproved");
  assert.equal(outcome(ask({ ...plain, outsideText: true }, [standing(["npm", "test"])])), "ask");
  assert.equal(outcome(ask({ ...plain, outsideText: true }, [grant(["npm", "test"])])), "ask");
});
