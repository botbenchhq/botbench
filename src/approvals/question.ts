/*
 * A question an agent puts to the owner: Claude Code's AskUserQuestion tool.
 *
 * How it arrives (Anthropic's Agent SDK guide "Handle approvals and user input", read 2026-11-23; the owner's capture,
 * test/support/capture-question.ts, records it from the real CLI into test/recordings/ask-question.json):
 *   With `--permission-prompt-tool stdio`, the call is a permission prompt like any other, a `control_request` with
 *   `"subtype":"can_use_tool"` and `"tool_name":"AskUserQuestion"`, whose `input` is
 *     {"questions":[{"question":"…","header":"…","options":[{"label":"…","description":"…"}, …],"multiSelect":false}]}
 *   (one to four questions of two to four options each; an option may carry a `preview` when the host asks for one,
 *   which Botbench never does). The CLI waits for the answer as it does for any permission prompt.
 * How it is answered: `{"behavior":"allow","updatedInput":{…the input as given…, "answers":{"<question text>":"<label
 *   or the person's own text>"}}}`, and the agent's turn goes on with the answer as the tool's result. A `deny` with a
 *   message gives the agent that message instead.
 * When a tool list is given with `--tools` (a read-only attempt), it must name AskUserQuestion or the agent has no such tool.
 *
 * Botbench shows one question at a time, as a card with one button per choice and "Something else": a call with more
 * than one question, or one it cannot show as it is, is refused with a plain message to the agent and never makes a
 * card. Every word of it is the model's and is shown as plain text, never as markdown or HTML.
 */

export const QUESTION_TOOL = "AskUserQuestion";

/** The longest question, choice label and choice description a card shows. Longer ones are refused, not cut. */
export const MAX_QUESTION = 2000;
export const MAX_HEADER = 100;
export const MAX_LABEL = 200;
export const MAX_DESCRIPTION = 1000;
/** The longest answer the owner may give, as for a note. */
export const MAX_ANSWER = 2000;

export interface QuestionChoice {
  label: string;
  /** The agent's own line about the choice; "" when it gave none. */
  description: string;
}

/** One question as its card shows it. */
export interface Question {
  /** The question text, also the key the answer is returned under. */
  text: string;
  /** The agent's short label for it; "" when it gave none. */
  header: string;
  /** Two to four, in the agent's order. */
  choices: QuestionChoice[];
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const filled = (v: unknown): v is string => typeof v === "string" && v.trim() !== "";

/** What the agent is told when its question cannot be shown, and why. It is asked to try again in the one shape that can be. */
const refusal = (why: string): string => `Botbench could not show this question to the owner: ${why} Nothing was asked. Ask one question at a time, with two to four choices, each with a short label.`;

/**
 * Read an AskUserQuestion call's input. Pure. Answers the one question as its card shows it, or, as text for the agent,
 * why it cannot be shown: not one question, no question text, fewer than two or more than four choices, a choice with no
 * label, two choices with the same label, a field of the wrong type, or text too long for a card.
 */
export function readQuestion(input: unknown): Question | { problem: string } {
  if (!isObject(input) || !Array.isArray(input.questions)) return { problem: refusal("it holds no list of questions.") };
  if (input.questions.length !== 1) return { problem: refusal(`it holds ${input.questions.length} questions, and Botbench asks one at a time.`) };
  const q = input.questions[0];
  if (!isObject(q)) return { problem: refusal("the question is not readable.") };
  if (!filled(q.question)) return { problem: refusal("it has no question text.") };
  if (q.question.length > MAX_QUESTION) return { problem: refusal(`the question is longer than ${MAX_QUESTION} characters.`) };
  if (q.header !== undefined && typeof q.header !== "string") return { problem: refusal("its header is not text.") };
  if (typeof q.header === "string" && q.header.length > MAX_HEADER) return { problem: refusal(`its header is longer than ${MAX_HEADER} characters.`) };
  if (q.multiSelect !== undefined && typeof q.multiSelect !== "boolean") return { problem: refusal("multiSelect is not true or false.") };
  if (!Array.isArray(q.options)) return { problem: refusal("it has no list of choices.") };
  if (q.options.length < 2 || q.options.length > 4) return { problem: refusal(`it has ${q.options.length} choice${q.options.length === 1 ? "" : "s"}.`) };
  const choices: QuestionChoice[] = [];
  for (const option of q.options) {
    if (!isObject(option) || !filled(option.label)) return { problem: refusal("a choice has no label.") };
    if (option.label.length > MAX_LABEL) return { problem: refusal(`a choice's label is longer than ${MAX_LABEL} characters.`) };
    if (option.description !== undefined && typeof option.description !== "string") return { problem: refusal("a choice's description is not text.") };
    if (typeof option.description === "string" && option.description.length > MAX_DESCRIPTION) return { problem: refusal(`a choice's description is longer than ${MAX_DESCRIPTION} characters.`) };
    if (choices.some((c) => c.label === option.label)) return { problem: refusal("two choices have the same label.") };
    choices.push({ label: option.label, description: typeof option.description === "string" ? option.description : "" });
  }
  return { text: q.question, header: typeof q.header === "string" ? q.header : "", choices };
}

/** Why an answer the owner gave cannot be sent, or null when it can: it must be text with something in it, at most `MAX_ANSWER` characters. */
export function answerProblem(answer: unknown): string | null {
  if (typeof answer !== "string" || answer.trim() === "") return "Write an answer, or choose one of the choices.";
  if (answer.length > MAX_ANSWER) return `An answer can be at most ${MAX_ANSWER} characters.`;
  return null;
}

/** What the agent of a fully autonomous run is told in place of an answer: nobody is asked, so it decides and says what it chose. */
export const AUTONOMOUS_ANSWER =
  "This run is fully autonomous, so Botbench does not put questions to the owner and nobody will answer this one. Use your best judgement: choose the option you think is right, go on with the work, and say in your final reply which option you chose and why. The owner reviews this task before it is accepted.";

/** The stored form of a question, on its approval: JSON, read back by `parseStoredQuestion`. */
export const storedQuestion = (q: Question): string => JSON.stringify({ text: q.text, header: q.header, choices: q.choices.map((c) => ({ label: c.label, description: c.description })) });

/** A stored question read back; null for none, or for one that is not readable (then its card cannot be shown). */
export function parseStoredQuestion(stored: unknown): Question | null {
  if (typeof stored !== "string") return null;
  try {
    const q = JSON.parse(stored) as unknown;
    if (!isObject(q) || typeof q.text !== "string" || typeof q.header !== "string" || !Array.isArray(q.choices)) return null;
    const choices = q.choices.filter((c): c is QuestionChoice => isObject(c) && typeof c.label === "string" && typeof c.description === "string");
    return choices.length === q.choices.length ? { text: q.text, header: q.header, choices } : null;
  } catch {
    return null;
  }
}
