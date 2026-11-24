import { useEffect, useState } from "react";
import { ApiError, getRepositoryExecutions, getWatch, type RepositoryExecution, type WatchStatus } from "../../api/client.ts";
import { folderName } from "../../app/composer.ts";
import { EXECUTION_ABOUT, EXECUTION_HEADING, executionWords, NO_REPOSITORIES } from "../../app/execution-words.ts";
import { counted } from "../../app/format.ts";
import { NO_WATCH, watchAbout, watchFailure, watchStateWords } from "../../app/watch-words.ts";
import { About, More, Note, Panel, Reading, SectionHeading, StateWord } from "./parts.tsx";

/** The commands of one kind, each in the code typeface, or "None". They are the settings file's own text. */
function Commands({ label, commands, testId }: { label: string; commands: readonly string[]; testId: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <dt className="text-meta font-semibold text-muted-foreground">{label}</dt>
      <dd data-testid={testId} className="flex flex-col items-start gap-1.5">
        {commands.length === 0 ? (
          <span className="text-meta text-muted-foreground">None</span>
        ) : (
          commands.map((command, i) => (
            <code key={i} data-ds-content="" className="max-w-full rounded-sm bg-sunken px-2 py-1 wrap-anywhere text-foreground">
              {command}
            </code>
          ))
        )}
      </dd>
    </div>
  );
}

/**
 * Where commands run (src/execution.ts, ADR 0009): each repository of the settings file, whether its tasks' commands
 * run on this Mac or in a container of the image it names, and the setup and check commands Botbench runs there itself.
 * All of it is set in the settings file, which Botbench never writes, so it is shown here, not changed.
 */
function Repositories({ onSignedOut }: { onSignedOut: () => void }) {
  const [repositories, setRepositories] = useState<RepositoryExecution[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    getRepositoryExecutions().then(
      (found) => live && (setRepositories(found), setProblem(null)),
      (err: unknown) => {
        if (!live) return;
        if (err instanceof ApiError && err.status === 401) return onSignedOut();
        setProblem(err instanceof ApiError ? `Where commands run could not be read. ${err.message}` : "Where commands run could not be read: Botbench could not be reached.");
      },
    );
    return () => {
      live = false;
    };
  }, [onSignedOut]);

  return (
    <section data-testid="execution-settings" aria-labelledby="settings-execution" className="flex flex-col gap-4">
      <SectionHeading id="settings-execution" right={repositories !== null && repositories.length > 0 && <About>{counted(repositories.length, "repository", "repositories")}</About>}>
        {EXECUTION_HEADING}
      </SectionHeading>
      {problem !== null ? (
        <Note tone="error" role="alert">
          {problem}
        </Note>
      ) : repositories === null ? (
        <Reading>Reading where commands run.</Reading>
      ) : repositories.length === 0 ? (
        <p className="text-sm text-muted-foreground">{NO_REPOSITORIES}</p>
      ) : (
        repositories.map((r) => {
          const words = executionWords(r.execution);
          return (
            <Panel key={r.path} data-testid="execution" className="flex flex-col gap-4 p-5">
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <h3 data-ds-content="" className="text-base font-semibold">
                  {folderName(r.path)}
                </h3>
                <code data-ds-content="" className="min-w-0 break-all text-muted-foreground">
                  {r.path}
                </code>
              </div>
              {/* Where the commands run, then the commands in two columns of their own: a third of the card each cut a long command into a dozen short lines. */}
              <dl className="grid gap-4 md:grid-cols-2">
                <div className="flex min-w-0 flex-col gap-1.5 md:col-span-2">
                  <dt className="text-meta font-semibold text-muted-foreground">Commands run</dt>
                  <dd className="flex flex-col gap-1">
                    <span data-testid="execution-kind" className="text-sm font-semibold">
                      {words.kind}
                    </span>
                    <span className="text-meta text-muted-foreground">{words.about}</span>
                  </dd>
                </div>
                <Commands label="Setup" commands={r.setup} testId="execution-setup" />
                <Commands label="Checks" commands={r.checks} testId="execution-checks" />
              </dl>
            </Panel>
          );
        })
      )}
    </section>
  );
}

/**
 * Watched issues (issue #73): each repository whose settings file entry has a "watch", with its label, how often it is
 * looked at, that the label is not trust (anyone with triage access can apply it), and how its last look went: when it
 * worked, or why it did not, with what gh said and when it tries again. Set in the settings file; shown here.
 */
function Watched({ onSignedOut }: { onSignedOut: () => void }) {
  const [watches, setWatches] = useState<WatchStatus[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  // Read as Settings opens; Work is where the watch's changes show as they come.
  useEffect(() => {
    let live = true;
    getWatch().then(
      (found) => live && (setWatches(found.watches), setProblem(null)),
      (err: unknown) => {
        if (!live) return;
        if (err instanceof ApiError && err.status === 401) return onSignedOut();
        setProblem(err instanceof ApiError ? `The watched repositories could not be read. ${err.message}` : "The watched repositories could not be read: Botbench could not be reached.");
      },
    );
    return () => {
      live = false;
    };
  }, [onSignedOut]);

  return (
    <section data-testid="watch-settings" aria-labelledby="settings-watch" className="flex flex-col gap-4">
      <SectionHeading id="settings-watch">Watched issues</SectionHeading>
      {problem !== null ? (
        <Note tone="error" role="alert">
          {problem}
        </Note>
      ) : watches === null ? (
        <Reading>Reading the watched repositories.</Reading>
      ) : watches.length === 0 ? (
        <p className="text-sm text-muted-foreground">{NO_WATCH}</p>
      ) : (
        watches.map((w) => {
          const failure = w.state === "failed" ? watchFailure(w) : null;
          return (
            <Panel key={w.path} data-testid="watch" className="flex flex-col gap-3 p-5">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <h3 data-ds-content="" className="text-base font-semibold">
                  {folderName(w.path)}
                </h3>
                <StateWord tone={w.state === "failed" ? "attention" : "quiet"} role="status">
                  {watchStateWords(w)}
                </StateWord>
              </div>
              <p className="text-meta text-muted-foreground">{watchAbout(w)}</p>
              {failure !== null && (
                <Note tone="error" role="alert">
                  {`${failure.lead} `}
                  {w.said !== null && <span data-ds-content="">{`${w.said} `}</span>}
                  {failure.after}
                </Note>
              )}
            </Panel>
          );
        })
      )}
    </section>
  );
}

/** Execution environments: per repository, where its commands run with its setup and checks, and what it watches. */
export function EnvironmentsGroup({ onSignedOut }: { onSignedOut: () => void }) {
  return (
    <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
      <div className="flex min-w-0 flex-col gap-8">
        <Repositories onSignedOut={onSignedOut} />
        <Watched onSignedOut={onSignedOut} />
      </div>
      <aside aria-label="About execution environments" className="flex flex-col gap-4">
        <Panel className="flex flex-col gap-2 p-5">
          <h2 className="text-base font-semibold">How to change this</h2>
          <About>Edit the settings file, then start Botbench again. A setting it cannot use stops Botbench at start, with a sentence that names it.</About>
          <More about="How to change where commands run">
            <p>{EXECUTION_ABOUT}</p>
            <pre data-ds-content="" className="overflow-x-auto rounded-md bg-sunken p-3 text-foreground">{`"repositories": {\n  "/Users/you/code/docs-site": {\n    "setup": ["npm ci"],\n    "checks": ["npm run build"],\n    "execution": {\n      "kind": "container",\n      "image": "node:24"\n    }\n  }\n}`}</pre>
            <p>Leave "execution" out, or set its kind to "host", and the commands run on this Mac.</p>
          </More>
        </Panel>
        <Panel className="flex flex-col gap-2 bg-transparent p-5">
          <h2 className="text-base font-semibold">What never reaches the place commands run</h2>
          <About>Your secrets. Sign-ins, keys and tokens stay outside it, on this Mac or in a container: a command is given no credential and cannot read a sign-in folder, the Keychain or your SSH keys.</About>
        </Panel>
      </aside>
    </div>
  );
}
