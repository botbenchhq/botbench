import crypto from "node:crypto";
import path from "node:path";

/**
 * The launch arguments of Claude Code attempts of every kind (their settings object included) and the argv of setup
 * and check commands (confinedStart), as built by the source tree at `root`, for fixed places that do not exist, with
 * the two paths that depend on where the tree lies (node, the permission hook's script) written as <node> and <proxy>;
 * and its SHA-256. Run with HOME set to a place that does not exist, so the secret places are the same on every Mac.
 * The host kind's digest was taken from the code before the container kind (ADR 0009), so a test can hold it unchanged.
 */
export async function launchFingerprint(root: string): Promise<{ digest: string; normalized: string }> {
  const { claudeArgs } = await import(path.join(root, "src/drivers/claude-code.ts"));
  const { confinedStart } = await import(path.join(root, "src/engine/stations.ts"));
  const { PROXY_SCRIPT } = await import(path.join(root, "src/approvals/permission-proxy.ts"));
  const DATA = "/nonexistent-data/botbench";
  const CWD = `${DATA}/worktrees/run-1/task-1`;
  const place = { cwd: CWD, dataDir: DATA, allowedHosts: [] as string[], gitDir: "/nonexistent-repo/.git" };
  const kinds = [
    {},
    { allowEdits: true },
    { allowEdits: true, gated: true, instructionsFile: "/nonexistent-data/instructions.md" },
    { readOnly: true, gated: true },
    { gated: true },
    { model: "haiku", resumeCursor: "5a850a06-92af-40cd-8cde-1c4435399134", allowEdits: true, gated: true },
  ];
  const launches = [...kinds.map((k) => claudeArgs({ confinement: place, ...k })), claudeArgs({ confinement: { ...place, allowedHosts: ["registry.npmjs.org"] }, allowEdits: true, gated: true })];
  const starts = [null, 4321].map((proxyPort) => confinedStart({ command: "npm test\necho 'done'", worktree: CWD, dataDir: DATA, tmp: "/nonexistent-tmp/own", proxyPort }).argv);
  const json = (s: string): string => JSON.stringify(s).slice(1, -1);
  const normalized = JSON.stringify({ launches, starts }).replaceAll(json(process.execPath), "<node>").replaceAll(json(PROXY_SCRIPT), "<proxy>");
  return { digest: crypto.createHash("sha256").update(normalized).digest("hex"), normalized };
}
