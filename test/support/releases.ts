import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { git, initRepo, ownerCommit, write } from "./repo.ts";

/*
 * What an update reads and fetches, for tests.
 *
 * GitHub's latest-release answer: test/fixtures/github-release/release-please-action-latest.json is the real response
 * of GET https://api.github.com/repos/googleapis/release-please-action/releases/latest, captured once (23 November
 * 2026), a release made by release-please as Botbench's are. Botbench has published no release yet, so a test serves
 * that response from a real HTTP server with only the fields that name the release (tag, notes, address) set to the
 * test repository's own tag: every other field is as GitHub sent it.
 *
 * The repository: a real git repository acting as GitHub's, with real commits and real tags, fetched with the real git.
 */

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const CAPTURED = path.join(ROOT, "test", "fixtures", "github-release", "release-please-action-latest.json");

export interface ReleaseServer {
  url: string;
  /** How many requests it was sent, and the headers of the last. */
  requests: { path: string; headers: http.IncomingHttpHeaders }[];
  /** Publish a release (the tag, its notes), or none (404, as GitHub answers before the first). */
  publish(release: { tag: string; notes: string } | null): void;
  close(): Promise<void>;
}

export async function startReleaseServer(): Promise<ReleaseServer> {
  const captured = JSON.parse(fs.readFileSync(CAPTURED, "utf8")) as Record<string, unknown>;
  let current: { tag: string; notes: string } | null = null;
  const requests: ReleaseServer["requests"] = [];
  const server = http.createServer((req, res) => {
    requests.push({ path: req.url ?? "", headers: req.headers });
    if (req.url !== "/repos/jon-lange/botbench/releases/latest" || current === null) {
      res.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ message: "Not Found", documentation_url: "https://docs.github.com/rest/releases/releases#get-the-latest-release", status: "404" }));
      return;
    }
    const body = { ...captured, tag_name: current.tag, name: current.tag, body: current.notes, html_url: `https://github.com/jon-lange/botbench/releases/tag/${current.tag}` };
    res.writeHead(200, { "content-type": "application/json; charset=utf-8" }).end(JSON.stringify(body));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/repos/jon-lange/botbench/releases/latest`,
    requests,
    publish: (r) => (current = r),
    close: () => new Promise((resolve) => (server.closeAllConnections(), server.close(() => resolve()))),
  };
}

/** Notes as release-please writes them. */
export const notesFor = (version: string, line: string): string =>
  `## [${version}](https://github.com/jon-lange/botbench/compare/v0.1.0...v${version}) (2026-11-24)\n\n\n### Features\n\n* ${line} ([#200](https://github.com/jon-lange/botbench/issues/200)) ([1a2b3c4](https://github.com/jon-lange/botbench/commit/1a2b3c4d5e6f))\n`;

/** Set package.json's version (and the lockfile's, when there is one) in a checkout. */
export function bumpVersion(dir: string, version: string): void {
  for (const file of ["package.json", "package-lock.json"]) {
    const full = path.join(dir, file);
    if (!fs.existsSync(full)) continue;
    const json = JSON.parse(fs.readFileSync(full, "utf8")) as { version?: string; packages?: Record<string, { version?: string }> };
    json.version = version;
    if (json.packages?.[""] !== undefined) json.packages[""].version = version;
    fs.writeFileSync(full, `${JSON.stringify(json, null, 2)}\n`);
  }
}

/** Commit everything in `dir` and tag it `tag`. Returns the commit. */
export function commitAndTag(dir: string, message: string, tag: string): string {
  const commit = ownerCommit(dir, message);
  git(dir, "-c", "user.name=Owner", "-c", "user.email=owner@example.invalid", "tag", "-a", "-m", tag, tag);
  return commit;
}

/** A small repository with a package.json at `version` and nothing else to install. */
export function smallRepo(dir: string, version: string): string {
  initRepo(dir, { "package.json": `${JSON.stringify({ name: "sample", version, private: true }, null, 2)}\n` });
  return git(dir, "rev-parse", "HEAD").trim();
}

/**
 * A repository holding this checkout's files as they are now (tracked and new, not ignored), on main, at its version:
 * Botbench itself as the repository an installation is cloned from.
 */
export function botbenchRepo(dir: string): string {
  const files = execFileSync("git", ["-C", ROOT, "ls-files", "-z", "--cached", "--others", "--exclude-standard"], { encoding: "utf8" }).split("\0").filter((f) => f !== "" && fs.existsSync(path.join(ROOT, f)));
  fs.mkdirSync(dir, { recursive: true });
  git(dir, "init", "--quiet", "-b", "main");
  for (const file of files) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.copyFileSync(path.join(ROOT, file), path.join(dir, file));
  }
  return ownerCommit(dir, "Botbench as it is");
}

export { write };
