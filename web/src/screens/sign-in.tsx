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
      else setError("Cannot reach Botbench. Check that it is running, then try again.");
    });
  };

  return (
    <main className="ds-sign-in p-lg">
      <p className="ds-sign-in__product">Botbench</p>
      <div className="ds-stack ds-gap-sm">
        <h1>Sign in</h1>
        <p id="token-help">Botbench printed the token the first time it started. It is also in the file named login-token in Botbench's data directory on your Mac.</p>
      </div>
      <form onSubmit={submit} className="ds-stack ds-gap-lg">
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
        {/* Password managers save a username with a password: a fixed one names the entry, so the phone can fill the token. */}
        <input type="text" name="username" autoComplete="username" value="Botbench" readOnly hidden />
        <div className="ds-field">
          <label htmlFor="token" className="ds-field__label">
            Login token <span className="ds-field__required">required</span>
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
            className="ds-field__control"
          />
        </div>
        <button type="submit" aria-busy={busy} className="ds-button ds-button--primary">
          {busy ? "Signing in" : "Sign in"}
        </button>
      </form>
    </main>
  );
}
