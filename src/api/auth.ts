import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import type http from "node:http";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { setTimeout as sleep } from "node:timers/promises";
import { writeFileAtomic } from "../store/atomic.ts";
import { audioFormat } from "../dictation/dictation.ts";
import { BodyError, json, readJsonBody, requestUrl } from "./router.ts";
import { createPairing, REFUSAL_WORDS, type Refusal } from "./pairing.ts";
import { createSessions, deviceLabel, SESSION_MAX_AGE_S } from "./sessions.ts";
import { isShellRequest } from "./static.ts";

/** The owner's login token, inside Botbench's data directory. */
export const LOGIN_TOKEN_FILE = "login-token";
export const SESSION_COOKIE = "botbench_session";

/**
 * Read the owner's login token, creating it on the first start.
 * `created` is true only for the start that made it, which is the one start allowed to show it.
 */
export function loadOrCreateLoginToken(home: string): { token: string; created: boolean } {
  const file = path.join(home, LOGIN_TOKEN_FILE);
  if (fs.existsSync(file)) {
    fs.chmodSync(file, 0o600); // owner-only even if something loosened it
    const token = fs.readFileSync(file, "utf8").trim();
    if (token.length < 32) throw new Error(`${file} does not hold a login token. Delete it and start Botbench again to get a new one.`);
    return { token, created: false };
  }
  const token = randomBytes(32).toString("base64url");
  writeFileAtomic(file, `${token}\n`, 0o600);
  return { token, created: true };
}

export interface AuthOptions {
  token: string;
  /** Where the sessions are kept, so a device stays signed in across restarts. */
  db: DatabaseSync;
  /** The addresses Botbench listens on. */
  listen: readonly string[];
  /** The bound port; a function because port 0 is only known once the first listener is up. */
  port: () => number;
  /** HTTPS names a private-network proxy forwards from. */
  publicHosts: readonly string[];
  /** Wait after the first wrong token; it doubles with each further one, up to `MAX_SIGN_IN_DELAY_MS`. */
  signInDelayMs?: number;
  /** How long a code from Add a device signs in; 5 minutes unless a test asks for less. */
  pairingLifetimeMs?: number;
}

export interface Auth {
  /**
   * Decide whether a request may reach the routes. Resolves true when it carries
   * a valid session and passes the header checks, or when it asks for the client
   * shell on an allowed host (the shell holds no data); otherwise the request has
   * already been answered (sign-in included) and the caller must do nothing more.
   */
  gate(req: http.IncomingMessage, res: http.ServerResponse): Promise<boolean>;
}

export const DEFAULT_SIGN_IN_DELAY_MS = 500;
export const MAX_SIGN_IN_DELAY_MS = 10_000;
/** Sign-in attempts allowed to wait their turn at once; further ones are turned away unchecked. */
export const MAX_WAITING_SIGN_INS = 10;
const SIGN_IN_PATH = "/api/sign-in";
/** The one write route whose body is not JSON: a recording to transcribe, in one of the formats `audioFormat` takes. */
export const TRANSCRIBE_PATH = "/api/voice/transcribe";
const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** Compare without the time taken depending on where the two differ, or on their lengths. */
function sameSecret(a: string, b: string): boolean {
  const digest = (s: string): Buffer => createHash("sha256").update(s).digest();
  return timingSafeEqual(digest(a), digest(b));
}

const isJson = (req: http.IncomingMessage): boolean => (req.headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase() === "application/json";

/**
 * The session a request carries. Only for a request the gate has let through, which is how a route knows the session is
 * valid; a route uses it to tell one signed-in device from another, never to decide whether it may answer.
 */
export function sessionOf(req: http.IncomingMessage): string | undefined {
  return cookieValue(req, SESSION_COOKIE);
}

function cookieValue(req: http.IncomingMessage, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const eq = part.indexOf("=");
    if (eq !== -1 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return undefined;
}

export function createAuth(options: AuthOptions): Auth {
  const publicHosts = new Set(options.publicHosts.map((h) => h.toLowerCase()));
  const baseDelay = options.signInDelayMs ?? DEFAULT_SIGN_IN_DELAY_MS;

  // Sessions are kept in the database (as hashes), so a restart signs nobody out. They are not tied to the login
  // token: replacing the token file changes what signs in from then on, and leaves signed-in devices signed in.
  const sessions = createSessions(options.db);
  const pairing = createPairing(options.db, options.pairingLifetimeMs);
  /** Each session's requests in flight, the event stream included, so ending a session ends them at once. */
  const inFlight = new Map<number, Set<http.ServerResponse>>();
  const track = (id: number, res: http.ServerResponse): void => {
    let open = inFlight.get(id);
    if (open === undefined) inFlight.set(id, (open = new Set()));
    open.add(res);
    res.on("close", () => {
      open.delete(res);
      if (open.size === 0 && inFlight.get(id) === open) inFlight.delete(id);
    });
  };
  /** Cut off what an ended session still has open, except the reply that is ending it. */
  const cutOff = (id: number, except: http.ServerResponse): void => {
    for (const res of inFlight.get(id) ?? []) if (res !== except) res.destroy();
  };

  const sessionCookie = (secret: string, secure: boolean, maxAge = SESSION_MAX_AGE_S): string =>
    `${SESSION_COOKIE}=${secret}; Max-Age=${maxAge}; HttpOnly; SameSite=Strict; Path=/${secure ? "; Secure" : ""}`;

  /** `Host` values of Botbench's own plain-HTTP listeners. */
  const directHosts = (): Set<string> => {
    const port = options.port();
    const hosts = new Set([`localhost:${port}`]);
    for (const address of options.listen) hosts.add(`${address.includes(":") ? `[${address}]` : address}:${port}`.toLowerCase());
    return hosts;
  };

  /** A browser's `Origin` must be Botbench itself: http on a listen address, https on a public name. */
  const originAllowed = (origin: string): boolean => {
    let url: URL;
    try {
      url = new URL(origin);
    } catch {
      return false;
    }
    if (url.protocol === "https:") return publicHosts.has(url.host);
    return url.protocol === "http:" && directHosts().has(url.host);
  };

  // Wrong tokens and wrong codes are slowed down together, for everyone at once, not per address: there is one owner,
  // and a per-address count would be reset by simply coming from another address. Attempts of both kinds wait in the one
  // line and are checked one at a time, so sending many side by side, or mixing tokens and codes, gains nothing.
  let failures = 0;
  let notBefore = 0;
  let queue: Promise<unknown> = Promise.resolve();
  let waiting = 0;
  /** Run `check` in its turn, after the wait the failures so far set; anything but true counts as one more failure. */
  const attempt = <R,>(check: () => true | R): Promise<true | R | "busy"> => {
    // A bounded line: without it a flood of guesses would keep the owner's own sign-in waiting behind them for ever.
    if (waiting >= MAX_WAITING_SIGN_INS) return Promise.resolve("busy");
    waiting += 1;
    const result = queue.then(async () => {
      const wait = notBefore - Date.now();
      if (wait > 0) await sleep(wait, undefined, { ref: false });
      const outcome = check();
      if (outcome === true) {
        failures = 0;
        notBefore = 0;
        return true as const;
      }
      failures += 1;
      notBefore = Date.now() + Math.min(baseDelay * 2 ** (failures - 1), MAX_SIGN_IN_DELAY_MS);
      return outcome;
    });
    queue = result.catch(() => undefined);
    return result.finally(() => (waiting -= 1));
  };

  const signIn = async (req: http.IncomingMessage, res: http.ServerResponse, secure: boolean): Promise<void> => {
    let body: unknown;
    try {
      body = await readJsonBody(req, 4096);
    } catch (err) {
      if (!(err instanceof BodyError)) throw err;
      return json(res, err.status, { error: err.message });
    }
    // The login token, or a one-time code from Add a device: exactly one of the two.
    const fields = typeof body === "object" && body !== null ? (body as { token?: unknown; code?: unknown }) : {};
    const token = typeof fields.token === "string" && fields.code === undefined ? fields.token : undefined;
    const code = typeof fields.code === "string" && fields.token === undefined ? fields.code : undefined;
    if (token === undefined && code === undefined) return json(res, 400, { error: 'expected { "token": "..." } or { "code": "..." }' });
    let madeBy: number | undefined;
    const redeem = (typed: string): true | Refusal => {
      const result = pairing.redeem(typed);
      if (typeof result === "string") return result;
      madeBy = result.madeBy;
      return true;
    };
    const outcome = await attempt<false | Refusal>(code === undefined ? () => sameSecret(token!, options.token) || false : () => redeem(code));
    if (outcome === "busy") return json(res, 429, { error: "too many tries at signing in; wait a moment, then try again" });
    if (outcome === false) return json(res, 401, { error: "wrong token" });
    if (outcome !== true) return json(res, 401, { error: REFUSAL_WORDS[outcome], refused: outcome });
    const device = deviceLabel(req.headers["user-agent"]);
    const { id, secret } = sessions.create(device);
    // Never the code: which device was added, and which device's code added it.
    if (madeBy !== undefined) console.log(`A device was added with a one-time code: device ${id} (${device}), from the code made on device ${madeBy}.`);
    json(res, 200, { signedIn: true }, { "set-cookie": sessionCookie(secret, secure) });
  };

  /** The signed-in devices: listing them, adding one with a code, signing one out, signing out every other. Answered here; false when not one of them. */
  const deviceRoutes = (req: http.IncomingMessage, res: http.ServerResponse, pathname: string, current: number, secure: boolean): boolean => {
    if (req.method === "GET" && pathname === "/api/devices") {
      json(res, 200, { devices: sessions.list().map((d) => ({ ...d, current: d.id === current })) });
      return true;
    }
    // Add a device: a new one-time code, which cancels the one before it. Shown once, on the device that asked.
    if (req.method === "POST" && pathname === "/api/devices/pairing") {
      const made = pairing.create(current);
      console.log(`A one-time code to add a device was made on device ${current} (${sessions.list().find((d) => d.id === current)?.device ?? "unknown"}).`);
      json(res, 200, made, { "cache-control": "no-store" });
      return true;
    }
    if (req.method === "POST" && pathname === "/api/devices/sign-out-others") {
      for (const id of sessions.endAllBut(current)) cutOff(id, res);
      json(res, 200, { signedOut: "others" });
      return true;
    }
    const one = /^\/api\/devices\/([^/]+)\/sign-out$/.exec(pathname);
    if (req.method === "POST" && one !== null) {
      const id = /^\d{1,15}$/.test(one[1]!) ? Number(one[1]) : NaN;
      if (!Number.isSafeInteger(id) || !sessions.end(id)) {
        json(res, 404, { error: "That device is not signed in." });
        return true;
      }
      cutOff(id, res);
      // Signing this device out also clears its cookie.
      json(res, 200, { signedOut: id }, id === current ? { "set-cookie": sessionCookie("", secure, 0) } : {});
      return true;
    }
    return false;
  };

  const gate = async (req: http.IncomingMessage, res: http.ServerResponse): Promise<boolean> => {
    const host = (req.headers.host ?? "").toLowerCase();
    // A proxy such as `tailscale serve` terminates TLS and forwards with the HTTPS name as Host.
    const viaHttps = publicHosts.has(host);
    if (!viaHttps && !directHosts().has(host)) {
      json(res, 403, { error: "host not allowed" });
      return false;
    }
    const write = !READ_METHODS.has(req.method ?? "");
    if (write && req.headers.origin !== undefined && !originAllowed(req.headers.origin)) {
      json(res, 403, { error: "origin not allowed" });
      return false;
    }
    const { pathname } = requestUrl(req);
    // The sign-in screen has to load before there is a session. Only these static files are open.
    if (isShellRequest(req.method, pathname)) return true;
    const signingIn = req.method === "POST" && pathname === SIGN_IN_PATH;
    const secret = cookieValue(req, SESSION_COOKIE);
    const session = signingIn || secret === undefined || secret === "" ? null : sessions.find(secret);
    if (!signingIn && session === null) {
      json(res, 401, { error: "sign in required" });
      return false;
    }
    if (write && req.method === "POST" && pathname === TRANSCRIBE_PATH) {
      if (audioFormat(req.headers["content-type"]) === null) {
        json(res, 415, { error: "body must be a recording: audio/mp4, audio/webm, audio/ogg or audio/wav" });
        return false;
      }
    } else if (write && !isJson(req)) {
      json(res, 415, { error: "body must be application/json" });
      return false;
    }
    if (signingIn || session === null) {
      await signIn(req, res, viaHttps);
      return false;
    }
    track(session.id, res);
    // Used a day or more after its last renewal: the device gets a fresh 90 days.
    if (session.renewed) res.setHeader("set-cookie", sessionCookie(secret!, viaHttps));
    if (deviceRoutes(req, res, pathname, session.id, viaHttps)) return false;
    return true;
  };
  return { gate };
}
