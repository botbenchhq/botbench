/**
 * The one-time code from Settings → Add a device, as the screens show it and as the sign-in address carries it. The code
 * goes after `#`, which a browser never sends to the server, so it stays out of every request line and proxy log.
 */

/** In two groups of four, as it is read out and typed: ABCD-EFGH. */
export const groupCode = (code: string): string => code.replace(/[\s-]/g, "").toUpperCase().replace(/^(.{4})(?=.)/, "$1-");

/** The sign-in address with the code in it, for the QR code: this page's own address. */
export const signInAddress = (origin: string, code: string): string => `${origin}/#code=${groupCode(code)}`;

/** The code an address carries, from its part after `#`, or null when it carries none. */
export function codeFromAddress(hash: string): string | null {
  const found = /^#code=([A-Za-z0-9-]{1,32})$/.exec(hash);
  return found ? groupCode(found[1]!) : null;
}
