import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign, verify, type KeyObject } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { inspect } from "node:util";

/*
 * The workbench key (Peers P5, ADR 0004 decision 2). A workbench's identity to another workbench is one Ed25519 public
 * key; its name (P1) is only a label. The key pair is made with node:crypto the first time something needs it, and the
 * private key is kept in the data folder, owner-only (0600), as the login token is. It never leaves this module: what
 * `workbenchKey` returns holds the public key, its fingerprint and a function that signs, and nothing that serialises,
 * logs or inspects to the private key. Anyone who can read the data folder can act as this workbench to its peer, as
 * they can already read the login token (threat model, B16); confined commands cannot read it (U27).
 */

export const WORKBENCH_KEY_FILE = "workbench-key.pem";

/** This workbench's key: the public half as text, its fingerprint, and a signer. The private half is not reachable. */
export interface WorkbenchKey {
  /** The raw 32-byte Ed25519 public key, base64url without padding (43 characters). */
  readonly publicKey: string;
  /** A short form of the public key for two people to compare: five groups of four hex digits. */
  readonly fingerprint: string;
  /** An Ed25519 signature of `bytes` (64 bytes). */
  sign(bytes: Uint8Array): Buffer;
}

const RAW_KEY = /^[A-Za-z0-9_-]{43}$/;

/** Why `key` is not a public key as this module writes one, or null. */
export function publicKeyProblem(key: unknown): string | null {
  if (typeof key !== "string" || !RAW_KEY.test(key) || Buffer.from(key, "base64url").length !== 32 || Buffer.from(key, "base64url").toString("base64url") !== key) {
    return "A workbench key is 32 bytes written as 43 characters of base64url.";
  }
  return null;
}

/**
 * The fingerprint of a public key: the first 10 bytes (80 bits) of its SHA-256, as five groups of four hex digits, such
 * as "3f2a 9c01 77de 0b45 e6a8". The same key always gives the same fingerprint.
 */
export function fingerprintOf(publicKey: string): string {
  const problem = publicKeyProblem(publicKey);
  if (problem !== null) throw new Error(problem);
  const hex = createHash("sha256").update(Buffer.from(publicKey, "base64url")).digest("hex").slice(0, 20);
  return hex.match(/.{4}/g)!.join(" ");
}

const keyObjectOf = (publicKey: string): KeyObject => createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: publicKey }, format: "jwk" });

/** Whether `signature` is `publicKey`'s Ed25519 signature of `bytes`. False for anything malformed, never a throw. */
export function verifySignature(publicKey: string, bytes: Uint8Array, signature: Uint8Array): boolean {
  if (publicKeyProblem(publicKey) !== null || signature.length !== 64) return false;
  try {
    return verify(null, bytes, keyObjectOf(publicKey), signature);
  } catch {
    return false;
  }
}

const rawPublic = (privateKey: KeyObject): string => {
  const jwk = createPublicKey(privateKey).export({ format: "jwk" });
  if (typeof jwk.x !== "string") throw new Error("An Ed25519 key without its public half.");
  return jwk.x;
};

/**
 * Put `data` at `file` only if nothing is there: written to a temporary file (0600) and linked into place, which fails
 * when `file` exists, so a key that appeared meanwhile is never replaced. False when one was there.
 */
function placeOnce(file: string, data: string | Buffer): boolean {
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
  const fd = fs.openSync(tmp, "wx", 0o600);
  try {
    fs.fchmodSync(fd, 0o600);
    fs.writeFileSync(fd, data);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fs.linkSync(tmp, file);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw err;
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

/**
 * This workbench's key, made and kept in `home` the first time it is needed. Later calls read the same key. The file is
 * owner-only, narrowed again if something loosened it.
 */
export function workbenchKey(home: string): WorkbenchKey {
  const file = path.join(home, WORKBENCH_KEY_FILE);
  let privateKey: KeyObject;
  if (fs.existsSync(file)) {
    fs.chmodSync(file, 0o600);
    try {
      privateKey = createPrivateKey({ key: fs.readFileSync(file, "utf8"), format: "pem" });
    } catch {
      throw new Error(`${WORKBENCH_KEY_FILE} in the data folder does not hold this workbench's key. Botbench does not replace it by itself: a new key ends every pairing. To start again with a new key, move the file away and start Botbench; each pairing then needs a new invite.`);
    }
    if (privateKey.asymmetricKeyType !== "ed25519") throw new Error(`${WORKBENCH_KEY_FILE} in the data folder holds a ${privateKey.asymmetricKeyType ?? "unknown"} key, not this workbench's Ed25519 key. Move the file away and start Botbench to make a new one; each pairing then needs a new invite.`);
  } else {
    privateKey = generateKeyPairSync("ed25519").privateKey;
    if (!placeOnce(file, privateKey.export({ format: "pem", type: "pkcs8" }))) return workbenchKey(home);
  }
  const publicKey = rawPublic(privateKey);
  const fingerprint = fingerprintOf(publicKey);
  const shown = { publicKey, fingerprint };
  return Object.freeze({
    publicKey,
    fingerprint,
    sign: (bytes: Uint8Array): Buffer => sign(null, bytes, privateKey),
    // What a log line, a JSON answer or an inspection of this object shows: never the private key.
    toJSON: () => shown,
    [inspect.custom]: () => `WorkbenchKey ${inspect(shown)}`,
  });
}
