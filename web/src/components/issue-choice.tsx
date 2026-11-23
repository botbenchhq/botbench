import { useEffect, useRef, useState } from "react";
import { BusyButton } from "../../vendor/design-system/react/busy-button.tsx";
import { ApiError, issueSourceOf, lookUpIssue, timedOut, type IssuePreview } from "../api/client.ts";
import type { AttachedIssue } from "../app/composer.ts";
import { authorWords, hostsHint } from "../app/run-words.ts";

/*
 * From an issue, in the Add context sheet: the owner names one issue of the chosen repository, Botbench reads it with the
 * owner's own gh and shows exactly what it read, and the owner attaches it to the run. Everything an issue holds but its
 * number was written by people outside the project, so all of it is shown as plain text: no markdown, no link and no
 * image from it is drawn, and nothing it names is fetched.
 */

/** Whether the chosen repository's issues can be read: being asked, yes (its GitHub repository and allowed hosts), or no. */
type Source = { state: "checking" } | { state: "offered"; repository: string; hosts: string[] } | { state: "none" };

export interface IssueChoiceState {
  source: Source;
  given: string;
  setGiven(given: string): void;
  looking: boolean;
  /** What went wrong with the last look, in words. */
  problem: string | null;
  /** The issue as Botbench read it, before it is attached. */
  preview: IssuePreview | null;
  lookUp(): void;
  allowHosts: boolean;
  setAllowHosts(allow: boolean): void;
  attached: AttachedIssue | null;
  attach(): void;
  remove(): void;
}

/**
 * The issue choice for the repository at `repo` ("" for none), asked about only while a run is being set up. `preset`
 * is an issue proposed on Work that the owner chose Start on: once the From an issue row is offered for that same
 * repository, it is looked up as if the owner had typed its number, and attached when it is read.
 */
export function useIssueChoice(repo: string, wanted: boolean, onSignedOut: () => void, preset: { repo: string; number: number } | null = null): IssueChoiceState {
  const [source, setSource] = useState<Source>({ state: "none" });
  const [given, setGiven] = useState("");
  const [looking, setLooking] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [preview, setPreview] = useState<IssuePreview | null>(null);
  const [allowHosts, setAllowHosts] = useState(false);
  const [attached, setAttached] = useState<AttachedIssue | null>(null);
  /** The repository the offered source was read for, so a preset is looked up only in its own. */
  const sourceFor = useRef<string | null>(null);
  const presetDone = useRef<{ repo: string; number: number } | null>(null);

  // Another repository: nothing read for the last one is kept.
  useEffect(() => {
    setGiven("");
    setProblem(null);
    setPreview(null);
    setAllowHosts(false);
    setAttached(null);
    const path = repo.trim();
    sourceFor.current = null;
    if (!wanted || path === "") return setSource({ state: "none" });
    setSource({ state: "checking" });
    const older = new AbortController();
    issueSourceOf(path, older.signal).then(
      (found) => {
        sourceFor.current = found.repository === null ? null : path;
        setSource(found.repository === null ? { state: "none" } : { state: "offered", repository: found.repository, hosts: found.hosts });
      },
      (err: unknown) => {
        if (older.signal.aborted) return;
        if (err instanceof ApiError && err.status === 401) onSignedOut();
        setSource({ state: "none" });
      },
    );
    return () => older.abort();
  }, [repo, wanted, onSignedOut]);

  const lookUpText = (text: string, attachWhenRead: boolean): void => {
    setLooking(true);
    setProblem(null);
    setPreview(null);
    lookUpIssue(repo.trim(), text).then(
      (found) => {
        setLooking(false);
        setPreview(found);
        // Hosts stay off: a run from an issue reaches no network host unless the owner allows them for it.
        if (attachWhenRead) setAttached({ fetchId: found.fetchId, allowHosts: false, number: found.number, title: found.title });
      },
      (err: unknown) => {
        setLooking(false);
        if (err instanceof ApiError && err.status === 401) return onSignedOut();
        setProblem(err instanceof ApiError ? err.message : timedOut(err) ? "GitHub did not answer in time. Try again." : "Botbench could not be reached.");
      },
    );
  };
  const lookUp = (): void => {
    if (looking || given.trim() === "") return;
    lookUpText(given.trim(), false);
  };

  // An issue Start was chosen on: looked up once, in its own repository, as soon as that repository's issues are offered.
  useEffect(() => {
    if (preset === null || source.state !== "offered" || sourceFor.current !== preset.repo || repo.trim() !== preset.repo) return;
    if (presetDone.current?.repo === preset.repo && presetDone.current.number === preset.number) return;
    presetDone.current = preset;
    setGiven(String(preset.number));
    lookUpText(String(preset.number), true);
    // lookUpText reads only `repo`, which is part of the check above.
  }, [preset, source, repo]);

  return {
    source,
    given,
    setGiven: (next) => {
      setGiven(next);
      setProblem(null);
    },
    looking,
    problem,
    preview,
    lookUp,
    allowHosts,
    setAllowHosts: (allow) => {
      setAllowHosts(allow);
      setAttached((now) => (now === null ? null : { ...now, allowHosts: allow }));
    },
    attached,
    attach: () => preview !== null && setAttached({ fetchId: preview.fetchId, allowHosts, number: preview.number, title: preview.title }),
    remove: () => {
      setAttached(null);
      setPreview(null);
      setGiven("");
    },
  };
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/** The From an issue view: the field, Look it up, then what was read, and Attach this issue or Remove the issue. */
export function IssueOptions({ state }: { state: IssueChoiceState }) {
  const { preview, attached, source } = state;
  const shown = preview ?? null;
  const hosts = source.state === "offered" ? source.hosts : [];
  const written = shown === null ? null : authorWords(shown.author, shown.authorRelation, state.allowHosts ? hosts : []);
  return (
    <div className="ds-stack ds-gap-lg">
      <form
        className="ds-stack ds-gap-sm"
        onSubmit={(e) => {
          e.preventDefault();
          state.lookUp();
        }}
      >
        <div className="ds-field">
          <label htmlFor="issue-given" className="ds-field__label">
            Issue number or address
          </label>
          <input id="issue-given" name="issue" type="text" inputMode="url" autoCapitalize="none" autoCorrect="off" spellCheck={false} value={state.given} onChange={(e) => state.setGiven(e.target.value)} aria-describedby="issue-about" aria-invalid={state.problem !== null} className="ds-field__control" />
          <p id="issue-about" data-testid="issue-state" role="status" className={state.problem !== null ? "ds-field__error" : "ds-field__description"}>
            {state.problem ??
              (state.looking ? (
                "Reading the issue from GitHub with your gh."
              ) : (
                <>
                  An issue of <span data-ds-content="">{source.state === "offered" ? source.repository : "this repository"}</span>, such as 123 or its address. Botbench only reads it: nothing is posted to GitHub.
                </>
              ))}
          </p>
        </div>
        <div className="ds-cluster ds-gap-xs">
          <BusyButton type="submit" busy={state.looking} busyLabel="Looking it up" disabled={state.given.trim() === ""}>
            Look it up
          </BusyButton>
        </div>
      </form>

      {shown !== null && written !== null && (
        <section className="ds-card" aria-labelledby="issue-title" data-testid="issue-preview">
          <div className="ds-card__header">
            <h3 className="ds-card__title" id="issue-title" data-ds-content="">
              {shown.title}
            </h3>
          </div>
          <div className="ds-card__body ds-stack ds-gap-sm">
          <dl className="ds-key-value">
            <div className="ds-key-value__item">
              <dt className="ds-key-value__label">Issue</dt>
              <dd className="ds-key-value__value">
                #{shown.number} of <span data-ds-content="">{shown.repository}</span>
              </dd>
            </div>
            <div className="ds-key-value__item">
              <dt className="ds-key-value__label">Opened by</dt>
              <dd className="ds-key-value__value" data-ds-content={shown.author === null ? undefined : ""}>
                {shown.author ?? "An account that no longer exists"}
              </dd>
            </div>
            <div className="ds-key-value__item">
              <dt className="ds-key-value__label">State</dt>
              <dd className="ds-key-value__value">{shown.state === "OPEN" ? "Open" : shown.state === "CLOSED" ? "Closed" : shown.state}</dd>
            </div>
            {shown.labels.length > 0 && (
              <div className="ds-key-value__item">
                <dt className="ds-key-value__label">Labels</dt>
                <dd className="ds-key-value__value" data-ds-content="">
                  {shown.labels.join(", ")}
                </dd>
              </div>
            )}
          </dl>
          <details className="ds-disclosure">
            <summary className="ds-disclosure__summary">
              What the issue says
              <span className="ds-disclosure__meta">{plural(shown.comments.length, "comment", "comments")}</span>
            </summary>
            <div className="ds-disclosure__content ds-stack ds-gap-sm">
              {/* Plain text only: React writes it as text, so no markdown, link or image in it is drawn or fetched. */}
              <figure className="ds-code-block">
                <pre className="ds-code-block__body" data-testid="issue-body" data-ds-content="">
                  <code>{shown.body.trim() === "" ? "(The issue has no text.)" : shown.body}</code>
                </pre>
              </figure>
              {shown.comments.map((comment, at) => (
                <figure className="ds-code-block" key={at}>
                  <figcaption className="ds-code-block__caption">
                    Comment by <span data-ds-content="">{comment.author ?? "an account that no longer exists"}</span>
                  </figcaption>
                  <pre className="ds-code-block__body" data-ds-content="">
                    <code>{comment.body}</code>
                  </pre>
                </figure>
              ))}
              {shown.cutWords !== null && <p>{shown.cutWords}</p>}
            </div>
          </details>
          <p data-testid="issue-outside">
            {written.author !== null && <span data-ds-content="">{written.author}</span>}
            {written.text}
          </p>
          {hosts.length > 0 && (
            <div className="ds-checkbox">
              <input className="ds-checkbox__input" type="checkbox" id="issue-hosts" checked={state.allowHosts} onChange={(e) => state.setAllowHosts(e.target.checked)} aria-describedby="issue-hosts-about" />
              <label className="ds-checkbox__label" htmlFor="issue-hosts">
                Allow this repository's network hosts for this run
              </label>
              <p className="ds-checkbox__description" id="issue-hosts-about">
                {hostsHint(hosts, state.allowHosts)}
              </p>
            </div>
          )}
          <div className="ds-cluster ds-gap-xs">
            {attached !== null && attached.fetchId === shown.fetchId ? (
              <>
                <p data-testid="issue-attached">Attached to this run.</p>
                <button type="button" className="ds-button" onClick={state.remove}>
                  Remove the issue
                </button>
              </>
            ) : (
              <button type="button" className="ds-button ds-button--primary" onClick={state.attach}>
                Attach this issue
              </button>
            )}
          </div>
          </div>
        </section>
      )}
    </div>
  );
}
