import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { LOGIN_TOKEN_FILE } from "../../src/api/auth.ts";
import type { Config } from "../../src/config.ts";
import { startServer } from "../../src/server.ts";
import { initRepo, tempDir } from "../support/repo.ts";

// Settings → Execution environments shows, for each repository of the settings file, the setup and check commands
// Botbench runs there itself. Over real HTTP against a real server with a real temporary repository; no driver starts.

test("GET /api/settings lists each repository's setup and check commands as the settings file gives them, in order, and none for a repository that names none; without a session it answers 401", async (t) => {
  const dir = tempDir("botbench-settings-commands-");
  const home = path.join(dir, "home");
  const checked = path.join(dir, "checked");
  const plain = path.join(dir, "plain");
  initRepo(checked);
  initRepo(plain);
  const config: Config = {
    port: 0,
    listen: ["127.0.0.1"],
    drivers: { "claude-code": {} },
    roles: {},
    repositories: {
      [checked]: { setup: ["npm ci"], checks: ["npm run typecheck", { command: "npm test", timeoutSeconds: 900 }], machineChecks: [{ command: "npm run e2e", needs: ["chrome"] }], execution: { kind: "container", image: "node:24" } },
      [plain]: {},
    },
  };
  const server = await startServer({ config, home, signInDelayMs: 1 });
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.port}`;

  const refused = await fetch(`${base}/api/settings`);
  await refused.arrayBuffer();
  assert.equal(refused.status, 401);

  const token = fs.readFileSync(path.join(home, LOGIN_TOKEN_FILE), "utf8").trim();
  const signedIn = await fetch(`${base}/api/sign-in`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token }) });
  await signedIn.arrayBuffer();
  const res = await fetch(`${base}/api/settings`, { headers: { cookie: signedIn.headers.getSetCookie()[0]!.split(";")[0]! } });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { repositories: unknown[] };
  assert.deepEqual(body.repositories, [
    { path: checked, execution: { kind: "container", image: "node:24" }, setup: ["npm ci"], checks: ["npm run typecheck", "npm test", "npm run e2e"] },
    { path: plain, execution: { kind: "host" }, setup: [], checks: [] },
  ]);
});
