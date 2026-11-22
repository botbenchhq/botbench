import { createCipheriv, createECDH, createPrivateKey, ECDH, generateKeyPairSync, hkdfSync, randomBytes, sign, type JsonWebKey, type KeyObject } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { Approval } from "./approvals/broker.ts";
import { now } from "./store/db.ts";
import { writeFileAtomic } from "./store/atomic.ts";

/*
 * Notifications to the owner's devices (unit 23, KTD16): standard Web Push, with node:crypto only.
 *   - RFC 8291 message encryption with the RFC 8188 aes128gcm content coding: each message is encrypted to the
 *     device's own key, so the push service (Apple's or Google's) carries it without being able to read it.
 *   - RFC 8292 VAPID: Botbench signs each request with its own P-256 key, made on first use and kept owner-only in the
 *     data folder. The push service learns the public key and that a message was sent, nothing else.
 * What a message says is fixed: a short sentence and the screen to open. Never a command, code, a path, a repository's
 * name or the words of a task (R24). KTD16 allows the run's name too, but a run has no name of its own: what a card
 * shows as its title is the first line of the owner's prompt, which can hold any of those, so it is left out.
 * Sending never holds up or fails what caused it: an approval or a task goes on as if no device were subscribed.
 */

export const PUSH_KEYS_FILE = "push-keys.json";
/** How long a push service keeps a message for a device that is offline. An approval waits about as long. */
const TTL_SECONDS = 12 * 3600;
const SEND_TIMEOUT_MS = 10_000;
const RECORD_SIZE = 4096;
/** The VAPID contact. Push services want one; this one names no person, so nothing about the owner reaches them. */
const VAPID_SUBJECT = "mailto:botbench@example.com";
const MAX_ENDPOINT = 2048;

export interface PushKeys {
  /** The uncompressed P-256 point, 65 bytes: the browser's applicationServerKey and the VAPID `k`. */
  publicKey: Buffer;
  privateKey: KeyObject;
}

/** Read Botbench's push keys, making them on first use. The file is owner-only, narrowed again if something loosened it. */
export function loadOrCreatePushKeys(home: string): PushKeys {
  const file = path.join(home, PUSH_KEYS_FILE);
  let jwk: JsonWebKey;
  if (fs.existsSync(file)) {
    fs.chmodSync(file, 0o600);
    try {
      jwk = JSON.parse(fs.readFileSync(file, "utf8")) as JsonWebKey;
    } catch {
      throw new Error(`${file} does not hold Botbench's notification keys. Delete it and start Botbench again; each device then allows notifications again.`);
    }
  } else {
    jwk = generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey.export({ format: "jwk" });
    writeFileAtomic(file, `${JSON.stringify(jwk)}\n`, 0o600);
  }
  if (jwk.kty !== "EC" || jwk.crv !== "P-256" || typeof jwk.x !== "string" || typeof jwk.y !== "string" || typeof jwk.d !== "string") {
    throw new Error(`${file} does not hold a P-256 key. Delete it and start Botbench again; each device then allows notifications again.`);
  }
  return { publicKey: Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, "base64url"), Buffer.from(jwk.y, "base64url")]), privateKey: createPrivateKey({ key: jwk, format: "jwk" }) };
}

const hkdf = (salt: Buffer, ikm: Buffer, info: Buffer, length: number): Buffer => Buffer.from(hkdfSync("sha256", ikm, salt, info, length));

/**
 * Encrypt one message to a device (RFC 8291 section 3.4, one aes128gcm record). `salt` and `asPrivate` are for the
 * RFC's own test vector; left out, both are fresh for every message, as the RFC requires.
 */
export function encryptMessage(plaintext: Buffer, device: { p256dh: Buffer; auth: Buffer }, o: { salt?: Buffer; asPrivate?: Buffer } = {}): Buffer {
  if (plaintext.length > RECORD_SIZE - 17) throw new Error("A notification is longer than one record.");
  const ecdh = createECDH("prime256v1");
  if (o.asPrivate) ecdh.setPrivateKey(o.asPrivate);
  else ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const secret = ecdh.computeSecret(device.p256dh);
  const salt = o.salt ?? randomBytes(16);
  const ikm = hkdf(device.auth, secret, Buffer.concat([Buffer.from("WebPush: info\0"), device.p256dh, asPublic]), 32);
  const cek = hkdf(salt, ikm, Buffer.from("Content-Encoding: aes128gcm\0"), 16);
  const nonce = hkdf(salt, ikm, Buffer.from("Content-Encoding: nonce\0"), 12);
  const header = Buffer.alloc(21);
  salt.copy(header, 0);
  header.writeUInt32BE(RECORD_SIZE, 16);
  header[20] = asPublic.length;
  const cipher = createCipheriv("aes-128-gcm", cek, nonce);
  // 0x02 marks the last (here the only) record; no further padding.
  const sealed = Buffer.concat([cipher.update(Buffer.concat([plaintext, Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  return Buffer.concat([header, asPublic, sealed]);
}

/** The `Authorization` header for one request to `endpoint` (RFC 8292): a JWT for the endpoint's origin, signed ES256. */
export function vapidAuthorization(endpoint: string, keys: PushKeys, at = Date.now()): string {
  const part = (value: object): string => Buffer.from(JSON.stringify(value)).toString("base64url");
  const unsigned = `${part({ typ: "JWT", alg: "ES256" })}.${part({ aud: new URL(endpoint).origin, exp: Math.floor(at / 1000) + 12 * 3600, sub: VAPID_SUBJECT })}`;
  const signature = sign("sha256", Buffer.from(unsigned), { key: keys.privateKey, dsaEncoding: "ieee-p1363" });
  return `vapid t=${unsigned}.${signature.toString("base64url")}, k=${keys.publicKey.toString("base64url")}`;
}

/** What a notification carries: its one fixed sentence, and the screen of Botbench it opens. */
export interface PushMessage {
  title: string;
  path: string;
}

export function approvalMessage(approval: Pick<Approval, "taskId" | "runId">): PushMessage {
  return { title: "An approval is waiting", path: approval.taskId !== null ? `/#/tasks/${approval.taskId}` : `/#/runs/${approval.runId}` };
}
export function readyMessage(task: { id: number }): PushMessage {
  return { title: "A task is ready for review", path: `/#/tasks/${task.id}` };
}
export function testMessage(): PushMessage {
  return { title: "Test notification from Botbench", path: "/#/settings" };
}

export class PushError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

interface Subscription {
  endpoint: string;
  p256dh: Buffer;
  auth: Buffer;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const base64url = (v: unknown, bytes: number): Buffer | null => (typeof v === "string" && /^[A-Za-z0-9_-]+={0,2}$/.test(v) && Buffer.from(v, "base64url").length === bytes ? Buffer.from(v, "base64url") : null);

/** Where a message for a subscription goes, for the log: the push service's origin. The path is the device's secret. */
const origin = (endpoint: string): string => new URL(endpoint).origin;

export interface Push {
  /** The key a browser subscribes with, base64url. */
  publicKey: string;
  /** Store a browser's subscription (`PushSubscription.toJSON()`); the same endpoint again replaces its keys. Throws PushError(400). */
  subscribe(body: unknown): void;
  /** Remove a device's subscription; whether there was one. */
  unsubscribe(endpoint: string): boolean;
  subscribed(endpoint: string): boolean;
  /** Send the test notification to one device. Throws PushError: 404 not subscribed, 410 expired (and removed), 502 not taken. */
  sendTest(endpoint: string): Promise<void>;
  /** The broker's listener: a newly pending approval notifies every device once. */
  approvalChanged(approval: Approval): void;
  /** The engine's listener: a task that has reached Ready for review notifies every device once. */
  taskChanged(task: { id: number; status: string }): void;
  /** Resolves when every message in flight has been sent or has failed. */
  idle(): Promise<void>;
}

export function createPush(options: { db: DatabaseSync; home: string; allowHttpEndpoints?: boolean }): Push {
  const { db } = options;
  const keys = loadOrCreatePushKeys(options.home);
  const inFlight = new Set<Promise<unknown>>();
  // In memory: after a restart, what was already announced is not announced again, and nothing old is either,
  // because only a change seen by this process sends.
  const approvalsSent = new Set<number>();
  const tasksSent = new Set<number>();

  const rows = (): Subscription[] =>
    db
      .prepare("SELECT endpoint, p256dh, auth FROM push_subscriptions ORDER BY id")
      .all()
      .map((row) => ({ endpoint: String(row.endpoint), p256dh: Buffer.from(String(row.p256dh), "base64url"), auth: Buffer.from(String(row.auth), "base64url") }));
  const remove = (endpoint: string): boolean => Number(db.prepare("DELETE FROM push_subscriptions WHERE endpoint = ?").run(endpoint).changes) > 0;

  /** One request to one device's endpoint. Never throws: the outcome says what happened, and a failure is logged. */
  const deliver = async (sub: Subscription, message: PushMessage): Promise<"sent" | "gone" | "failed"> => {
    const where = origin(sub.endpoint);
    try {
      const res = await fetch(sub.endpoint, {
        method: "POST",
        headers: { ttl: String(TTL_SECONDS), urgency: "high", "content-encoding": "aes128gcm", "content-type": "application/octet-stream", authorization: vapidAuthorization(sub.endpoint, keys) },
        body: new Uint8Array(encryptMessage(Buffer.from(JSON.stringify(message)), sub)),
        redirect: "error",
        signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      });
      await res.arrayBuffer().catch(() => undefined);
      if (res.ok) return "sent";
      if (res.status === 404 || res.status === 410) {
        remove(sub.endpoint);
        console.error(`A notification to ${where} was refused with ${res.status}: that device's subscription has expired and was removed.`);
        return "gone";
      }
      console.error(`A notification to ${where} was refused with ${res.status}.`);
      return "failed";
    } catch (err) {
      const cause = err instanceof Error && err.cause instanceof Error ? `: ${err.cause.message}` : "";
      console.error(`A notification to ${where} could not be sent: ${err instanceof Error ? err.message : String(err)}${cause}`);
      return "failed";
    }
  };

  const track = <T>(p: Promise<T>): Promise<T> => {
    inFlight.add(p);
    void p.finally(() => inFlight.delete(p));
    return p;
  };

  const sendAll = (message: PushMessage): void => {
    let subs: Subscription[];
    try {
      subs = rows();
    } catch (err) {
      return console.error(`The devices to notify could not be read: ${err instanceof Error ? err.message : String(err)}`);
    }
    for (const sub of subs) void track(deliver(sub, message));
  };

  const subscribe = (body: unknown): void => {
    // voice: not on screen. The client sends what the browser made; these reach a person only if the browser is wrong.
    if (!isObject(body) || typeof body.endpoint !== "string" || !isObject(body.keys)) throw new PushError(400, 'expected { "endpoint": "...", "keys": { "p256dh": "...", "auth": "..." } }');
    let url: URL;
    try {
      url = new URL(body.endpoint);
    } catch {
      throw new PushError(400, "The notification address from this browser is not an address.");
    }
    const schemeOk = url.protocol === "https:" || (options.allowHttpEndpoints === true && url.protocol === "http:");
    if (!schemeOk || url.username !== "" || url.password !== "" || body.endpoint.length > MAX_ENDPOINT) throw new PushError(400, "The notification address from this browser is not one Botbench sends to: it must be a plain HTTPS address.");
    const p256dh = base64url(body.keys.p256dh, 65);
    const auth = base64url(body.keys.auth, 16);
    let pointOk = p256dh !== null;
    try {
      if (p256dh) ECDH.convertKey(p256dh, "prime256v1");
    } catch {
      pointOk = false;
    }
    if (!pointOk || auth === null) throw new PushError(400, "The keys from this browser are not keys Botbench can encrypt to.");
    db.prepare("INSERT INTO push_subscriptions (endpoint, p256dh, auth, created_at) VALUES (?, ?, ?, ?) ON CONFLICT (endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth").run(
      body.endpoint,
      p256dh!.toString("base64url"),
      auth.toString("base64url"),
      now(),
    );
  };

  const subscribed = (endpoint: string): boolean => db.prepare("SELECT 1 FROM push_subscriptions WHERE endpoint = ?").get(endpoint) !== undefined;

  const sendTest = async (endpoint: string): Promise<void> => {
    const sub = rows().find((row) => row.endpoint === endpoint);
    if (!sub) throw new PushError(404, "Notifications are not on for this device. Choose Allow notifications first.");
    const outcome = await track(deliver(sub, testMessage()));
    if (outcome === "gone") throw new PushError(410, "Notifications for this device had expired. Choose Allow notifications again.");
    if (outcome === "failed") throw new PushError(502, "The test notification could not be sent. The reason is in Botbench's log. Try again in a moment.");
  };

  const approvalChanged = (approval: Approval): void => {
    try {
      // Only an approval newly asked in this run: an answer to a parked one stays pending but asks nothing new.
      if (approval.status !== "pending" || approval.parkedAt !== null || approval.storedDecision !== null || approvalsSent.has(approval.id)) return;
      approvalsSent.add(approval.id);
      sendAll(approvalMessage(approval));
    } catch (err) {
      console.error(`A notification for an approval could not be started: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const taskChanged = (task: { id: number; status: string }): void => {
    try {
      if (task.status !== "awaiting_decision" || tasksSent.has(task.id)) return;
      tasksSent.add(task.id);
      sendAll(readyMessage(task));
    } catch (err) {
      console.error(`A notification for a task could not be started: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const idle = async (): Promise<void> => {
    while (inFlight.size > 0) await Promise.allSettled([...inFlight]);
  };

  return { publicKey: keys.publicKey.toString("base64url"), subscribe, unsubscribe: remove, subscribed, sendTest, approvalChanged, taskChanged, idle };
}
