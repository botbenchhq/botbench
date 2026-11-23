import fs from "node:fs";
import path from "node:path";
import type { DriverEvent } from "../../src/drivers/events.ts";
import type { FixtureTurn } from "./replay-build.ts";

/*
 * The real Claude Code session in which the agent put one question to its user with AskUserQuestion and went on once
 * it was answered, recorded by test/support/capture-question.ts into test/recordings/ask-question.json. The owner makes
 * that file once, on their own login; until then every test that replays it is skipped with `NO_QUESTION_RECORDING` as
 * its reason. Played as a builder's turn by test/support/replay-build.ts (a `FixtureTurn`).
 */

export const QUESTION_RECORDING = path.resolve(import.meta.dirname, "..", "recordings", "ask-question.json");

/** Why the tests that replay the question are skipped, or false once the recording exists. */
export const NO_QUESTION_RECORDING: string | false = fs.existsSync(QUESTION_RECORDING)
  ? false
  : "test/recordings/ask-question.json does not exist yet: the owner must run `node test/support/capture-question.ts` once, on their own Claude Code login, to record how the real CLI asks a question.";

export interface QuestionRecording {
  about: string;
  cli: string;
  recordedAt: string;
  prompt: string;
  /** What arrived: the tool's name and the input of the CLI's can_use_tool request. */
  finding: { controlRequest: string; tool: string; input: unknown };
  /** The answer the capture gave. */
  answer: string;
  events: DriverEvent[];
}

export const loadQuestionRecording = (): QuestionRecording => JSON.parse(fs.readFileSync(QUESTION_RECORDING, "utf8")) as QuestionRecording;

/** The recorded turn, for a replayed builder. */
export function questionTurn(): FixtureTurn {
  const recording = loadQuestionRecording();
  return { about: recording.about, events: recording.events };
}
