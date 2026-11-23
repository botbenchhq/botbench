import type { DatabaseSync } from "node:sqlite";
import { now, transaction } from "../store/db.ts";

/*
 * Chats as rows of a list (src/api/board.ts). A chat is named by its first attempt. Which attempts make up a chat is
 * recorded as each message is sent (`recordChat`, from src/api/chat.ts): the attempts the device sent as the
 * conversation, and the new replies. A chat started before this was recorded is listed from its next message on.
 * The owner may give a chat a name of their own (`renameChat`); nothing else of the chat is ever changed here.
 */

/** The longest name a chat can be given, in characters. */
export const MAX_CHAT_TITLE = 80;
/** How much of the first message a chat's default name keeps. */
const DEFAULT_TITLE_LENGTH = 120;

/** A refused request; `status` is its HTTP answer. */
export class ListError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const isChatAttempt = (db: DatabaseSync, attemptId: number): boolean => db.prepare("SELECT 1 FROM chat_attempts WHERE attempt_id = ?").get(attemptId) !== undefined;

/**
 * Record which chat a message's attempts belong to: the chat one of them already belongs to, else the chat named by the
 * first of them. Only attempts a chat started are recorded, so a task's or a review's attempt never joins a chat.
 * An attempt already recorded keeps its chat.
 */
export function recordChat(db: DatabaseSync, conversation: readonly number[], replies: readonly number[]): void {
  const members = [...new Set([...conversation, ...replies])].filter((id) => isChatAttempt(db, id));
  if (members.length === 0) return;
  transaction(db, () => {
    const known = members.map((id) => db.prepare("SELECT chat_id FROM chat_members WHERE attempt_id = ?").get(id)).find((row) => row !== undefined);
    const chat = known === undefined ? members[0]! : Number(known.chat_id);
    const at = now();
    for (const id of members) db.prepare("INSERT OR IGNORE INTO chat_members (attempt_id, chat_id, created_at) VALUES (?, ?, ?)").run(id, chat, at);
  });
}

/** Whether `chatId` names a recorded chat. */
export const isChat = (db: DatabaseSync, chatId: number): boolean => db.prepare("SELECT 1 FROM chat_members WHERE chat_id = ? LIMIT 1").get(chatId) !== undefined;

/** The owner's first message of a chat: the message of its first round, else the first prompt its first attempt was sent. */
function firstMessage(db: DatabaseSync, chatId: number): string {
  const round = db.prepare("SELECT r.message FROM chat_attempts c JOIN chat_rounds r ON r.id = c.round_id WHERE c.attempt_id = ?").get(chatId);
  if (round !== undefined) return String(round.message);
  const prompt = db.prepare("SELECT payload FROM events WHERE attempt_id = ? AND type = 'user_prompt' ORDER BY id LIMIT 1").get(chatId);
  if (prompt === undefined) return "";
  const parsed = JSON.parse(String(prompt.payload)) as { text?: unknown };
  return typeof parsed.text === "string" ? parsed.text : "";
}

/** A chat's name when the owner gave it none: the first line of its first message, without a markdown heading's marks. */
function defaultTitle(db: DatabaseSync, chatId: number): string {
  const line = firstMessage(db, chatId).trim().split("\n")[0]!.replace(/^#+\s*/, "").trim();
  if (line === "") return "Chat";
  return line.length > DEFAULT_TITLE_LENGTH ? `${line.slice(0, DEFAULT_TITLE_LENGTH)}…` : line;
}

/** The name the owner gave a chat, or null. */
const ownTitle = (db: DatabaseSync, chatId: number): string | null => {
  const row = db.prepare("SELECT title FROM chat_titles WHERE chat_id = ?").get(chatId);
  return row === undefined ? null : String(row.title);
};

export interface ChatRow {
  id: number;
  /** The owner's name for it, else the first line of its first message. */
  title: string;
  /** Whether the title is one the owner gave it. */
  named: boolean;
  /** The agents that answered in it, in the order they first did. */
  agents: string[];
  /** Its attempts, oldest first: what a device shows as the chat. */
  attempts: number[];
  createdAt: string;
  updatedAt: string;
}

/** One recorded chat as a list shows it; null when there is no such chat. */
export function chatRow(db: DatabaseSync, chatId: number): ChatRow | null {
  const rows = db.prepare("SELECT a.id, a.driver, a.created_at, a.updated_at FROM chat_members m JOIN attempts a ON a.id = m.attempt_id WHERE m.chat_id = ? ORDER BY a.id").all(chatId);
  if (rows.length === 0) return null;
  const own = ownTitle(db, chatId);
  return {
    id: chatId,
    title: own ?? defaultTitle(db, chatId),
    named: own !== null,
    agents: [...new Set(rows.map((row) => String(row.driver)))],
    attempts: rows.map((row) => Number(row.id)),
    createdAt: String(rows[0]!.created_at),
    updatedAt: rows.map((row) => String(row.updated_at)).sort().at(-1)!,
  };
}

/** Every recorded chat. */
export function listChats(db: DatabaseSync): ChatRow[] {
  return db.prepare("SELECT DISTINCT chat_id FROM chat_members ORDER BY chat_id").all().map((row) => chatRow(db, Number(row.chat_id))!);
}

/**
 * Give a chat the owner's name for it: one line, trimmed, its spaces run together, at most `MAX_CHAT_TITLE` characters.
 * An empty name gives the chat back its default one. Only the chat's name is stored: its messages and attempts are
 * not touched.
 */
export function renameChat(db: DatabaseSync, chatId: number, title: unknown): ChatRow {
  // voice: not on screen. It names the API's own field for a caller whose request was malformed; the client never sends one.
  if (typeof title !== "string") throw new ListError(400, 'expected { "title": "..." }, an empty title to go back to the first message');
  if (!isChat(db, chatId)) throw new ListError(404, "There is no such chat in the list.");
  const name = title.replace(/\s+/g, " ").trim();
  if ([...name].length > MAX_CHAT_TITLE) throw new ListError(400, `A chat's name can be at most ${MAX_CHAT_TITLE} characters. This one has ${[...name].length}.`);
  if (name === "") db.prepare("DELETE FROM chat_titles WHERE chat_id = ?").run(chatId);
  else db.prepare("INSERT INTO chat_titles (chat_id, title, updated_at) VALUES (?, ?, ?) ON CONFLICT (chat_id) DO UPDATE SET title = excluded.title, updated_at = excluded.updated_at").run(chatId, name, now());
  return chatRow(db, chatId)!;
}
