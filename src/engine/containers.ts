import type { DatabaseSync } from "node:sqlite";
import { findDocker, labelledContainers, mountedFrom, removeContainer, startTaskContainer, type ContainerStart } from "../execution.ts";

/*
 * The task containers of this Botbench (src/execution.ts, ADR 0009): started for a task of a repository whose commands
 * run in a container, and removed once the task is no longer live. One sweep owns the removing (the shape of
 * paperclip's orphan sandbox sweep): it runs at start, over every container carrying Botbench's workbench label, under
 * any workbench name, whose mount lies in this data folder, and after each change of a task this process started a
 * container for. A task is live until it is accepted, rejected or cancelled, or the owner discards what it left; a
 * task that failed or was stopped keeps its container, as it keeps its copy, for a resume.
 * Docker calls are made one at a time, so a start and a removal of the same container never cross.
 */

/** The task ends after which nothing more runs in a task's copy. */
const ENDED = new Set(["accepted", "rejected", "cancelled"]);

/** Whether a task may still run commands: it exists, is not accepted, rejected or cancelled, and was not discarded. */
export function taskLive(db: DatabaseSync, taskId: number): boolean {
  const row = db.prepare("SELECT status FROM tasks WHERE id = ?").get(taskId);
  if (row === undefined || ENDED.has(String(row.status))) return false;
  return db.prepare("SELECT 1 FROM action_log WHERE task_id = ? AND rule = 'owner_discarded' LIMIT 1").get(taskId) === undefined;
}

export interface Containers {
  /** Start a task's container, or find it running as it was started; refused with why, and nothing falls back. */
  start(o: { taskId: number; image: string; mount: string; allowedHosts: readonly string[] }): Promise<ContainerStart>;
  /** A task changed: when it is no longer live, its container is removed. Never rejects. */
  taskChanged(taskId: number): void;
  /** Remove every Botbench container whose mount lies in this data folder and whose task is not live. Never rejects. */
  sweep(): Promise<void>;
  /** Resolves once no Docker call is under way. */
  idle(): Promise<void>;
}

export function createContainers(o: { db: DatabaseSync; home: string; workbench: () => string; docker?: string | null; log?: (line: string) => void }): Containers {
  const log = o.log ?? ((line: string) => console.error(line));
  /** Found once: Botbench's own PATH does not change while it runs. */
  const docker = o.docker === undefined ? findDocker() : o.docker;
  /**
   * The tasks this process started or found a container for, each with its container's id, so a task change looks at
   * Docker only for them, and removes exactly that container (a workbench renamed since, or a container made under the
   * same name later, does not change which).
   */
  const known = new Map<number, string>();
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(work: () => Promise<T>): Promise<T> => {
    const next = queue.then(work, work);
    queue = next.catch(() => undefined);
    return next;
  };
  /** Work nobody waits on: what goes wrong is logged, never thrown. */
  const quietly = (what: string, work: () => Promise<void>): Promise<void> => serial(work).catch((err: unknown) => log(`${what} failed: ${err instanceof Error ? err.message : String(err)}`));
  const remove = async (taskId: number, id: string): Promise<void> => {
    if (docker === null) return;
    const failed = await removeContainer(docker, id);
    if (failed === null) known.delete(taskId);
    else log(`Removing the container ${id.slice(0, 12)} of task ${taskId} failed (${failed}). Remove it with docker rm -f ${id.slice(0, 12)}.`);
  };

  return {
    start: (s) =>
      serial(async () => {
        const started = await startTaskContainer({ workbench: o.workbench(), taskId: s.taskId, image: s.image, mount: s.mount, dataDir: o.home, allowedHosts: s.allowedHosts, ...(docker === null ? {} : { docker }) });
        if (started.ok) known.set(s.taskId, started.container.id);
        return started;
      }),
    taskChanged: (taskId) => {
      const id = known.get(taskId);
      if (id === undefined || taskLive(o.db, taskId)) return;
      void quietly(`Removing the container of task ${taskId}`, () => remove(taskId, id));
    },
    sweep: () =>
      quietly("Removing containers left by tasks that ended", async () => {
        if (docker === null) return;
        const found = await labelledContainers(docker);
        // Docker not answering is not news at start: a task that needs it says so when it starts.
        if (found === null) return;
        for (const c of found) {
          if (!mountedFrom(c.mount, o.home)) continue;
          if (c.taskId !== null && taskLive(o.db, c.taskId)) known.set(c.taskId, c.id);
          else await remove(c.taskId ?? 0, c.id);
        }
      }),
    idle: () => serial(async () => {}),
  };
}
