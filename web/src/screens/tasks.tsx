import { useCallback, useEffect, useState } from "react";
import { ApiError, listTasks, openEventStream, type TaskSummary } from "../api/client.ts";
import { Alert, Frame, NewLink, Page, PageHeader } from "../components/header.tsx";
import { checksWords } from "../components/evidence.tsx";
import { statusLook, statusWord } from "../components/task-status.ts";
import { StatusBadge } from "../components/status.tsx";

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
        else setFailed(err instanceof ApiError ? `The tasks could not be read. ${err.message}` : "The tasks could not be read: Botbench could not be reached.");
      },
    );
  }, [onSignedOut]);

  // Read the list whenever the stream comes up, and again each time any task reaches a new state or starts or stops waiting on an approval.
  useEffect(() => {
    load();
    return openEventStream(0, { onEvent: () => {}, onConnection: (connected) => connected && load(), onSignedOut, onTask: load, onApproval: load });
  }, [load, onSignedOut]);

  return (
    <Frame current="tasks">
      <Page>
        <PageHeader title="Tasks" action={<NewLink href="#/tasks/new">New task</NewLink>} />
        {failed !== null && (
          <Alert tone="error" role="alert">
            {failed}
          </Alert>
        )}
        {tasks === null ? (
          failed === null && (
            <p role="status" data-testid="task-list-state" className="ds-spinner">
              Reading tasks.
            </p>
          )
        ) : tasks.length === 0 ? (
          <div className="ds-empty-state">
            <h2 data-testid="task-list-state" className="ds-empty-state__title">
              No tasks yet
            </h2>
            <p className="ds-empty-state__body">A task you start with New task, and each task of a run whose plan you approved, is listed here with its state.</p>
          </div>
        ) : (
          <ul data-testid="task-list" className="ds-list">
            {tasks.map((task) => (
              <li key={task.id} className="ds-list__row">
                <a href={`#/tasks/${task.id}`} className="ds-list__link">
                  <span className="ds-run-status">
                    <span data-ds-content="" className="ds-run-status__title">
                      {firstLine(task.prompt)}
                    </span>
                    <span className="ds-run-status__station">
                      <StatusBadge look={statusLook(task)}>{statusWord(task)}</StatusBadge>
                    </span>
                    <span className="ds-run-status__facts">{`Task ${task.id}${task.checks === null ? "" : ` · ${checksWords(task.checks)}`} · ${task.repo}`}</span>
                  </span>
                </a>
              </li>
            ))}
          </ul>
        )}
      </Page>
    </Frame>
  );
}
