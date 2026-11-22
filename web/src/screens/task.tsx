import { useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { ApiError, getTask, getTaskDiff, getTranscript, openEventStream, type FileChange, type StoredEvent, type TaskDetail } from "../api/client.ts";
import { ApprovalsContext } from "../app/approvals.tsx";
import { ApprovalCard } from "../components/approval-card.tsx";
import { Header } from "../components/header.tsx";
import { modelWords, sessionModel } from "../components/model-picker.tsx";
import { statusSentence } from "../components/task-status.ts";
import { mergeEvents, Transcript } from "../components/transcript.tsx";

/** What is known about one file's diff: being fetched, fetched, or why it could not be. */
type DiffState = { kind: "loading" } | { kind: "loaded"; diff: string; truncated: boolean } | { kind: "failed"; why: string };

/** Lines are told apart by their first character, which stays in the text; weight and background only repeat it. */
function lineKind(line: string): "added" | "removed" | "hunk" | "header" | "context" {
  if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("diff ") || line.startsWith("index ") || /^(new|deleted) file mode /.test(line)) return "header";
  if (line.startsWith("@@")) return "hunk";
  if (line.startsWith("+")) return "added";
  if (line.startsWith("-")) return "removed";
  return "context";
}
const LINE_CLASS = { added: "bg-border font-medium", removed: "text-muted", hunk: "text-muted", header: "text-muted", context: "" } as const;

/** A unified diff as text, in a block that scrolls sideways on its own so the page never does. */
function Diff({ state }: { state: DiffState }) {
  if (state.kind === "loading") return <p role="status" className="px-md pb-md text-muted">Reading the diff.</p>;
  if (state.kind === "failed") return <p role="alert" className="break-words px-md pb-md font-medium">{`The diff could not be read. ${state.why}`}</p>;
  const lines = state.diff.replace(/\n$/, "").split("\n");
  return (
    <div className="flex flex-col gap-sm pb-md">
      <div data-testid="diff-scroll" tabIndex={0} aria-label="Diff" className="overflow-x-auto rounded-sm border">
        <pre data-testid="diff" className="w-max p-md font-mono text-mono">
          {lines.map((line, i) => {
            const kind = lineKind(line);
            return (
              <span key={i} data-line={kind} className={`block ${LINE_CLASS[kind]}`}>
                {line === "" ? " " : line}
              </span>
            );
          })}
        </pre>
      </div>
      {state.truncated && <p className="text-muted">This diff is longer than Smelt shows here. The whole of it is on the branch.</p>}
    </div>
  );
}

function countWords(file: FileChange): string {
  return file.binary ? "binary" : `+${file.added} −${file.removed}`;
}

export function TaskScreen({ id, onSignedOut }: { id: number; onSignedOut: () => void }) {
  const [task, setTask] = useState<TaskDetail | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [events, setEvents] = useState<StoredEvent[]>([]);
  const [connected, setConnected] = useState(true);
  const [diffs, setDiffs] = useState<Record<string, DiffState>>({});
  const [open, setOpen] = useState<string[]>([]);
  const [copied, setCopied] = useState<string | null>(null);
  const missing = useRef(false);
  /** Counts reads of the task, so an answer that arrives after a newer one was asked for is dropped. */
  const reads = useRef(0);

  /** Read the task as it stands, and its attempt's stored transcript. */
  const load = useCallback((): void => {
    if (missing.current) return;
    const read = ++reads.current;
    const failed = (what: string) => (err: unknown): void => {
      if (err instanceof ApiError && err.status === 401) return onSignedOut();
      if (read !== reads.current) return;
      setProblem(err instanceof ApiError ? `${what} could not be read. ${err.message}` : `${what} could not be read: Smelt could not be reached.`);
    };
    getTask(id).then((next) => {
      // Several states can be announced within milliseconds; only the newest read may set what the screen shows.
      if (read !== reads.current) return;
      setTask(next);
      setProblem(null);
      // Stored events only ever add up, so a transcript is folded in whichever read fetched it.
      if (next.attemptId !== null) getTranscript(next.attemptId).then((transcript) => setEvents((have) => mergeEvents(have, transcript.events)), failed("The transcript"));
    }, (err: unknown) => {
      if (err instanceof ApiError && err.status === 404) {
        missing.current = true;
        return setProblem(`There is no task ${id}.`);
      }
      failed("The task")(err);
    });
  }, [id, onSignedOut]);

  // Follow the stream from now on. The task and its stored transcript are read each time the stream comes up
  // and each time the task reaches a new state, so nothing that happened in between is missed.
  useEffect(() => {
    load();
    return openEventStream(0, {
      onEvent: (event) => setEvents((have) => mergeEvents(have, [event])),
      onConnection: (isConnected) => {
        setConnected(isConnected);
        if (isConnected) load();
      },
      onSignedOut,
      onTask: (announcement) => {
        if (announcement.taskId === id) load();
      },
    });
  }, [id, load, onSignedOut]);

  // This task's requests that wait for an answer, oldest first. One card at a time: the oldest.
  const { pending } = useContext(ApprovalsContext);
  const waiting = useMemo(() => (pending ?? []).filter((approval) => approval.taskId === id), [pending, id]);
  const asking = waiting[0];
  // The task starts and stops waiting as its requests come and go, so it is read again when they do.
  useEffect(() => load(), [load, asking?.id]);

  const attemptId = task?.attemptId ?? null;
  const shown = useMemo(() => events.filter((e) => e.attemptId === attemptId), [events, attemptId]);

  // The model that answered is the one the driver's own session event names; what was asked for is on the task.
  const session = useMemo(() => sessionModel(shown), [shown]);

  const toggle = (file: string): void => {
    if (open.includes(file)) return setOpen(open.filter((f) => f !== file));
    setOpen([...open, file]);
    if (diffs[file]?.kind === "loaded") return;
    setDiffs((have) => ({ ...have, [file]: { kind: "loading" } }));
    getTaskDiff(id, file).then(
      ({ diff, truncated }) => setDiffs((have) => ({ ...have, [file]: { kind: "loaded", diff, truncated } })),
      (err: unknown) => {
        if (err instanceof ApiError && err.status === 401) return onSignedOut();
        setDiffs((have) => ({ ...have, [file]: { kind: "failed", why: err instanceof ApiError ? err.message : "Smelt could not be reached." } }));
      },
    );
  };

  const copyBranch = (branch: string): void => {
    // The clipboard is only there on a secure page (HTTPS, or this Mac itself) and may still refuse.
    const written = navigator.clipboard === undefined ? Promise.reject(new Error("no clipboard")) : navigator.clipboard.writeText(branch);
    written.then(
      () => setCopied("Copied."),
      () => setCopied("Not copied: this browser refused. Select the name to copy it."),
    );
  };

  // Between the end of the turn and Smelt's commit the task is still building, but Claude Code is no longer working.
  const working = task?.status === "building" && attemptId !== null && !shown.some((e) => e.type === "turn_ended") ? (asking === undefined ? "Claude Code is working." : "Claude Code is paused until you answer.") : null;

  return (
    <div className="mx-auto flex min-h-screen max-w-transcript flex-col">
      <Header current={null} />
      {!connected && (
        <p role="status" data-testid="stream-banner" className="border-b bg-border px-lg py-sm font-medium">
          Live updates are disconnected. Reconnecting.
        </p>
      )}
      <main className="flex flex-col gap-xl p-lg">
        {problem !== null && (
          <p role="alert" className="break-words font-medium">
            {problem}
          </p>
        )}
        {task === null ? (
          problem === null && (
            <p role="status" className="text-muted">
              Reading the task.
            </p>
          )
        ) : (
          <>
            <section className="flex flex-col gap-xs">
              <h1 className="font-semibold">{`Task ${task.id}`}</h1>
              <p data-testid="task-status" role="status" className="break-words font-medium">
                {statusSentence(task)}
              </p>
              <p data-testid="task-model" className="break-all font-mono text-mono text-muted">
                {`${modelWords(session)}. Requested: ${task.requestedModel ?? "the CLI default"}.`}
              </p>
              <p data-testid="task-repo" className="break-all font-mono text-mono text-muted">
                {task.repo}
              </p>
            </section>

            {asking !== undefined && <ApprovalCard key={asking.id} approval={asking} more={waiting.length - 1} onSignedOut={onSignedOut} />}

            {shown.length > 0 || working !== null ? (
              <section aria-label="Transcript">
                <Transcript events={shown} working={working} />
              </section>
            ) : (
              attemptId === null && (
                <p data-testid="task-prompt" className="whitespace-pre-wrap break-words rounded-sm bg-border p-md font-mono text-mono">
                  {task.prompt}
                </p>
              )
            )}

            {task.filesProblem !== null && (
              <p role="alert" className="break-words font-medium">
                {task.filesProblem}
              </p>
            )}
            {task.files !== null && (
              <section className="flex flex-col gap-sm">
                <h2 className="font-semibold">Changed files</h2>
                {task.files.length === 0 ? (
                  <p data-testid="no-changes" className="text-muted">
                    No file was changed, so the branch is still at the commit it started from.
                  </p>
                ) : (
                  <ul data-testid="changed-files" className="flex flex-col border-t">
                    {task.files.map((file) => {
                      const expanded = open.includes(file.path);
                      return (
                        <li key={file.path} className="border-b">
                          <button type="button" aria-expanded={expanded} onClick={() => toggle(file.path)} className="flex min-h-touch w-full items-center gap-md py-sm text-left font-mono text-mono">
                            <span aria-hidden="true" className="shrink-0">
                              {expanded ? "−" : "+"}
                            </span>
                            <span className="min-w-0 flex-1 break-all">{file.path}</span>
                            <span className="shrink-0 text-muted">{file.status}</span>
                            <span className="shrink-0">{countWords(file)}</span>
                          </button>
                          {expanded && <Diff state={diffs[file.path] ?? { kind: "loading" }} />}
                        </li>
                      );
                    })}
                  </ul>
                )}
              </section>
            )}

            {task.branch !== null && (
              <section className="flex flex-col gap-sm">
                <h2 className="font-semibold">Branch</h2>
                <div className="flex items-center gap-md">
                  <code data-testid="branch" className="min-w-0 flex-1 break-all font-mono text-mono">
                    {task.branch}
                  </code>
                  <button type="button" aria-label="Copy branch name" onClick={() => copyBranch(task.branch!)} className="min-h-touch min-w-touch shrink-0 rounded-sm border px-md font-medium">
                    Copy
                  </button>
                </div>
                {copied !== null && (
                  <p data-testid="copy-state" role="status" className="text-muted">
                    {copied}
                  </p>
                )}
                <p data-testid="not-merged" className="text-muted">
                  Nothing has been merged or pushed. Claude Code may read and change files inside this task's worktree without asking. Every shell command waits for your answer first, and Smelt sends you anything else it wants to do as well. A worktree keeps changes apart; it is not a sandbox: a command you allow runs with your account's rights.
                </p>
              </section>
            )}
          </>
        )}
      </main>
    </div>
  );
}
