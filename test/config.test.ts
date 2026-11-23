import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { DEFAULT_CONFIG_FILE, loadConfig, maxRefineRounds, offerStandingAfter, repositoryCommands, repositoryDelivery, repositoryHosts, repositoryProtectedPaths, botbenchHome, silenceLimitMs, usageLimitWaitMs } from "../src/config.ts";

/** Write real config files into a temporary directory and return their paths. */
function configFiles(t: { after(fn: () => void): void }, defaults: unknown, local?: unknown): { defaults: string; local: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "botbench-config-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const files = { defaults: path.join(dir, "botbench.config.json"), local: path.join(dir, "botbench.local.json") };
  fs.writeFileSync(files.defaults, typeof defaults === "string" ? defaults : JSON.stringify(defaults));
  if (local !== undefined) fs.writeFileSync(files.local, typeof local === "string" ? local : JSON.stringify(local));
  return files;
}

const BASE = {
  port: 4780,
  listen: ["127.0.0.1"],
  drivers: { "claude-code": {} },
  roles: { implementer: { driver: "claude-code" } },
};

test("the shipped defaults load: port 4780, loopback only, every role on a known driver", () => {
  const config = loadConfig({ defaults: DEFAULT_CONFIG_FILE });
  assert.equal(config.port, 4780);
  assert.deepEqual(config.listen, ["127.0.0.1"]);
  assert.ok(Object.keys(config.roles).length > 0);
  for (const role of Object.values(config.roles)) assert.ok(role.driver in config.drivers);
});

test("protected paths: this repository protects test/recordings/; a list at the top and one per repository are merged", (t) => {
  assert.deepEqual(loadConfig({ defaults: DEFAULT_CONFIG_FILE }).protectedPaths, ["test/recordings/"]);
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "botbench-config-repo-"));
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  const config = loadConfig(configFiles(t, { ...BASE, protectedPaths: ["test/recordings/", "LICENSE"], repositories: { [repo]: { protectedPaths: ["docs/adr/", "LICENSE"] } } }));
  assert.deepEqual(repositoryProtectedPaths(config, repo), ["test/recordings/", "LICENSE", "docs/adr/"]);
  assert.deepEqual(repositoryProtectedPaths(config, "/elsewhere"), ["test/recordings/", "LICENSE"]);
  assert.deepEqual(repositoryProtectedPaths(loadConfig(configFiles(t, BASE)), repo), []);
});

test("protected paths that are not paths inside the repository are refused, saying what one looks like", (t) => {
  const rule = /must be a list of paths inside the repository, such as \["test\/recordings\/", "package-lock\.json"\]/;
  for (const bad of ["test/recordings/", ["/etc/passwd"], ["../outside"], ["a/../b"], ["test/*.json"], [""], ["a//b"], [3], ["a\\b"], ["./a"]]) {
    assert.throws(() => loadConfig(configFiles(t, { ...BASE, protectedPaths: bad })), (err: Error) => /"protectedPaths" /.test(err.message) && rule.test(err.message), JSON.stringify(bad));
  }
  assert.throws(() => loadConfig(configFiles(t, { ...BASE, repositories: { "/r": { protectedPaths: ["/abs"] } } })), /repository "\/r": "protectedPaths" holds "\/abs", which cannot be used/);
});

test("defaults load unchanged when there is no local file", (t) => {
  const files = configFiles(t, BASE);
  assert.deepEqual(loadConfig(files), BASE);
});

test("a local config file overrides defaults key by key and keeps the rest", (t) => {
  const files = configFiles(t, BASE, {
    port: 5999,
    listen: ["127.0.0.1", "100.64.0.7"],
    drivers: { codex: { model: "gpt-mini" } },
    roles: { reviewer: { driver: "codex" } },
  });
  assert.deepEqual(loadConfig(files), {
    port: 5999,
    listen: ["127.0.0.1", "100.64.0.7"],
    drivers: { "claude-code": {}, codex: { model: "gpt-mini" } },
    roles: { implementer: { driver: "claude-code" }, reviewer: { driver: "codex" } },
  });
});

test("the data directory is ~/.botbench unless BOTBENCH_HOME says otherwise", () => {
  assert.equal(botbenchHome({}), path.join(os.homedir(), ".botbench"));
  assert.equal(botbenchHome({ BOTBENCH_HOME: "/tmp/elsewhere" }), "/tmp/elsewhere");
  assert.equal(botbenchHome({ BOTBENCH_HOME: "" }), path.join(os.homedir(), ".botbench"));
});

test("a role that names an unknown driver is rejected, naming the role and the file", (t) => {
  const files = configFiles(t, BASE, { roles: { reviewer: { driver: "copilot" } } });
  assert.throws(() => loadConfig(files), (err: Error) => {
    assert.match(err.message, /role "reviewer"/);
    assert.match(err.message, /unknown driver "copilot"/);
    assert.match(err.message, /claude-code, codex, gemini-cli, grok, antigravity/);
    assert.ok(err.message.includes(files.local), "names the file the value came from");
    return true;
  });
});

test("an unknown driver name in the drivers map is rejected, naming the map and the file", (t) => {
  const files = configFiles(t, { ...BASE, drivers: { "claude-code": {}, cursor: {} } });
  assert.throws(() => loadConfig(files), (err: Error) => {
    assert.match(err.message, /"drivers"/);
    assert.match(err.message, /unknown driver "cursor"/);
    assert.ok(err.message.includes(files.defaults));
    return true;
  });
});

test("a role that names a known driver missing from the drivers map is rejected", (t) => {
  const files = configFiles(t, BASE, { roles: { planner: { driver: "grok" } } });
  assert.throws(() => loadConfig(files), /role "planner" uses driver "grok", which is not in "drivers"/);
});

test("all five known driver names are accepted", (t) => {
  const drivers = { "claude-code": {}, codex: {}, "gemini-cli": {}, grok: {}, antigravity: {} };
  const roles = { a: { driver: "claude-code" }, b: { driver: "codex" }, c: { driver: "gemini-cli" }, d: { driver: "grok" }, e: { driver: "antigravity" } };
  const files = configFiles(t, { ...BASE, drivers, roles });
  assert.deepEqual(loadConfig(files).drivers, drivers);
});

test("Codex cannot be set as the builder or the planner, and says why; it can be set as the reviewer", (t) => {
  const drivers = { "claude-code": {}, codex: {} };
  assert.throws(() => loadConfig(configFiles(t, { ...BASE, drivers, roles: { implementer: { driver: "codex" } } })), /role "implementer": Codex cannot be the builder: in Botbench it cannot ask you for permission or edit files/);
  assert.throws(() => loadConfig(configFiles(t, { ...BASE, drivers, roles: { planner: { driver: "codex" } } })), /role "planner": Codex cannot be the planner/);
  assert.equal(loadConfig(configFiles(t, { ...BASE, drivers, roles: { reviewer: { driver: "codex" } } })).roles.reviewer?.driver, "codex");
});

test("Grok and Antigravity cannot be set as the builder or the planner, and say why; each can be set as the reviewer", (t) => {
  for (const [driver, name] of [["grok", "Grok"], ["antigravity", "Antigravity"]] as const) {
    const drivers = { "claude-code": {}, [driver]: {} };
    assert.throws(() => loadConfig(configFiles(t, { ...BASE, drivers, roles: { implementer: { driver } } })), new RegExp(`role "implementer": ${name} cannot be the builder`));
    assert.throws(() => loadConfig(configFiles(t, { ...BASE, drivers, roles: { planner: { driver } } })), new RegExp(`role "planner": ${name} cannot be the planner`));
    assert.equal(loadConfig(configFiles(t, { ...BASE, drivers, roles: { reviewer: { driver } } })).roles.reviewer?.driver, driver);
  }
});

test("malformed values are rejected with the setting's name", (t) => {
  assert.throws(() => loadConfig(configFiles(t, BASE, { port: "4780" })), /"port" must be a whole number from 0 to 65535/);
  assert.throws(() => loadConfig(configFiles(t, BASE, { port: 70000 })), /"port"/);
  assert.throws(() => loadConfig(configFiles(t, BASE, { listen: [] })), /"listen" must be a non-empty list of addresses/);
  assert.throws(() => loadConfig(configFiles(t, BASE, { listen: "127.0.0.1" })), /"listen"/);
  assert.throws(() => loadConfig(configFiles(t, BASE, { roles: { planner: "claude-code" } })), /role "planner" must be an object with a "driver"/);
  assert.throws(() => loadConfig(configFiles(t, BASE, { drivers: { codex: { model: 5 } } })), /driver "codex": "model"/);
});

test("a config file that is not a JSON object is rejected, naming the file", (t) => {
  const broken = configFiles(t, BASE, "{ not json");
  assert.throws(() => loadConfig(broken), (err: Error) => err.message.includes(broken.local));
  const list = configFiles(t, "[1, 2]");
  assert.throws(() => loadConfig(list), (err: Error) => err.message.includes(list.defaults) && /must be a JSON object/.test(err.message));
  const missing = path.join(os.tmpdir(), "botbench-no-such-dir", "botbench.config.json");
  assert.throws(() => loadConfig({ defaults: missing }), (err: Error) => err.message.includes(missing));
});

test("BOTBENCH_HOME is resolved to an absolute path, and a leading ~ means the home directory", async () => {
  const { botbenchHome } = await import("../src/config.ts");
  const os = await import("node:os");
  const path = await import("node:path");
  assert.equal(botbenchHome({ BOTBENCH_HOME: "relative/dir" }), path.resolve("relative/dir"));
  assert.equal(botbenchHome({ BOTBENCH_HOME: "~/elsewhere" }), path.join(os.homedir(), "elsewhere"));
  assert.equal(botbenchHome({}), path.join(os.homedir(), ".botbench"));
});

test("publicHosts is a list of host names: absent by default in a file, overridden by the local file, rejected when malformed", (t) => {
  assert.deepEqual(loadConfig({ defaults: DEFAULT_CONFIG_FILE }).publicHosts, [], "the shipped default names no HTTPS host");
  assert.deepEqual(loadConfig(configFiles(t, BASE, { publicHosts: ["mac.tailnet.ts.net"] })).publicHosts, ["mac.tailnet.ts.net"]);
  assert.deepEqual(loadConfig(configFiles(t, { ...BASE, publicHosts: ["a.example"] }, { publicHosts: [] })).publicHosts, []);
  for (const bad of ["mac.tailnet.ts.net", [7], [""], ["https://mac.tailnet.ts.net"], ["mac.tailnet.ts.net/path"], ["two names"], { name: "x" }, null]) {
    assert.throws(() => loadConfig(configFiles(t, BASE, { publicHosts: bad })), /"publicHosts" must be a list of host names/, JSON.stringify(bad));
  }
});

test("a model may be set for a role and for a driver, and a driver may list its models; each must be a plain model name", (t) => {
  const config = loadConfig(configFiles(t, BASE, { drivers: { "claude-code": { model: "sonnet", models: ["sonnet", "claude-haiku-4-5-20251001"] } }, roles: { implementer: { driver: "claude-code", model: "haiku" } } }));
  assert.deepEqual(config.drivers["claude-code"], { model: "sonnet", models: ["sonnet", "claude-haiku-4-5-20251001"] });
  assert.deepEqual(config.roles.implementer, { driver: "claude-code", model: "haiku" });
  // The shipped list is only what `claude --help` itself names, for when the CLI reports no list.
  assert.deepEqual(loadConfig({ defaults: DEFAULT_CONFIG_FILE }).drivers["claude-code"], { models: ["fable", "opus", "sonnet"] });
  assert.throws(() => loadConfig(configFiles(t, BASE, { drivers: { "claude-code": { model: "--bare" } } })), /driver "claude-code": "model".*model name/);
  assert.throws(() => loadConfig(configFiles(t, BASE, { drivers: { "claude-code": { models: "haiku" } } })), /driver "claude-code": "models" must be a list/);
  assert.throws(() => loadConfig(configFiles(t, BASE, { drivers: { "claude-code": { models: ["haiku", "-p"] } } })), /driver "claude-code": "models".*model name/);
  assert.throws(() => loadConfig(configFiles(t, BASE, { roles: { implementer: { driver: "claude-code", model: "hai ku" } } })), /role "implementer": "model".*model name/);
});

test("a repository's settings are keyed by its full path: lists of plain commands, and extra entries for the safety floor", (t) => {
  const repositories = { "/Users/owner/code/sample": { preapproved: ["npm test", "sh make-marker.sh"], setup: ["npm ci"], checks: ["npm test"] }, "/Users/owner/code/bare": {} };
  const floor = [{ name: "no-publish", command: "npm publish" }];
  const config = loadConfig(configFiles(t, { ...BASE, repositories, floor }));
  assert.deepEqual(config.repositories, repositories);
  assert.deepEqual(config.floor, floor);
  assert.equal(loadConfig(configFiles(t, BASE)).repositories, undefined);
  // The owner's local file adds repositories and keeps the ones it does not name.
  const merged = loadConfig(configFiles(t, { ...BASE, repositories }, { repositories: { "/Users/owner/code/other": { preapproved: ["make"] } } }));
  assert.deepEqual(Object.keys(merged.repositories ?? {}), ["/Users/owner/code/sample", "/Users/owner/code/bare", "/Users/owner/code/other"]);

  const refused: [unknown, RegExp][] = [
    [{ repositories: [] }, /"repositories" must be an object keyed by the full path/],
    [{ repositories: { "code/sample": {} } }, /"code\/sample".*full path/],
    [{ repositories: { "/r": [] } }, /repository "\/r" must be an object/],
    [{ repositories: { "/r": { preapproved: "npm test" } } }, /repository "\/r": "preapproved" must be a list of commands/],
    [{ repositories: { "/r": { preapproved: ["npm test && ls"] } } }, /repository "\/r": "preapproved".*"npm test && ls".*one plain command/],
    [{ repositories: { "/r": { preapproved: [""] } } }, /repository "\/r": "preapproved".*empty/],
    [{ repositories: { "/r": { setup: [7] } } }, /repository "\/r": "setup" must be a list of commands/],
    [{ repositories: { "/r": { checks: "npm test" } } }, /repository "\/r": "checks" must be a list of commands/],
    [{ repositories: { "/r": { preaproved: [] } } }, /repository "\/r" has unknown setting "preaproved"/],
    [{ floor: {} }, /"floor" must be a list/],
    [{ floor: [{ name: "x" }] }, /"floor".*"name" and a "command"/],
    [{ floor: [{ name: "", command: "npm publish" }] }, /"floor".*"name" and a "command"/],
    [{ floor: [{ name: "git-push", command: "npm publish" }] }, /"floor".*"git-push".*built-in/],
    [{ floor: [{ name: "x", command: "npm publish | cat" }] }, /"floor".*"x".*one plain command/],
  ];
  for (const [over, words] of refused) assert.throws(() => loadConfig(configFiles(t, { ...BASE, ...(over as object) })), words, JSON.stringify(over));
});

test("the number of approvals after which a card offers standing permission is 3 as shipped, can be set by the owner, and must be a whole number of at least 1", (t) => {
  // Changed with the refine loop: the shipped settings name its cap too.
  assert.deepEqual(loadConfig({ defaults: DEFAULT_CONFIG_FILE }).autonomy, { offerStandingAfter: 3, mode: "manual", maxRefineRounds: 2, silenceLimitSeconds: 600, usageLimitWaitSeconds: 1800 });
  assert.equal(offerStandingAfter(loadConfig({ defaults: DEFAULT_CONFIG_FILE })), 3);
  // A config that says nothing of it still means 3.
  const silent = loadConfig(configFiles(t, BASE));
  assert.equal(silent.autonomy, undefined);
  assert.equal(offerStandingAfter(silent), 3);
  assert.equal(offerStandingAfter(loadConfig(configFiles(t, { ...BASE, autonomy: {} }))), 3);
  // The owner's local file sets it and keeps everything else.
  const local = loadConfig(configFiles(t, { ...BASE, autonomy: { offerStandingAfter: 3 } }, { autonomy: { offerStandingAfter: 5 } }));
  assert.equal(offerStandingAfter(local), 5);
  assert.equal(local.port, 4780);
  assert.equal(offerStandingAfter(loadConfig(configFiles(t, { ...BASE, autonomy: { offerStandingAfter: 1 } }))), 1);

  const refused: [unknown, RegExp][] = [
    [{ autonomy: [] }, /"autonomy" must be an object/],
    [{ autonomy: 3 }, /"autonomy" must be an object/],
    [{ autonomy: { offerStandingAfter: 0 } }, /"autonomy.offerStandingAfter" must be a whole number of at least 1/],
    [{ autonomy: { offerStandingAfter: -2 } }, /"autonomy.offerStandingAfter" must be a whole number of at least 1/],
    [{ autonomy: { offerStandingAfter: 1.5 } }, /"autonomy.offerStandingAfter" must be a whole number of at least 1/],
    [{ autonomy: { offerStandingAfter: "3" } }, /"autonomy.offerStandingAfter" must be a whole number of at least 1/],
    [{ autonomy: { offerStandingAfter: null } }, /"autonomy.offerStandingAfter" must be a whole number of at least 1/],
    [{ autonomy: { offerStandingAfter: 1e21 } }, /"autonomy.offerStandingAfter" must be a whole number of at least 1/],
    [{ autonomy: { offerStandingAfte: 3 } }, /"autonomy" has unknown setting "offerStandingAfte"/],
  ];
  for (const [over, words] of refused) assert.throws(() => loadConfig(configFiles(t, { ...BASE, ...(over as object) })), words, JSON.stringify(over));
});

test("the mode a new run is given is manual as shipped, the owner may set semi or full, and nothing else is a mode", (t) => {
  assert.equal(loadConfig({ defaults: DEFAULT_CONFIG_FILE }).autonomy?.mode, "manual");
  assert.equal(loadConfig(configFiles(t, { ...BASE, autonomy: { mode: "full" } })).autonomy?.mode, "full");
  for (const mode of ["yolo", "", null, 1, "Semi"]) assert.throws(() => loadConfig(configFiles(t, { ...BASE, autonomy: { mode } })), /"autonomy.mode" must be "manual", "semi" or "full"/, JSON.stringify(mode));
});

test("a repository's setup and check commands are each a command, or a command with its own time limit in seconds; the limit is 10 minutes when none is given", (t) => {
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "botbench-config-repo-")));
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  const config = loadConfig(configFiles(t, { ...BASE, repositories: { [repo]: { setup: ["npm ci", { command: "make deps", timeoutSeconds: 90 }], checks: [{ command: "npm test" }] } } }));
  assert.deepEqual(repositoryCommands(config, repo), {
    setup: [{ command: "npm ci", limitMs: 600_000 }, { command: "make deps", limitMs: 90_000 }],
    checks: [{ command: "npm test", limitMs: 600_000 }],
  });
  assert.deepEqual(repositoryCommands(config, "/somewhere/else"), { setup: [], checks: [] });

  const refused: [unknown, RegExp][] = [
    [{ setup: [{ timeoutSeconds: 5 }] }, /repository "\/r": "setup".*"command"/],
    [{ setup: [{ command: "" }] }, /repository "\/r": "setup".*empty/],
    [{ setup: [{ command: "npm ci", timeoutSeconds: 0 }] }, /repository "\/r": "setup".*"timeoutSeconds".*whole number of seconds from 1 to 86400/],
    [{ checks: [{ command: "npm test", timeoutSeconds: 1.5 }] }, /repository "\/r": "checks".*"timeoutSeconds"/],
    [{ checks: [{ command: "npm test", timeoutSeconds: 100000 }] }, /repository "\/r": "checks".*"timeoutSeconds"/],
    [{ checks: [{ command: "npm test", timeoutSeconds: "60" }] }, /repository "\/r": "checks".*"timeoutSeconds"/],
    [{ checks: [{ command: "npm test", timeout: 60 }] }, /repository "\/r": "checks".*unknown.*"timeout"/],
  ];
  for (const [over, words] of refused) assert.throws(() => loadConfig(configFiles(t, { ...BASE, repositories: { "/r": over } })), words, JSON.stringify(over));
});

test("a repository's allowed hosts are plain host names its commands may reach; anything else is refused, naming the repository, the setting and the value", (t) => {
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "botbench-config-repo-")));
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  const config = loadConfig(configFiles(t, { ...BASE, repositories: { [repo]: { allowedHosts: ["registry.npmjs.org", "github.com"] } } }));
  assert.deepEqual(repositoryHosts(config, repo), ["registry.npmjs.org", "github.com"]);
  assert.deepEqual(repositoryHosts(config, "/somewhere/else"), [], "no network for a repository that allows none");
  assert.deepEqual(repositoryHosts(loadConfig(configFiles(t, { ...BASE, repositories: { [repo]: { setup: ["npm ci"] } } })), repo), []);

  const refused: [unknown, RegExp][] = [
    [{ allowedHosts: "github.com" }, /repository "\/r": "allowedHosts" must be a list of host names/],
    [{ allowedHosts: ["*.npmjs.org"] }, /repository "\/r": "allowedHosts" holds "\*\.npmjs\.org", which cannot be used\. .*plain host name/],
    [{ allowedHosts: ["github.com", "https://github.com"] }, /repository "\/r": "allowedHosts" holds "https:\/\/github\.com"/],
    [{ allowedHosts: ["github.com:443"] }, /"allowedHosts" holds "github\.com:443"/],
    [{ allowedHosts: ["localhost"] }, /"allowedHosts" holds "localhost"/],
    [{ allowedHosts: ["127.0.0.1"] }, /"allowedHosts" holds "127\.0\.0\.1"/],
    [{ allowedHosts: [7] }, /"allowedHosts" holds 7/],
  ];
  for (const [over, words] of refused) assert.throws(() => loadConfig(configFiles(t, { ...BASE, repositories: { "/r": over } })), words, JSON.stringify(over));
});

test("a repository may name the remote and base branch of its pull requests; origin and the default branch otherwise; anything that could read as an option or is Botbench's own branch is refused", (t) => {
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "botbench-config-repo-")));
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  assert.deepEqual(repositoryDelivery(loadConfig(configFiles(t, { ...BASE, repositories: { [repo]: { remote: "upstream", baseBranch: "release/1.2" } } })), repo), { remote: "upstream", baseBranch: "release/1.2" });
  assert.deepEqual(repositoryDelivery(loadConfig(configFiles(t, BASE)), repo), { remote: "origin", baseBranch: null });
  const refused: [unknown, RegExp][] = [
    [{ remote: "--mirror" }, /"remote" must be the name of one of the repository's remotes/],
    [{ remote: "../x" }, /"remote" must be/],
    [{ remote: 7 }, /"remote" must be/],
    [{ baseBranch: "-main" }, /"baseBranch" must be a branch name/],
    [{ baseBranch: "botbench/run-1/task-1" }, /not one of Botbench's own/],
    [{ baseBranch: "a..b" }, /"baseBranch" must be/],
  ];
  for (const [over, words] of refused) assert.throws(() => loadConfig(configFiles(t, { ...BASE, repositories: { "/r": over } })), words, JSON.stringify(over));
});

test("the cap on rounds of fixes after a review is 2 as shipped and when unset, can be set by the owner, and must be a whole number from 0 to 5", (t) => {
  assert.equal(maxRefineRounds(loadConfig({ defaults: DEFAULT_CONFIG_FILE })), 2);
  assert.equal(maxRefineRounds(loadConfig(configFiles(t, BASE))), 2);
  for (const good of [0, 1, 5]) assert.equal(maxRefineRounds(loadConfig(configFiles(t, { ...BASE, autonomy: { maxRefineRounds: good } }))), good);
  for (const bad of [-1, 6, 1.5, "2", null]) {
    assert.throws(() => loadConfig(configFiles(t, { ...BASE, autonomy: { maxRefineRounds: bad } })), /"autonomy\.maxRefineRounds" must be a whole number from 0 to 5/, String(bad));
  }
});

test("the silence limit is 600 seconds as shipped and when unset, 0 turns it off, and anything but a whole number of seconds from 0 to 86,400 is refused at start", (t) => {
  assert.equal(silenceLimitMs(loadConfig({ defaults: DEFAULT_CONFIG_FILE })), 600_000);
  assert.equal(silenceLimitMs(loadConfig(configFiles(t, BASE))), 600_000);
  assert.equal(silenceLimitMs(loadConfig(configFiles(t, { ...BASE, autonomy: {} }))), 600_000);
  for (const good of [0, 1, 90, 86_400]) assert.equal(silenceLimitMs(loadConfig(configFiles(t, { ...BASE, autonomy: { silenceLimitSeconds: good } }))), good * 1000, String(good));
  // The owner's local file sets it and keeps the rest of the shipped autonomy settings.
  const local = loadConfig(configFiles(t, { ...BASE, autonomy: { maxRefineRounds: 1 } }, { autonomy: { silenceLimitSeconds: 0 } }));
  assert.equal(silenceLimitMs(local), 0);
  assert.equal(local.autonomy?.maxRefineRounds, 1);
  for (const bad of [-1, -600, 1.5, 0.1, "600", null, true, [600], { seconds: 600 }, 86_401, Number.NaN, 1e21]) {
    assert.throws(() => loadConfig(configFiles(t, { ...BASE, autonomy: { silenceLimitSeconds: bad } })), /"autonomy\.silenceLimitSeconds" must be a whole number of seconds from 0 to 86400: how long a builder or planner may send nothing while it works before Botbench stops it\. 0 turns the limit off\./, String(bad));
  }
});

test("the wait after a usage limit with no reset time is 1800 seconds as shipped and when unset, can be set by the owner, and anything but a whole number of seconds from 1 to 86,400 is refused at start", (t) => {
  assert.equal(usageLimitWaitMs(loadConfig({ defaults: DEFAULT_CONFIG_FILE })), 1_800_000);
  assert.equal(usageLimitWaitMs(loadConfig(configFiles(t, BASE))), 1_800_000);
  assert.equal(usageLimitWaitMs(loadConfig(configFiles(t, { ...BASE, autonomy: {} }))), 1_800_000);
  for (const good of [1, 60, 3600, 86_400]) assert.equal(usageLimitWaitMs(loadConfig(configFiles(t, { ...BASE, autonomy: { usageLimitWaitSeconds: good } }))), good * 1000, String(good));
  // The owner's local file sets it and keeps the rest of the shipped autonomy settings.
  const local = loadConfig(configFiles(t, { ...BASE, autonomy: { silenceLimitSeconds: 90 } }, { autonomy: { usageLimitWaitSeconds: 600 } }));
  assert.equal(usageLimitWaitMs(local), 600_000);
  assert.equal(local.autonomy?.silenceLimitSeconds, 90);
  for (const bad of [0, -1, 1.5, "1800", null, true, [1800], { seconds: 1800 }, 86_401, Number.NaN, 1e21]) {
    assert.throws(() => loadConfig(configFiles(t, { ...BASE, autonomy: { usageLimitWaitSeconds: bad } })), /"autonomy\.usageLimitWaitSeconds" must be a whole number of seconds from 1 to 86400: how long Botbench waits before it tries a builder again once its usage limit was reached, when the agent gives no time it resets\./, String(bad));
  }
});

test("the settings file may name the workbench; a name a git ref could not carry is refused, saying why", (t) => {
  assert.equal(loadConfig(configFiles(t, BASE, { workbench: "jons-mac" })).workbench, "jons-mac");
  for (const bad of ["Jons-Mac", "a/b", "../x", "", 3]) assert.throws(() => loadConfig(configFiles(t, BASE, { workbench: bad })), /"workbench" must be a workbench name\. A workbench name is 1 to 30 lowercase letters/, String(bad));
});
