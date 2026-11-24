import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { Input } from "@/ui/input";
import { ApiError, signIn } from "../../api/client.ts";
import { tabTitle } from "../../app/arrival.ts";
import { codeFromAddress } from "../../app/sign-in-code.ts";
import { Mark } from "../../brand/mark.tsx";
import { useNextRoot } from "../../shell/use-next-root.ts";
import { About, Busy, FieldLabel, Note, Reading, Segmented } from "../settings/parts.tsx";

type Method = "token" | "code";

const METHODS = [
  { value: "token", label: "Token" },
  { value: "code", label: "Code" },
] as const;

/** The frame of what is shown before a session: the whole window, no navigation, the product's name over one column. */
function Before({ children }: { children: ReactNode }) {
  useNextRoot();
  return (
    <main className="flex min-h-svh flex-col items-center px-4 py-12 sm:justify-center">
      <div className="flex w-full max-w-sm flex-col gap-6">
        <p className="flex items-center gap-2 text-base font-semibold tracking-tight">
          <Mark />
          Botbench
        </p>
        {children}
      </div>
    </main>
  );
}

/** What stands in the window while the session is checked, or while Botbench cannot be reached. */
export function SessionState({ unreachable }: { unreachable: boolean }) {
  return (
    <Before>
      {unreachable ? (
        <Note tone="warning" role="status">
          Cannot reach Botbench. Trying again every two seconds.
        </Note>
      ) : (
        <Reading>Checking your session.</Reading>
      )}
    </Before>
  );
}

/**
 * Sign in, with the login token or with a one-time code from a device that is signed in. The whole window, with no
 * navigation. The field has the focus on arrival. A code the address carries (the QR code from Add a device) is read
 * once and taken out of the address.
 */
export default function SignInScreen({ notice, onSignedIn }: { notice: string | null; onSignedIn: () => void }) {
  // The code the address carries: read once, then taken out of the address, so it is neither kept in the history nor
  // still there after the page loads again once signed in.
  const [carried] = useState(() => codeFromAddress(window.location.hash));
  useEffect(() => {
    if (carried !== null) window.history.replaceState(null, "", window.location.pathname + window.location.search);
  }, [carried]);
  useEffect(() => {
    document.title = tabTitle("Sign in");
  }, []);
  const [method, setMethod] = useState<Method>(carried === null ? "token" : "code");
  const [token, setToken] = useState("");
  const [code, setCode] = useState(carried ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
  const required = <span className="font-normal text-muted-foreground">required</span>;
  return (
    <Before>
      <div className="flex flex-col gap-2">
        <h1 className="text-title font-bold tracking-tight">Sign in</h1>
        <About id={`${field}-help`} className="text-sm">
          {method === "token"
            ? "Botbench printed the token the first time it started. It is also in the file named login-token in Botbench's data directory on your Mac."
            : "A device that is signed in makes one in Settings → Connections and peers → Add a device: 8 letters and digits, such as ABCD-EFGH. It works once, for 5 minutes."}
        </About>
      </div>
      <form onSubmit={submit} className="flex flex-col gap-5">
        {notice !== null && (
          <Note tone="note" role="status">
            {notice}
          </Note>
        )}
        <div className="flex flex-col items-start gap-1.5">
          <span aria-hidden="true" className="text-sm font-semibold">
            Sign in with
          </span>
          <Segmented label="Sign in with" value={method} options={METHODS} onChange={choose} />
        </div>
        {error !== null && (
          <Note tone="error" role="alert" id={`${field}-error`}>
            {error}
          </Note>
        )}
        {method === "token" ? (
          <>
            {/* Password managers save a username with a password: a fixed one names the entry, so the phone can fill the token. */}
            <input type="text" name="username" autoComplete="username" value="Botbench" readOnly hidden />
            <div className="flex flex-col gap-1.5">
              <FieldLabel htmlFor="token">Login token {required}</FieldLabel>
              <Input id="token" name="token" type="password" required autoFocus autoComplete="current-password" autoCapitalize="none" spellCheck={false} value={token} onChange={(e) => setToken(e.target.value)} aria-describedby={error === null ? "token-help" : "token-help token-error"} aria-invalid={error !== null} />
            </div>
          </>
        ) : (
          <div className="flex flex-col gap-1.5">
            <FieldLabel htmlFor="code">One-time code {required}</FieldLabel>
            {/* No maxlength: a code pasted with spaces or a dash must not lose its end. Case, spaces and dashes do not matter. */}
            <Input id="code" name="code" type="text" required autoFocus autoComplete="one-time-code" autoCapitalize="characters" autoCorrect="off" spellCheck={false} value={code} onChange={(e) => setCode(e.target.value)} aria-describedby={error === null ? "code-help" : "code-help code-error"} aria-invalid={error !== null} className="font-mono tracking-widest" />
          </div>
        )}
        <Busy type="submit" variant="default" busy={busy} busyLabel="Signing in">
          Sign in
        </Busy>
      </form>
    </Before>
  );
}
