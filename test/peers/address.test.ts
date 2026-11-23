import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { DEFAULT_CONFIG_FILE, loadConfig } from "../../src/config.ts";
import { joinHostPort, peerAddressProblem, splitHostPort } from "../../src/peers/address.ts";
import { startServer } from "../../src/server.ts";

// Where the peer listener may listen (ADR 0004 decision 1): loopback, RFC 1918, RFC 4193 and 100.64.0.0/10 only.
// Only the address check runs here: no test binds anything but loopback.

test("loopback, every RFC 1918 range, RFC 4193 and the carrier-grade range are accepted", () => {
  for (const address of ["127.0.0.1", "127.255.255.254", "::1", "10.0.0.1", "10.255.255.255", "172.16.0.1", "172.31.255.254", "192.168.0.1", "192.168.255.255", "fc00::1", "fd12:3456:789a::1", "fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff", "100.64.0.1", "100.127.255.254", "100.100.100.100"]) {
    assert.equal(peerAddressProblem(address), null, address);
  }
});

test("public IPv4 and IPv6, every-address, the edges of each range, link-local, mapped forms and host names are refused", () => {
  const refused = [
    "8.8.8.8", "1.1.1.1", "172.15.255.255", "172.32.0.1", "192.167.255.255", "192.169.0.1", "100.63.255.255", "100.128.0.1", "11.0.0.1", "169.254.1.1",
    "2001:4860:4860::8888", "2606:4700::1111", "fe80::1", "fe00::1", "fe80::1%en0",
    "0.0.0.0", "::", "::0", "::ffff:10.0.0.1", "::ffff:127.0.0.1",
    "localhost", "mac.tailnet.ts.net", "example.com", "", " 127.0.0.1", "127.0.0.1 ", "127.0.0.1:4790",
  ];
  for (const address of refused) assert.notEqual(peerAddressProblem(address), null, address);
  assert.notEqual(peerAddressProblem(undefined), null);
  assert.notEqual(peerAddressProblem(4790), null);
  assert.match(peerAddressProblem("8.8.8.8")!, /not a loopback or private address/);
  assert.match(peerAddressProblem("localhost")!, /not an IP address/);
});

test("a listener's address and port are written and read back in one form, with brackets for IPv6", () => {
  assert.equal(joinHostPort("127.0.0.1", 4790), "127.0.0.1:4790");
  assert.equal(joinHostPort("fd00::1", 4790), "[fd00::1]:4790");
  assert.deepEqual(splitHostPort("127.0.0.1:4790"), { address: "127.0.0.1", port: 4790 });
  assert.deepEqual(splitHostPort("[fd00::1]:4790"), { address: "fd00::1", port: 4790 });
  for (const bad of ["8.8.8.8:4790", "[2001:db8::1]:1", "127.0.0.1", "127.0.0.1:0", "127.0.0.1:65536", "127.0.0.1:04790", "fd00::1:4790", "localhost:4790", "127.0.0.1:4790/x", 4790]) {
    assert.equal(splitHostPort(bad), null, String(bad));
  }
});

function settingsFile(t: { after(fn: () => void): void }, content: unknown): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "botbench-peer-settings-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "botbench.local.json");
  fs.writeFileSync(file, JSON.stringify(content));
  return file;
}

test("the settings file turns the listener on only with an accepted address; a public one stops the start with the file and the setting named", (t) => {
  assert.equal(loadConfig({ defaults: DEFAULT_CONFIG_FILE }).peers, undefined, "off when absent");
  const on = settingsFile(t, { peers: { listen: { address: "127.0.0.1", port: 4790 } } });
  assert.deepEqual(loadConfig({ defaults: DEFAULT_CONFIG_FILE, local: on }).peers, { listen: { address: "127.0.0.1", port: 4790 } });
  for (const address of ["0.0.0.0", "::", "8.8.8.8", "2001:4860:4860::8888", "localhost"]) {
    const file = settingsFile(t, { peers: { listen: { address, port: 4790 } } });
    assert.throws(() => loadConfig({ defaults: DEFAULT_CONFIG_FILE, local: file }), (err: Error) => {
      assert.ok(err.message.startsWith(`${file}: "peers.listen.address" cannot be used, so Botbench did not start.`), err.message);
      return true;
    }, address);
  }
  for (const [peers, setting] of [[{ listen: { address: "127.0.0.1", port: 70000 } }, "peers.listen.port"], [{ listen: { address: "127.0.0.1", port: 0 } }, "peers.listen.port"], [{ listen: { address: "127.0.0.1", port: 1, extra: 1 } }, "peers.listen"], [{ other: 1 }, "peers"], ["on", "peers"]] as const) {
    const file = settingsFile(t, { peers });
    assert.throws(() => loadConfig({ defaults: DEFAULT_CONFIG_FILE, local: file }), (err: Error) => err.message.startsWith(`${file}: "${setting}"`), setting);
  }
});

test("a config handed to the server in code with a public peer address stops the start before anything opens", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "botbench-peer-start-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  await assert.rejects(startServer({ config: { port: 0, listen: ["127.0.0.1"], drivers: { "claude-code": {} }, roles: {}, peers: { listen: { address: "0.0.0.0", port: 0 } } }, home: path.join(home, "data") }), /"peers\.listen\.address" cannot be used/);
  assert.equal(fs.existsSync(path.join(home, "data")), false, "no data folder was made");
});
