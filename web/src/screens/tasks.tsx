import { useCallback, useEffect, useState } from "react";
import { ApiError, listTasks, openEventStream, type TaskSummary } from "../api/client.ts";
import { Alert, Frame, Page, PageHeader } from "../components/header.tsx";
import { statusLook, statusWord } from "../components/task-status.ts";

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

  // Read the list whenever the stream comes up, and again each time any task reaches a new state or starts or stops waiting on an approval.
  useEffect(() => {
    load();
    return openEventStream(0, { onEvent: () => {}, onConnection: (connected) => connected && load(), onSignedOut, onTask: load, onApproval: load });
  }, [load, onSignedOut]);

  return (
    <Frame current="tasks">
      <Page>
        <PageHeader title="Tasks" />
        {failed !== null && (
          <Alert tone="error" role="alert">
            {failed}
          </Alert>
        )}
        {tasks === null ? (
          failed === null && (
            <p role="status" data-testid="task-list-state" className="gw-spinner">
              Reading tasks.
            </p>
          )
        ) : tasks.length === 0 ? (
          <div className="gw-empty-state">
            <h2 data-testid="task-list-state" className="gw-empty-state__title">
              No tasks yet
            </h2>
            <p className="gw-empty-state__body">A task you start from New task is listed here with its state.</p>
          </div>
        ) : (
          <ul data-testid="task-list" className="gw-list">
            {tasks.map((task) => (
              <li key={task.id} className="gw-list__row">
                <a href={`#/tasks/${task.id}`} className="gw-list__link">
                  <span className="gw-run-status">
                    <span className="gw-run-status__title">{firstLine(task.prompt)}</span>
                    <span className="gw-run-status__station">
                      <span className={statusLook(task)}>{statusWord(task)}</span>
                    </span>
                    <span className="gw-run-status__facts">{`Task ${task.id} · ${task.repo}`}</span>
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
