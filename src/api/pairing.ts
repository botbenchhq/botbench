import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

/**
 * Adding a device with a one-time code. A signed-in device asks for a code (Settings → Signed-in devices → Add a
 * device); another device types it on the sign-in screen, or opens the address the QR code holds, and is signed in as
 * with the login token. One code at a time: a new one cancels the last. It works once, for 5 minutes. The store keeps
 * its SHA-256 and its expiry in `device_pairing`, never the code, and Botbench never logs it.
 *
 * After OpenMausBot's pairing codes (`server/sessions.ts`: rejection-sampled symbols, only the hash kept, a digest
 * compared in constant time, expired pairings dropped; `packages/phone-protocol/src/pairing-code.ts`: an alphabet with
 * no look-alikes, shown in groups of four, dashes, spaces and case ignored) and Rakazo's devices
 * (`packages/adapters/src/computers/host/user-device-gateway.ts`: looked up by hash, compared again in constant time).
 */

/** No 0, 1, I or O, which read alike. 32 symbols, 5 bits each. */
export const PAIRING_CODE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
export const PAIRING_CODE_LENGTH = 8;
export const PAIRING_LIFETIME_MS = 5 * 60 * 1000;

/** Why a code did not sign in. A code never issued, and one that is not a code at all, read as `wrong`. */
export type Refusal = "wrong" | "used" | "expired" | "replaced";

/** The plain-words answer for each refusal, which the sign-in screen shows as it is. */
export const REFUSAL_WORDS: Record<Refusal, string> = {
  wrong: "Wrong code. Check it, or make a new one in Settings → Signed-in devices on a device that is signed in.",
  used: "That code was already used. A code works once: make a new one in Settings → Signed-in devices on a device that is signed in.",
  expired: "That code has expired. Make a new one in Settings → Signed-in devices on a device that is signed in.",
  replaced: "That code was replaced by a newer one. Use the code Settings shows now, or make a new one.",
};

/** 8 symbols from the system's random source. Rejection sampling keeps every symbol equally likely for any alphabet size. */
export function generatePairingCode(): string {
  const limit = Math.floor(256 / PAIRING_CODE_ALPHABET.length) * PAIRING_CODE_ALPHABET.length;
  let code = "";
  while (code.length < PAIRING_CODE_LENGTH) {
    for (const byte of randomBytes(PAIRING_CODE_LENGTH)) {
      if (byte >= limit) continue;
      code += PAIRING_CODE_ALPHABET[byte % PAIRING_CODE_ALPHABET.length];
      if (code.length === PAIRING_CODE_LENGTH) break;
    }
  }
  return code;
}

/** A code as typed or pasted: case, spaces and dashes do not matter. */
export const normalizePairingCode = (input: string): string => input.toUpperCase().replace(/[\s-]/g, "");

const digest = (code: string): Buffer => createHash("sha256").update(normalizePairingCode(code)).digest();

/** Compare two stored or presented digests in constant time. */
function same(stored: unknown, presented: Buffer): boolean {
  if (typeof stored !== "string") return false;
  const kept = Buffer.from(stored, "hex");
  return kept.length === presented.length && timingSafeEqual(kept, presented);
}

export interface Pairing {
  /**
   * Make a new code on the signed-in device `madeBy`, cancelling the one before it. The code is returned once, here, and
   * kept nowhere. It is tied to that device's session: signing the device out deletes the pairing (`ON DELETE CASCADE`).
   */
  create(madeBy: number): { code: string; expiresAt: string };
  /** Use a code: the id of the session that made it when it signs in, which it does once; otherwise why not. */
  redeem(code: string): { madeBy: number } | Refusal;
}

export function createPairing(db: DatabaseSync, lifetimeMs: number = PAIRING_LIFETIME_MS): Pairing {
  const iso = (ms: number): string => new Date(ms).toISOString();
  const dropExpired = (now: number): void => void db.prepare("DELETE FROM device_pairing WHERE expires_at <= ?").run(iso(now));
  dropExpired(Date.now());

  const create = (madeBy: number): { code: string; expiresAt: string } => {
    const now = Date.now();
    dropExpired(now);
    const code = generatePairingCode();
    const expiresAt = iso(now + lifetimeMs);
    const previous = db.prepare("SELECT code_hash FROM device_pairing WHERE id = 1").get();
    db.prepare("INSERT OR REPLACE INTO device_pairing (id, session_id, code_hash, expires_at, used_at, replaced_hash) VALUES (1, ?, ?, ?, NULL, ?)").run(
      madeBy,
      digest(code).toString("hex"),
      expiresAt,
      previous === undefined ? null : String(previous.code_hash),
    );
    return { code, expiresAt };
  };

  const redeem = (code: string): { madeBy: number } | Refusal => {
    const presented = digest(code);
    const row = db.prepare("SELECT session_id, code_hash, expires_at, used_at, replaced_hash FROM device_pairing WHERE id = 1").get();
    if (row === undefined) return "wrong";
    const current = same(row.code_hash, presented);
    const replaced = same(row.replaced_hash, presented);
    const now = Date.now();
    if (!(Date.parse(String(row.expires_at)) > now)) {
      dropExpired(now);
      return current || replaced ? "expired" : "wrong";
    }
    if (replaced) return "replaced";
    if (!current) return "wrong";
    if (row.used_at !== null) return "used";
    // Single use even if two sign-ins were ever checked at once: only the first sets `used_at`.
    const taken = db.prepare("UPDATE device_pairing SET used_at = ? WHERE id = 1 AND used_at IS NULL AND code_hash = ?").run(iso(now), presented.toString("hex"));
    return taken.changes === 1 ? { madeBy: Number(row.session_id) } : "used";
  };

  return { create, redeem };
}
