import type { UpdateStatus } from "../api/client.ts";

/*
 * What Settings' Version row says (src/update.ts). The release's notes are the repository's text: the row shows their
 * summary as text, after a fixed lead, and nothing in them is followed.
 */

/** The row's lead line under "Botbench <version>": whether there is a release to update to, or why it is not known. */
export function versionAbout(s: UpdateStatus): { lead: string; notes: string | null } {
  if (s.available && s.latest !== null) return { lead: `Update available: ${s.latest.version}`, notes: s.latest.summary === "" ? null : s.latest.summary };
  if (!s.checking) return { lead: "This Botbench does not look for new releases.", notes: null };
  if (s.checkProblem !== null) return { lead: `Could not look for a new release. ${s.checkProblem}`, notes: null };
  if (s.checkedAt === null) return { lead: "Looking for a new release.", notes: null };
  return { lead: s.latest === null ? "No release has been published yet." : "This is the newest release.", notes: null };
}

/** Whether "Update now" is offered: a newer release, and no update waiting, running or installed already. */
export const canUpdate = (s: UpdateStatus): boolean => s.available && (s.state.kind === "idle" || s.state.kind === "failed" || s.state.kind === "updated");

/** Whether the update is still under way, so Settings looks again soon. */
export const updateUnderWay = (s: UpdateStatus): boolean => s.state.kind === "waiting" || s.state.kind === "updating" || s.state.kind === "restarting";

/** The update's state in one line under the row; null when there is nothing to say. Failures are shown as an error. */
export function updateStateWords(s: UpdateStatus): string | null {
  const { kind, version, message } = s.state;
  if (kind === "idle" || kind === "failed") return null;
  if (kind === "updating") return `Updating to ${version}. ${message ?? ""}`.trim();
  return message;
}

export const UPDATE_MODE_ABOUT = "Botbench looks for a new release on GitHub every 6 hours and sends nothing about you. An update fetches the release from GitHub, waits until no task is working, checks that the new version starts, then restarts Botbench.";
