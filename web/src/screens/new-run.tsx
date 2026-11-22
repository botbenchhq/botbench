import { useEffect, useState, type FormEvent } from "react";
import { ApiError, getDefaultMode, startRun, type Delivery, type RunMode } from "../api/client.ts";
import { ModePicker } from "../components/mode-choice.tsx";
import { Alert, Frame, Page, PageHeader } from "../components/header.tsx";
import { ModelPicker, useModelChoice } from "../components/model-picker.tsx";
import { PreapprovedEditor, REPO_HINT, RepositoryField, useRepository } from "../components/repository.tsx";
import { DeliveryChoice } from "../components/pull-request.tsx";
import { ReviewChoice, useReviewChoice } from "../components/review-choice.tsx";

export function NewRunScreen({ onSignedOut }: { onSignedOut: () => void }) {
  const repository = useRepository(onSignedOut);
  const [prompt, setPrompt] = useState("");
  const [specPath, setSpecPath] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const models = useModelChoice(onSignedOut);
  // The tasks are built on the planning model unless the owner picks another.
  const [sameBuild, setSameBuild] = useState(true);
  const buildModels = useModelChoice(onSignedOut, "botbench.buildModel");
  const review = useReviewChoice(onSignedOut);
  const [delivery, setDelivery] = useState<Delivery>("branch");
  const { listed } = repository;
  // Preselected with the default from Settings; until it is read, nothing is chosen.
  const [mode, setMode] = useState<RunMode | null>(null);
  useEffect(() => {
    let live = true;
    getDefaultMode().then(
      (found) => live && setMode((chosen) => chosen ?? found),
      (err: unknown) => {
        if (live && err instanceof ApiError && err.status === 401) onSignedOut();
      },
    );
    return () => {
      live = false;
    };
  }, [onSignedOut]);

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (busy) return;
    const refuse = (why: string): void => setError(`The run was not started. ${why}`);
    if (repository.repo.trim() === "") return refuse(REPO_HINT);
    if (repository.refused) return refuse(repository.words);
    const hasPrompt = prompt.trim() !== "";
    const hasSpec = specPath.trim() !== "";
    if (!hasPrompt && !hasSpec) return refuse("Give a prompt or the path of a spec file.");
    if (mode === null) return refuse("Choose a mode.");
    if (hasPrompt && hasSpec) return refuse("Give a prompt or a spec file, not both.");
    const model = models.request();
    if (!model.ok) return refuse(model.why);
    const build = sameBuild ? model : buildModels.request();
    if (!build.ok) return refuse(`Build model: ${build.why}`);
    // A command typed and not added is neither granted behind the owner's back nor dropped without a word.
    if (listed !== null && repository.adding.trim() !== "") return refuse("Add the command you typed, or clear it: it is not on the list yet.");
    setError(null);
    setBusy(true);
    // The server checks the repository and the spec file itself; what this screen knows is only for the owner's benefit.
    // Only the commands shown in the list are sent, and the server grants nothing else.
    startRun({ repo: repository.repo.trim(), ...(hasPrompt ? { prompt } : { specPath: specPath.trim() }), model: model.model, ...(build.model === undefined ? {} : { buildModel: build.model }), preapproved: listed?.commands ?? [], reviewer: review.choice(), mode, delivery }).then(
      ({ runId }) => {
        window.location.hash = `#/runs/${runId}`;
      },
      (err: unknown) => {
        setBusy(false);
        if (err instanceof ApiError && err.status === 401) return onSignedOut();
        setError(err instanceof ApiError ? `The run was not started. ${err.message}` : "The run was not started: Botbench could not be reached.");
      },
    );
  };

  return (
    <Frame current={null}>
      <Page>
        <PageHeader title="New run" />
        <form onSubmit={submit} className="ds-stack ds-gap-lg" noValidate>
          <RepositoryField choice={repository} />
          <div className="ds-field">
            <label htmlFor="run-prompt" className="ds-field__label">
              Prompt
            </label>
            <textarea id="run-prompt" name="prompt" value={prompt} onChange={(e) => setPrompt(e.target.value)} aria-describedby="run-prompt-about" className="ds-field__control ds-textarea" />
            <p id="run-prompt-about" className="ds-field__description">What to build, in your own words. Leave this empty when you give a spec file.</p>
          </div>
          <div className="ds-field">
            <label htmlFor="run-spec" className="ds-field__label">
              Spec file path
            </label>
            <input id="run-spec" name="specPath" type="text" autoCapitalize="none" autoCorrect="off" spellCheck={false} value={specPath} onChange={(e) => setSpecPath(e.target.value)} aria-describedby="run-spec-about" className="ds-field__control" />
            <p id="run-spec-about" className="ds-field__description">Or the full path of a .md, .markdown or .txt file on this Mac that describes the work. Botbench reads it once, now.</p>
          </div>
          <ModelPicker state={models} label="Planning model" />
          <div className="ds-checkbox">
            <input className="ds-checkbox__input" type="checkbox" id="same-build-model" checked={sameBuild} onChange={(e) => setSameBuild(e.target.checked)} aria-describedby="same-build-model-about" />
            <label className="ds-checkbox__label" htmlFor="same-build-model">
              Build the tasks with the same model
            </label>
            <p className="ds-checkbox__description" id="same-build-model-about">
              Clear this to build the tasks with another model than the one that plans.
            </p>
          </div>
          {!sameBuild && <ModelPicker state={buildModels} id="build-model" label="Build model" />}
          <ReviewChoice state={review} />
          <ModePicker name="run-mode" legend="Mode" hint="How much the run does without you. It cannot be changed once the run starts." value={mode} onChange={setMode} />
          <DeliveryChoice value={delivery} onChange={setDelivery} />
          <PreapprovedEditor choice={repository} scope="run" />
          {error !== null && (
            <Alert tone="error" role="alert">
              {error}
            </Alert>
          )}
          <button type="submit" aria-busy={busy} className="ds-button ds-button--primary">
            {busy ? "Starting" : "Start run"}
          </button>
          <p>
            The planning model plans the run: Claude Code reads the repository in a separate copy that it cannot change, and proposes tasks.{" "}
            {mode === "full" ? "Building starts on the plan without your approval." : "Nothing is built until you approve the plan."} Your own files and your branch are not touched.{delivery === "pull_request" ? (mode === "full" ? " Each task the run accepts without you is then pushed and opened as a pull request, with no person looking at it first." : " Each task you accept is then pushed and opened as a pull request.") : ""}
          </p>
        </form>
      </Page>
    </Frame>
  );
}
