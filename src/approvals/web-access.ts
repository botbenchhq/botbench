import net from "node:net";
import type { DatabaseSync } from "node:sqlite";
import { now } from "../store/db.ts";

/*
 * "Web access": what Claude Code's own web tools (WebFetch, WebSearch) may do, in a chat, a task or a run, as the owner
 * chose in Settings (kept under its first name, `chat_web_access`, from when it was for chats only). Allow, the
 * default: they run without a card, each one shown in the transcript and written to the action log; a fetch of this
 * Mac, the local network or anything but a public web page still asks. Ask: each one is put to the owner as an approval
 * card. Off: each one is refused, saying where to turn it on. A fully autonomous run refuses what would ask. A run that
 * read outside text (a GitHub issue) does not follow the setting: each of its web tools asks. A web tool reaches the
 * site or the search provider through the CLI itself, outside the confinement of commands.
 */

export const WEB_ACCESS = ["allow", "ask", "off"] as const;
export type WebAccess = (typeof WEB_ACCESS)[number];

/** Claude Code's own tools that reach the web. */
export const WEB_TOOLS: ReadonlySet<string> = new Set(["WebFetch", "WebSearch"]);

export const isWebAccess = (v: unknown): v is WebAccess => typeof v === "string" && (WEB_ACCESS as readonly string[]).includes(v);

/** The owner's choice, read from the store each time it is needed; Allow when none was made. */
export function chatWebAccess(db: DatabaseSync): WebAccess {
  const stored = db.prepare("SELECT value FROM owner_settings WHERE name = 'chat_web_access'").get()?.value;
  return isWebAccess(stored) ? stored : "allow";
}

export function setChatWebAccess(db: DatabaseSync, value: WebAccess): void {
  if (!isWebAccess(value)) throw new Error(`Web access is allow, ask or off, not ${JSON.stringify(value)}.`);
  db.prepare("INSERT INTO owner_settings (name, value, updated_at) VALUES ('chat_web_access', ?, ?) ON CONFLICT (name) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at").run(value, now());
}

/** What the owner sees for each value, in Settings and in the log. */
export const WEB_ACCESS_WORDS: Record<WebAccess, string> = { allow: "Allow", ask: "Ask", off: "Off" };

/** What Claude Code is told, and the transcript says, when web access is off. */
export const WEB_OFF = "Web access is off, so Botbench refused this without asking you. You can switch it on in Settings, under Web access.";

/**
 * Whether a fetch is aimed at a public web page: an http or https address whose host is a dotted name that is not this
 * Mac's or a local network's (`localhost`, `.local`, `.internal`, `.lan`, `.home.arpa`, a bare name) or an IP address
 * that is not loopback, private, link-local, unspecified or unique-local. Only such a fetch may run on Allow: Claude
 * Code fetches from this Mac, outside the sandbox of commands, so anything else (Botbench's own port, a router, a
 * cloud metadata address, a file) asks. A name that a resolver maps to a local address is not caught here.
 */
export function publicWebAddress(url: unknown): boolean {
  if (typeof url !== "string") return false;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return false;
  const host = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase().replace(/\.$/, "");
  if (net.isIPv4(host)) return !/^(0\.|10\.|127\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|22[4-9]\.|2[3-5]\d\.)/.test(host);
  if (net.isIPv6(host)) return !/^(::|::1|f[cd]|fe[89ab]|ff|::ffff:)/.test(host) && host !== "::";
  return host.includes(".") && !/(^|\.)(localhost|local|internal|lan|home\.arpa)$/.test(host);
}
