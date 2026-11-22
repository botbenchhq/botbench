import { useEffect, useState, type FormEvent } from "react";
import { ApiError, CHECK_REPO_LIMIT_MS, checkRepo, getRepoSettings, startTask, timedOut, type RepoCheck } from "../api/client.ts";
import { Alert, Frame, Page, PageHeader } from "../components/header.tsx";
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
    <Frame current="new-task">
      <Page>
        <PageHeader title="New task" />
        <form onSubmit={submit} className="gw-stack gw-gap-lg" noValidate>
          <div className="gw-field">
            <label htmlFor="repo" className="gw-field__label">
              Repository path <span className="gw-field__required">required</span>
            </label>
            <input id="repo" name="repo" type="text" required autoCapitalize="none" autoCorrect="off" spellCheck={false} value={repo} onChange={(e) => setRepo(e.target.value)} aria-describedby="repo-state" aria-invalid={refused} className="gw-field__control" />
            <p id="repo-state" data-testid="repo-state" role="status" className={refused ? "gw-field__error sm-wrap" : "gw-field__description sm-wrap"}>
              {repoWords(repoState)}
            </p>
          </div>
          <div className="gw-field">
            <label htmlFor="task-prompt" className="gw-field__label">
              Prompt <span className="gw-field__required">required</span>
            </label>
            <textarea id="task-prompt" name="prompt" required value={prompt} onChange={(e) => setPrompt(e.target.value)} className="gw-field__control gw-textarea" />
          </div>
          <ModelPicker state={models} />
          {listed !== null && (
            <section aria-labelledby="preapproved-heading" className="gw-stack gw-gap-sm">
              <h2 id="preapproved-heading">Runs without asking in this task</h2>
              <p data-testid="preapproved-about">
                Claude Code may run these commands in this task without a card, with further arguments too. A script or a test command runs whatever its files hold at that moment. Dangerous commands always ask: the ones on Smelt's never-list, such as git push, sudo and deleting outside the worktree, and anything chained, piped or redirected.
              </p>
              {listed.note !== null && (
                <Alert tone="warning" role="status">
                  {listed.note}
                </Alert>
              )}
              {listed.commands.length === 0 ? (
                <p data-testid="preapproved-none">No command is listed, so every shell command asks.</p>
              ) : (
                <ul data-testid="preapproved-list" className="gw-list">
                  {listed.commands.map((command) => (
                    <li key={command} className="gw-list__row">
                      <div className="gw-list__content">
                        <span className="gw-list__body">
                          <code className="gw-list__primary">{command}</code>
                        </span>
                      </div>
                      <div className="gw-list__action">
                        <button type="button" aria-label={`Remove ${command}`} onClick={() => removeCommand(command)} className="gw-button gw-button--quiet gw-button--small">
                          Remove
                        </button>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
              <div className="flex items-end gap-sm">
                <div className="gw-field min-w-0 flex-1">
                  <label htmlFor="preapproved-add" className="gw-field__label">
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
                    className="gw-field__control"
                  />
                </div>
                <button type="button" onClick={addCommand} className="gw-button">
                  Add
                </button>
              </div>
            </section>
          )}
          {error !== null && (
            <Alert tone="error" role="alert">
              {error}
            </Alert>
          )}
          <button type="submit" aria-busy={busy} className="gw-button gw-button--primary">
            {busy ? "Starting" : "Start task"}
          </button>
          <p>Smelt builds the task in its own worktree on a new branch, from the repository's current commit. Your checkout and your branch are not touched.</p>
        </form>
      </Page>
    </Frame>
  );
}
