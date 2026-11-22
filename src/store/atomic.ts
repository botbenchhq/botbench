import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/**
 * Write a file so readers see either the old content or the new, never a part.
 * The content goes to a temporary file in the same directory (owner-only from
 * the moment it exists), is flushed to disk, then renamed over the target.
 */
export function writeFileAtomic(file: string, data: string | Uint8Array, mode = 0o600): void {
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
  const fd = fs.openSync(tmp, "wx", mode);
  try {
    try {
      fs.fchmodSync(fd, mode); // the mode given to open is narrowed by the umask
      fs.writeFileSync(fd, data);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, file);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}
