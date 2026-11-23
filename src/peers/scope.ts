import path from "node:path";
import { fileURLToPath } from "node:url";
import { repositoryDelivery, type Config } from "../config.ts";
import { githubRepoOf, repoName } from "../github.ts";
import { remoteAddress } from "../worktrees.ts";
import { repositoryProblem } from "./envelope.ts";

/*
 * The scope of a pairing (Peers P5, ADR 0004 decision 5): one repository, named by its delivery remote, which both
 * owners' copies share. On GitHub that is `host/owner/name`; for a bare repository on this Mac it is the remote's path
 * as git has it. The one field that names a pairing's scope; nothing else about a repository is sent to a peer.
 */

/** The repository a local copy is paired on, by its delivery remote, or why it cannot be paired. */
export async function pairingScope(config: Config, repo: string): Promise<{ repository: string } | { problem: string }> {
  const { remote } = repositoryDelivery(config, repo);
  let address: Awaited<ReturnType<typeof remoteAddress>>;
  try {
    address = await remoteAddress(repo, remote);
  } catch (err) {
    return { problem: `The repository's remote ${remote} could not be read: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (address === null) return { problem: `The repository has no remote named ${remote}. A pairing covers one repository both workbenches push to, named by that remote.` };
  const github = githubRepoOf(address.configured);
  let repository: string | null = null;
  if (github !== null) repository = repoName(github);
  else if (address.configured.startsWith("file:///")) repository = fileURLToPath(address.configured);
  else if (path.isAbsolute(address.configured)) repository = address.configured;
  if (repository !== null && repository.length > 1 && repository.endsWith("/")) repository = repository.replace(/\/+$/, "");
  if (repository === null || repositoryProblem(repository) !== null) return { problem: `The remote ${remote} is neither a GitHub repository nor a repository on this Mac, so Botbench cannot name it to another workbench. Pairing works for a repository on GitHub or a bare repository on this Mac.` };
  return { repository };
}
