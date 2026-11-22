import { useState, type FormEvent } from "react";
import { ApiError, signIn } from "../api/client.ts";
import { Alert } from "../components/header.tsx";

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
    <main className="gw-sign-in p-lg">
      <p className="gw-sign-in__product">Smelt</p>
      <div className="gw-stack gw-gap-sm">
        <h1>Sign in</h1>
        <p id="token-help">Smelt printed the token the first time it started. It is also in the file named login-token in Smelt's data directory on your Mac.</p>
      </div>
      <form onSubmit={submit} className="gw-stack gw-gap-lg">
        {notice !== null && (
          <Alert tone="note" role="status">
            {notice}
          </Alert>
        )}
        {error !== null && (
          <Alert tone="error" role="alert" id="token-error">
            {error}
          </Alert>
        )}
        <div className="gw-field">
          <label htmlFor="token" className="gw-field__label">
            Login token <span className="gw-field__required">required</span>
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
            className="gw-field__control"
          />
        </div>
        <button type="submit" aria-busy={busy} className="gw-button gw-button--primary">
          {busy ? "Signing in" : "Sign in"}
        </button>
      </form>
    </main>
  );
}
