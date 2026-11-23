import assert from "node:assert/strict";
import { test } from "node:test";
import { publicWebAddress } from "../../src/approvals/web-access.ts";

// Which addresses a web fetch may reach on Allow without asking: a public web page only. Pure, no network.

test("a fetch of this Mac, a local network or an address that only names one is never a public web page", () => {
  const local = [
    "http://127.0.0.1:4780/api/approvals", "http://localhost:8080/", "http://app.localhost/", "http://[::1]/", "http://192.168.1.1/", "http://10.0.0.5/", "http://172.16.3.4/",
    "http://169.254.169.254/latest/meta-data", "http://printer.local/", "http://router.home/", "http://nas.lan/", "http://db.internal/", "http://box.home.arpa/", "http://intranet/",
    // Names whose public DNS answers with the address they embed.
    "http://localtest.me/", "http://api.localtest.me/", "http://127.0.0.1.nip.io/", "http://app.10.0.0.5.nip.io/", "http://192-168-1-1.sslip.io/", "http://10.0.0.1.xip.io/", "http://7f000001.nip.io/",
    // Special IPv4 ranges: benchmarking, IETF protocol assignments, shared address space.
    "http://198.18.0.1/", "http://198.19.255.254/", "http://192.0.0.8/", "http://100.64.0.1/",
    // IPv6: site-local, NAT64 (the IPv4 inside it), unique-local, link-local, mapped IPv4.
    "http://[fec0::1]/", "http://[feff::1]/", "http://[64:ff9b::7f00:1]/", "http://[64:ff9b::c0a8:101]/", "http://[64:ff9b::808:808]/", "http://[fd00::1]/", "http://[fe80::1]/", "http://[::ffff:127.0.0.1]/",
    "http://0.0.0.0/", "file:///etc/passwd", "ftp://example.com/x", "not a url",
  ];
  for (const url of local) assert.equal(publicWebAddress(url), false, url);
});

test("a public web page is one", () => {
  for (const url of ["https://example.com", "https://docs.example.org/a?b=c", "http://8.8.8.8/", "http://198.20.0.1/", "http://192.0.2.1.example.com/", "https://[2606:4700::1111]/", "https://nip.io.example.com/"]) assert.equal(publicWebAddress(url), true, url);
});
