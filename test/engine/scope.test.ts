import assert from "node:assert/strict";
import { test } from "node:test";
import { fileScope, isProtected, isTestFile, pathWords, protectedWords, unexpectedWords } from "../../src/engine/scope.ts";
import { taskPrompt } from "../../src/engine/roles.ts";

// The rule that marks a task's changed files (src/engine/scope.ts), on plans and file lists as a real task has them.

const marks = (plan: string, files: string[], o: { checks?: string[]; protectedPaths?: string[] } = {}): Record<string, string> =>
  Object.fromEntries(fileScope({ files, plan, checks: o.checks ?? [], protectedPaths: o.protectedPaths ?? [] }).map((f) => [f.path, `${f.expected ? "expected" : "unexpected"}${f.protected ? ", protected" : ""}`]));

test("path-like words are those with a slash or an extension, without the punctuation around them", () => {
  assert.deepEqual(pathWords('Edit "src/config.ts", then calc.py. Also ./web/src/ and test/recordings/; not words like plan or e'), ["src/config.ts", "calc.py", "web/src", "test/recordings"]);
});

test("a file the plan names by its path, its end, its name or a folder it is in is expected; any other is not", () => {
  const plan = taskPrompt({ title: "Mark files outside the plan", criteria: ["validated in src/config.ts", "a unit test in engine/reviewer-prompt.test.ts", "roles.ts asks the reviewer", "the task screen in web/ shows them"] });
  assert.deepEqual(marks(plan, ["src/config.ts", "test/engine/reviewer-prompt.test.ts", "src/engine/roles.ts", "web/src/screens/task.tsx", "src/server.ts", "config.ts.bak"]), {
    "src/config.ts": "expected",
    "test/engine/reviewer-prompt.test.ts": "expected",
    "src/engine/roles.ts": "expected",
    "web/src/screens/task.tsx": "expected",
    "src/server.ts": "unexpected",
    // A name is matched whole, at folder boundaries: config.ts does not name config.ts.bak.
    "config.ts.bak": "unexpected",
  });
});

test("a check that ran on the task names the files it expects", () => {
  assert.deepEqual(marks("Add a farewell file\n\nAcceptance criteria:\n- bye.txt exists", ["bye.txt", "hello.txt", "other.txt"], { checks: ["test -f hello.txt", "npm test"] }), { "bye.txt": "expected", "hello.txt": "expected", "other.txt": "unexpected" });
});

test("tests: a test file is expected when the plan asks for a test or it tests an expected file; a named test leads to the file it tests", () => {
  assert.deepEqual(marks("Add add(a, b) to calc.py", ["calc.py", "test_calc.py", "tests/test_other.py"]), { "calc.py": "expected", "test_calc.py": "expected", "tests/test_other.py": "unexpected" });
  assert.deepEqual(marks("Add add(a, b), with a test", ["calc.py", "test/calc.test.ts"]), { "calc.py": "unexpected", "test/calc.test.ts": "expected" });
  assert.deepEqual(marks("Make test/scope.test.ts pass", ["test/scope.test.ts", "src/engine/scope.ts", "src/engine/task.ts"]), { "test/scope.test.ts": "expected", "src/engine/scope.ts": "expected", "src/engine/task.ts": "unexpected" });
  // A test the plan names leads to its source file even when only the source changed.
  assert.deepEqual(marks("Make test/scope.test.ts pass", ["src/engine/scope.ts", "src/engine/task.ts"]), { "src/engine/scope.ts": "expected", "src/engine/task.ts": "unexpected" });
  // A file with no name before its extension is linked to nothing.
  assert.deepEqual(marks("Add .env.example, with a test", [".env.example", ".gitignore"]), { ".env.example": "expected", ".gitignore": "unexpected" });
  assert.ok(isTestFile("test/a.ts") && isTestFile("src/a.test.ts") && isTestFile("pkg/a_test.go") && isTestFile("test_a.py") && isTestFile("src/a.spec.tsx"));
  assert.ok(!isTestFile("src/attest.ts") && !isTestFile("src/latest.ts") && !isTestFile("contest/a.ts"));
});

test("a protected path is a folder or one exact file, and marks a file whether or not the plan expects it", () => {
  assert.ok(isProtected("test/recordings/a.json", ["test/recordings/"]));
  assert.ok(isProtected("test/recordings/sign-in/b.json", ["test/recordings"]));
  assert.ok(isProtected("LICENSE", ["LICENSE"]));
  assert.ok(!isProtected("test/recordings-old/a.json", ["test/recordings/"]));
  assert.ok(!isProtected("src/test/recordings/a.json", ["test/recordings/"]));
  assert.deepEqual(marks("Update test/recordings/a.json", ["test/recordings/a.json", "src/b.ts"], { protectedPaths: ["test/recordings/"] }), { "test/recordings/a.json": "expected, protected", "src/b.ts": "unexpected" });
});

test("the reasons name the files, and say how many more past twenty", () => {
  assert.equal(protectedWords(["test/recordings/a.json"]), "It changed 1 file under a protected path, which only you can accept: test/recordings/a.json.");
  assert.equal(unexpectedWords(["a.ts", "b.ts"]), "It changed 2 files not expected from the plan: a.ts, b.ts.");
  const many = Array.from({ length: 22 }, (_, i) => `f${i}.ts`);
  assert.match(unexpectedWords(many), /^It changed 22 files not expected from the plan: f0\.ts, .*, f19\.ts and 2 more\.$/);
});
