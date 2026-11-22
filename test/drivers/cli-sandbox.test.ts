import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { SANDBOX_EXEC } from "../../src/confinement.ts";
import { makeReviewFolder, neutralizeMentions, removeLeftoverReviewFolders, wholeCliProfile } from "../../src/drivers/cli-sandbox.ts";
import { tempDir } from "../support/repo.ts";

// Real sandbox-exec, real files; no CLI of a vendor is started here.

test("the whole-CLI profile denies reading every listed place but the CLI's own folders and the review folder, and writing anywhere but those and the temporary folder", (t) => {
  const dir = fs.realpathSync(tempDir("botbench-cli-sandbox-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const data = path.join(dir, "data");
  const own = path.join(dir, "own");
  const review = path.join(data, "reviewers", "r1");
  // Not in the temporary folder, which stays writable: beside this checkout, removed afterwards.
  const outside = path.resolve(import.meta.dirname, "..", "..", `.cli-sandbox-probe-${process.pid}`);
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  for (const d of [data, own, review, outside]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(data, "decoy.txt"), "DECOY\n");
  fs.writeFileSync(path.join(own, "own.txt"), "OWN\n");
  const profile = wholeCliProfile({ unreadable: [data, own], readable: [own, review], writable: [own, review] });
  const sh = (script: string) => spawnSync(SANDBOX_EXEC, ["-p", profile, "/bin/sh", "-c", script], { encoding: "utf8" });
  assert.notEqual(sh(`cat ${data}/decoy.txt`).status, 0, "a denied place cannot be read");
  assert.equal(sh(`cat ${own}/own.txt`).stdout, "OWN\n", "the CLI's own folder is opened again for it");
  assert.equal(sh(`echo x > ${review}/a && cat ${review}/a`).stdout, "x\n", "the review folder is readable and writable");
  assert.notEqual(sh(`echo x > ${outside}/b`).status, 0);
  assert.equal(fs.existsSync(path.join(outside, "b")), false, "nothing is written outside the allowed places");
  assert.equal(sh(`echo x > ${os.tmpdir()}/botbench-cli-sandbox-probe-$$ && echo ok`).stdout.trim(), "ok", "the temporary folder stays writable");
  assert.match(profile, /\(deny lsopen\)/);
  assert.doesNotMatch(profile, /deny network/, "the CLI must reach its own provider");
});

test("a path that could break out of the profile is refused", () => {
  assert.throws(() => wholeCliProfile({ unreadable: ['/tmp/a"b'], readable: [], writable: [] }), /quote/);
});

test("every @ in a prompt is written as a full-width ＠, so no CLI reads it as a file to attach; nothing else changes", () => {
  assert.equal(neutralizeMentions("see @/etc/hosts and @!.env, mail a@b.c"), "see ＠/etc/hosts and ＠!.env, mail a＠b.c");
  assert.equal(neutralizeMentions("no mention"), "no mention");
});

test("a review folder is new, empty, the owner's alone, inside the data folder, and is removed by its own cleanup", () => {
  const data = tempDir("botbench-review-folder-");
  const folder = makeReviewFolder(data);
  assert.equal(path.dirname(path.dirname(folder.path)), fs.realpathSync(data));
  assert.deepEqual(fs.readdirSync(folder.path), []);
  assert.equal(fs.statSync(folder.path).mode & 0o777, 0o700);
  assert.notEqual(makeReviewFolder(data).path, folder.path);
  folder.remove();
  folder.remove();
  assert.equal(fs.existsSync(folder.path), false);
  fs.rmSync(data, { recursive: true, force: true });
});

test("at start, review folders a stopped Botbench left in its data folder are removed, and nothing else there is touched", () => {
  const data = tempDir("botbench-review-leftovers-");
  const left = makeReviewFolder(data);
  fs.mkdirSync(path.join(left.path, ".agents", "agents"), { recursive: true });
  fs.writeFileSync(path.join(left.path, ".agents", "agents", "botbench-review.md"), "x");
  fs.writeFileSync(path.join(data, "keep.txt"), "keep");
  assert.equal(removeLeftoverReviewFolders(data), 1);
  assert.deepEqual(fs.readdirSync(path.join(data, "reviewers")), []);
  assert.equal(fs.readFileSync(path.join(data, "keep.txt"), "utf8"), "keep");
  assert.equal(removeLeftoverReviewFolders(path.join(data, "never-made")), 0, "a data folder with no review folders is fine");
  fs.rmSync(data, { recursive: true, force: true });
});
