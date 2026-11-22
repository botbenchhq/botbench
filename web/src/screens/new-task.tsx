import { useEffect, useState, type FormEvent } from "react";
import { ApiError, CHECK_REPO_LIMIT_MS, checkRepo, startTask, timedOut, type RepoCheck } from "../api/client.ts";
import { Header } from "../components/header.tsx";

const CHECK_DELAY_MS = 250;
const HINT = "Enter the full path of a git repository on this Mac.";

/** What is known about the path in the field: nothing yet, being asked, the server's answer, or that it could not be asked and why. */
type RepoState = { kind: "empty" } | { kind: "checking" } | { kind: "answer"; check: RepoCheck } | { kind: "unknown"; why: string };

function repoWords(state: RepoState): string {
  if (state.kind === "empty") return HINT;
  if (state.kind === "checking") return "Checking.";
  if (state.kind === "unknown") return `The path could not be checked: ${state.why}`;
  return state.check.usable ? "Usable git repository." : (state.check.reason ?? "This path cannot be used.");
}

export function NewTaskScreen({ onSignedOut }: { onSignedOut: () => void }) {
  const [repo, setRepo] = useState("");
  const [repoState, setRepoState] = useState<RepoState>({ kind: "empty" });
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Ask the server about the path a moment after the owner stops typing. A newer path ends the request for an older one,
  // and a request with no answer ends at its own time limit, so the screen never stays on "Checking.".
  useEffect(() => {
    const path = repo.trim();
    if (path === "") return setRepoState({ kind: "empty" });
    setRepoState({ kind: "checking" });
    let stale = false;
    const older = new AbortController();
    const timer = window.setTimeout(() => {
      checkRepo(path, older.signal).then(
        (check) => !stale && setRepoState({ kind: "answer", check }),
        (err: unknown) => {
          if (stale) return;
          if (err instanceof ApiError && err.status === 401) return onSignedOut();
          setRepoState({ kind: "unknown", why: timedOut(err) ? `Smelt did not answer within ${CHECK_REPO_LIMIT_MS / 1000} seconds.` : "Smelt could not be reached." });
        },
      );
    }, CHECK_DELAY_MS);
    return () => {
      stale = true;
      older.abort();
      window.clearTimeout(timer);
    };
  }, [repo, onSignedOut]);

  const refused = repoState.kind === "answer" && !repoState.check.usable;

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (busy) return;
    if (repo.trim() === "") return setError(`The task was not started. ${HINT}`);
    if (refused) return setError(`The task was not started. ${repoWords(repoState)}`);
    if (prompt.trim() === "") return setError("The task was not started. Say what the task is.");
    setError(null);
    setBusy(true);
    // The server checks the path again itself; what this screen knows is only for the owner's benefit.
    startTask(repo.trim(), prompt).then(
      ({ taskId }) => {
        window.location.hash = `#/tasks/${taskId}`;
      },
      (err: unknown) => {
        setBusy(false);
        if (err instanceof ApiError && err.status === 401) return onSignedOut();
        setError(err instanceof ApiError ? `The task was not started. ${err.message}` : "The task was not started: Smelt could not be reached.");
      },
    );
  };

  return (
    <div className="mx-auto flex min-h-screen max-w-transcript flex-col">
      <Header current="new-task" />
      <main className="p-lg">
        <form onSubmit={submit} className="flex flex-col gap-lg" noValidate>
          <h1 className="font-semibold">New task</h1>
          <div className="flex flex-col gap-xs">
            <label htmlFor="repo" className="font-mono text-mono text-muted">
              Repository path
            </label>
            <input
              id="repo"
              name="repo"
              type="text"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              value={repo}
              onChange={(e) => setRepo(e.target.value)}
              aria-describedby="repo-state"
              aria-invalid={refused}
              className="min-h-touch rounded-sm border bg-surface px-md font-mono text-mono"
            />
            <p id="repo-state" data-testid="repo-state" role="status" className={`break-words ${refused ? "font-medium" : "text-muted"}`}>
              {repoWords(repoState)}
            </p>
          </div>
          <div className="flex flex-col gap-xs">
            <label htmlFor="task-prompt" className="font-mono text-mono text-muted">
              Prompt
            </label>
            <textarea id="task-prompt" name="prompt" rows={5} value={prompt} onChange={(e) => setPrompt(e.target.value)} className="min-h-touch rounded-sm border bg-surface p-md" />
          </div>
          {error !== null && (
            <p role="alert" className="break-words font-medium">
              {error}
            </p>
          )}
          <button type="submit" className="min-h-touch rounded-sm border border-accent bg-accent px-lg font-medium uppercase tracking-wide text-surface">
            {busy ? "Starting" : "Start task"}
          </button>
          <p className="text-muted">
            Smelt builds the task in its own worktree on a new branch, from the repository's current commit. Your checkout and your branch are not touched.
          </p>
        </form>
      </main>
    </div>
  );
}
