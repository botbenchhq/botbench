// What a confined command can reach on the network, run inside the sandbox as a project's own test file would be.
// Arguments: a Unix socket to try that lies outside the copy and the temporary folder, and Botbench's own port.
// Each line printed is `name=ok`, `name=<error code>` or, for Botbench's port, `botbench=<HTTP status>`.
const net = require("net"), http = require("http"), path = require("path");
const [, , unixOutside, botbenchPort] = process.argv;
const line = (name, value) => console.log(name + "=" + value);
const attempt = (name, opts) => new Promise((done) => {
  const c = net.connect(opts);
  c.setTimeout(5000, () => (line(name, "timeout"), c.destroy(), done()));
  c.on("connect", () => (line(name, "ok"), c.destroy(), done()));
  c.on("error", (e) => (line(name, e.code), done()));
});
const serve = (name, at) => new Promise((done) => {
  const server = http.createServer((req, res) => res.end("served"));
  server.on("error", (e) => (line(name, e.code), done()));
  server.listen(at, () => http.get(typeof at === "string" ? { socketPath: at, path: "/" } : { host: at.host, port: server.address().port, path: "/" }, (res) => {
    let body = ""; res.on("data", (d) => (body += d)); res.on("end", () => (line(name, body === "served" ? "ok" : body), server.close(done)));
  }).on("error", (e) => (line(name, e.code), server.close(done))));
});
(async () => {
  await serve("http4", { host: "127.0.0.1", port: 0 });
  await serve("http6", { host: "::1", port: 0 });
  await serve("unixTmp", path.join(process.env.TMPDIR, "s.sock"));
  await serve("unixCopy", path.join(process.cwd(), "s.sock"));
  await attempt("internet", { host: "1.1.1.1", port: 443 });
  await attempt("internet6", { host: "2606:4700:4700::1111", port: 443 });
  await attempt("network", { host: "192.0.2.1", port: 80 });
  line("tmpdir", process.env.TMPDIR);
  if (unixOutside) await attempt("unixOutside", unixOutside);
  if (botbenchPort) await new Promise((done) => http.get({ host: "127.0.0.1", port: Number(botbenchPort), path: "/api/board" }, (res) => (line("botbench", res.statusCode), res.resume(), res.on("end", done))).on("error", (e) => (line("botbench", e.code), done())));
})();
