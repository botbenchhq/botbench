import type { DatabaseSync } from "node:sqlite";
import { taskEvidence } from "./stations.ts";
import type { Task } from "./task.ts";

/*
 * Scope: which of the files a task changed its plan led one to expect, and which lie under a path the owner protects.
 * Botbench reads the files changed from the task's start commit to its head commit and marks each one. The marks are
 * shown on the task screen and decide what a mode may do on its own (engine/task.ts, `handOver`):
 *   - a file under a protected path (botbench.config.json, "protectedPaths") holds the task for the owner in every mode,
 *     with a reason naming the files, and a fully autonomous run never accepts it;
 *   - a file not expected from the plan stops a fully autonomous run from accepting the task on its own.
 * The owner still decides on either; neither mark refuses the owner's own Accept.
 *
 * The rule for "expected", which is a heuristic read from names alone. A changed file is expected when:
 *   1. the task's own words name it: a path-like word in its title and criteria (for a task started on its own, the
 *      owner's prompt) is the file's path, ends its path at a folder boundary ("engine/modes.ts", "modes.ts"), or is a
 *      folder it lies in ("test/recordings/", "web/src"). A path-like word holds a "/" or ends in an extension;
 *   2. a check that ran on the task names it the same way (a check `test -f hello.txt` expects hello.txt);
 *   3. it is a test file and the plan asks for a test (the word "test" or "tests"), or it shares its name, without the
 *      test markers and the extension, with a file expected by 1 or 2 (calc.test.ts beside calc.ts);
 *   4. a test file the plan or a check names (by 1 or 2, changed or not) shares its name with it, the same way: the
 *      named test leads one to expect the file it tests.
 * Only words the owner wrote or chose are read: the plan, the task's prompt and the configured checks. An issue's text,
 * the agents' replies and the contents of the changed files are never read for this, so nothing an agent writes can
 * make a file expected. A protected path is compared as a folder ("test/recordings/") or one exact file.
 */

/** One changed file with its marks. */
export interface FileScope {
  path: string;
  /** The plan, the checks or the task's tests lead one to expect it (the rule above). */
  expected: boolean;
  /** It lies under one of the protected paths. */
  protected: boolean;
}

/** The path-like words of a text: those holding a "/" or ending in an extension, without the quotes and punctuation around them. */
export function pathWords(text: string): string[] {
  const words: string[] = [];
  for (const raw of text.match(/[A-Za-z0-9_@.\-/]+/g) ?? []) {
    const word = raw.replace(/^(\.\/)+/, "").replace(/[.\-]+$/, "").replace(/\/+$/, "");
    if (word === "" || word === "." || word === "..") continue;
    if (raw.includes("/") || /\.[A-Za-z0-9]+$/.test(word)) words.push(word);
  }
  return words;
}

/** Whether a path-like word names the file: its path, its end at a folder boundary, or a folder it lies in. */
const names = (word: string, file: string): boolean => `/${file}/`.includes(`/${word}/`);

const TEST_FOLDER = /(^|\/)(test|tests|__tests__|spec|specs)\//;
const TEST_NAME = /(^test_|[._-](test|spec)\.[^/]+$|_test\.[^/]+$)/;

/** Whether a path is a test file: under a test folder, or named as one (calc.test.ts, calc_test.go, test_calc.py). */
export function isTestFile(file: string): boolean {
  const name = file.slice(file.lastIndexOf("/") + 1);
  return TEST_FOLDER.test(file) || TEST_NAME.test(name);
}

/** A file's name without its folder, its extensions and any test markers: "calc" for test/calc.test.ts and src/calc.ts. */
function stem(file: string): string {
  const name = file.slice(file.lastIndexOf("/") + 1);
  return name.replace(/^test_/, "").replace(/\..*$/, "").replace(/[._-](test|spec)$/, "");
}

/** Whether a file lies under one of the protected paths. */
export function isProtected(file: string, protectedPaths: readonly string[]): boolean {
  return protectedPaths.some((entry) => {
    const folder = entry.replace(/\/+$/, "");
    return file === folder || file.startsWith(`${folder}/`);
  });
}

/** Each changed file with its marks, by the rule above. `plan` is the task's own words; `checks` the check commands that ran on it. */
export function fileScope(o: { files: readonly string[]; plan: string; checks: readonly string[]; protectedPaths: readonly string[] }): FileScope[] {
  const words = [...pathWords(o.plan), ...o.checks.flatMap(pathWords)];
  const named = new Set(o.files.filter((file) => words.some((word) => names(word, file))));
  const asksForTests = /\btests?\b/i.test(o.plan);
  // A name with no stem (".gitignore", ".github/…") is linked to no other file.
  const namedStems = new Set([...named].map(stem).filter((s) => s !== ""));
  // A test the plan or a check names leads to the file it tests whether or not the test itself changed.
  const namedTests = [...[...named].filter(isTestFile), ...words.filter((word) => /\.[A-Za-z0-9]+$/.test(word) && isTestFile(word))];
  const namedTestStems = new Set(namedTests.map(stem).filter((s) => s !== ""));
  return o.files.map((file) => {
    const expected = named.has(file) || (isTestFile(file) ? asksForTests || namedStems.has(stem(file)) : namedTestStems.has(stem(file)));
    return { path: file, expected, protected: isProtected(file, o.protectedPaths) };
  });
}

/** The marks of a task's changed files, from its own words and the check commands recorded on it. */
export function taskScope(db: DatabaseSync, task: Task, files: readonly string[], protectedPaths: readonly string[]): FileScope[] {
  const checks = [...new Set(taskEvidence(db, task.id).filter((e) => e.kind === "check").map((e) => e.command))];
  return fileScope({ files, plan: task.prompt, checks, protectedPaths });
}

/** Files named in a sentence: the first 20, and how many more. */
export const listed = (files: readonly string[]): string => (files.length <= 20 ? files.join(", ") : `${files.slice(0, 20).join(", ")} and ${files.length - 20} more`);

const count = (n: number): string => (n === 1 ? "1 file" : `${n} files`);

/** Why a task that changed files under a protected path waits for the owner, naming them. */
export function protectedWords(files: readonly string[]): string {
  return `It changed ${count(files.length)} under a protected path, which only you can accept: ${listed(files)}.`;
}

/** Why a fully autonomous run did not accept a task that changed files its plan did not lead one to expect, naming them. */
export function unexpectedWords(files: readonly string[]): string {
  return `It changed ${count(files.length)} not expected from the plan: ${listed(files)}.`;
}
