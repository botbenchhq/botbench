import { useEffect, useState } from "react";
import { ApiError, CHECK_REPO_LIMIT_MS, checkRepo, getRepoSettings, listRepos, timedOut, type KnownRepository, type RepoCheck } from "../api/client.ts";
import { REPO_HINT, type RepoStatus } from "../app/composer.ts";
import { Alert } from "./header.tsx";

const CHECK_DELAY_MS = 250;

/** What is known about the path in the field: nothing yet, being asked, the server's answer, or that it could not be asked and why. */
type RepoState = { kind: "empty" } | { kind: "checking" } | { kind: "answer"; check: RepoCheck } | { kind: "unknown"; why: string };

function repoWords(state: RepoState): string {
  if (state.kind === "empty") return REPO_HINT;
  if (state.kind === "checking") return "Checking.";
  if (state.kind === "unknown") return `The path could not be checked: ${state.why}`;
  return state.check.usable ? "Usable git repository." : (state.check.reason ?? "This path cannot be used.");
}

/**
 * The commands that may run without asking, for the repository at `path`. `commands` starts as what the owner's
 * settings offer for that repository and is the owner's to edit; `note` says so when the offer could not be read.
 */
interface Preapproved {
  path: string;
  commands: string[];
  note: string | null;
}

/** The repository the composer names, as far as the server has answered about it, and the commands the owner confirms for it. */
export interface RepositoryChoice {
  /** What is known about the path, in words. */
  words: string;
  /** The same, as the composer decides by it. */
  status: RepoStatus;
  /** The server answered that the path cannot be used. */
  refused: boolean;
  /** The pre-approved list for the usable repository in the field; null until it is known. */
  listed: Preapproved | null;
  adding: string;
  setAdding(command: string): void;
  addCommand(): void;
  removeCommand(command: string): void;
}

/** The repositories used before, most recent first, then the configured ones; empty until read, and when they cannot be. */
export function useKnownRepositories(onSignedOut: () => void): KnownRepository[] {
  const [known, setKnown] = useState<KnownRepository[]>([]);
  useEffect(() => {
    let stale = false;
    listRepos().then(
      (found) => !stale && setKnown(found),
      (err: unknown) => {
        if (!stale && err instanceof ApiError && err.status === 401) onSignedOut();
      },
    );
    return () => {
      stale = true;
    };
  }, [onSignedOut]);
  return known;
}

/** Check the repository at `repo` ("" for none) as it changes, and read the commands the owner's settings offer for it. */
export function useRepository(repo: string, onSignedOut: () => void): RepositoryChoice {
  const [repoState, setRepoState] = useState<RepoState>({ kind: "empty" });
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
          setRepoState({ kind: "unknown", why: timedOut(err) ? `Botbench did not answer within ${CHECK_REPO_LIMIT_MS / 1000} seconds.` : "Botbench could not be reached." });
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
  const status: RepoStatus =
    repoState.kind === "empty" ? { state: "none" } : repoState.kind === "checking" ? { state: "checking" } : repoState.kind === "unknown" ? { state: "unknown", words: repoWords(repoState) } : repoState.check.usable ? { state: "usable" } : { state: "refused", words: repoWords(repoState) };
  return { words: repoWords(repoState), status, refused, listed, adding, setAdding, addCommand, removeCommand };
}

const ABOUT = {
  task: "Claude Code may run these commands in this task without asking you first, with further arguments too. A script or a test command runs whatever its files hold at that moment. Dangerous commands always ask: the ones Botbench's safety rules catch, such as git push, sudo and deleting outside the task's copy of the project, and anything chained, piped or redirected.",
  run: "When this run's tasks are built, Claude Code may run these commands without asking you first, with further arguments too. A script or a test command runs whatever its files hold at that moment. While planning it never does: planning only reads, and every command it wants asks. Dangerous commands always ask: the ones Botbench's safety rules catch, such as git push, sudo and deleting outside a task's copy of the project, and anything chained, piped or redirected.",
};

/** The commands the owner confirms may run without asking, once the repository is known: listed, removable, and added to. */
export function PreapprovedEditor({ choice, scope }: { choice: RepositoryChoice; scope: "task" | "run" }) {
  const { listed } = choice;
  if (listed === null) return null;
  return (
    <section aria-label={`Allowed for this ${scope}`} className="ds-stack ds-gap-sm">
      <p data-testid="preapproved-about">{ABOUT[scope]}</p>
      {listed.note !== null && (
        <Alert tone="warning" role="status">
          {listed.note}
        </Alert>
      )}
      {listed.commands.length === 0 ? (
        <p data-testid="preapproved-none">No command is listed, so every shell command asks.</p>
      ) : (
        <ul data-testid="preapproved-list" className="ds-list">
          {listed.commands.map((command) => (
            <li key={command} className="ds-list__row">
              <div className="ds-list__content">
                <span className="ds-list__body">
                  <code data-ds-content="" className="ds-list__primary">
                    {command}
                  </code>
                </span>
              </div>
              <div className="ds-list__action">
                <button type="button" data-ds-content-label="" aria-label={`Remove ${command}`} onClick={() => choice.removeCommand(command)} className="ds-button ds-button--quiet ds-button--small">
                  Remove
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
      <div className="flex items-end gap-sm">
        <div className="ds-field min-w-0 flex-1">
          <label htmlFor="preapproved-add" className="ds-field__label">
            Add a command
          </label>
          <input
            id="preapproved-add"
            type="text"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            value={choice.adding}
            onChange={(e) => choice.setAdding(e.target.value)}
            onKeyDown={(e) => {
              // Enter adds to the list. It must not send the form.
              if (e.key !== "Enter") return;
              e.preventDefault();
              choice.addCommand();
            }}
            className="ds-field__control"
          />
        </div>
        <button type="button" onClick={choice.addCommand} className="ds-button">
          Add
        </button>
      </div>
    </section>
  );
}
