import http from "node:http";
import { splitHostPort } from "./address.ts";

/*
 * How bytes reach a paired workbench (Peers P5, ADR 0004 decision 1): one JSON request over HTTP, straight to the
 * peer's listener on a network the two owners already have. This function and the peer listener's handlers
 * (src/peers/listener.ts) are the only places that know the transport; everything else hands them signed values.
 */

/** The four routes of a peer listener, and nothing else. */
export const PEER_ROUTES = ["pair", "message", "settings", "end"] as const;
export type PeerRoute = (typeof PEER_ROUTES)[number];
export const peerPath = (route: PeerRoute): string => `/peer/${route}`;

/** The most a request or an answer between two workbenches may be (decision 8). */
export const MAX_PEER_BYTES = 64 * 1024;
/** How long one request to a peer may take, from connecting to the last byte of the answer. */
export const PEER_REQUEST_MS = 10_000;

export interface PeerReply {
  status: number;
  /** The answer's JSON, or null when it had none that could be read. */
  body: unknown;
}

/**
 * POST `body` to `route` of the peer listener at `address` ("127.0.0.1:4790"), and read its JSON answer. Rejects when
 * the peer cannot be reached, takes too long, or answers with more than 64 KB; an answer of any status resolves.
 * Only an address a peer may be reached at is used: loopback, private or carrier-grade, never a host name.
 */
export function postToPeer(address: string, route: PeerRoute, body: unknown, signal?: AbortSignal): Promise<PeerReply> {
  const target = splitHostPort(address);
  if (target === null) return Promise.reject(new Error(`${address} is not an address Botbench sends peer traffic to.`));
  const payload = Buffer.from(JSON.stringify(body), "utf8");
  if (payload.length > MAX_PEER_BYTES) return Promise.reject(new Error("A request to a paired workbench is at most 64 KB."));
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: target.address, port: target.port, method: "POST", path: peerPath(route), headers: { "content-type": "application/json", "content-length": payload.length }, timeout: PEER_REQUEST_MS, signal, agent: false },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_PEER_BYTES) {
            req.destroy(new Error("The paired workbench answered with more than 64 KB."));
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", () => {
          let parsed: unknown = null;
          try {
            parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          } catch {
            parsed = null;
          }
          resolve({ status: res.statusCode ?? 0, body: parsed });
        });
        res.on("error", reject);
      },
    );
    const limit = setTimeout(() => req.destroy(new Error(`The paired workbench at ${address} did not answer within ${PEER_REQUEST_MS / 1000} seconds.`)), PEER_REQUEST_MS);
    limit.unref();
    req.on("timeout", () => req.destroy(new Error(`The paired workbench at ${address} did not answer within ${PEER_REQUEST_MS / 1000} seconds.`)));
    req.on("error", (err) => {
      clearTimeout(limit);
      reject(err);
    });
    req.on("close", () => clearTimeout(limit));
    req.end(payload);
  });
}
