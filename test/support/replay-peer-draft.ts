import fs from "node:fs";
import path from "node:path";
import type { DriverEvent } from "../../src/drivers/events.ts";
import type { FixtureTurn } from "./replay-build.ts";

/*
 * The real Claude Code session in which a task's builder, told by Botbench how to draft a message to a paired
 * workbench, wrote one botbench-peer-message block in its reply, recorded by test/support/capture-peer-draft.ts into
 * test/recordings/peer-draft.json. The owner makes that file once, on their own login; until then every test that
 * replays it is skipped with `NO_PEER_DRAFT_RECORDING` as its reason. Played as a builder's turn by
 * test/support/replay-build.ts (a `FixtureTurn`).
 */

export const PEER_DRAFT_RECORDING = path.resolve(import.meta.dirname, "..", "recordings", "peer-draft.json");

/** Why the tests that replay the draft are skipped, or false once the recording exists. */
export const NO_PEER_DRAFT_RECORDING: string | false = fs.existsSync(PEER_DRAFT_RECORDING)
  ? false
  : "test/recordings/peer-draft.json does not exist yet: the owner must run `node test/support/capture-peer-draft.ts` once, on their own Claude Code login, to record a real reply that drafts a message to another workbench.";

export interface PeerDraftRecording {
  about: string;
  cli: string;
  recordedAt: string;
  prompt: string;
  events: DriverEvent[];
}

/** The recorded turn, for a replayed builder. */
export function peerDraftTurn(): FixtureTurn {
  const recording = JSON.parse(fs.readFileSync(PEER_DRAFT_RECORDING, "utf8")) as PeerDraftRecording;
  return { about: recording.about, events: recording.events };
}
