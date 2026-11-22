import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

/**
 * The owner's signed-in devices. Each sign-in is one row of `browser_sessions`, so a device stays signed in across
 * restarts. The row holds the SHA-256 of the session secret, never the secret: a copy of the database signs nobody in.
 */

/** How long a device stays signed in after it was last renewed: 90 days. */
export const SESSION_MAX_AGE_S = 90 * 24 * 60 * 60;
const MAX_AGE_MS = SESSION_MAX_AGE_S * 1000;
/** A session used this long after its last renewal gets a fresh 90 days (and its cookie again). */
const RENEW_AFTER_MS = 24 * 60 * 60 * 1000;
/** The last-used time is written at most this often, so requests do not each write to the database. */
const TOUCH_AFTER_MS = 60 * 1000;

/** A short name for the device a sign-in came from, read from its User-Agent: "iPhone · Safari", "Mac · Chrome". */
export function deviceLabel(userAgent: string | undefined): string {
  const ua = userAgent ?? "";
  const platform = /iPhone/.test(ua) ? "iPhone" : /iPad/.test(ua) ? "iPad" : /Android/.test(ua) ? "Android" : /Macintosh/.test(ua) ? "Mac" : /Windows/.test(ua) ? "Windows" : /Linux/.test(ua) ? "Linux" : null;
  const ios = platform === "iPhone" || platform === "iPad";
  const browser = /Edg(A|iOS)?\//.test(ua)
    ? "Edge"
    : /Firefox\/|FxiOS\//.test(ua)
      ? "Firefox"
      : /Chrome\/|CriOS\//.test(ua)
        ? "Chrome"
        : /Version\/[\d.]+.*Safari\//.test(ua)
          ? "Safari"
          : // An app added to the Home Screen on iOS reports WebKit with no browser name.
            ios && /AppleWebKit\//.test(ua)
            ? "Home Screen app"
            : null;
  if (platform === null) return browser ?? "Browser";
  return browser === null ? platform : `${platform} · ${browser}`;
}

export interface Device {
  id: number;
  device: string;
  signedInAt: string;
  lastUsedAt: string;
}

export interface Found {
  id: number;
  /** True when this request gave the session a fresh 90 days: the cookie is to be sent again. */
  renewed: boolean;
}

export interface Sessions {
  /** Start a session for a device. Returns its secret, which goes into the cookie and nowhere else. */
  create(device: string): { id: number; secret: string };
  /** The session a cookie value names, if it stands; an expired one is removed. Renews and touches it as it is used. */
  find(secret: string): Found | null;
  list(): Device[];
  /** End one session. False when there was none with that id. */
  end(id: number): boolean;
  /** End every session but `keep`. Returns the ids ended. */
  endAllBut(keep: number): number[];
}

const hash = (secret: string): Buffer => createHash("sha256").update(secret).digest();

export function createSessions(db: DatabaseSync): Sessions {
  const iso = (ms: number): string => new Date(ms).toISOString();
  // Expired rows go at start, and later one at a time as they are met.
  db.prepare("DELETE FROM browser_sessions WHERE expires_at <= ?").run(iso(Date.now()));

  const create = (device: string): { id: number; secret: string } => {
    const now = Date.now();
    // 256 bits from the system's random source.
    const secret = randomBytes(32).toString("base64url");
    const result = db
      .prepare("INSERT INTO browser_sessions (secret_hash, device, created_at, last_used_at, expires_at) VALUES (?, ?, ?, ?, ?)")
      .run(hash(secret).toString("hex"), device, iso(now), iso(now), iso(now + MAX_AGE_MS));
    return { id: Number(result.lastInsertRowid), secret };
  };

  const find = (secret: string): Found | null => {
    const digest = hash(secret);
    // Looked up by its hash, so the time a lookup takes says nothing about the secret; then compared in constant time.
    const row = db.prepare("SELECT id, secret_hash, last_used_at, expires_at FROM browser_sessions WHERE secret_hash = ?").get(digest.toString("hex"));
    if (row === undefined) return null;
    const stored = Buffer.from(String(row.secret_hash), "hex");
    if (stored.length !== digest.length || !timingSafeEqual(stored, digest)) return null;
    const id = Number(row.id);
    const now = Date.now();
    const expires = Date.parse(String(row.expires_at));
    if (!(expires > now)) {
      db.prepare("DELETE FROM browser_sessions WHERE id = ?").run(id);
      return null;
    }
    const renewed = expires - now < MAX_AGE_MS - RENEW_AFTER_MS;
    const touch = now - Date.parse(String(row.last_used_at)) >= TOUCH_AFTER_MS;
    if (renewed) db.prepare("UPDATE browser_sessions SET expires_at = ?, last_used_at = ? WHERE id = ?").run(iso(now + MAX_AGE_MS), iso(now), id);
    else if (touch) db.prepare("UPDATE browser_sessions SET last_used_at = ? WHERE id = ?").run(iso(now), id);
    return { id, renewed };
  };

  const list = (): Device[] =>
    db
      .prepare("SELECT id, device, created_at, last_used_at FROM browser_sessions WHERE expires_at > ? ORDER BY id")
      .all(iso(Date.now()))
      .map((row) => ({ id: Number(row.id), device: String(row.device), signedInAt: String(row.created_at), lastUsedAt: String(row.last_used_at) }));

  const end = (id: number): boolean => db.prepare("DELETE FROM browser_sessions WHERE id = ?").run(id).changes > 0;

  const endAllBut = (keep: number): number[] => db.prepare("DELETE FROM browser_sessions WHERE id <> ? RETURNING id").all(keep).map((row) => Number(row.id));

  return { create, find, list, end, endAllBut };
}
