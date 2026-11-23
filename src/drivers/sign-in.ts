/*
 * Each vendor CLI's own sign-in, as Botbench starts it from Settings (U26). Botbench runs the CLI's sign-in command,
 * reads the link and the code it prints, and shows them to the owner; the owner signs in with the vendor, and the CLI
 * keeps its own credentials. Nothing here reads, stores or forwards a credential.
 *
 * Seen on the installed CLIs on 2026-11-22, each with an empty configuration directory, stdin and stdout pipes:
 *   Claude Code 2.1.322  `claude auth login --claudeai` prints a link to claude.com and then "Paste code here if
 *                        prompted > ". The vendor's page shows a code after sign-in, which the CLI reads on its input;
 *                        a wrong code ends it with exit 1 and "Login failed: …" on stderr. It opens the link with
 *                        $BROWSER, so Botbench sets that to a command that does nothing: no window opens on the Mac.
 *                        Its configuration directory is CLAUDE_CONFIG_DIR.
 *   Codex 0.171.0        `codex login --device-auth` prints https://auth.openai.com/codex/device and a one-time code
 *                        (two groups of four or five letters and digits, "expires in 15 minutes") with colour escapes
 *                        even into a pipe, then waits. Its configuration directory is CODEX_HOME.
 * The output, with the secret parts replaced, is in test/recordings/sign-in/.
 */

/** How the sign-in reaches the owner. "on-the-mac": it can only be finished in a browser on the Mac itself. */
export type SignInKind = "device-code" | "link" | "on-the-mac";

/** What the CLI printed for the owner: the vendor's page and, for a device code, the code to enter there. */
export interface SignInPrompt {
  url: string;
  code: string | null;
}

/** One CLI's sign-in and sign-out, as a driver names them. */
export interface SignInDefinition {
  /** The driver's name, as in `attempts.driver`. */
  readonly driver: string;
  /** The agent's name on screen. */
  readonly product: string;
  readonly kind: SignInKind;
  readonly command: string;
  readonly args: readonly string[];
  /** The same sign-in, as the owner would type it in a terminal on the Mac. */
  readonly terminalCommand: string;
  /** The CLI's own sign-out: its arguments, and the command as the owner reads it. */
  readonly signOutArgs: readonly string[];
  readonly signOutCommand: string;
  /** Variables Botbench sets for both: where the CLI keeps its login, and no browser opened on the Mac. */
  readonly env: Readonly<Record<string, string>>;
  /**
   * The sign-in is one Botbench keeps in a folder of its own, apart from the CLI's in a terminal (Antigravity): signing
   * out removes it there (`removeSignIn`) and runs no command, and a terminal sign-in cannot stand in for it.
   */
  readonly keptByBotbench?: boolean;
  /** Sign-out for a sign-in Botbench keeps: removes the CLI's sign-in file from Botbench's folder. Nothing is read. */
  readonly removeSignIn?: () => void;
  /** The code the owner pasted, as it goes to the CLI, or null when it is not one. pastedCode when left out. */
  readonly pasted?: (value: unknown) => string | null;
  /** The CLI waits on its input for the code the vendor's page shows after sign-in. */
  readonly takesCode: boolean;
  /** How long Botbench waits for the owner before it stops the sign-in. */
  readonly limitMs: number;
  /** The link and code in everything the CLI has printed so far, once it has printed them all; else null. Pure. */
  parse(output: string): SignInPrompt | null;
}

/** Given as $BROWSER, so a CLI that opens its link on the Mac runs this instead, and nothing opens. */
export const NO_BROWSER = "/usr/bin/true";

const FIFTEEN_MINUTES = 15 * 60_000;

/** The text without terminal colour and cursor escapes. */
export const plainText = (output: string): string => output.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "").replace(/\u001b\][^\u0007]*\u0007/g, "");

/** The first https link in `text` on one of `hosts`. A link anywhere else is not shown to the owner. */
export function linkOn(text: string, hosts: readonly string[]): string | null {
  for (const [raw] of text.matchAll(/https:\/\/[^\s"'<>]+/g)) {
    try {
      const url = new URL(raw);
      if (url.protocol === "https:" && url.username === "" && url.password === "" && url.port === "" && hosts.includes(url.hostname)) return url.href;
    } catch {
      // Not a link after all.
    }
  }
  return null;
}

const CLAUDE_HOSTS = ["claude.com", "claude.ai"];

/** Claude Code: the link, once the CLI asks for the code (so its input is ready). */
export function parseClaudeSignIn(output: string): SignInPrompt | null {
  const text = plainText(output);
  if (!/Paste code here/.test(text)) return null;
  const url = linkOn(text, CLAUDE_HOSTS);
  return url === null ? null : { url, code: null };
}

const CODEX_HOSTS = ["auth.openai.com"];
const DEVICE_CODE = /(?<![A-Za-z0-9])([A-Z0-9]{4,5}-[A-Z0-9]{4,5})(?![A-Za-z0-9])/;

/** Codex: the device page and the one-time code printed after "Enter this one-time code". */
export function parseCodexSignIn(output: string): SignInPrompt | null {
  const text = plainText(output);
  const at = text.search(/one-time code/i);
  if (at < 0) return null;
  const url = linkOn(text.slice(0, at), CODEX_HOSTS);
  const code = DEVICE_CODE.exec(text.slice(at))?.[1] ?? null;
  return url === null || code === null ? null : { url, code };
}

/** Claude Code's own sign-in with a Claude subscription. `configDir` is its CLAUDE_CONFIG_DIR, when the owner moved it. */
export function claudeCodeSignIn(configDir?: string): SignInDefinition {
  return {
    driver: "claude-code",
    product: "Claude Code",
    kind: "link",
    command: "claude",
    // --claudeai: the subscription, never the metered Console login.
    args: ["auth", "login", "--claudeai"],
    terminalCommand: "claude auth login",
    signOutArgs: ["auth", "logout"],
    signOutCommand: "claude auth logout",
    env: { BROWSER: NO_BROWSER, ...(configDir ? { CLAUDE_CONFIG_DIR: configDir } : {}) },
    takesCode: true,
    limitMs: FIFTEEN_MINUTES,
    parse: parseClaudeSignIn,
  };
}

/**
 * Codex's own device-code sign-in with ChatGPT, ready for the Codex driver to name as its `signIn`. `home` is its
 * CODEX_HOME, when the owner moved it.
 */
export function codexSignIn(home?: string): SignInDefinition {
  return {
    driver: "codex",
    product: "Codex",
    kind: "device-code",
    command: "codex",
    args: ["login", "--device-auth"],
    terminalCommand: "codex login --device-auth",
    signOutArgs: ["logout"],
    signOutCommand: "codex logout",
    env: { BROWSER: NO_BROWSER, ...(home ? { CODEX_HOME: home } : {}) },
    takesCode: false,
    // The code it prints "expires in 15 minutes".
    limitMs: FIFTEEN_MINUTES,
    parse: parseCodexSignIn,
  };
}

const GOOGLE_HOSTS = ["accounts.google.com"];
/** Where Google's page sends the owner after an Antigravity sign-in: it shows the code, which is also in its address. */
export const ANTIGRAVITY_CALLBACK = "https://antigravity.google/oauth-callback";

/** Antigravity's `agy acp --login`: Google's sign-in page, once the CLI asks for the code (so its input is ready). */
export function parseAntigravitySignIn(output: string): SignInPrompt | null {
  const text = plainText(output);
  if (!/paste the authorization code/i.test(text)) return null;
  const url = linkOn(text, GOOGLE_HOSTS);
  if (url === null) return null;
  const link = new URL(url);
  // Only Google's own page that lands on Antigravity's page showing the code: anything else would never be pasted back.
  if (link.pathname !== "/o/oauth2/auth" || link.searchParams.get("redirect_uri") !== ANTIGRAVITY_CALLBACK || link.searchParams.get("response_type") !== "code") return null;
  return { url, code: null };
}

/**
 * What the owner pastes back to `agy acp --login`, which takes the code or the whole address of the page Google landed
 * on: a code, or that address on Antigravity's own page, on one line. Null for anything else.
 */
export function pastedAntigravityCode(value: unknown): string | null {
  const code = pastedCode(value);
  if (code !== null) return code;
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (text.length > 4096 || /\s/.test(text)) return null;
  try {
    const url = new URL(text);
    return url.origin === "https://antigravity.google" && url.pathname === "/oauth-callback" && url.username === "" && url.password === "" && url.searchParams.getAll("code").length === 1 ? url.href : null;
  } catch {
    return null;
  }
}

/** What a code the owner pastes back may be: the characters of an authorization code and its state, on one line. */
const PASTED_CODE = /^[A-Za-z0-9._~#+/=-]{1,2048}$/;

/** The code as it goes to the CLI, or null when it is not one line of code characters. */
export function pastedCode(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const code = value.trim();
  return PASTED_CODE.test(code) ? code : null;
}

/**
 * Why a sign-in ended without success, in the CLI's own words: the last line it wrote to stderr, else to stdout,
 * without colour, with every value in `secrets` taken out, at most 300 characters. Null when it wrote nothing.
 */
export function signInFailure(stdout: string, stderr: string, secrets: readonly string[]): string | null {
  const last = (text: string): string | null =>
    plainText(text)
      .split(/\r?\n/)
      .map((line) => line.replace(/[\u0000-\u001f\u007f]/g, "").trim())
      .filter((line) => line !== "")
      .at(-1) ?? null;
  let line = last(stderr) ?? last(stdout);
  if (line === null) return null;
  for (const secret of secrets) if (secret !== "") line = line.replaceAll(secret, "…");
  return line.length > 300 ? `${line.slice(0, 299)}…` : line;
}
