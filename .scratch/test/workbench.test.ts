import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { openStore } from "../src/store/db.ts";
import { chooseWorkbench, deriveWorkbench, isOwnBranch, ownWorkbenches, parseTaskBranch, workbenchName, workbenchProblem } from "../src/workbench.ts";
import { tempDir } from "./support/repo.ts";

// The workbench's name (Peers P1): made from the host name, held to a pattern a git ref can carry, kept in the store.

test("a workbench name is made from the host name: its first label, lowercase letters, digits and hyphens, at most 30", () => {
  assert.equal(deriveWorkbench("Jons-MacBook-Pro.local"), "jons-macbook-pro");
  assert.equal(deriveWorkbench("Jon's MacBook Pro"), "jon-s-macbook-pro");
  assert.equal(deriveWorkbench("--ÉCOLE__mac--"), "cole-mac");
  assert.equal(deriveWorkbench("a".repeat(40)), "a".repeat(30));
  assert.equal(deriveWorkbench(`${"a".repeat(29)}-b`), "a".repeat(29), "no hyphen is left at the end after cutting");
  assert.equal(deriveWorkbench(""), "workbench");
  assert.equal(deriveWorkbench("..."), "workbench");
  assert.equal(deriveWorkbench("日本"), "workbench");
});

test("a workbench name is checked strictly: it becomes part of a git ref", () => {
  for (const good of ["a", "jons-mac", "dev2", "a".repeat(30), "a-b-c"]) assert.equal(workbenchProblem(good), null, good);
  for (const bad of ["", "A", "Jons-Mac", "-a", "a-", "a_b", "a.b", "a/b", "..", "a b", "a".repeat(31), "@{u}", "a\n", 7, null, undefined]) assert.notEqual(workbenchProblem(bad), null, String(bad));
});

test("task branches: the named form, the two older forms, and nothing else", () => {
  assert.deepEqual(parseTaskBranch("botbench/jons-mac/run-1/task-1"), { prefix: "botbench", workbench: "jons-mac", run: "run-1", task: "task-1" });
  assert.deepEqual(parseTaskBranch("botbench/run-4/task-5"), { prefix: "botbench", workbench: null, run: "run-4", task: "task-5" });
  assert.deepEqual(parseTaskBranch("smelt/run-4/task-5"), { prefix: "smelt", workbench: null, run: "run-4", task: "task-5" });
  assert.deepEqual(parseTaskBranch("botbench/dev2/run-4/task-5-2"), { prefix: "botbench", workbench: "dev2", run: "run-4", task: "task-5-2" }, "a name taken already gets a number");
  for (const bad of [
    "botbench/../x",
    "botbench/a/../task-1",
    "botbench/Dev2/run-1/task-1",
    `botbench/${"a".repeat(31)}/run-1/task-1`,
    "botbench/dev2/run-1/task-1/more",
    "botbench/run-1",
    "botbench/dev2-run-4-task-5",
    "botbench//run-1/task-1",
    "botbench/run-1/task-1/",
    "smelt/dev2/run-1/task-1",
    "Botbench/run-1/task-1",
    "refs/heads/botbench/run-1/task-1",
    "botbench/-a/run-1/task-1",
    "botbench/dev2/-run/task-1",
    "botbench/dev2/run-1/task.lock",
    "botbench/dev2/run 1/task-1",
    "main",
    "",
  ]) assert.equal(parseTaskBranch(bad), null, bad);
});

test("the name is made once and kept; a change keeps the earlier names as this installation's own, and another workbench's branch is never its own", (t) => {
  const dir = tempDir("botbench-workbench-test-");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const home = path.join(dir, "home");
  let db = openStore(home);
  assert.equal(workbenchName(db, () => "Alices-Mac.local"), "alices-mac");
  assert.equal(workbenchName(db, () => "another-host"), "alices-mac", "never changes by itself");
  db.close();
  db = openStore(home);
  t.after(() => db.close());
  assert.equal(workbenchName(db, () => "another-host"), "alices-mac", "kept in the data folder across a restart");

  assert.throws(() => chooseWorkbench(db, "Not/Valid", "owner"), /lowercase letters, digits and hyphens/);
  chooseWorkbench(db, "alice", "owner");
  assert.equal(workbenchName(db), "alice");
  assert.deepEqual([...ownWorkbenches(db)].sort(), ["alice", "alices-mac"]);
  assert.ok(isOwnBranch(db, "botbench/alice/run-1/task-1"));
  assert.ok(isOwnBranch(db, "botbench/alices-mac/run-1/task-1"), "a branch made before the rename");
  assert.ok(isOwnBranch(db, "botbench/run-1/task-1"), "a branch made before workbenches had names");
  assert.ok(isOwnBranch(db, "smelt/run-1/task-1"));
  assert.equal(isOwnBranch(db, "botbench/bob/run-1/task-1"), false, "another workbench's");
  assert.equal(isOwnBranch(db, "botbench/../alice"), false);
  assert.throws(() => db.prepare("DELETE FROM workbench_names").run(), /append-only/);
  assert.throws(() => db.prepare("UPDATE workbench_names SET name = 'bob'").run(), /append-only/);
  assert.throws(() => db.prepare("INSERT INTO workbench_names (name, source, chosen_at) VALUES ('Bad/Name', 'owner', 'x')").run(), /CHECK/);
});
