import os from "node:os";

/**
 * Stop a capture script before it writes anything when a recorded line looks like it holds a token or key, an account
 * id, an e-mail address, or a path in the owner's home folder. The words the CLIs use for these, such as "Missing
 * bearer or basic authentication", are not themselves secrets and are let through.
 */
export function checkRecording(lines: readonly string[]): void {
  const SECRET = /sk-[A-Za-z0-9]|xai-[A-Za-z0-9]|AIza[0-9A-Za-z_-]{10}|ya29\.|eyJ[A-Za-z0-9_-]{10}|account[_-]?id|@[a-z0-9-]+\.[a-z]{2,}|bearer\s+[A-Za-z0-9]|refresh_token|access_token|client_secret/i;
  const home = os.homedir();
  for (const line of lines) {
    const words = line.replace("Missing bearer or basic authentication", "");
    if (SECRET.test(words) || line.includes(home)) throw new Error(`A recorded line looks like it holds a secret or a path in your home folder; nothing was written:\n${line.slice(0, 300)}`);
  }
}
