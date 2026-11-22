import { useLayoutEffect, useRef, type ReactNode, type RefObject } from "react";
import type { Delivery, KnownRepository, RunMode } from "../api/client.ts";
import { ISSUE_NOT_FULL, splitPath, type Kind, type RepoPick, type Row } from "../app/composer.ts";
import { IssueOptions, type IssueChoiceState } from "./issue-choice.tsx";
import { Icon, type IconName } from "./icon.tsx";
import { ModePicker } from "./mode-choice.tsx";
import { ModelOptions, type ModelChoiceState } from "./model-picker.tsx";
import { Option } from "./option.tsx";
import { PreapprovedEditor, type RepositoryChoice } from "./repository.tsx";
import { ReviewOptions, type ReviewChoiceState } from "./review-choice.tsx";

/** What the sheet shows: the rows, or one setting's view. */
export type SheetView = "rows" | Row;

/** Each row's name on the row, its view's title and its icon. */
const ROW: Record<Row, { label: string; title: string; icon: IconName }> = {
  repository: { label: "Repository", title: "Repository", icon: "folder" },
  kind: { label: "What to do", title: "What to do", icon: "git-branch" },
  issue: { label: "From an issue", title: "From an issue", icon: "external-link" },
  spec: { label: "Spec file", title: "Spec file", icon: "file" },
  mode: { label: "Mode", title: "Mode", icon: "shield" },
  review: { label: "Review", title: "Review", icon: "eye" },
  delivery: { label: "When accepted", title: "When you accept a task", icon: "circle-check" },
  commands: { label: "Allowed commands", title: "Allowed commands", icon: "terminal" },
  models: { label: "Model", title: "Model", icon: "cpu" },
};

/** What the sheet reads and sets: the composer's settings. */
export interface SheetState {
  rows: Row[];
  values: Record<Row, string>;
  /** Whether a row's value carries a risk (Fully autonomous). */
  warning: Partial<Record<Row, boolean>>;
  repo: RepoPick;
  otherPath: string;
  known: KnownRepository[];
  chooseRepo(pick: RepoPick): void;
  setOtherPath(path: string): void;
  repository: RepositoryChoice;
  kind: Kind;
  setKind(kind: Kind): void;
  specPath: string;
  setSpecPath(path: string): void;
  mode: RunMode | null;
  setMode(mode: RunMode): void;
  review: ReviewChoiceState;
  delivery: Delivery;
  setDelivery(delivery: Delivery): void;
  issue: IssueChoiceState;
  models: ModelChoiceState;
  sameBuild: boolean;
  setSameBuild(same: boolean): void;
  buildModels: ModelChoiceState;
}

/**
 * The Add context sheet: a bottom sheet on a phone, a side panel from 768px. Its rows show each setting's value; a row
 * opens that setting's view in the same sheet, with Back to the rows. Choosing sets the value at once.
 */
export function ContextSheet({ sheetRef, view, setView, state }: { sheetRef: RefObject<HTMLDialogElement | null>; view: SheetView; setView: (view: SheetView) => void; state: SheetState }) {
  /** The row whose view is open, so Back can put the focus on it again. */
  const pressed = useRef<Row | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const shown: SheetView = view !== "rows" && !state.rows.includes(view) ? "rows" : view;
  const title = shown === "rows" ? "Add context" : shown === "models" && state.rows.includes("spec") ? "Models" : ROW[shown].title;

  // A view takes the focus on its chosen option (else its first control); the rows give it back to the row that was pressed.
  useLayoutEffect(() => {
    const dialog = sheetRef.current;
    if (dialog === null || !dialog.open) return;
    const body = bodyRef.current;
    if (body === null) return;
    if (shown === "rows") {
      if (pressed.current !== null) body.querySelector<HTMLElement>(`[data-row="${pressed.current}"]`)?.focus();
      return;
    }
    pressed.current = shown;
    (body.querySelector<HTMLElement>("input:checked") ?? body.querySelector<HTMLElement>("input:not([disabled]), button, textarea"))?.focus();
  }, [shown, sheetRef]);

  return (
    <dialog ref={sheetRef} className="ds-sheet" aria-labelledby="context-title" onClose={() => setView("rows")}>
      <form className="ds-sheet__header" method="dialog">
        {shown === "rows" ? (
          <h2 className="ds-sheet__title" id="context-title">
            {title}
          </h2>
        ) : (
          <div className="ds-cluster ds-gap-xs">
            <button type="button" className="ds-button ds-button--quiet ds-icon-button" aria-label="Back to Add context" onClick={() => setView("rows")}>
              <Icon name="chevron-left" className="ds-button__icon" />
            </button>
            <h2 className="ds-sheet__title" id="context-title">
              {title}
            </h2>
          </div>
        )}
        <button type="submit" className="ds-button ds-button--quiet ds-icon-button" value="close" aria-label="Close Add context">
          <Icon name="x" className="ds-button__icon" />
        </button>
      </form>
      <div ref={bodyRef} className="ds-sheet__body">
        {shown === "rows" ? (
          <ul className="ds-context-list" aria-label="Settings of what you send">
            {state.rows.map((row) => (
              <li key={row}>
                <button type="button" data-row={row} className="ds-context-list__button" onClick={() => setView(row)}>
                  <Icon name={ROW[row].icon} className="ds-context-list__icon" />
                  <span className="ds-context-list__label">{row === "models" && state.rows.includes("spec") ? "Models" : ROW[row].label}</span>{" "}
                  <span className={state.warning[row] === true ? "ds-context-list__value ds-context-list__value--warning" : "ds-context-list__value"}>{state.values[row]}</span>
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <View row={shown} state={state} />
        )}
      </div>
    </dialog>
  );
}

function View({ row, state }: { row: Row; state: SheetState }): ReactNode {
  if (row === "repository") return <RepositoryOptions state={state} />;
  if (row === "kind")
    return (
      <fieldset className="ds-option-picker">
        <legend className="ds-option-picker__legend ds-visually-hidden">What to do</legend>
        <Option group="kind" id="kind-task" value="task" checked={state.kind === "task"} onChange={() => state.setKind("task")} name="One task" description="Claude Code does it on a new branch, for you to review." />
        <Option group="kind" id="kind-run" value="run" checked={state.kind === "run"} onChange={() => state.setKind("run")} name="Plan a run" description="Claude Code plans several tasks for you to approve, then builds them." />
      </fieldset>
    );
  if (row === "spec")
    return (
      <div className="ds-field">
        <label htmlFor="spec-path" className="ds-field__label">
          Spec file path
        </label>
        <input id="spec-path" name="specPath" type="text" autoCapitalize="none" autoCorrect="off" spellCheck={false} value={state.specPath} onChange={(e) => state.setSpecPath(e.target.value)} aria-describedby="spec-path-about" className="ds-field__control" />
        <p id="spec-path-about" className="ds-field__description">
          A .md, .markdown or .txt file on this Mac that describes the work, in place of a message. Botbench reads it once, when the run starts.
        </p>
      </div>
    );
  if (row === "mode")
    return state.kind === "task" ? (
      <ModePicker name="run-mode" legend="Mode" hideLegend hint="A single task always runs in Manual. Plan a run to choose another mode." value="manual" onChange={() => {}} only="manual" />
    ) : (
      <ModePicker name="run-mode" legend="Mode" hideLegend hint={state.issue.attached !== null ? ISSUE_NOT_FULL : "Fully autonomous accepts only work whose checks all passed and that its reviewer, if any, said looks right; the rest waits for you. The mode cannot be changed once the run starts."} value={state.mode} onChange={state.setMode} {...(state.issue.attached !== null ? { refused: { mode: "full" as const, state: "Not for a run from an issue" } } : {})} />
    );
  if (row === "issue") return <IssueOptions state={state.issue} />;
  if (row === "review") return <ReviewOptions state={state.review} />;
  if (row === "delivery")
    return (
      <fieldset className="ds-option-picker" aria-describedby="delivery-hint">
        <legend className="ds-option-picker__legend ds-visually-hidden">When you accept a task</legend>
        <p id="delivery-hint" className="ds-option-picker__hint">
          It cannot be changed once the run starts.
        </p>
        <Option group="delivery" id="delivery-branch" value="branch" checked={state.delivery === "branch"} onChange={() => state.setDelivery("branch")} name="Keep the branch" description="The work stays on its branch on this Mac. Nothing is sent anywhere." />
        <Option
          group="delivery"
          id="delivery-pr"
          value="pull_request"
          checked={state.delivery === "pull_request"}
          onChange={() => state.setDelivery("pull_request")}
          name="Open a pull request"
          description="Botbench pushes the task's branch with your own git and gh, and opens a pull request. It never merges, never pushes by force, and never pushes to your main branch."
        />
      </fieldset>
    );
  if (row === "commands") return <PreapprovedEditor choice={state.repository} scope={state.kind} />;
  if (!state.rows.includes("spec")) return <ModelOptions state={state.models} legend="Model" hideLegend />;
  return (
    <div className="ds-stack ds-gap-lg">
      <ModelOptions state={state.models} legend="Planning model" />
      <div className="ds-checkbox">
        <input className="ds-checkbox__input" type="checkbox" id="same-build-model" checked={state.sameBuild} onChange={(e) => state.setSameBuild(e.target.checked)} />
        <label className="ds-checkbox__label" htmlFor="same-build-model">
          Build the tasks with the same model
        </label>
      </div>
      {!state.sameBuild && <ModelOptions state={state.buildModels} id="build-model" legend="Build model" />}
    </div>
  );
}

/** None (just chat), the repositories Botbench knows of, recent first, and Another folder…, which reveals the path field. */
function RepositoryOptions({ state }: { state: SheetState }) {
  const { repo, known, repository } = state;
  const listed = repo.kind === "known" && !known.some((k) => k.path === repo.path) ? [{ name: splitPath(repo.path)[1].replace(/\/$/, ""), path: repo.path }, ...known] : known;
  return (
    <fieldset className="ds-option-picker">
      <legend className="ds-option-picker__legend ds-visually-hidden">Repository</legend>
      <Option group="repository" id="repo-none" value="" checked={repo.kind === "none"} onChange={() => state.chooseRepo({ kind: "none" })} name="None (just chat)" description="Claude Code answers in a folder of its own, outside your projects." />
      {listed.map((k, at) => (
        <Option key={k.path} group="repository" id={`repo-${at}`} value={k.path} checked={repo.kind === "known" && repo.path === k.path} onChange={() => state.chooseRepo({ kind: "known", path: k.path })} name={k.name} path={splitPath(k.path)} />
      ))}
      <Option group="repository" id="repo-other" value="?other" checked={repo.kind === "other"} onChange={() => state.chooseRepo({ kind: "other", path: state.otherPath })} name="Another folder…" />
      <div className="ds-option-picker__reveal">
        <div className="ds-field">
          <label htmlFor="repo" className="ds-field__label">
            Folder path
          </label>
          <input id="repo" name="repo" type="text" autoCapitalize="none" autoCorrect="off" spellCheck={false} value={state.otherPath} onChange={(e) => state.setOtherPath(e.target.value)} aria-describedby="repo-state" aria-invalid={repo.kind === "other" && repository.refused} className="ds-field__control" />
          <p id="repo-state" data-testid="repo-state" role="status" className={repo.kind === "other" && repository.refused ? "ds-field__error" : "ds-field__description"}>
            {repo.kind === "other" ? repository.words : ""}
          </p>
        </div>
      </div>
    </fieldset>
  );
}
