import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from "react";
import { Check, ShieldCheck } from "lucide-react";
import { Button } from "@/ui/button";
import { cn } from "@/ui/lib/utils";
import { ApiError, getActionLog, getAskEveryCommand, getChatWebAccess, getDefaultMode, listGrants, previewCommand, revokeGrant, setAskEveryCommand, setChatWebAccess, setDefaultMode, type LogEntry, type LogRule, type ModePreview, type RunMode, type StandingGrant, type WebAccess } from "../../api/client.ts";
import { takesItsPlace } from "../../app/focus-after.ts";
import { fullDate } from "../../app/format.ts";
import { stepWord, times, visible } from "../../components/approval-words.ts";
import { MODES } from "../../components/mode-choice.tsx";
import { useKnownRepositories } from "../../components/repository.tsx";
import { About, Busy, Confirm, FieldLabel, More, Note, ON_OFF, Panel, Reading, Row, SectionHeading, Segmented, Select, Textarea } from "./parts.tsx";

/** How many log entries are read at a time. */
const PAGE = 10;

/** The rule that decided, in words. */
const RULE_WORDS: Record<LogRule, string> = {
  asked_owner: "Asked you",
  owner_allowed: "You allowed",
  owner_declined: "You denied",
  ended_unanswered: "Ended without your answer",
  auto_worktree_edit: "Edited a file in the task's copy, without asking",
  broker_failure_denied: "Botbench denied",
  stored_answer_applied: "Your answer from before a restart was used",
  stored_answer_discarded: "Your answer from before a restart was not used",
  preapproved: "Ran without asking: allowed for this task",
  standing: "Ran without asking: always allowed",
  standing_granted: "You chose Always allow",
  standing_revoked: "You took Always allow back",
  owner_accepted: "You accepted",
  owner_rejected: "You rejected",
  owner_discarded: "You discarded",
  mode_allowed: "Ran without asking: kept in the task's copy",
  mode_refused: "Refused without asking: fully autonomous",
  mode_accepted: "Accepted without you: fully autonomous",
  delivery: "Pull request",
  web_allowed: "Ran without asking: Web access is Allow",
  web_refused: "Refused without asking: Web access is Off",
  bookkeeping: "Ran without asking: Claude Code's own to-do list or tool loading",
  issue_claim: "Issue claim",
  sandboxed: "Ran without asking: kept by its own sandbox, as Codex and Grok cannot ask",
  memory: "Memory",
  owner_answered: "You answered Claude Code's question",
  question_unasked: "Not asked: fully autonomous, Claude Code chose itself",
  handoff: "Moved to another agent",
  peer_message_conflict: "Refused: another workbench sent a message again with other content",
  peer_invite: "Invite to pair with another workbench",
  peer_pairing: "Pairing with another workbench",
  peer_protocol: "Sent to a paired workbench without asking: a fixed reply or notice",
  peer_refused: "Refused from another workbench",
  peer_message: "Message to or from another workbench",
  peer_kind_refused: "Not sent or not taken: switched off for that workbench",
  peer_send_attempt: "Claude Code drafted a message to another workbench",
  peer_send_over_limit: "Not sent: the run's most messages to other workbenches",
  peer_settings: "What another workbench may send or receive, changed by you",
  expired_unanswered: "Denied by Botbench: nobody answered in time",
  repeat_declined: "Denied without asking: you denied it before in this task",
};

/** An edit's entry holds the whole file it wrote; the list shows where each entry begins. */
const shorten = (text: string, max = 300): string => (text.length > max ? `${text.slice(0, max)}…` : text);
/** Where a standing permission applies, in words. The path is relative to the copy of whichever task asks. */
const directoryWords = (cwd: string): string => (cwd === "." ? "The top folder of a task's copy" : `${cwd}, inside a task's copy`);
/** What an activity entry was about: the command, or the tool with what it was given. */
const entryCommand = (entry: LogEntry): string =>
  shorten(entry.command === "" ? entry.tool : entry.tool === "Bash" || entry.rule === "owner_accepted" || entry.rule === "owner_rejected" || entry.rule === "owner_discarded" || entry.rule === "mode_accepted" || entry.rule === "delivery" || entry.rule === "issue_claim" || entry.rule === "memory" || entry.rule === "handoff" ? entry.command : `${entry.tool} ${entry.command}`);

/** The mode a new run starts with: three cards, one chosen, each with its one line. Saved as it is chosen. */
function DefaultMode({ onSignedOut }: { onSignedOut: () => void }) {
  const id = useId();
  const [mode, setMode] = useState<RunMode | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => {
    getDefaultMode().then(setMode, (err: unknown) => {
      if (err instanceof ApiError && err.status === 401) return onSignedOut();
      setProblem(err instanceof ApiError ? `The default mode could not be read. ${err.message}` : "The default mode could not be read: Botbench could not be reached.");
    });
  }, [onSignedOut]);
  const choose = (next: RunMode): void => {
    const before = mode;
    setMode(next);
    setProblem(null);
    setDefaultMode(next).then(setMode, (err: unknown) => {
      if (err instanceof ApiError && err.status === 401) return onSignedOut();
      setMode(before);
      setProblem(err instanceof ApiError ? `The default mode was not saved. ${err.message}` : "The default mode was not saved: Botbench could not be reached.");
    });
  };
  return (
    <section aria-labelledby={`${id}-heading`} className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <SectionHeading id={`${id}-heading`}>Default mode</SectionHeading>
        <About id={`${id}-hint`}>A new run starts with this mode chosen. You can pick another for each run.</About>
      </div>
      <fieldset data-testid="default-mode-picker" aria-labelledby={`${id}-heading`} aria-describedby={`${id}-hint`} className="grid gap-3 md:grid-cols-3">
        {MODES.map((option) => {
          const chosen = mode === option.mode;
          return (
            <label key={option.mode} className={cn("relative flex min-h-24 flex-col gap-1.5 rounded-xl border bg-card p-4 has-focus-visible:ring-3 has-focus-visible:ring-ring/50 has-disabled:opacity-60", chosen ? "border-primary ring-1 ring-primary" : "border-border")}>
              <input type="radio" name={`${id}-mode`} value={option.mode} checked={chosen} disabled={mode === null} aria-labelledby={`${id}-${option.mode}-name`} aria-describedby={`${id}-${option.mode}-about`} onChange={() => choose(option.mode)} className="absolute inset-0 size-full cursor-pointer appearance-none opacity-0 disabled:cursor-not-allowed" />
              <span className="flex items-center gap-2">
                <span aria-hidden="true" className={cn("size-2.5 shrink-0 rounded-full border", chosen ? "border-primary bg-primary" : "border-edge")} />
                <span id={`${id}-${option.mode}-name`} className="text-base font-semibold">
                  {option.name}
                </span>
                {chosen && <Check aria-hidden="true" className="ml-auto size-4 text-primary" />}
              </span>
              <span id={`${id}-${option.mode}-about`} className="text-meta text-muted-foreground">
                {option.description}
                {option.warning !== undefined && <span className="mt-1 block font-semibold text-attention">{option.warning}</span>}
              </span>
            </label>
          );
        })}
      </fieldset>
      {problem !== null && (
        <Note tone="error" role="alert">
          {problem}
        </Note>
      )}
      <div className="flex items-start gap-3 rounded-xl border border-border px-4 py-3 text-sm">
        <ShieldCheck aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-primary" />
        <p>
          <span className="font-semibold">A mode never loosens the safety rules.</span> Dangerous actions always ask; in a fully autonomous run they are refused.
        </p>
      </div>
    </section>
  );
}

/** The choices for web access, in the order they are offered. */
const WEB_ACCESS: { value: WebAccess; label: string }[] = [
  { value: "allow", label: "Allow" },
  { value: "ask", label: "Ask" },
  { value: "off", label: "Off" },
];

/**
 * Web access: whether Claude Code may fetch pages and search the web without asking, in a chat, a task or a run, asks
 * you each time, or may not; and whether Codex and Grok, which cannot ask, may use their own web search (Allow only).
 * Kept by Botbench and saved as it is chosen; it is read at each request.
 */
function WebAccessRow({ onSignedOut }: { onSignedOut: () => void }) {
  const id = useId();
  const [value, setValue] = useState<WebAccess | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  // The last choice reached Botbench: said under the row, since the control shows the choice before it is kept.
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    getChatWebAccess().then(setValue, (err: unknown) => {
      if (err instanceof ApiError && err.status === 401) return onSignedOut();
      setProblem(err instanceof ApiError ? `Web access could not be read. ${err.message}` : "Web access could not be read: Botbench could not be reached.");
    });
  }, [onSignedOut]);
  const choose = (next: WebAccess): void => {
    const before = value;
    setValue(next);
    setProblem(null);
    setSaved(false);
    setChatWebAccess(next).then(
      (kept) => {
        setValue(kept);
        setSaved(true);
      },
      (err: unknown) => {
        if (err instanceof ApiError && err.status === 401) return onSignedOut();
        setValue(before);
        setProblem(err instanceof ApiError ? `Web access was not saved. ${err.message}` : "Web access was not saved: Botbench could not be reached.");
      },
    );
  };
  return (
    <Row label="Web access" about={<About id={`${id}-about`}>Whether agents may fetch pages and search the web, in a chat, a task or a run.</About>} control={<Segmented testId="chat-web-access" label="Web access" value={value} options={WEB_ACCESS} describedBy={`${id}-about`} onChange={choose} />}>
      <More about="Web access">
        <p>Whether Claude Code may fetch pages and search the web, in a chat, a task or a run. The address or search goes to that site or search service; what comes back goes to Claude Code. Each one shows in the transcript. A run started from a GitHub issue always asks.</p>
        <p>Codex, Grok and Antigravity search the web, in a chat and when they review a task, only on Allow: their own provider runs the search without asking you first, and their commands reach nothing on the network but that provider.</p>
      </More>
      {saved && problem === null && (
        <About role="status" data-testid="web-access-saved">
          Saved.
        </About>
      )}
      {problem !== null && (
        <Note tone="error" role="alert">
          {problem}
        </Note>
      )}
    </Row>
  );
}

/**
 * Ask before every command: off by default. On, every command of a Manual run or a single task asks you, also one kept
 * inside the task's copy. Kept by Botbench and saved as it is chosen; it is read at each request.
 */
function AskEveryCommandRow({ onSignedOut }: { onSignedOut: () => void }) {
  const id = useId();
  const [value, setValue] = useState<boolean | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    getAskEveryCommand().then(setValue, (err: unknown) => {
      if (err instanceof ApiError && err.status === 401) return onSignedOut();
      setProblem(err instanceof ApiError ? `Ask before every command could not be read. ${err.message}` : "Ask before every command could not be read: Botbench could not be reached.");
    });
  }, [onSignedOut]);
  const choose = (next: boolean): void => {
    const before = value;
    setValue(next);
    setProblem(null);
    setSaved(false);
    setAskEveryCommand(next).then(
      (kept) => {
        setValue(kept);
        setSaved(true);
      },
      (err: unknown) => {
        if (err instanceof ApiError && err.status === 401) return onSignedOut();
        setValue(before);
        setProblem(err instanceof ApiError ? `Ask before every command was not saved. ${err.message}` : "Ask before every command was not saved: Botbench could not be reached.");
      },
    );
  };
  return (
    <Row
      label="Ask before every command"
      about={<About id={`${id}-about`}>In Manual runs and single tasks, asks you before each command, also one kept inside the task's copy.</About>}
      control={<Segmented testId="ask-every-command" label="Ask before every command" value={value === null ? null : value ? "on" : "off"} options={ON_OFF} describedBy={`${id}-about`} onChange={(next) => choose(next === "on")} />}
    >
      <More about="Ask before every command">
        <p>Off, only commands on the always-ask list or outside the copy ask.</p>
      </More>
      {saved && problem === null && (
        <About role="status" data-testid="ask-every-saved">
          Saved.
        </About>
      )}
      {problem !== null && (
        <Note tone="error" role="alert">
          {problem}
        </Note>
      )}
    </Row>
  );
}

/** A check's answer, with the repository and command it is for: changing either clears it, so it never stands beside another command. */
interface Checked {
  path: string;
  command: string;
  modes: ModePreview[];
}

/**
 * Check a command: what it would get in a task of a known repository, in each mode, as the permission check itself
 * answers. It reads only, and runs nothing.
 */
function CommandCheck({ onSignedOut }: { onSignedOut: () => void }) {
  const id = useId();
  const known = useKnownRepositories(onSignedOut);
  const [repo, setRepo] = useState("");
  const [command, setCommand] = useState("");
  const [checked, setChecked] = useState<Checked | null>(null);
  /** Why the last check gave no answer, with the repository and command it was about: changing either clears it, as for an answer. */
  const [failed, setFailed] = useState<{ path: string; command: string; text: string } | null>(null);
  const [checking, setChecking] = useState(false);
  // The first repository Botbench knows is chosen once the list arrives, so the box can be used at once.
  const chosen = repo !== "" ? repo : (known[0]?.path ?? "");

  const check = (e: FormEvent): void => {
    e.preventDefault();
    if (checking) return;
    if (chosen === "") return setFailed({ path: chosen, command, text: "Choose a repository." });
    setFailed(null);
    setChecking(true);
    previewCommand(chosen, command).then(
      (answer) => {
        setChecking(false);
        setChecked({ path: chosen, command, modes: answer.modes });
      },
      (err: unknown) => {
        if (err instanceof ApiError && err.status === 401) return onSignedOut();
        setChecking(false);
        setChecked(null);
        setFailed({ path: chosen, command, text: err instanceof ApiError ? err.message : "The command was not checked: Botbench could not be reached." });
      },
    );
  };
  const shown = checked !== null && checked.path === chosen && checked.command === command ? checked : null;
  const problem = failed !== null && failed.path === chosen && failed.command === command ? failed.text : null;
  const described = [`${id}-command-about`, ...(problem === null ? [] : [`${id}-problem`])].join(" ");

  return (
    <section aria-labelledby={`${id}-heading`} className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <SectionHeading id={`${id}-heading`}>Check a command</SectionHeading>
        <About>What a command would get in a task of a repository, in each mode. Checking runs nothing and changes nothing.</About>
      </div>
      <Panel className="p-5">
        <form onSubmit={check} className="flex flex-col gap-3" noValidate>
          <div className="flex flex-col gap-1.5">
            <FieldLabel htmlFor={`${id}-repo`}>Repository</FieldLabel>
            <Select data-testid="check-repository" id={`${id}-repo`} value={chosen} disabled={known.length === 0} aria-describedby={known.length === 0 ? `${id}-repo-about` : undefined} onChange={(e) => setRepo(e.currentTarget.value)} className="w-full sm:w-72">
              {known.length === 0 && <option value="">No repository yet</option>}
              {known.map((r) => (
                <option key={r.path} value={r.path}>
                  {r.name}
                </option>
              ))}
            </Select>
            {known.length === 0 && <About id={`${id}-repo-about`}>A repository you start a task in, or name in Botbench's settings file, is listed here.</About>}
          </div>
          <div className="flex flex-col gap-1.5">
            <FieldLabel htmlFor={`${id}-command`}>Command</FieldLabel>
            <div className="flex items-end gap-3">
              {/* A box of several lines: a command pasted with a line break is checked as it would run, and a single-line field would drop the break. */}
              <Textarea data-testid="check-command" id={`${id}-command`} rows={2} autoCapitalize="none" autoCorrect="off" autoComplete="off" spellCheck={false} value={command} onChange={(e) => setCommand(e.currentTarget.value)} aria-invalid={problem !== null || undefined} aria-describedby={described} className="min-h-(--control) flex-1 font-mono text-meta md:text-meta" />
              <Busy type="submit" busy={checking} busyLabel="Checking">
                Check
              </Busy>
            </div>
            <About id={`${id}-command-about`}>As Claude Code would ask to run it from the top folder of a task's copy.</About>
            {problem !== null && (
              <p role="alert" id={`${id}-problem`} className="text-meta text-destructive">
                {problem}
              </p>
            )}
          </div>
        </form>
        {shown !== null && (
          <div role="status" className="mt-4 flex flex-col gap-3 border-t pt-4">
            <ul data-testid="check-result" data-ds-content-label="" aria-label={`What ${visible(shown.command)} would get`} className="flex flex-col gap-3">
              {shown.modes.map((m) => (
                <li key={m.mode} data-mode={m.mode} data-verdict={m.verdict} className="flex flex-col gap-0.5">
                  <span className="text-sm font-semibold">{MODES.find((choice) => choice.mode === m.mode)?.name ?? m.mode}</span>
                  {/* The server's own line, which may hold the listed command it ran on; its wording is checked where it is built. */}
                  <span data-ds-content="" className="text-meta text-muted-foreground">
                    {visible(m.words)}
                    {m.floor !== undefined && (
                      <>
                        {" Rule: "}
                        <code>{visible(m.floor)}</code>
                      </>
                    )}
                  </span>
                </li>
              ))}
            </ul>
            <About>A task gets the allowed commands as this repository's settings offer them. A run started from a GitHub issue uses neither those nor Always allow.</About>
          </div>
        )}
      </Panel>
    </section>
  );
}

/**
 * What Botbench may do without asking, and what it did: the commands always allowed, each with the control that takes
 * it back, the command check, and the activity, newest first, as a table.
 */
function Allowed({ onSignedOut }: { onSignedOut: () => void }) {
  const [grants, setGrants] = useState<StandingGrant[] | null>(null);
  const [offerAfter, setOfferAfter] = useState<number | null>(null);
  const [log, setLog] = useState<{ entries: LogEntry[]; older: boolean } | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  /** The id of the grant being taken back: its button is busy and keeps the focus; the others wait. */
  const [takingBack, setTakingBack] = useState<number | null>(null);
  /** Whether it is the older log entries that are being read. */
  const [readingOlder, setReadingOlder] = useState(false);
  /** The grant just taken back and its place in the list: once the list is read without it, the focus goes to its neighbour. */
  const [taken, setTaken] = useState<{ id: number; at: number } | null>(null);
  const grantsHeading = useRef<HTMLHeadingElement>(null);
  const activityHeading = useRef<HTMLHeadingElement>(null);
  const grantList = useRef<HTMLUListElement>(null);
  /** Counts reads of the log's newest page, so an answer that arrives after a newer one was asked for is dropped. */
  const reads = useRef(0);

  const failed = useCallback(
    (what: string) =>
      (err: unknown): void => {
        if (err instanceof ApiError && err.status === 401) return onSignedOut();
        setTakingBack(null);
        setProblem(err instanceof ApiError ? `${what} ${err.message}` : `${what} Botbench could not be reached.`);
      },
    [onSignedOut],
  );

  /** Reads the grants and the log's newest page again; the promise ends when the grants have answered, read or not. */
  const load = useCallback((): Promise<void> => {
    const read = ++reads.current;
    getActionLog(PAGE).then((page) => read === reads.current && setLog(page), failed("The activity could not be read."));
    return listGrants().then((answer) => {
      setGrants(answer.grants);
      setOfferAfter(answer.offerStandingAfter);
    }, failed("The always-allowed commands could not be read."));
  }, [failed]);

  useEffect(() => void load(), [load]);

  // The row of a grant taken back held the focus, on its Take back button. Once the list no longer has it, the focus
  // goes to the Take back button of the row that took its place, or to the section's heading when none is left. A
  // focus the owner moved elsewhere meanwhile is left where it is: only a focus the row took with it is placed.
  useEffect(() => {
    if (taken === null || grants === null || grants.some((grant) => grant.id === taken.id)) return;
    setTaken(null);
    if (document.activeElement !== null && document.activeElement !== document.body) return;
    const next = takesItsPlace(grants, taken.at);
    (next === undefined ? grantsHeading.current : grantList.current?.querySelector<HTMLButtonElement>(`[data-grant="${next.id}"] button`))?.focus();
  }, [grants, taken]);

  const loadOlder = (): void => {
    const oldest = log?.entries.at(-1);
    if (oldest === undefined) return;
    const read = reads.current;
    setReadingOlder(true);
    getActionLog(PAGE, oldest.id).then(
      (page) => {
        setReadingOlder(false);
        // The newest page was read again meanwhile: this older page no longer follows what is shown.
        if (read !== reads.current) return;
        setLog((have) => (have === null ? have : { entries: [...have.entries, ...page.entries], older: page.older }));
      },
      (err: unknown) => {
        setReadingOlder(false);
        failed("The older entries could not be read.")(err);
      },
    );
  };

  const takeBack = (grant: StandingGrant): void => {
    setTakingBack(grant.id);
    setProblem(null);
    const at = grants?.findIndex((g) => g.id === grant.id) ?? 0;
    revokeGrant(grant.id).then(
      () => {
        setTaken({ id: grant.id, at });
        // The button stays busy until the list is read again and its row goes: it is never live again in between.
        void load().then(() => setTakingBack(null));
      },
      (err: unknown) => {
        failed("Always allow was not taken back.")(err);
        // Taken back elsewhere meanwhile, the row goes all the same once the list is read again.
        setTaken({ id: grant.id, at });
        void load();
      },
    );
  };

  return (
    <>
      {problem !== null && (
        <Note tone="error" role="alert">
          {problem}
        </Note>
      )}
      <section aria-labelledby="trust-grants" className="flex flex-col gap-3">
        <div className="flex flex-col gap-1">
          <SectionHeading
            ref={grantsHeading}
            id="trust-grants"
            tabIndex={-1}
            right={
              grants !== null &&
              grants.length > 0 && (
                <Button type="button" variant="outline" size="sm" onClick={() => activityHeading.current?.focus()}>
                  See what ran in Activity
                </Button>
              )
            }
          >
            Always allowed
          </SectionHeading>
          {grants !== null && grants.length > 0 && <About>Claude Code runs these without asking you. Take one back at any time.</About>}
        </div>
        {grants === null ? (
          problem === null && <Reading>Reading what is always allowed.</Reading>
        ) : grants.length === 0 ? (
          <p data-testid="grants-none" className="text-sm text-muted-foreground">{`Nothing is always allowed.${offerAfter === null ? "" : ` After you have allowed the same command ${times(offerAfter)}, its request offers Always allow.`}`}</p>
        ) : (
          <Panel>
            <ul ref={grantList} data-testid="grant-list" className="divide-y">
              {grants.map((grant) => (
                <li key={grant.id} data-grant={grant.id} className="flex flex-col gap-3 px-5 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-6">
                  <div className="flex min-w-0 flex-col gap-1">
                    <code data-testid="grant-command" data-ds-content="" className="wrap-anywhere text-foreground">
                      {visible(grant.command)}
                    </code>
                    <span className="text-meta text-muted-foreground">
                      {`Claude Code runs this without asking you during the ${stepWord(grant.role)} step. ${directoryWords(grant.cwd)}, in this repository: `}
                      <code data-ds-content="" className="break-all">
                        {visible(grant.repo)}
                      </code>
                    </span>
                    <span className="text-meta text-muted-foreground">{`Chosen ${fullDate(grant.grantedAt)}${grant.taskId === null ? "" : `, in task ${grant.taskId}`}. ${grant.lastUsedAt === null ? "Not used yet." : `Used ${times(grant.timesUsed)}, last ${fullDate(grant.lastUsedAt)}.`}`}</span>
                  </div>
                  <Confirm
                    label="Take back"
                    opener={{ name: `Take back ${visible(grant.command)}`, object: visible(grant.command), theirs: true }}
                    title="Stop always allowing this command?"
                    confirmLabel="Take it back"
                    cancelLabel="Keep it"
                    disabled={readingOlder || (takingBack !== null && takingBack !== grant.id)}
                    busy={takingBack === grant.id}
                    busyLabel="Taking back"
                    losing
                    testId="take-back-confirm"
                    className="shrink-0 self-start sm:self-center"
                    onConfirm={() => takeBack(grant)}
                  >
                    <p>The next time this command is asked for, Botbench asks you again.</p>
                    <p>
                      <code data-ds-content="" className="wrap-anywhere text-foreground">
                        {visible(grant.command)}
                      </code>
                    </p>
                  </Confirm>
                </li>
              ))}
            </ul>
          </Panel>
        )}
      </section>
      <CommandCheck onSignedOut={onSignedOut} />
      <section aria-labelledby="trust-log" className="flex flex-col gap-3">
        <div className="flex flex-col gap-1">
          <SectionHeading ref={activityHeading} id="trust-log" tabIndex={-1}>
            Activity
          </SectionHeading>
          {log !== null && log.entries.length > 0 && <About>Newest first.</About>}
        </div>
        {log === null ? (
          problem === null && <Reading>Reading the activity.</Reading>
        ) : log.entries.length === 0 ? (
          <p data-testid="log-none" className="text-sm text-muted-foreground">
            Nothing has been asked, allowed or run yet.
          </p>
        ) : (
          <>
            <Panel className="overflow-hidden">
              <table data-testid="action-log" className="w-full text-left text-meta">
                <thead className="border-b text-muted-foreground max-sm:sr-only">
                  <tr>
                    <th scope="col" className="px-5 py-2 font-semibold">
                      What happened
                    </th>
                    <th scope="col" className="px-3 py-2 font-semibold">
                      Command or action
                    </th>
                    <th scope="col" className="px-5 py-2 font-semibold whitespace-nowrap">
                      Task and time
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {log.entries.map((entry) => (
                    <tr key={entry.id} data-testid="activity-entry" className="align-top max-sm:flex max-sm:flex-col max-sm:gap-1 max-sm:px-5 max-sm:py-3">
                      <th scope="row" className="px-5 py-3 text-sm font-semibold max-sm:p-0 sm:w-1/3">
                        {RULE_WORDS[entry.rule] ?? entry.rule}
                      </th>
                      <td className="px-3 py-3 max-sm:p-0">
                        <code data-ds-content="" className="break-all text-foreground">
                          {visible(entryCommand(entry))}
                        </code>
                        {/* The server's own sentence, which may hold the command it is about; its wording is checked where it is built. */}
                        {entry.detail !== null && (
                          <span data-ds-content="" className="mt-1 block text-muted-foreground">
                            {visible(entry.detail)}
                          </span>
                        )}
                      </td>
                      <td className="px-5 py-3 text-muted-foreground max-sm:p-0 sm:whitespace-nowrap">{`${entry.taskId === null ? "" : `Task ${entry.taskId} · `}${fullDate(entry.ts)}`}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Panel>
            {log.older && (
              <Busy variant="ghost" busy={readingOlder} busyLabel="Reading older activity" disabled={takingBack !== null} onClick={loadOlder} className="self-start">
                Show older activity
              </Busy>
            )}
          </>
        )}
      </section>
    </>
  );
}

/** Permissions and autonomy: the default mode, web access, asking before every command, what is always allowed, the command check and the activity. */
export function PermissionsGroup({ onSignedOut }: { onSignedOut: () => void }) {
  return (
    <>
      <DefaultMode onSignedOut={onSignedOut} />
      <Panel className="divide-y">
        <WebAccessRow onSignedOut={onSignedOut} />
        <AskEveryCommandRow onSignedOut={onSignedOut} />
      </Panel>
      <Allowed onSignedOut={onSignedOut} />
    </>
  );
}
