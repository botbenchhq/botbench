import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { DEFAULT_CONFIG_FILE, loadConfig, smeltHome } from "../src/config.ts";

/** Write real config files into a temporary directory and return their paths. */
function configFiles(t: { after(fn: () => void): void }, defaults: unknown, local?: unknown): { defaults: string; local: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "smelt-config-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const files = { defaults: path.join(dir, "smelt.config.json"), local: path.join(dir, "smelt.local.json") };
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

test("the data directory is ~/.smelt unless SMELT_HOME says otherwise", () => {
  assert.equal(smeltHome({}), path.join(os.homedir(), ".smelt"));
  assert.equal(smeltHome({ SMELT_HOME: "/tmp/elsewhere" }), "/tmp/elsewhere");
  assert.equal(smeltHome({ SMELT_HOME: "" }), path.join(os.homedir(), ".smelt"));
});

test("a role that names an unknown driver is rejected, naming the role and the file", (t) => {
  const files = configFiles(t, BASE, { roles: { reviewer: { driver: "copilot" } } });
  assert.throws(() => loadConfig(files), (err: Error) => {
    assert.match(err.message, /role "reviewer"/);
    assert.match(err.message, /unknown driver "copilot"/);
    assert.match(err.message, /claude-code, codex, gemini-cli, grok/);
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

test("all four known driver names are accepted", (t) => {
  const drivers = { "claude-code": {}, codex: {}, "gemini-cli": {}, grok: {} };
  const roles = { a: { driver: "claude-code" }, b: { driver: "codex" }, c: { driver: "gemini-cli" }, d: { driver: "grok" } };
  const files = configFiles(t, { ...BASE, drivers, roles });
  assert.deepEqual(loadConfig(files).drivers, drivers);
});

test("malformed values are rejected with the setting's name", (t) => {
  assert.throws(() => loadConfig(configFiles(t, BASE, { port: "4780" })), /"port" must be a whole number from 0 to 65535/);
  assert.throws(() => loadConfig(configFiles(t, BASE, { port: 70000 })), /"port"/);
  assert.throws(() => loadConfig(configFiles(t, BASE, { listen: [] })), /"listen" must be a non-empty list of addresses/);
  assert.throws(() => loadConfig(configFiles(t, BASE, { listen: "127.0.0.1" })), /"listen"/);
  assert.throws(() => loadConfig(configFiles(t, BASE, { roles: { planner: "claude-code" } })), /role "planner" must be an object with a "driver"/);
  assert.throws(() => loadConfig(configFiles(t, BASE, { drivers: { codex: { model: 5 } } })), /driver "codex": "model" must be a string/);
});

test("a config file that is not a JSON object is rejected, naming the file", (t) => {
  const broken = configFiles(t, BASE, "{ not json");
  assert.throws(() => loadConfig(broken), (err: Error) => err.message.includes(broken.local));
  const list = configFiles(t, "[1, 2]");
  assert.throws(() => loadConfig(list), (err: Error) => err.message.includes(list.defaults) && /must be a JSON object/.test(err.message));
  const missing = path.join(os.tmpdir(), "smelt-no-such-dir", "smelt.config.json");
  assert.throws(() => loadConfig({ defaults: missing }), (err: Error) => err.message.includes(missing));
});

test("SMELT_HOME is resolved to an absolute path, and a leading ~ means the home directory", async () => {
  const { smeltHome } = await import("../src/config.ts");
  const os = await import("node:os");
  const path = await import("node:path");
  assert.equal(smeltHome({ SMELT_HOME: "relative/dir" }), path.resolve("relative/dir"));
  assert.equal(smeltHome({ SMELT_HOME: "~/elsewhere" }), path.join(os.homedir(), "elsewhere"));
  assert.equal(smeltHome({}), path.join(os.homedir(), ".smelt"));
});

test("publicHosts is a list of host names: absent by default in a file, overridden by the local file, rejected when malformed", (t) => {
  assert.deepEqual(loadConfig({ defaults: DEFAULT_CONFIG_FILE }).publicHosts, [], "the shipped default names no HTTPS host");
  assert.deepEqual(loadConfig(configFiles(t, BASE, { publicHosts: ["mac.tailnet.ts.net"] })).publicHosts, ["mac.tailnet.ts.net"]);
  assert.deepEqual(loadConfig(configFiles(t, { ...BASE, publicHosts: ["a.example"] }, { publicHosts: [] })).publicHosts, []);
  for (const bad of ["mac.tailnet.ts.net", [7], [""], ["https://mac.tailnet.ts.net"], ["mac.tailnet.ts.net/path"], ["two names"], { name: "x" }, null]) {
    assert.throws(() => loadConfig(configFiles(t, BASE, { publicHosts: bad })), /"publicHosts" must be a list of host names/, JSON.stringify(bad));
  }
});
