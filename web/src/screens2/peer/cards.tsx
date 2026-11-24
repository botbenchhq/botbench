import { useContext, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Lock } from "lucide-react";
import { Button } from "@/ui/button";
import { answerPeerCard, ApiError, dismissPeerCard, dontSendPeerDraft, givePeerCard, seePeerCard, sendPeerDraft, type PeerCard } from "../../api/client.ts";
import { PeerCardsContext } from "../../app/peer-cards.tsx";
import { visible } from "../../components/approval-card.tsx";
import { MAX_MESSAGE } from "../../components/peer-card.tsx";
import { About, Busy, FieldLabel, OutsideMark, Panel, StateWord, Textarea } from "../settings/parts.tsx";
import { RepoChoice } from "../settings/repo-choice.tsx";

/** Cards already reported as drawn by this screen, so each is reported once. */
const reported = new Set<string>();

/**
 * Tell the server, once, that a signed-in device drew this card: the friction record's "shown" (src/peers/cards.ts).
 * A report that fails is said in the browser's console and changes nothing on the screen.
 */
function useSeen(card: PeerCard): void {
  useEffect(() => {
    const key = `${card.pairingId} ${card.direction} ${card.messageId}`;
    if (reported.has(key)) return;
    reported.add(key);
    seePeerCard(card.pairingId, card.direction, card.messageId).catch((err: unknown) => {
      reported.delete(key);
      console.error(`Botbench could not record that this card was shown: ${err instanceof Error ? err.message : String(err)}`);
    });
  }, [card.pairingId, card.direction, card.messageId]);
}

/** What a failed press says: the server's own words, or that it could not be reached. */
const failure = (what: string, err: unknown): string => (err instanceof ApiError ? `${what} ${err.message}` : `${what} Botbench could not be reached.`);

/** The first letter of a name, in a small round mark. Decoration: the name stands beside it. */
export function Initial({ name, peer = false }: { name: string; peer?: boolean }) {
  return (
    <span aria-hidden="true" className={`flex size-7 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${peer ? "bg-peer-subtle text-peer" : "bg-fill text-muted-foreground"}`}>
      {name.slice(0, 1).toUpperCase()}
    </span>
  );
}

/**
 * The words another workbench sent, in the peer colour's box: whose they are, the Outside text mark, and the text as
 * plain text only (never markdown, HTML or a link), its line breaks kept and its invisible characters written out.
 */
export function PeerWords({ name, right, text, testId }: { name: string; right?: ReactNode; text: string; testId: string }) {
  return (
    <div className="flex flex-col gap-2 rounded-xl border border-peer/60 bg-peer-subtle p-4">
      <div className="flex flex-wrap items-center gap-2">
        <Initial name={name} peer />
        <span data-ds-content="" className="text-sm font-semibold">
          {name}
        </span>
        <OutsideMark />
        {right !== undefined && <span className="ml-auto text-meta text-muted-foreground">{right}</span>}
      </div>
      <p data-testid={testId} data-ds-content="" className="text-base wrap-anywhere whitespace-pre-wrap">
        {visible(text)}
      </p>
    </div>
  );
}

/** One of the three choices: its button, and under it what it does. */
function Choice({ about, children }: { about: ReactNode; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-1 basis-40 flex-col gap-2">
      {children}
      <About>{about}</About>
    </div>
  );
}

/**
 * What the paired workbench needs (ADR 0004 decision 8), as the conversation's focal card: who sent it, the Outside
 * text mark, the text as plain text, and the owner's three choices, each with what it does. Answer it yourself opens a
 * field and sends the owner's own reply on Send; Give it to Claude Code starts a task in the owner's copy of the
 * repository, marked as having read outside text; Dismiss closes it. Nothing leaves this Mac until Send.
 */
export function NeedsCard({ card, when, onSignedOut }: { card: PeerCard; when: string | null; onSignedOut: () => void }) {
  useSeen(card);
  const { refresh } = useContext(PeerCardsContext);
  const [open, setOpen] = useState<"answer" | "give" | null>(null);
  const [text, setText] = useState("");
  const [repo, setRepo] = useState<string | null>(null);
  const [hosts, setHosts] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const heading = useId();
  const field = useId();
  const field2 = useId();
  const input = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (open === "answer") input.current?.focus();
  }, [open]);
  const name = card.peer.name;
  const reply = card.kind === "question" ? "Your answer" : "Your next question";

  // One action at a time, and each has its own view (the three buttons, the answer, the task): its button is the busy one.
  const act = (what: string, run: () => Promise<unknown>, after?: (value: unknown) => void): void => {
    if (busy) return;
    setBusy(true);
    setProblem(null);
    run().then(
      (value) => {
        refresh();
        after?.(value);
      },
      (err: unknown) => {
        if (err instanceof ApiError && err.status === 401) return onSignedOut();
        setBusy(false);
        setProblem(failure(what, err));
        refresh();
      },
    );
  };

  return (
    <Panel role="article" data-testid="peer-card" data-message-id={card.messageId} aria-labelledby={heading} className="flex flex-col gap-4 p-5">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <p data-ds-content="" className="text-meta font-semibold text-muted-foreground">
          {card.kind === "question" ? `What ${name} needs` : `What ${name} answered`}
        </p>
        <div className="flex flex-wrap items-center gap-3">
          {when !== null && <span className="text-meta text-muted-foreground">{`${card.kind === "question" ? "Question" : "Answer"}, ${when}`}</span>}
          <StateWord tone="attention">Waits for you</StateWord>
        </div>
      </div>
      <h2 id={heading} data-ds-content="" className="text-heading font-semibold tracking-tight">
        {card.title}
      </h2>
      <PeerWords
        name={name}
        text={card.text}
        testId="peer-card-text"
        right={
          <span data-testid="peer-card-fingerprint">
            {"Signed by "}
            <code data-ds-content="">{card.peer.fingerprint}</code>
          </span>
        }
      />
      <About data-testid="peer-card-line">{card.line}</About>
      {problem !== null && (
        <p role="alert" className="text-sm text-destructive">
          {problem}
        </p>
      )}
      {open === null && (
        <div className="flex flex-wrap gap-3">
          <Choice about={<span data-ds-content="">{`You write ${card.kind === "question" ? "the answer" : "what you ask next"}. Only that text goes to ${name}'s workbench.`}</span>}>
            <Button type="button" disabled={busy} onClick={() => setOpen("answer")}>
              Answer it yourself
            </Button>
          </Choice>
          <Choice about="Starts a task in your copy of the repository, in Manual mode. It drafts an answer for you to send.">
            <Button type="button" variant="outline" disabled={busy} onClick={() => setOpen("give")}>
              Give it to Claude Code
            </Button>
          </Choice>
          <Choice about="Closes this card without an answer.">
            <Busy busy={busy} busyLabel="Dismissing" onClick={() => act("It was not dismissed.", () => dismissPeerCard(card.pairingId, card.messageId))}>
              Dismiss
            </Busy>
          </Choice>
        </div>
      )}
      {open === "answer" && (
        <form
          className="flex flex-col gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (text.trim() !== "") act("It was not sent.", () => answerPeerCard(card.pairingId, card.messageId, text));
          }}
        >
          <FieldLabel htmlFor={field}>{reply}</FieldLabel>
          <About id={`${field}-about`} data-ds-content="">{`Only this text leaves this Mac, and only to ${name}'s workbench, when you press Send.`}</About>
          <Textarea ref={input} id={field} value={text} maxLength={MAX_MESSAGE} readOnly={busy} aria-describedby={`${field}-about`} onChange={(e) => setText(e.target.value)} />
          <div className="flex flex-wrap gap-2">
            <Busy type="submit" variant="default" busy={busy} busyLabel="Sending" disabled={text.trim() === ""}>
              Send
            </Busy>
            <Button type="button" variant="ghost" disabled={busy} onClick={() => setOpen(null)}>
              Cancel
            </Button>
          </div>
        </form>
      )}
      {open === "give" && (
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (repo !== null) act("No task was started.", () => givePeerCard(card.pairingId, card.messageId, repo, hosts), (started) => (window.location.hash = `#/tasks/${(started as { taskId: number }).taskId}`));
          }}
        >
          <p data-ds-content="" className="text-sm">{`Botbench starts a task for Claude Code in your copy of the repository, with ${name}'s message in it as outside text: no command is allowed for it in advance or always, it runs in Manual mode, and nothing is sent to ${name}'s workbench unless you press Send on a draft.`}</p>
          <RepoChoice label="Your copy of the repository" value={repo} onChange={setRepo} onSignedOut={onSignedOut} />
          <div className="flex items-start gap-3">
            <input id={field2} type="checkbox" checked={hosts} aria-describedby={`${field2}-about`} onChange={(e) => setHosts(e.target.checked)} className="mt-0.5 size-5 shrink-0 accent-primary" />
            <div className="flex flex-col gap-0.5">
              <FieldLabel htmlFor={field2} className="font-medium">
                Allow this repository's network hosts for this task
              </FieldLabel>
              <About id={`${field2}-about`}>Off, its commands reach no network host.</About>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <Busy type="submit" variant="default" busy={busy} busyLabel="Starting" disabled={repo === null}>
              Start the task
            </Busy>
            <Button type="button" variant="ghost" disabled={busy} onClick={() => setOpen(null)}>
              Cancel
            </Button>
          </div>
        </form>
      )}
      <p className="flex items-start gap-2 border-t pt-4 text-meta text-muted-foreground">
        <Lock aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
        Nothing leaves this Mac until you press Send. A message never runs anything.
      </p>
    </Panel>
  );
}

/**
 * An agent's draft to the paired workbench (ADR 0004 decision 9): "Send this to bob?", the line that says what it is
 * and who drafted it, who asked when the work was given a message, the full text exactly as it will be sent, and the
 * sentence about what leaves. Send sends it, or the owner's edit of it, which the server allows; Don't send sends nothing.
 */
export function DraftCard({ card, onSignedOut }: { card: PeerCard; onSignedOut: () => void }) {
  useSeen(card);
  const { refresh } = useContext(PeerCardsContext);
  const [edited, setEdited] = useState<string | null>(null);
  const [busy, setBusy] = useState<"send" | "dont" | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const heading = useId();
  const field = useId();

  const act = (what: "send" | "dont"): void => {
    if (busy !== null) return;
    setBusy(what);
    setProblem(null);
    (what === "send" ? sendPeerDraft(card.pairingId, card.messageId, edited === null || edited === card.text ? undefined : edited) : dontSendPeerDraft(card.pairingId, card.messageId)).then(
      () => refresh(),
      (err: unknown) => {
        if (err instanceof ApiError && err.status === 401) return onSignedOut();
        setBusy(null);
        setProblem(failure(what === "send" ? "It was not sent." : "The draft is still waiting.", err));
        refresh();
      },
    );
  };

  return (
    <Panel role="article" data-testid="draft-card" data-message-id={card.messageId} aria-labelledby={heading} className="flex flex-col gap-4 p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-meta font-semibold text-muted-foreground">A draft for you to send</p>
        <StateWord tone="attention">Waits for you</StateWord>
      </div>
      <h2 id={heading} data-ds-content="" className="text-heading font-semibold tracking-tight">
        {card.title}
      </h2>
      <About data-testid="draft-card-line">{card.line}</About>
      {card.askedBy !== null && (
        <About data-testid="draft-asked-by" data-ds-content="">
          {card.askedBy}
        </About>
      )}
      {edited === null ? (
        <div role="group" aria-label="The text to send" className="rounded-xl border border-border bg-sunken p-4">
          <p data-testid="draft-card-text" data-ds-content="" className="text-base wrap-anywhere whitespace-pre-wrap">
            {visible(card.text)}
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-1.5">
          <FieldLabel htmlFor={field}>The text to send</FieldLabel>
          <Textarea id={field} value={edited} maxLength={MAX_MESSAGE} readOnly={busy !== null} onChange={(e) => setEdited(e.target.value)} />
        </div>
      )}
      <About data-testid="draft-card-note" data-ds-content="">
        {card.note}
      </About>
      {problem !== null && (
        <p role="alert" className="text-sm text-destructive">
          {problem}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Busy variant="default" busy={busy === "send"} busyLabel="Sending" disabled={busy === "dont" || (edited !== null && edited.trim() === "")} onClick={() => act("send")}>
          Send
        </Busy>
        {edited === null && (
          <Button type="button" variant="outline" disabled={busy !== null} onClick={() => setEdited(card.text)}>
            Edit
          </Button>
        )}
        <Busy busy={busy === "dont"} busyLabel="Not sending" disabled={busy === "send"} onClick={() => act("dont")}>
          {"Don't send"}
        </Busy>
      </div>
    </Panel>
  );
}
