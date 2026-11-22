import { useState, type FormEvent } from "react";
import { ApiError, startTask } from "../api/client.ts";
import { Alert, Frame, Page, PageHeader } from "../components/header.tsx";
import { ModelPicker, useModelChoice } from "../components/model-picker.tsx";
import { PreapprovedEditor, REPO_HINT, RepositoryField, useRepository } from "../components/repository.tsx";

export function NewTaskScreen({ onSignedOut }: { onSignedOut: () => void }) {
  const repository = useRepository(onSignedOut);
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const models = useModelChoice(onSignedOut);
  const { listed } = repository;

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (busy) return;
    if (repository.repo.trim() === "") return setError(`The task was not started. ${REPO_HINT}`);
    if (repository.refused) return setError(`The task was not started. ${repository.words}`);
    if (prompt.trim() === "") return setError("The task was not started. Say what the task is.");
    const model = models.request();
    if (!model.ok) return setError(`The task was not started. ${model.why}`);
    // A command typed and not added is neither granted behind the owner's back nor dropped without a word.
    if (listed !== null && repository.adding.trim() !== "") return setError('The task was not started. Add the command you typed, or clear it: it is not on the list yet.');
    setError(null);
    setBusy(true);
    // The server checks the path again itself; what this screen knows is only for the owner's benefit.
    // Only the commands shown in the list are sent, and the server grants nothing else.
    startTask(repository.repo.trim(), prompt, model.model, listed?.commands ?? []).then(
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
    <Frame current={null}>
      <Page>
        <PageHeader title="New task" />
        <form onSubmit={submit} className="gw-stack gw-gap-lg" noValidate>
          <RepositoryField choice={repository} />
          <div className="gw-field">
            <label htmlFor="task-prompt" className="gw-field__label">
              Prompt <span className="gw-field__required">required</span>
            </label>
            <textarea id="task-prompt" name="prompt" required value={prompt} onChange={(e) => setPrompt(e.target.value)} className="gw-field__control gw-textarea" />
          </div>
          <ModelPicker state={models} />
          <PreapprovedEditor choice={repository} scope="task" />
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
