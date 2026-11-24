import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from "react";
import { Check } from "lucide-react";
import { Button } from "@/ui/button";
import { Input } from "@/ui/input";
import { ApiError, editMemoryNote, forgetMemoryNote, getMemory, getPeerOverview, getUpdate, getWorkbench, setUpdateMode, setWorkbench, startUpdate, type MemoryList, type MemoryNote, type PeerOverview, type UpdateMode, type UpdateStatus, type WorkbenchSetting } from "../../api/client.ts";
import { chooseAppearance, useAppearance, type Appearance } from "../../app/appearance.ts";
import { takesItsPlace } from "../../app/focus-after.ts";
import { counted, fullDate, number as grouped } from "../../app/format.ts";
import { canUpdate, UPDATE_MODE_ABOUT, updateStateWords, updateUnderWay, versionAbout } from "../../app/update-words.ts";
import { About, Busy, Confirm, FieldLabel, More, Mono, Note, Panel, Reading, Row, SectionHeading, Select, StateWord } from "./parts.tsx";

/** The same rule the server holds a workbench name to (src/workbench.ts), so a name it would refuse is said before it is sent. */
const WORKBENCH = /^[a-z0-9](?:[a-z0-9-]{0,28}[a-z0-9])?$/;

/**
 * This workbench's name (Peers P1): its new task branches carry it, so they never clash with another workbench's on a
 * shared remote. Saved with Save name; a name the settings file sets is shown, and changed there.
 */
function WorkbenchName({ onSignedOut }: { onSignedOut: () => void }) {
  const id = useId();
  const [current, setCurrent] = useState<WorkbenchSetting | null>(null);
  const [typed, setTyped] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const failed = (what: string) => (err: unknown) => {
    if (err instanceof ApiError && err.status === 401) return onSignedOut();
    setProblem(err instanceof ApiError ? `${what} ${err.message}` : `${what.replace(/\.$/, "")}: Botbench could not be reached.`);
  };
  useEffect(() => {
    getWorkbench().then((found) => {
      setCurrent(found);
      setTyped(found.name);
    }, failed("The workbench name could not be read."));
  }, [onSignedOut]);
  const save = (): void => {
    setSaved(false);
    if (!WORKBENCH.test(typed)) return setProblem('A workbench name is 1 to 30 lowercase letters, digits and hyphens, and starts and ends with a letter or digit, such as "jons-mac".');
    setProblem(null);
    setWorkbench(typed).then((found) => {
      setCurrent(found);
      setTyped(found.name);
      setSaved(true);
    }, failed("The workbench name was not saved."));
  };
  const fromFile = current?.setInFile === true;
  return (
    <Panel className="p-5">
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        <div className="flex flex-col gap-1">
          <FieldLabel htmlFor={`${id}-name`} className="text-base">
            Workbench name
          </FieldLabel>
          <About id={`${id}-about`}>
            {fromFile ? 'Set in the settings file ("workbench"), so it is changed there.' : `New task branches carry this name, such as botbench/${current?.name ?? "name"}/run-1/task-1, so they never clash with another workbench's on a shared remote. Changing it affects only new branches.`}
          </About>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Input
            data-testid="workbench-name"
            id={`${id}-name`}
            type="text"
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            maxLength={30}
            value={typed}
            readOnly={fromFile || current === null}
            aria-invalid={problem !== null || undefined}
            aria-describedby={problem === null ? `${id}-about` : `${id}-about ${id}-problem`}
            onChange={(e) => {
              setTyped(e.currentTarget.value);
              setSaved(false);
            }}
            className="min-w-0 flex-1 basis-48"
          />
          {!fromFile && current !== null && (
            <Button type="submit" variant="outline" disabled={typed === current.name}>
              Save name
            </Button>
          )}
        </div>
        {problem !== null && (
          <p role="alert" id={`${id}-problem`} className="text-meta text-destructive">
            {problem}
          </p>
        )}
        {saved && problem === null && (
          <p role="status" data-testid="workbench-saved" className="flex items-center gap-2 text-meta text-muted-foreground">
            <Check aria-hidden="true" className="size-4 text-success" />
            Saved.
          </p>
        )}
      </form>
    </Panel>
  );
}

/** This workbench's fingerprint, as a paired workbench's owner sees it. Shown only once the listener for paired workbenches has made its key. */
function Fingerprint({ onSignedOut }: { onSignedOut: () => void }) {
  const [overview, setOverview] = useState<PeerOverview | null>(null);
  useEffect(() => {
    let stale = false;
    getPeerOverview().then(
      (found) => stale || setOverview(found),
      (err: unknown) => err instanceof ApiError && err.status === 401 && onSignedOut(),
    );
    return () => {
      stale = true;
    };
  }, [onSignedOut]);
  if (overview === null || overview.fingerprint === null) return null;
  const paired = overview.pairings.find((p) => p.state === "in_force");
  return (
    <Panel data-testid="identity-fingerprint" className="flex flex-col gap-3 p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-base font-semibold">This workbench's fingerprint</h2>
        {paired !== undefined && (
          <StateWord tone="peer">
            {"Paired with "}
            <span data-ds-content="">{paired.peer.name}</span>
          </StateWord>
        )}
      </div>
      <Mono className="text-base font-semibold tracking-wide">{overview.fingerprint}</Mono>
      <About>The paired side sees these same words for your workbench. When you pair, the other person asks you to read it out and confirms only if it is the one their screen shows.</About>
    </Panel>
  );
}

const APPEARANCES: { value: Appearance; label: string }[] = [
  { value: "dark", label: "Dark" },
  { value: "light", label: "Light" },
  { value: "auto", label: "Match device" },
];

/** The mode this device shows, saved on the device as it is chosen. */
function AppearanceChoice() {
  const id = useId();
  const { choice } = useAppearance();
  return (
    <Panel>
      <Row
        label={
          <label htmlFor={`${id}-mode`} className="text-base">
            Appearance
          </label>
        }
        about={<About id={`${id}-about`}>Dark is the default. Match device follows this device's own light or dark setting. Kept on this device only.</About>}
        control={
          <Select data-testid="appearance" id={`${id}-mode`} value={choice} aria-describedby={`${id}-about`} onChange={(e) => chooseAppearance(e.currentTarget.value as Appearance)} className="w-full sm:w-40">
            {APPEARANCES.map((mode) => (
              <option key={mode.value} value={mode.value}>
                {mode.label}
              </option>
            ))}
          </Select>
        }
      />
    </Panel>
  );
}

/**
 * Version (issue #116): the version this Botbench runs, whether a newer release is published, with its notes' summary
 * and "Update now", and how it is going; and the owner's choice of updating on a tap (the default) or by itself. Read
 * as the group opens, and again every few seconds while an update is under way.
 */
function Version({ onSignedOut }: { onSignedOut: () => void }) {
  const id = useId();
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const failed = useCallback(
    (what: string) => (err: unknown) => {
      if (err instanceof ApiError && err.status === 401) return onSignedOut();
      setProblem(err instanceof ApiError ? `${what} ${err.message}` : `${what} Botbench could not be reached.`);
    },
    [onSignedOut],
  );
  useEffect(() => {
    let live = true;
    getUpdate().then((s) => live && (setStatus(s), setProblem(null)), (err: unknown) => live && failed("The version could not be read.")(err));
    return () => {
      live = false;
    };
  }, [failed]);
  // While an update waits, runs or restarts, its state is read again; a restart answers again once the new version runs.
  useEffect(() => {
    if (status === null || !updateUnderWay(status)) return;
    const timer = setTimeout(() => getUpdate().then(setStatus, () => setStatus({ ...status })), 3000);
    return () => clearTimeout(timer);
  }, [status]);

  const update = (): void => {
    setBusy(true);
    setProblem(null);
    startUpdate()
      .then(setStatus, failed("The update did not start."))
      .finally(() => setBusy(false));
  };
  const choose = (mode: UpdateMode): void => {
    setProblem(null);
    setUpdateMode(mode).then(setStatus, failed("When to update was not saved."));
  };

  const about = status === null ? null : versionAbout(status);
  const stateWords = status === null ? null : updateStateWords(status);
  return (
    <Panel data-testid="update-settings" role="group" aria-labelledby={`${id}-heading`} className="divide-y">
      <div data-testid="version-row" className="flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-center sm:justify-between sm:gap-6">
        <div className="flex min-w-0 flex-col gap-1">
          <h2 id={`${id}-heading`} data-testid="version" className="text-base font-semibold">
            {status === null ? "Botbench" : `Botbench ${status.version}`}
          </h2>
          <About id={`${id}-about`} data-testid="version-about">
            {about === null ? "Reading the version." : about.lead}
            {about?.notes != null && (
              <>
                {" — "}
                <span data-ds-content="">{about.notes}</span>
              </>
            )}
          </About>
          {stateWords !== null && (
            <About role="status" data-testid="update-state">
              {stateWords}
            </About>
          )}
        </div>
        {status !== null && canUpdate(status) && (
          <Busy aria-describedby={`${id}-about`} busy={busy} busyLabel="Starting" onClick={update} className="shrink-0">
            Update now
          </Busy>
        )}
      </div>
      {status?.state.kind === "failed" && status.state.message !== null && (
        <div className="px-5 py-4">
          <Note tone="error" role="alert" testId="update-failed">
            {status.state.message}
          </Note>
        </div>
      )}
      <Row
        label={<label htmlFor={`${id}-mode`}>Updates</label>}
        about={<About id={`${id}-mode-about`}>Botbench looks for a new release on GitHub every 6 hours and sends nothing about you.</About>}
        control={
          <Select data-testid="update-mode" id={`${id}-mode`} value={status?.mode ?? ""} disabled={status === null || !status.checking} aria-describedby={`${id}-mode-about`} onChange={(e) => choose(e.currentTarget.value as UpdateMode)} className="w-full sm:w-44">
            {status === null && <option value="">Checking</option>}
            <option value="tap">On a tap</option>
            <option value="auto">Automatically</option>
          </Select>
        }
      >
        <More about="Updates">
          <p>{UPDATE_MODE_ABOUT}</p>
        </More>
      </Row>
      {problem !== null && (
        <div className="px-5 py-4">
          <Note tone="error" role="alert">
            {problem}
          </Note>
        </div>
      )}
    </Panel>
  );
}

/** The note being edited: what the owner typed, the version it was read at, and why it was not saved. */
type Editing = { id: number; text: string; hash: string; saving: boolean; problem: string | null; now: string | null };

/** One note at rest: its text, when it was saved or edited, and Edit and Forget. Its text is always a React child, never markup. */
function NoteRow({ note, number, locked, forgetting, onEdit, onForget }: { note: MemoryNote; number: number; /** Another note is being edited or forgotten. */ locked: boolean; /** This note is being forgotten: Forget is busy and keeps the focus. */ forgetting: boolean; onEdit: () => void; onForget: () => void }) {
  return (
    <div className="flex flex-col gap-3 px-5 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-6">
      <div className="flex min-w-0 flex-col gap-0.5">
        <span data-ds-content="" className="text-sm wrap-anywhere">
          {note.text}
        </span>
        <span className="text-meta text-muted-foreground">{note.editedAt === null ? `Saved ${fullDate(note.savedAt)}` : `Edited ${fullDate(note.editedAt)}`}</span>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <Button type="button" variant="ghost" data-memory-edit={note.id} disabled={locked || forgetting} data-ds-content-label="" aria-label={`Edit note ${number}: ${note.text}`} onClick={onEdit}>
          Edit
        </Button>
        <Confirm label="Forget" opener={{ name: `Forget note ${number}: ${note.text}`, object: `note ${number}: ${note.text}`, theirs: true }} title="Forget this note?" confirmLabel="Forget" cancelLabel="Keep it" disabled={locked} busy={forgetting} busyLabel="Forgetting" losing testId={`memory-forget-${note.id}`} onConfirm={onForget}>
          <p>Botbench removes it from memory and keeps no copy there. Agents are no longer given it. Chats and runs that already had it keep their words.</p>
        </Confirm>
      </div>
    </div>
  );
}

/** The editor a note's row turns into. Enter saves; Escape cancels. */
function NoteEditor({ editing, number, max, onChange, onSave, onCancel }: { editing: Editing; number: number; max: number; onChange: (text: string) => void; onSave: () => void; onCancel: () => void }) {
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), []);
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    onSave();
  };
  const described = [`${id}-about`, ...(editing.now === null ? [] : [`${id}-now`]), ...(editing.problem === null ? [] : [`${id}-problem`])].join(" ");
  return (
    <form onSubmit={submit} onKeyDown={(e) => e.key === "Escape" && !editing.saving && onCancel()} className="flex flex-col gap-2 px-5 py-3" noValidate>
      <FieldLabel htmlFor={`${id}-text`}>{`Note ${number}`}</FieldLabel>
      <Input ref={input} data-testid="memory-note-text" id={`${id}-text`} type="text" autoComplete="off" maxLength={max} readOnly={editing.saving} value={editing.text} onChange={(e) => onChange(e.currentTarget.value)} aria-invalid={editing.problem !== null || undefined} aria-describedby={described} />
      <About id={`${id}-about`}>{`One line, at most ${grouped(max)} characters.`}</About>
      {editing.now !== null && (
        <About id={`${id}-now`} data-ds-content="">
          {`The note now: ${editing.now}`}
        </About>
      )}
      {editing.problem !== null && (
        <p role="alert" id={`${id}-problem`} className="text-meta text-destructive">
          {editing.problem}
        </p>
      )}
      <div className="flex items-center gap-2">
        <Busy type="submit" busy={editing.saving} busyLabel="Saving note">
          Save note
        </Busy>
        <Button type="button" variant="ghost" disabled={editing.saving} onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

/**
 * Memory (ADR 0006): the notes Botbench keeps because the owner began a chat message with "Remember:" or "Remember
 * that", newest first. Each can be edited in its row, or forgotten after a question. An edit carries the version the
 * screen read, so one made on a note that changed since (in another tab) is refused, and the owner sees the note as it
 * is now before trying again.
 */
function Memory({ onSignedOut }: { onSignedOut: () => void }) {
  const [list, setList] = useState<MemoryList | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [editing, setEditing] = useState<Editing | null>(null);
  /** The id of the note being forgotten. */
  const [forgetting, setForgetting] = useState<number | null>(null);
  /** Where the focus goes once the list is drawn again: a note's Edit button, or the heading when no note is left. */
  const [focusEdit, setFocusEdit] = useState<number | "heading" | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const group = useRef<HTMLElement>(null);

  const failed = (what: string) => (err: unknown): void => {
    if (err instanceof ApiError && err.status === 401) return onSignedOut();
    setProblem(err instanceof ApiError ? `${what} ${err.message}` : `${what.replace(/\.$/, "")}: Botbench could not be reached.`);
  };
  const load = (): Promise<MemoryList | null> =>
    getMemory().then(
      (found) => (setList(found), found),
      (err: unknown) => (failed("Memory could not be read.")(err), null),
    );
  useEffect(() => {
    void load();
  }, [onSignedOut]);
  // After Save or Cancel, the focus goes back to the row's Edit button.
  useEffect(() => {
    if (focusEdit === null) return;
    setFocusEdit(null);
    // Only a focus that went with the editor or the row is placed; one the owner moved elsewhere meanwhile stays.
    if (document.activeElement !== null && document.activeElement !== document.body) return;
    (focusEdit === "heading" ? heading.current : group.current?.querySelector<HTMLButtonElement>(`[data-memory-edit="${focusEdit}"]`))?.focus();
  }, [focusEdit, list, editing]);

  const close = (noteId: number): void => {
    setEditing(null);
    setFocusEdit(noteId);
  };
  const save = (): void => {
    if (editing === null || editing.saving) return;
    if (editing.text.trim() === "") return setEditing({ ...editing, problem: "Write the note, or cancel to keep it as it was. To remove it, use Forget." });
    const sent = editing;
    setEditing({ ...sent, saving: true, problem: null });
    editMemoryNote(sent.id, sent.text, sent.hash).then(
      (saved) => {
        setList((was) => (was === null ? was : { ...was, notes: was.notes.map((n) => (n.id === saved.id ? saved : n)) }));
        close(saved.id);
      },
      async (err: unknown) => {
        if (err instanceof ApiError && err.status === 401) return onSignedOut();
        const message = err instanceof ApiError ? err.message : "The note was not saved: Botbench could not be reached. Your text is still here. Save again once it is.";
        // Changed or forgotten since this screen read it: what is there now is read, and nothing was overwritten.
        if (err instanceof ApiError && (err.status === 409 || err.status === 404)) {
          const found = await load();
          const now = found?.notes.find((n) => n.id === sent.id);
          if (now === undefined) {
            setEditing(null);
            setProblem(message);
            return;
          }
          return setEditing({ ...sent, saving: false, problem: message, hash: now.hash, now: now.text });
        }
        setEditing({ ...sent, saving: false, problem: message });
      },
    );
  };
  const forget = (note: MemoryNote): void => {
    setForgetting(note.id);
    setProblem(null);
    const at = notes.findIndex((n) => n.id === note.id);
    forgetMemoryNote(note.id, note.hash).then(
      (found) => {
        setList(found);
        setForgetting(null);
        // The focus goes to the Edit button of the note that took its place, or of the one before it when it was last,
        // or to the heading when no note is left.
        setFocusEdit(takesItsPlace(found.notes, at)?.id ?? "heading");
      },
      (err: unknown) => {
        setForgetting(null);
        failed("The note was not forgotten.")(err);
        void load();
      },
    );
  };

  const notes = list?.notes ?? [];
  return (
    <section ref={group} data-testid="memory-settings" aria-labelledby="settings-memory" className="flex flex-col gap-3">
      <SectionHeading ref={heading} tabIndex={-1} id="settings-memory" right={notes.length > 0 && <About>{`${counted(notes.length, "note", "notes")}, newest first`}</About>}>
        Memory
      </SectionHeading>
      <About>Start a chat message with "Remember:" or "Remember that" and Botbench keeps the rest of it as a note, in your words.</About>
      <More about="Memory">
        <p>{`Every agent of a later chat, and the planner and builder of a later run, is given your notes. Botbench keeps them on this Mac, in its data folder, and never adds them to a repository. An agent given them sends them to its provider with the rest of its prompt, as it does your messages.${list === null ? "" : ` At most ${grouped(list.maxNoteChars)} characters a note, and ${list.maxKb} KB in all.`}`}</p>
      </More>
      {problem !== null && (
        <Note tone="error" role="alert">
          {problem}
        </Note>
      )}
      {list === null ? (
        problem === null && <Reading>Reading memory.</Reading>
      ) : notes.length === 0 ? (
        <Panel className="flex flex-col gap-1 border-dashed bg-transparent p-5">
          <h3 className="text-base font-semibold">No notes yet</h3>
          <About>Start a chat message with "Remember:" to add the first one.</About>
        </Panel>
      ) : (
        <Panel>
          <ol data-testid="memory-notes" aria-label="Notes in memory, newest first" className="divide-y">
            {notes.map((note, i) => (
              <li key={note.id}>
                {editing?.id === note.id ? (
                  <NoteEditor editing={editing} number={i + 1} max={list.maxNoteChars} onChange={(text) => setEditing({ ...editing, text })} onSave={save} onCancel={() => close(note.id)} />
                ) : (
                  <NoteRow note={note} number={i + 1} locked={editing !== null || (forgetting !== null && forgetting !== note.id)} forgetting={forgetting === note.id} onEdit={() => setEditing({ id: note.id, text: note.text, hash: note.hash, saving: false, problem: null, now: null })} onForget={() => forget(note)} />
                )}
              </li>
            ))}
          </ol>
        </Panel>
      )}
    </section>
  );
}

/** Workbench identity: its name, its fingerprint when it has one, how it looks on this device, its version and updates, and its memory. */
export function IdentityGroup({ onSignedOut }: { onSignedOut: () => void }) {
  return (
    <div className="grid items-start gap-6 xl:grid-cols-2">
      <div className="flex min-w-0 flex-col gap-6">
        <WorkbenchName onSignedOut={onSignedOut} />
        <Fingerprint onSignedOut={onSignedOut} />
        <AppearanceChoice />
      </div>
      <div className="flex min-w-0 flex-col gap-6">
        <Version onSignedOut={onSignedOut} />
        <Memory onSignedOut={onSignedOut} />
      </div>
    </div>
  );
}
