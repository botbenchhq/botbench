import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

// Build the client when it has never been built or a source file is newer than the build.

const web = path.resolve(import.meta.dirname, "..", "web");
const built = path.join(web, "dist", "index.html");

function newest(target: string): number {
  const stat = fs.statSync(target);
  if (!stat.isDirectory()) return stat.mtimeMs;
  return Math.max(0, ...fs.readdirSync(target).map((name) => newest(path.join(target, name))));
}

const sources = ["src", "index.html", "package.json", "package-lock.json", "tailwind.config.ts", "vite.config.ts", "postcss.config.js"].map((name) => path.join(web, name));
if (!fs.existsSync(built) || Math.max(...sources.map(newest)) > fs.statSync(built).mtimeMs) {
  console.log("Building the client.");
  execFileSync("npm", ["run", "build", "--prefix", web], { stdio: "inherit" });
}
