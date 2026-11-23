import type { RepositoryExecution } from "../api/client.ts";

/*
 * The words of Settings' "Where commands run" (src/execution.ts, ADR 0009), decided without a browser: each repository
 * of the settings file, and whether its tasks' commands run on this Mac or in a container of the image it names.
 */

export const EXECUTION_HEADING = "Where commands run";

/** The line under the heading: where this is set, and that nothing falls back. */
export const EXECUTION_ABOUT = 'Set per repository in the settings file, as "execution". A repository that runs its commands in a container never runs them on this Mac instead: when Docker or the image is not there, its task does not start.';

/** What Settings says when the settings file names no repository. */
export const NO_REPOSITORIES = "No repository has settings of its own, so every task's commands run on this Mac, kept away from your sign-ins and the network.";

/** One repository's line: where its tasks' commands run. */
export function executionWords(e: RepositoryExecution["execution"]): { kind: string; about: string } {
  if (e.kind === "container") {
    return { kind: "In a container", about: `In a Docker container of the image ${e.image}, one for each task, with only the task's separate copy in it and no network. Claude Code stays on this Mac; each command it runs goes into the container. Botbench never downloads the image.` };
  }
  return { kind: "On this Mac", about: "On this Mac, kept away from your sign-ins and the network, in the task's separate copy." };
}
