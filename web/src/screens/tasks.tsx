import { useCallback, useEffect, useState } from "react";
import { ApiError, listTasks, openEventStream, type TaskSummary } from "../api/client.ts";
import { Header } from "../components/header.tsx";
import { STATUS_WORD } from "../components/task-status.ts";

const firstLine = (text: string): string => text.trim().split("\n")[0] ?? "";

export function TasksScreen({ onSignedOut }: { onSignedOut: () => void }) {
  const [tasks, setTasks] = useState<TaskSummary[] | null>(null);
  const [failed, setFailed] = useState<string | null>(null);

  const load = useCallback((): void => {
    listTasks().then(
      (list) => {
        setTasks(list);
        setFailed(null);
      },
      (err: unknown) => {
        if (err instanceof ApiError && err.status === 401) onSignedOut();
        else setFailed(err instanceof ApiError ? `The tasks could not be read. ${err.message}` : "The tasks could not be read: Smelt could not be reached.");
      },
    );
  }, [onSignedOut]);

  // Read the list whenever the stream comes up, and again each time any task reaches a new state.
  useEffect(() => {
    load();
    return openEventStream(0, { onEvent: () => {}, onConnection: (connected) => connected && load(), onSignedOut, onTask: load });
  }, [load, onSignedOut]);

  return (
    <div className="mx-auto flex min-h-screen max-w-transcript flex-col">
      <Header current="tasks" />
      <main className="flex flex-col gap-lg p-lg">
        <h1 className="font-semibold">Tasks</h1>
        {failed !== null && (
          <p role="alert" className="break-words font-medium">
            {failed}
          </p>
        )}
        {tasks === null ? (
          failed === null && (
            <p role="status" data-testid="task-list-state" className="text-muted">
              Reading tasks.
            </p>
          )
        ) : tasks.length === 0 ? (
          <p data-testid="task-list-state" className="text-muted">
            No tasks yet.
          </p>
        ) : (
          <ul data-testid="task-list" className="flex flex-col">
            {tasks.map((task) => (
              <li key={task.id} className="border-b">
                <a href={`#/tasks/${task.id}`} className="flex min-h-touch flex-col gap-xs py-md">
                  <span className="font-mono text-mono">
                    <span className="font-semibold">{`Task ${task.id}`}</span>
                    {` · ${STATUS_WORD[task.status]}`}
                  </span>
                  <span className="break-words">{firstLine(task.prompt)}</span>
                  <span className="break-all font-mono text-mono text-muted">{task.repo}</span>
                </a>
              </li>
            ))}
          </ul>
        )}
      </main>
    </div>
  );
}
