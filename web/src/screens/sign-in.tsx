import { useEffect, useId, useState, type FormEvent } from "react";
import { ApiError, signIn } from "../api/client.ts";
import { codeFromAddress } from "../app/sign-in-code.ts";
import { Alert } from "../components/header.tsx";

type Method = "token" | "code";

export function SignInScreen({ notice, onSignedIn }: { notice: string | null; onSignedIn: () => void }) {
  // The code the address carries (the QR code from Add a device): read once, then taken out of the address, so it is
  // neither kept in the history nor still there after the page loads again once signed in.
  const [carried] = useState(() => codeFromAddress(window.location.hash));
  useEffect(() => {
    if (carried !== null) window.history.replaceState(null, "", window.location.pathname + window.location.search);
  }, [carried]);
  const [method, setMethod] = useState<Method>(carried === null ? "token" : "code");
  const [token, setToken] = useState("");
  const [code, setCode] = useState(carried ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const name = useId();

  const choose = (next: Method): void => {
    setMethod(next);
    setError(null);
  };

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    signIn(method === "token" ? { token: token.trim() } : { code: code.trim() }).then(onSignedIn, (err: unknown) => {
      setBusy(false);
      // A refused code comes with the server's own reason in plain words: wrong, used, expired or replaced.
      if (err instanceof ApiError && err.status === 401) setError(method === "token" ? "Wrong token. Check it and try again." : err.message);
      else if (err instanceof ApiError) setError(`Sign-in was refused: ${err.message}.`);
      else setError("Cannot reach Botbench. Check that it is running, then try again.");
    });
  };

  const field = method === "token" ? "token" : "code";
  return (
    <main className="ds-sign-in p-lg">
      <p className="ds-sign-in__product">Botbench</p>
      <div className="ds-stack ds-gap-sm">
        <h1>Sign in</h1>
        <p id={`${field}-help`}>
          {method === "token"
            ? "Botbench printed the token the first time it started. It is also in the file named login-token in Botbench's data directory on your Mac."
            : "A device that is signed in makes one in Settings → Signed-in devices → Add a device: 8 letters and digits, such as ABCD-EFGH. It works once, for 5 minutes."}
        </p>
      </div>
      <form onSubmit={submit} className="ds-stack ds-gap-lg">
        {notice !== null && (
          <Alert tone="note" role="status">
            {notice}
          </Alert>
        )}
        <fieldset className="ds-segmented-control">
          <legend className="ds-segmented-control__legend">Sign in with</legend>
          <div className="ds-segmented-control__options">
            {(
              [
                ["token", "Token"],
                ["code", "Code"],
              ] as const
            ).map(([value, label]) => (
              <label key={value} className="ds-segmented-control__option">
                <input className="ds-segmented-control__input" type="radio" name={name} value={value} checked={method === value} onChange={() => choose(value)} />
                <span className="ds-segmented-control__label">{label}</span>
              </label>
            ))}
          </div>
        </fieldset>
        {error !== null && (
          <Alert tone="error" role="alert" id={`${field}-error`}>
            {error}
          </Alert>
        )}
        {method === "token" ? (
          <>
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
          </>
        ) : (
          <div className="ds-field">
            <label htmlFor="code" className="ds-field__label">
              One-time code <span className="ds-field__required">required</span>
            </label>
            {/* No maxlength: a code pasted with spaces or a dash must not lose its end. Case, spaces and dashes do not matter. */}
            <input
              id="code"
              name="code"
              type="text"
              required
              autoFocus
              autoComplete="one-time-code"
              autoCapitalize="characters"
              autoCorrect="off"
              spellCheck={false}
              value={code}
              onChange={(e) => setCode(e.target.value)}
              aria-describedby={error === null ? "code-help" : "code-help code-error"}
              aria-invalid={error !== null}
              className="ds-field__control ds-otp-input"
            />
          </div>
        )}
        <button type="submit" aria-busy={busy} className="ds-button ds-button--primary">
          {busy ? "Signing in" : "Sign in"}
        </button>
      </form>
    </main>
  );
}
