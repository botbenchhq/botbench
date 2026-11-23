import net from "node:net";

/*
 * Where a peer listener may listen, and which addresses Botbench sends peer traffic to (Peers P5, ADR 0004 decision 1).
 * Only an address on a network the owners already have: loopback, a private range (RFC 1918 for IPv4, RFC 4193 for
 * IPv6) or the carrier-grade range 100.64.0.0/10 that private overlay networks such as Tailscale use. Never a public
 * address, never "every address" (0.0.0.0, ::), and never a host name, whose address could change after the check.
 */

const allowed = new net.BlockList();
allowed.addSubnet("127.0.0.0", 8, "ipv4");
allowed.addSubnet("10.0.0.0", 8, "ipv4");
allowed.addSubnet("172.16.0.0", 12, "ipv4");
allowed.addSubnet("192.168.0.0", 16, "ipv4");
allowed.addSubnet("100.64.0.0", 10, "ipv4");
allowed.addAddress("::1", "ipv6");
allowed.addSubnet("fc00::", 7, "ipv6");

export const PEER_ADDRESS_RULE =
  "The peer listener listens only on loopback (127.0.0.1 or ::1), a private address (10.x.x.x, 172.16.x.x to 172.31.x.x, 192.168.x.x, or an IPv6 address starting fc or fd) or a 100.64.0.0/10 address such as a Tailscale one. Write the address itself, not a host name.";

/** Why `address` may not carry peer traffic, as a sentence, or null when it is loopback, private or carrier-grade. */
export function peerAddressProblem(address: unknown): string | null {
  if (typeof address !== "string" || address === "") return `It must be an address such as "127.0.0.1". ${PEER_ADDRESS_RULE}`;
  const family = net.isIP(address);
  if (family === 0) return `${JSON.stringify(address.slice(0, 100))} is not an IP address. ${PEER_ADDRESS_RULE}`;
  // An IPv4 address written inside IPv6 (::ffff:10.0.0.1), or one with a zone (fe80::1%en0), is not one of the forms above.
  if (family === 6 && (address.includes(".") || address.includes("%"))) return `${JSON.stringify(address)} is written in a form Botbench does not take. ${PEER_ADDRESS_RULE}`;
  if (!allowed.check(address, family === 4 ? "ipv4" : "ipv6")) return `${JSON.stringify(address)} is not a loopback or private address, so other people could reach the listener. ${PEER_ADDRESS_RULE}`;
  return null;
}

/** One listener's address and port, as an invite and a pair request carry it: "127.0.0.1:4790" or "[fd00::1]:4790". */
export function joinHostPort(address: string, port: number): string {
  return net.isIPv6(address) ? `[${address}]:${port}` : `${address}:${port}`;
}

/** The address and port in `text`, or null when it is not one listener a peer may be reached at. */
export function splitHostPort(text: unknown): { address: string; port: number } | null {
  if (typeof text !== "string" || text.length > 60) return null;
  const found = /^\[([0-9A-Fa-f:]+)\]:(\d{1,5})$/.exec(text) ?? /^(\d{1,3}(?:\.\d{1,3}){3}):(\d{1,5})$/.exec(text);
  if (found === null) return null;
  const port = Number(found[2]);
  if (!Number.isInteger(port) || port < 1 || port > 65535 || String(port) !== found[2]) return null;
  if (peerAddressProblem(found[1]) !== null) return null;
  return { address: found[1]!, port };
}
