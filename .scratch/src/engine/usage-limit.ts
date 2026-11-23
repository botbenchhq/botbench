/**
 * A builder's usage limit (issue #71). When a builder's turn ends because its agent's usage limit was reached (the
 * driver marks that turn end, `limitedEnd` in drivers/claude-code.ts), the task does not fail and is not stopped: its
 * work is committed as for any stop, and it waits at `waiting_for_limit` until a time stored on it (`tasks.retry_at`).
 * At that time Botbench starts the builder again by itself, once, in the same session and with the task's own model,
 * and the task goes back to building. A resumed turn that reaches the limit again stops the task for the owner.
 *
 * The time is the reset time the agent gave, when it gave one in the future; otherwise a fixed wait from now
 * (approach from paperclip packages/adapters/claude-local/src/server/parse.ts: read the reset time from the CLI's own
 * report, with a fallback when it gives none). The wait is bounded to one retry and stored with its due time (approach
 * from paperclip server/src/services/heartbeat/retries.ts), as a row that survives a restart, from which a timer is
 * armed again at each start (approach from paperclip server/src/modules/run-dispatch/adapters/scheduled-retry-park.ts). No code was copied.
 */

/** The wait when the agent gives no reset time: 30 minutes, unless `autonomy.usageLimitWaitSeconds` says otherwise. */
export const USAGE_LIMIT_WAIT_MS = 30 * 60_000;

/** When to try again, as an ISO time: `resetsAt` when it is a time after `nowMs`, otherwise `waitMs` after `nowMs`. Pure. */
export function retryTime(resetsAt: string | null, nowMs: number, waitMs: number): string {
  const reset = resetsAt === null ? Number.NaN : Date.parse(resetsAt);
  return new Date(Number.isFinite(reset) && reset > nowMs ? reset : nowMs + waitMs).toISOString();
}

/** What Botbench says to the agent when it resumes its session after the wait. Botbench's words, and they say so. */
export const LIMIT_PROMPT =
  "[From Botbench, not from the owner] Your work on this task stopped because your usage limit was reached. Botbench waited for it to reset. The files in this folder are as you left them. Carry on with the task from where you left off, and finish it.";

/** The same, for a round of fixes, put where a round's prompt says how it was stopped (task.ts, `refinePromptFor`). */
export const LIMIT_ROUND_NOTE =
  "Your usage limit was reached before you finished this round of fixes, and Botbench waited for it to reset; the files in this folder are as you left them. Do the round again from where it stands now.";

/** Why a task stops when the turn resumed after the wait reaches the limit again. */
export const limitAgainReason = (agent: string): string =>
  `${agent} reached its usage limit again when Botbench tried once more after waiting for it to reset, so Botbench stopped this task instead of waiting a second time. The work done up to then is committed. Resume tries again when you choose.`;

/** Why a task stops after the wait when its builder had reported no session to take up, so the same one cannot be resumed. */
export const limitNoSessionReason = (agent: string): string =>
  `${agent} reached its usage limit before it had started a session Botbench could take up again, so Botbench did not start it again by itself. The work done up to then is committed. Resume starts it again when you choose.`;

/** Why a task that waited for a usage limit ends when its run is cancelled. */
export const LIMIT_CANCELLED = "The run was cancelled while this task waited for a usage limit to reset. The work done up to then is committed to its branch.";

/** The longest a timer is set for; a later due time is reached by setting it again (Node's limit is about 24.8 days). */
export const MAX_TIMER_MS = 2 ** 31 - 1;
