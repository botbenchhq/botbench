// What the task screen says about an owner's note to a building task (src/engine/notes.ts), in one place, so the words
// test (test/note-words.test.ts) reads the same sentences the screen shows. The server's own reasons are in notes.ts.

export const NOTE_HEADING = "Note for Claude Code";
export const NOTE_LABEL = "Your note";
export const NOTE_ABOUT = "Claude Code reads your note as your next message once it finishes what it is doing now, before Botbench commits and checks the work. One note waits at a time: a second note replaces the first until it is delivered.";
/** On a task that is ready for review: what sending a note does instead of Accept or Reject (src/engine/note-rounds.ts). */
export const NOTE_ABOUT_READY = "Claude Code carries on where it left off, in the same copy, with your note as your next message. Botbench then commits, checks and reviews the work again, and it comes back here.";
/** A note sent while the task was ready for review, waiting for Claude Code to be started with it. */
export const NOTE_WAITING_ROUND = "Your note is waiting. Botbench starts Claude Code with it as soon as it can.";
export const NOTE_SEND = "Send note";
export const NOTE_SENDING = "Sending";
export const NOTE_WAITING = "Your note is waiting. Claude Code gets it when it finishes what it is doing now.";
export const NOTE_REPLACED = "Your new note replaced the one that was waiting.";
export const NOTE_WAITING_LABEL = "Waiting to be sent";
export const NOTE_NOT_DELIVERED = "Your note was not delivered";
/** The not-delivered alert's body: why, then the note's own words after it. */
export const notDeliveredLine = (reason: string): string => `${reason} It said: `;

/** A send the server refused, or one that could not reach it: what happened, then the server's reason. */
export const noteRefused = (reason: string | null): string => `The note was not sent. ${reason ?? "Botbench could not be reached."}`;
