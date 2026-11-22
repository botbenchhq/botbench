import { createHash } from "node:crypto";
import fs from "node:fs";
import type http from "node:http";
import path from "node:path";

/**
 * The built client: `index.html` and the hashed files Vite puts under
 * `assets/`. These hold no data, so they are served without a session and the
 * sign-in screen can load. Everything else needs one.
 */

const ASSETS_PREFIX = "/assets/";

/** Whether a request is for the client shell. The auth gate and the router both ask this, so they cannot disagree. */
export function isShellRequest(method: string | undefined, pathname: string): boolean {
  if (method !== "GET" && method !== "HEAD") return false;
  return pathname === "/" || pathname === "/index.html" || (pathname.startsWith(ASSETS_PREFIX) && pathname.length > ASSETS_PREFIX.length);
}

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
};

/** The page may load from Botbench itself and nowhere else, and nothing may frame it. */
const CONTENT_SECURITY_POLICY = "default-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

/**
 * The policy for one page: the base policy, and when the page holds inline scripts (the one that applies the owner's
 * appearance choice before the first paint), each allowed by the SHA-256 of its exact text and nothing else: no
 * 'unsafe-inline'. The page is Botbench's own build, read from the client folder, so a script is allowed only as built.
 */
function policyFor(page: string): string {
  const hashes = [...page.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => `'sha256-${createHash("sha256").update(match[1]!).digest("base64")}'`);
  return hashes.length === 0 ? CONTENT_SECURITY_POLICY : `${CONTENT_SECURITY_POLICY}; script-src 'self' ${hashes.join(" ")}`;
}

function plain(res: http.ServerResponse, status: number, text: string): void {
  res.writeHead(status, { "content-type": "text/plain; charset=utf-8", "content-length": Buffer.byteLength(text), "cache-control": "no-store", "x-content-type-options": "nosniff" });
  res.end(res.req.method === "HEAD" ? undefined : text);
}

/**
 * The file under `clientDir` a shell path names, or null when it names nothing
 * servable: a path that leaves the directory by any spelling, a link that
 * points out of it, a directory, or an unknown file type.
 */
function resolveFile(clientDir: string, pathname: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decoded.includes("\0") || decoded.includes("\\")) return null;
  const relative = decoded === "/" ? "index.html" : decoded.slice(1);
  if (relative.split("/").some((part) => part === "" || part === "." || part === "..")) return null;
  if (!(path.extname(relative) in CONTENT_TYPES)) return null;
  let root: string;
  let file: string;
  try {
    root = fs.realpathSync(clientDir);
    file = fs.realpathSync(path.join(root, relative));
  } catch {
    return null;
  }
  if (!file.startsWith(root + path.sep)) return null;
  return fs.statSync(file).isFile() ? file : null;
}

/** Answer a request `isShellRequest` accepted. */
export function serveShell(req: http.IncomingMessage, res: http.ServerResponse, clientDir: string, pathname: string): void {
  const isPage = pathname === "/" || pathname === "/index.html";
  const file = resolveFile(clientDir, pathname);
  if (file === null) {
    if (isPage) return plain(res, 503, "The Botbench client has not been built. Run: npm run build --prefix web\n");
    return plain(res, 404, "Not found\n");
  }
  const body = fs.readFileSync(file);
  res.writeHead(200, {
    "content-type": CONTENT_TYPES[path.extname(file)]!,
    "content-length": body.length,
    // The page is small and names its hashed files, so it is always checked; the hashed files never change.
    "cache-control": isPage ? "no-cache" : "public, max-age=31536000, immutable",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    ...(isPage ? { "content-security-policy": policyFor(body.toString("utf8")) } : {}),
  });
  res.end(req.method === "HEAD" ? undefined : body);
}
