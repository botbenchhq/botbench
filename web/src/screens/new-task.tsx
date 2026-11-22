import { useEffect, useState, type FormEvent } from "react";
import { ApiError, CHECK_REPO_LIMIT_MS, checkRepo, getRepoSettings, startTask, timedOut, type RepoCheck } from "../api/client.ts";
import { Header } from "../components/header.tsx";
import { ModelPicker, useModelChoice } from "../components/model-picker.tsx";

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

/**
 * The commands this task may run without asking, for the repository at `path`. `commands` starts as what the owner's
 * settings offer for that repository and is the owner's to edit; `note` says so when the offer could not be read.
 */
interface Preapproved {
  path: string;
  commands: string[];
  note: string | null;
}

export function NewTaskScreen({ onSignedOut }: { onSignedOut: () => void }) {
  const [repo, setRepo] = useState("");
  const [repoState, setRepoState] = useState<RepoState>({ kind: "empty" });
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const models = useModelChoice(onSignedOut);
  const [preapproved, setPreapproved] = useState<Preapproved | null>(null);
  const [adding, setAdding] = useState("");

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
  /** The repository as the server named it, once it is known to be usable. */
  const usablePath = repoState.kind === "answer" && repoState.check.usable ? repoState.check.path : null;

  // Once the repository is usable, read what the owner's settings offer for it. Another repository is another offer:
  // the list is never carried from one repository to the next.
  useEffect(() => {
    setPreapproved(null);
    if (usablePath === null) return;
    let stale = false;
    const older = new AbortController();
    getRepoSettings(usablePath, older.signal).then(
      (settings) => !stale && setPreapproved({ path: usablePath, commands: settings.preapproved, note: null }),
      (err: unknown) => {
        if (stale) return;
        if (err instanceof ApiError && err.status === 401) return onSignedOut();
        setPreapproved({ path: usablePath, commands: [], note: "The commands configured for this repository could not be read, so none is listed." });
      },
    );
    return () => {
      stale = true;
      older.abort();
    };
  }, [usablePath, onSignedOut]);

  const listed = preapproved !== null && preapproved.path === usablePath ? preapproved : null;
  const addCommand = (): void => {
    const command = adding.trim();
    if (listed === null || command === "") return;
    if (!listed.commands.includes(command)) setPreapproved({ ...listed, commands: [...listed.commands, command] });
    setAdding("");
  };
  const removeCommand = (command: string): void => {
    if (listed !== null) setPreapproved({ ...listed, commands: listed.commands.filter((c) => c !== command) });
  };

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (busy) return;
    if (repo.trim() === "") return setError(`The task was not started. ${HINT}`);
    if (refused) return setError(`The task was not started. ${repoWords(repoState)}`);
    if (prompt.trim() === "") return setError("The task was not started. Say what the task is.");
    const model = models.request();
    if (!model.ok) return setError(`The task was not started. ${model.why}`);
    // A command typed and not added is neither granted behind the owner's back nor dropped without a word.
    if (listed !== null && adding.trim() !== "") return setError('The task was not started. Add the command you typed, or clear it: it is not on the list yet.');
    setError(null);
    setBusy(true);
    // The server checks the path again itself; what this screen knows is only for the owner's benefit.
    // Only the commands shown in the list are sent, and the server grants nothing else.
    startTask(repo.trim(), prompt, model.model, listed?.commands ?? []).then(
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
          <ModelPicker state={models} />
          {listed !== null && (
            <section aria-labelledby="preapproved-heading" className="flex flex-col gap-sm">
              <h2 id="preapproved-heading" className="font-semibold">
                Runs without asking in this task
              </h2>
              <p data-testid="preapproved-about" className="text-muted">
                Claude Code may run these commands in this task without a card, with further arguments too. A script or a test command runs whatever its files hold at that moment. Dangerous commands always ask: the ones on Smelt's never-list, such as git push, sudo and deleting outside the worktree, and anything chained, piped or redirected.
              </p>
              {listed.note !== null && (
                <p role="status" className="break-words font-medium">
                  {listed.note}
                </p>
              )}
              {listed.commands.length === 0 ? (
                <p data-testid="preapproved-none" className="text-muted">
                  No command is listed, so every shell command asks.
                </p>
              ) : (
                <ul data-testid="preapproved-list" className="flex flex-col border-t">
                  {listed.commands.map((command) => (
                    <li key={command} className="flex items-center gap-md border-b py-xs">
                      <code className="min-w-0 flex-1 break-all font-mono text-mono">{command}</code>
                      <button type="button" aria-label={`Remove ${command}`} onClick={() => removeCommand(command)} className="min-h-touch min-w-touch shrink-0 rounded-sm border px-md font-medium">
                        Remove
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              <div className="flex items-end gap-md">
                <div className="flex min-w-0 flex-1 flex-col gap-xs">
                  <label htmlFor="preapproved-add" className="font-mono text-mono text-muted">
                    Add a command
                  </label>
                  <input
                    id="preapproved-add"
                    type="text"
                    autoCapitalize="none"
                    autoCorrect="off"
                    spellCheck={false}
                    value={adding}
                    onChange={(e) => setAdding(e.target.value)}
                    onKeyDown={(e) => {
                      // Enter adds to the list. It must not start the task.
                      if (e.key !== "Enter") return;
                      e.preventDefault();
                      addCommand();
                    }}
                    className="min-h-touch min-w-0 rounded-sm border bg-surface px-md font-mono text-mono"
                  />
                </div>
                <button type="button" onClick={addCommand} className="min-h-touch min-w-touch shrink-0 rounded-sm border px-md font-medium">
                  Add
                </button>
              </div>
            </section>
          )}
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
