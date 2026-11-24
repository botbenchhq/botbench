import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

// The design system's static scan (the first step of `npm test`) reads the paths of web/design-system.config.json.
// Since ADR 0012 those paths leave out the code built on shadcn/ui and Tailwind, which is not written in the design
// system's closed vocabulary, and nothing else. The scan takes no exclusion, so the paths list what is scanned; this
// test keeps that list whole: a new file or folder of the old kind that the list misses fails here, not silently.

const WEB = path.resolve(import.meta.dirname, "..", "web");

/** What the scan does not read, and why (ADR 0012, "What happens to the checks"). Nothing else under web/src may be left out. */
const LEFT_OUT = [
  "src/ui", // shadcn/ui's components, copied in by its CLI, with its `cn` helper and its hook: Tailwind utilities by design.
  "src/shell", // The frame and navigation of the rebuilt screens.
  "src/screens2", // The screens rebuilt on them, one folder each.
  "src/styles", // The order of the layers, shadcn/ui's stylesheet and the theme: tokens, not ds- components.
];

function filesUnder(dir: string): string[] {
  return fs.readdirSync(path.join(WEB, dir), { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? filesUnder(`${dir}/${entry.name}`) : [`${dir}/${entry.name}`]));
}

test("the design system's scan reads every file of the client except the code built on shadcn/ui, which is listed", () => {
  const { paths } = JSON.parse(fs.readFileSync(path.join(WEB, "design-system.config.json"), "utf8")) as { paths: string[] };
  const under = (file: string, roots: readonly string[]): boolean => roots.some((root) => file === root || file.startsWith(`${root}/`));
  const missed = filesUnder("src").filter((file) => !under(file, paths) && !under(file, LEFT_OUT));
  assert.deepEqual(missed, [], "files the scan does not read and that are not listed as left out");
  // Nothing is both scanned and left out, every path exists, and every folder left out exists (a stale entry hides nothing, but says something untrue).
  assert.deepEqual(paths.filter((entry) => under(entry, LEFT_OUT)), []);
  assert.deepEqual([...paths, ...LEFT_OUT].filter((entry) => !fs.existsSync(path.join(WEB, entry))), []);
  // The old code does not reach into the new, except the one place that shows a rebuilt screen at its address.
  const importsNew = filesUnder("src").filter((file) => under(file, paths) && /\.(ts|tsx)$/.test(file) && /from "(@\/|\.\.?\/(\.\.\/)*(ui|shell|screens2)\/)/.test(fs.readFileSync(path.join(WEB, file), "utf8")));
  assert.deepEqual(importsNew, ["src/app/shell.tsx"]);
});
