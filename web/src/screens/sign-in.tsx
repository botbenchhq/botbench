import { useState, type FormEvent } from "react";
import { ApiError, signIn } from "../api/client.ts";
import { Mark } from "../app/shell.tsx";

export function SignInScreen({ notice, onSignedIn }: { notice: string | null; onSignedIn: () => void }) {
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    signIn(token.trim()).then(onSignedIn, (err: unknown) => {
      setBusy(false);
      if (err instanceof ApiError && err.status === 401) setError("Wrong token. Check it and try again.");
      else if (err instanceof ApiError) setError(`Sign-in was refused: ${err.message}.`);
      else setError("Cannot reach Smelt. Check that it is running, then try again.");
    });
  };

  return (
    <main className="mx-auto flex min-h-screen max-w-column flex-col gap-xl p-lg">
      <Mark />
      <form onSubmit={submit} className="flex flex-col gap-md">
        <h1 className="font-semibold">Sign in</h1>
        {notice !== null && <p role="status">{notice}</p>}
        <div className="flex flex-col gap-xs">
          <label htmlFor="token" className="font-mono text-mono text-muted">
            Login token
          </label>
          <input
            id="token"
            name="token"
            type="password"
            required
            autoFocus
            autoComplete="current-password"
            autoCapitalize="none"
            spellCheck={false}
            value={token}
            onChange={(e) => setToken(e.target.value)}
            aria-describedby={error === null ? "token-help" : "token-help token-error"}
            aria-invalid={error !== null}
            className="min-h-touch rounded-sm border bg-surface px-md font-mono text-mono"
          />
        </div>
        {error !== null && (
          <p id="token-error" role="alert" className="font-medium">
            {error}
          </p>
        )}
        <button type="submit" className="min-h-touch rounded-sm border border-accent bg-accent px-lg font-medium uppercase tracking-wide text-surface">
          {busy ? "Signing in" : "Sign in"}
        </button>
        <p id="token-help" className="text-muted">
          Smelt printed the token the first time it started. It is also in the file named login-token in Smelt's data directory on your Mac.
        </p>
      </form>
    </main>
  );
}
