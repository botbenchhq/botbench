import { createDecipheriv, createECDH, createHmac, randomBytes } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";

/*
 * The receiving side of Web Push, for tests. `newDevice` makes the keys a browser makes when it subscribes, and
 * `decrypt` reads a message the way the browser does (RFC 8291 and RFC 8188), written here from the RFCs and checked
 * against the RFC 8291 example in test/push.test.ts, so a test can prove a real client could read what Botbench sent.
 * `startPushEndpoint` is a real HTTP server the test starts in the place of the push service's endpoint: it receives
 * the real request Botbench sends and answers with the status the test sets. It is no copy of Botbench's code.
 */

const b64u = (buf: Buffer): string => buf.toString("base64url");

function hkdf(salt: Buffer, ikm: Buffer, info: Buffer, length: number): Buffer {
  const prk = createHmac("sha256", salt).update(ikm).digest();
  return createHmac("sha256", prk).update(Buffer.concat([info, Buffer.from([1])])).digest().subarray(0, length);
}

export interface Device {
  /** The subscription as a browser hands it to the page. */
  subscription(endpoint: string): { endpoint: string; keys: { p256dh: string; auth: string } };
  privateKey: Buffer;
  publicKey: Buffer;
  auth: Buffer;
}

export function newDevice(): Device {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  const auth = randomBytes(16);
  const publicKey = ecdh.getPublicKey();
  return { privateKey: ecdh.getPrivateKey(), publicKey, auth, subscription: (endpoint) => ({ endpoint, keys: { p256dh: b64u(publicKey), auth: b64u(auth) } }) };
}

/** Decrypt one aes128gcm message body with the receiver's private key and auth secret; returns the plaintext without padding. */
export function decrypt(body: Buffer, uaPrivate: Buffer, auth: Buffer): Buffer {
  const salt = body.subarray(0, 16);
  const idlen = body[20]!;
  const asPublic = body.subarray(21, 21 + idlen);
  const ecdh = createECDH("prime256v1");
  ecdh.setPrivateKey(uaPrivate);
  const uaPublic = ecdh.getPublicKey();
  const secret = ecdh.computeSecret(asPublic);
  const ikm = hkdf(auth, secret, Buffer.concat([Buffer.from("WebPush: info\0"), uaPublic, asPublic]), 32);
  const cek = hkdf(salt, ikm, Buffer.from("Content-Encoding: aes128gcm\0"), 16);
  const nonce = hkdf(salt, ikm, Buffer.from("Content-Encoding: nonce\0"), 12);
  const record = body.subarray(21 + idlen);
  const decipher = createDecipheriv("aes-128-gcm", cek, nonce);
  decipher.setAuthTag(record.subarray(record.length - 16));
  const padded = Buffer.concat([decipher.update(record.subarray(0, record.length - 16)), decipher.final()]);
  // The last record ends with 0x02, then zero or more 0x00 of padding.
  let end = padded.length - 1;
  while (end >= 0 && padded[end] === 0) end -= 1;
  if (padded[end] !== 2) throw new Error("no last-record delimiter");
  return padded.subarray(0, end);
}

export interface Received {
  path: string;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

export interface PushEndpoint {
  /** The URL of one subscription's endpoint on this server. */
  url(name: string): string;
  received: Received[];
  /** The status answered for a path; 201 when not set. */
  answer(name: string, status: number): void;
  close(): Promise<void>;
}

export async function startPushEndpoint(): Promise<PushEndpoint> {
  const received: Received[] = [];
  const statuses = new Map<string, number>();
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const path = req.url ?? "/";
      received.push({ path, headers: req.headers, body: Buffer.concat(chunks) });
      res.writeHead(statuses.get(path) ?? 201);
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: (name) => `http://127.0.0.1:${port}/push/${name}`,
    received,
    answer: (name, status) => void statuses.set(`/push/${name}`, status),
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}
