import { useCallback, useContext, useEffect, useId, useState } from "react";
import { Button } from "@/ui/button";
import { Input } from "@/ui/input";
import { ApiError, confirmInvite, confirmPairing, endPairing, getPeerFriction, getPeerKinds, getPeerMessages, getPeerOverview, makeInvite, pasteInvite, refusePairing, setPeerKind, withdrawInvite, type KindSettings, type MessageKind, type Pairing, type PairingFriction, type PastedInvite, type PeerMessage, type PeerOverview } from "../../api/client.ts";
import { PeerChangesContext } from "../../app/approvals.tsx";
import { clock, counted, fullDate } from "../../app/format.ts";
import { frictionWords, inviteLife, pairingCards, threadHref, threadsOf } from "../../app/paired-words.ts";
import { PeerCardsContext } from "../../app/peer-cards.tsx";
import { NewQuestion } from "../peer/new-question.tsx";
import { About, Busy, Confirm, Fact, FieldLabel, More, Note, ON_OFF, Panel, Reading, SectionHeading, Segmented, StateWord } from "./parts.tsx";
import { RepoChoice } from "./repo-choice.tsx";

/** The settings file's words for turning pairing on, as the server's own refusal says them (src/peers/service.ts). */
export const LISTEN_SETTING = '"peers": { "listen": { "address": "127.0.0.1", "port": 4790 } }';

const words = (what: string, err: unknown): string => (err instanceof ApiError ? `${what} ${err.message}` : `${what} Botbench could not be reached.`);

/** What pairing never gives, said once on each screen that shows a pairing. */
export const NEVER_GIVES = "cannot read your files, tasks, transcripts or settings, and cannot start or wake an agent here. Code moves between you only through branches and pull requests.";

/** The two fingerprints the owners compare, side by side in the same words on both screens. */
function Fingerprints({ peer, own }: { peer: { name: string; fingerprint: string }; own: string }) {
  return (
    <dl className="grid gap-4 sm:grid-cols-2" data-testid="fingerprints">
      <Fact label={`${peer.name}'s fingerprint`} mono theirs testId="peer-fingerprint" className="[&>dd]:text-peer">
        {peer.fingerprint}
      </Fact>
      <Fact label="This workbench's fingerprint" mono testId="own-fingerprint">
        {own}
      </Fact>
    </dl>
  );
}

/** Invite: make a one-line invite for the chosen repository, show it to copy with its expiry, and Withdraw it. */
function Invite({ overview, onChanged, onSignedOut }: { overview: PeerOverview; onChanged: () => void; onSignedOut: () => void }) {
  const id = useId();
  const [repo, setRepo] = useState<string | null>(null);
  const [made, setMade] = useState<{ id: string; invite: string; repository: string; expiresAt: string } | null>(null);
  // What is being sent: "make", or the id of the invite being withdrawn. Its button is busy; the others wait.
  const [busy, setBusy] = useState<string | null>(null);
  const [copied, setCopied] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 15_000);
    return () => window.clearInterval(timer);
  }, []);
  const failed = (what: string) => (err: unknown) => {
    if (err instanceof ApiError && err.status === 401) return onSignedOut();
    setProblem(words(what, err));
  };
  const make = (): void => {
    if (repo === null) return;
    setBusy("make");
    setProblem(null);
    makeInvite(repo)
      .then((invite) => {
        setMade(invite);
        setCopied("");
        onChanged();
      }, failed("No invite was made."))
      .finally(() => setBusy(null));
  };
  const withdraw = (inviteId: string): void => {
    setBusy(inviteId);
    setProblem(null);
    withdrawInvite(inviteId)
      .then(() => {
        if (made?.id === inviteId) setMade(null);
        onChanged();
      }, failed("The invite was not withdrawn."))
      .finally(() => setBusy(null));
  };
  const copy = (): void => {
    if (made === null) return;
    navigator.clipboard.writeText(made.invite).then(
      () => setCopied("Invite copied."),
      () => setCopied("Not copied: this browser refused. Select the invite and copy it by hand."),
    );
  };
  // The open invite the server still holds: its line is shown only to the request that made it, never again.
  // Once it has expired the server no longer lists it; the line goes, and the screen says it expired.
  const shown = made !== null && (overview.invites.some((i) => i.id === made.id) || Date.parse(made.expiresAt) <= now) ? made : null;
  const others = overview.invites.filter((i) => i.id !== shown?.id);
  const life = shown === null ? null : inviteLife(shown.expiresAt, now);

  return (
    <div className="flex flex-col gap-3 px-5 py-4" data-testid="invite">
      <div className="flex flex-col gap-1">
        <h3 className="text-sm font-semibold">Invite</h3>
        <About id={`${id}-about`}>A one-line invite for the other workbench's owner to paste. Pass it to them yourself, in a message you trust. It works once, for 15 minutes.</About>
      </div>
      {shown === null && <RepoChoice label="The repository to pair on" value={repo} onChange={setRepo} onSignedOut={onSignedOut} />}
      {shown === null && (
        <div>
          <Busy aria-describedby={`${id}-about`} busy={busy === "make"} busyLabel="Making an invite" disabled={repo === null || (busy !== null && busy !== "make")} onClick={make}>
            Make an invite
          </Busy>
        </div>
      )}
      {shown !== null && life !== null && (
        <div className="flex flex-col gap-3">
          <dl>
            <Fact label="To pair on" mono theirs testId="invite-repository">
              {shown.repository}
            </Fact>
          </dl>
          <div className="flex flex-col gap-1.5">
            <FieldLabel htmlFor={`${id}-line`}>Invite</FieldLabel>
            <div className="flex flex-wrap items-center gap-2">
              <Input data-testid="invite-line" id={`${id}-line`} type="text" readOnly value={life.open ? shown.invite : ""} className="min-w-0 flex-1 basis-48 font-mono text-meta md:text-meta" />
              <Button type="button" variant="outline" aria-label="Copy the invite" disabled={!life.open} onClick={copy}>
                Copy
              </Button>
            </div>
            <About role="status">{copied}</About>
          </div>
          <p data-testid="invite-life" className="text-sm">
            {life.words}
          </p>
          <div>
            {life.open ? (
              <Busy busy={busy === shown.id} busyLabel="Withdrawing" disabled={busy !== null && busy !== shown.id} onClick={() => withdraw(shown.id)}>
                Withdraw
              </Busy>
            ) : (
              <Button type="button" variant="outline" disabled={busy !== null} onClick={() => setMade(null)}>
                Make a new invite
              </Button>
            )}
          </div>
        </div>
      )}
      {others.map((open) => (
        <div key={open.id} className="flex flex-col gap-3 rounded-lg border border-border p-4 sm:flex-row sm:items-center sm:justify-between" data-testid="open-invite">
          <div className="flex min-w-0 flex-col gap-1">
            <p className="text-sm font-semibold">An invite is open</p>
            <About>{`Until ${clock(open.expiresAt)}. Botbench shows an invite only once, when it is made.`}</About>
            <dl>
              <Fact label="To pair on" mono theirs>
                {open.repository}
              </Fact>
            </dl>
          </div>
          <Busy busy={busy === open.id} busyLabel="Withdrawing" disabled={busy !== null && busy !== open.id} onClick={() => withdraw(open.id)} className="shrink-0 self-start">
            Withdraw
          </Busy>
        </div>
      ))}
      {problem !== null && (
        <Note tone="error" role="alert">
          {problem}
        </Note>
      )}
    </div>
  );
}

/** Paste an invite: see the inviter's name, fingerprint and repository, then Confirm, which sends the pair request. */
function Paste({ onPaired, onSignedOut }: { onPaired: () => void; onSignedOut: () => void }) {
  const id = useId();
  const [text, setText] = useState("");
  const [repo, setRepo] = useState<string | null>(null);
  const [pasted, setPasted] = useState<PastedInvite | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const failed = (what: string) => (err: unknown) => {
    if (err instanceof ApiError && err.status === 401) return onSignedOut();
    setProblem(words(what, err));
  };
  const check = (): void => {
    if (busy || repo === null || text.trim() === "") return;
    setBusy(true);
    setProblem(null);
    pasteInvite(text.trim(), repo)
      .then(setPasted, failed("The invite was not taken."))
      .finally(() => setBusy(false));
  };
  const confirm = (): void => {
    if (pasted === null) return;
    setBusy(true);
    setProblem(null);
    confirmInvite(pasted.id)
      .then(() => {
        setPasted(null);
        setText("");
        onPaired();
      }, failed("Nothing was paired."))
      .finally(() => setBusy(false));
  };

  return (
    <div className="flex flex-col gap-3 px-5 py-4" data-testid="paste">
      <div className="flex flex-col gap-1">
        <h3 className="text-sm font-semibold">Paste an invite</h3>
        <About>An invite another workbench's owner gave you. Botbench shows who it is from before anything is sent.</About>
      </div>
      {pasted === null ? (
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            check();
          }}
        >
          <div className="flex flex-col gap-1.5">
            <FieldLabel htmlFor={`${id}-invite`}>Invite</FieldLabel>
            <Input id={`${id}-invite`} data-testid="paste-invite" type="text" autoComplete="off" autoCapitalize="none" spellCheck={false} value={text} onChange={(e) => setText(e.currentTarget.value)} />
          </div>
          <RepoChoice label="Your copy of the repository" value={repo} onChange={setRepo} onSignedOut={onSignedOut} />
          <div>
            <Busy type="submit" busy={busy} busyLabel="Checking" disabled={repo === null || text.trim() === ""}>
              Check the invite
            </Busy>
          </div>
        </form>
      ) : (
        <div className="flex flex-col gap-3 text-sm" data-testid="pasted">
          <p data-ds-content="">{`This invite is from ${pasted.name}'s workbench. Ask ${pasted.name} to read out the fingerprint their screen shows for their workbench, and check it is this one. Confirm only if it is.`}</p>
          <dl className="grid gap-4 sm:grid-cols-2">
            <Fact label="Workbench" theirs testId="pasted-name">
              {pasted.name}
            </Fact>
            <Fact label={`${pasted.name}'s fingerprint`} mono theirs testId="pasted-fingerprint">
              {pasted.fingerprint}
            </Fact>
            <Fact label="Repository" mono theirs testId="pasted-repository">
              {pasted.repository}
            </Fact>
            <Fact label="This workbench's fingerprint" mono testId="own-fingerprint">
              {pasted.ownFingerprint}
            </Fact>
          </dl>
          <p data-ds-content="">{`Confirm sends ${pasted.name}'s workbench this workbench's name, address and key, and nothing else. Nothing more is sent until ${pasted.name} confirms your fingerprint too.`}</p>
          <div className="flex flex-wrap gap-2">
            <Busy busy={busy} busyLabel="Confirming" onClick={confirm}>
              Confirm
            </Busy>
            <Button type="button" variant="ghost" disabled={busy} onClick={() => setPasted(null)}>
              Cancel
            </Button>
          </div>
        </div>
      )}
      {problem !== null && (
        <Note tone="error" role="alert">
          {problem}
        </Note>
      )}
    </div>
  );
}

const KIND_WORDS: Record<MessageKind, string> = { question: "questions", answer: "answers" };

/**
 * The four On/Off choices (ADR 0004 decision 11): what this workbench sends to the other, and what it takes from it.
 * `compact` is for the conversation's side pane, where the pairs stand one under the other.
 */
export function Kinds({ pairing, compact = false, onSignedOut }: { pairing: Pairing; compact?: boolean; onSignedOut: () => void }) {
  const id = useId();
  const changes = useContext(PeerChangesContext);
  const [kinds, setKinds] = useState<KindSettings | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  // The choice whose change is being sent, as "send-question": it stays enabled and keeps the focus; the others wait.
  const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => {
    let stale = false;
    getPeerKinds(pairing.id).then(
      (found) => stale || setKinds(found),
      (err: unknown) => {
        if (err instanceof ApiError && err.status === 401) return onSignedOut();
        if (!stale) setProblem(words("What may be sent and taken could not be read.", err));
      },
    );
    return () => {
      stale = true;
    };
  }, [pairing.id, changes, onSignedOut]);
  const name = pairing.peer.name;
  const change = (direction: "send" | "receive", kind: MessageKind, allowed: boolean): void => {
    // The choice moves at once; a refusal puts it back and says so.
    if (busy !== null) return;
    const before = kinds;
    if (kinds !== null) setKinds({ ...kinds, [direction]: { ...kinds[direction], [kind]: allowed } });
    setBusy(`${direction}-${kind}`);
    setProblem(null);
    setPeerKind(pairing.id, direction, kind, allowed)
      .then(setKinds, (err: unknown) => {
        if (err instanceof ApiError && err.status === 401) return onSignedOut();
        setKinds(before);
        setProblem(words(`It was not changed, and is still ${before?.[direction][kind] ? "on" : "off"}.`, err));
      })
      .finally(() => setBusy(null));
  };
  const row = (direction: "send" | "receive", kind: MessageKind) => {
    const key = `${direction}-${kind}`;
    const label = direction === "send" ? `Send ${KIND_WORDS[kind]} to ${name}` : `Take ${KIND_WORDS[kind]} from ${name}`;
    // The other side has switched this kind off: said under the choice it makes moot.
    const refusedThere = direction === "send" && kinds !== null && !kinds.peerReceives[kind];
    return (
      <div key={key} className="flex flex-col gap-1">
        <div className="flex items-center justify-between gap-3">
          <span data-ds-content="" className="text-sm font-medium">
            {label}
          </span>
          <Segmented testId={`kind-${key}`} label={label} value={kinds === null ? null : kinds[direction][kind] ? "on" : "off"} options={ON_OFF} disabled={busy !== null && busy !== key} busy={busy === key} describedBy={`${id}-${direction}-about`} onChange={(next) => change(direction, kind, next === "on")} />
        </div>
        {refusedThere && <About data-ds-content="">{`${name}'s workbench does not take ${KIND_WORDS[kind]} from you now, so none is sent whatever this says.`}</About>}
      </div>
    );
  };
  return (
    <div className="flex flex-col gap-4" data-testid="kinds">
      <div className={compact ? "flex flex-col gap-5" : "grid gap-x-8 gap-y-5 sm:grid-cols-2"}>
        <div className="flex flex-col gap-3">
          <p data-ds-content="" className="text-meta font-semibold text-muted-foreground">{`From you to ${name}`}</p>
          {row("send", "question")}
          {row("send", "answer")}
          <About id={`${id}-send-about`} data-ds-content="">{`Off, Botbench sends none to ${name}, also one you already pressed Send on that has not left yet.`}</About>
        </div>
        <div className="flex flex-col gap-3">
          <p data-ds-content="" className="text-meta font-semibold text-peer">{`From ${name} to you`}</p>
          {row("receive", "question")}
          {row("receive", "answer")}
          <About id={`${id}-receive-about`} data-ds-content="">{`Off, ${name}'s workbench is told, and Botbench refuses every one from it, whatever it sends.`}</About>
        </div>
      </div>
      {problem !== null && (
        <Note tone="error" role="alert">
          {problem}
        </Note>
      )}
    </div>
  );
}

/** The pairing's conversations, newest first, each a link to its own screen, and what the messages cost the owner. */
function Conversations({ pairing, onSignedOut }: { pairing: Pairing; onSignedOut: () => void }) {
  const changes = useContext(PeerChangesContext);
  const { cards } = useContext(PeerCardsContext);
  const [messages, setMessages] = useState<PeerMessage[] | null>(null);
  const [friction, setFriction] = useState<PairingFriction | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => {
    let stale = false;
    Promise.all([getPeerMessages(pairing.id), getPeerFriction()]).then(
      ([found, record]) => {
        if (stale) return;
        setMessages(found);
        setFriction(record.find((p) => p.pairingId === pairing.id) ?? null);
      },
      (err: unknown) => {
        if (err instanceof ApiError && err.status === 401) return onSignedOut();
        if (!stale) setProblem(words("The conversations could not be read.", err));
      },
    );
    return () => {
      stale = true;
    };
  }, [pairing.id, changes, onSignedOut]);
  const threads = messages === null ? [] : threadsOf(messages, cards ?? [], pairing.id);
  const total = friction === null ? null : frictionWords({ ...friction, cards: pairingCards(friction) });
  return (
    <>
      <div className="flex flex-col gap-3 px-5 py-4" data-testid="conversations">
        <h3 data-ds-content="" className="text-sm font-semibold">{`Conversations with ${pairing.peer.name}`}</h3>
        {problem !== null && (
          <Note tone="error" role="alert">
            {problem}
          </Note>
        )}
        {messages !== null && threads.length === 0 && <About data-ds-content="">{`No message yet. A question you send, or one from ${pairing.peer.name}, starts a conversation here.`}</About>}
        {threads.length > 0 && (
          <ul aria-label={`Conversations with ${pairing.peer.name}`} data-ds-content-label="" className="flex flex-col divide-y rounded-lg border border-border">
            {threads.map((t) => (
              <li key={t.contextId}>
                <a href={threadHref(pairing.id, t.contextId)} data-testid="thread-link" className="flex min-h-(--control) flex-col gap-0.5 px-4 py-2 hover:bg-fill">
                  <span data-ds-content="" className="line-clamp-1 text-sm font-medium wrap-anywhere">
                    {t.first}
                  </span>
                  <span className="text-meta text-muted-foreground">{`${counted(t.rows.length, "message", "messages")}${t.waiting ? " · Waits for you" : ""} · ${t.rows.at(-1)!.state}`}</span>
                </a>
              </li>
            ))}
          </ul>
        )}
      </div>
      {total !== null && (
        <div data-testid="friction" className="flex flex-col gap-1 px-5 py-4">
          <h3 className="text-sm font-semibold">What these messages cost you</h3>
          <p data-testid="friction-total" className="text-sm">{`${total.answered} ${total.waited} ${total.asDrafted}`}</p>
          <More about="What these messages cost you">
            <p>Counted from when a signed-in device first showed you each card to your choice on it. Each conversation's own numbers are on its screen.</p>
          </More>
        </div>
      )}
    </>
  );
}

/** End pairing, behind its confirmation: a destructive step, drawn as one. */
export function EndPairing({ pairing, disabled = false, onEnded, onSignedOut }: { pairing: Pairing; disabled?: boolean; onEnded: () => void; onSignedOut: () => void }) {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const name = pairing.peer.name;
  const end = (): void => {
    setBusy(true);
    setProblem(null);
    endPairing(pairing.id)
      .then(onEnded, (err: unknown) => {
        if (err instanceof ApiError && err.status === 401) return onSignedOut();
        setProblem(words("The pairing did not end.", err));
      })
      .finally(() => setBusy(false));
  };
  return (
    <>
      <Confirm label="End pairing" variant="destructive" title={`End pairing with ${name}?`} confirmLabel="End pairing" cancelLabel="Keep the pairing" disabled={disabled} busy={busy} busyLabel="Ending pairing" losing testId="end-pairing-dialog" className="shrink-0" onConfirm={end}>
        <p data-ds-content="">{`${name}'s workbench can no longer send you messages, and nothing more is sent to it. To work together again, one of you sends a new invite.`}</p>
      </Confirm>
      {problem !== null && (
        <Note tone="error" role="alert" className="basis-full">
          {problem}
        </Note>
      )}
    </>
  );
}

/** The pairing in force, or on its way: who, the fingerprints, the owner's steps, the four choices, its conversations, and End pairing. */
function PairingView({ pairing, onChanged, onSignedOut }: { pairing: Pairing; onChanged: () => void; onSignedOut: () => void }) {
  // The step being sent: its button is busy and keeps the focus; the others wait.
  const [busy, setBusy] = useState<"confirm" | "refuse" | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const name = pairing.peer.name;
  const step = (which: "confirm" | "refuse", what: string, run: () => Promise<unknown>) => (): void => {
    setBusy(which);
    setProblem(null);
    run()
      .then(onChanged, (err: unknown) => {
        if (err instanceof ApiError && err.status === 401) return onSignedOut();
        setProblem(words(what, err));
      })
      .finally(() => setBusy(null));
  };
  const inForce = pairing.state === "in_force";
  return (
    <Panel className="divide-y" data-testid="pairing" data-state={pairing.state}>
      <div className="flex flex-col gap-4 px-5 py-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex min-w-0 flex-col gap-1">
            <h3 className="text-base font-semibold">
              {"Paired workbench: "}
              <span data-testid="pairing-name" data-ds-content="">
                {name}
              </span>
            </h3>
            <About>
              {"On "}
              <code data-testid="pairing-repository" data-ds-content="" className="break-all text-foreground">
                {pairing.repository}
              </code>
              {`, each in your own copy. ${inForce ? "Paired since" : "Asked"} ${fullDate(pairing.createdAt)}.`}
            </About>
          </div>
          {inForce && (
            <StateWord tone="peer" testId="pairing-words" role="status">
              <span data-ds-content="">{pairing.words}</span>
            </StateWord>
          )}
        </div>
        {/* On its way, the pairing's state is a sentence of the server's: said whole, not in a mark. */}
        {!inForce && (
          <p role="status" data-testid="pairing-words" data-ds-content="" className="text-sm font-semibold text-attention">
            {pairing.words}
          </p>
        )}
        <Fingerprints peer={pairing.peer} own={pairing.ownFingerprint} />
        {pairing.state === "waiting_for_owner" && (
          <div className="flex flex-col gap-3 text-sm">
            <p data-ds-content="">{`Ask ${name} to read out the fingerprint their screen shows for their workbench. Confirm only if it is the one above; ${name} checks yours the same way.`}</p>
            <div className="flex flex-wrap gap-2">
              <Busy busy={busy === "confirm"} busyLabel="Confirming" disabled={busy !== null && busy !== "confirm"} onClick={step("confirm", "Nothing was confirmed.", () => confirmPairing(pairing.id))}>
                Confirm
              </Busy>
              <Busy busy={busy === "refuse"} busyLabel="Refusing" disabled={busy !== null && busy !== "refuse"} onClick={step("refuse", "Nothing was refused.", () => refusePairing(pairing.id))}>
                Refuse
              </Busy>
            </div>
          </div>
        )}
        {problem !== null && (
          <Note tone="error" role="alert">
            {problem}
          </Note>
        )}
      </div>
      {inForce && (
        <div className="px-5 py-4">
          <Kinds pairing={pairing} onSignedOut={onSignedOut} />
        </div>
      )}
      <div className="flex flex-col gap-1 px-5 py-4">
        <h3 className="text-sm font-semibold">What pairing never gives</h3>
        <About data-ds-content="">{`${name}'s workbench ${NEVER_GIVES}`}</About>
      </div>
      {inForce && (
        <div className="px-5 py-4">
          <NewQuestion pairingId={pairing.id} peer={name} onSignedOut={onSignedOut} />
        </div>
      )}
      {inForce && <Conversations pairing={pairing} onSignedOut={onSignedOut} />}
      <div className="flex flex-col gap-3 px-5 py-4 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between sm:gap-6">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <h3 data-ds-content="" className="text-sm font-semibold">{`End pairing with ${name}`}</h3>
          <About data-ds-content="">{`${name}'s workbench can no longer send you messages, and nothing more is sent to it. It asks first.`}</About>
        </div>
        <EndPairing pairing={pairing} disabled={busy !== null} onEnded={onChanged} onSignedOut={onSignedOut} />
      </div>
    </Panel>
  );
}

/**
 * The paired workbench (Peers P5, ADR 0004): pairing this workbench with one other person's, who it is, the
 * fingerprints, the four On/Off choices, its conversations, and End pairing. With the listener for paired workbenches
 * off in the settings file, it says so and how to switch it on, and offers no control.
 */
export function PairedWorkbench({ onSignedOut }: { onSignedOut: () => void }) {
  const changes = useContext(PeerChangesContext);
  const [overview, setOverview] = useState<PeerOverview | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [asked, setAsked] = useState(0);
  const again = useCallback(() => setAsked((n) => n + 1), []);
  useEffect(() => {
    let stale = false;
    getPeerOverview().then(
      (found) => {
        if (stale) return;
        setOverview(found);
        setProblem(null);
      },
      (err: unknown) => {
        if (err instanceof ApiError && err.status === 401) return onSignedOut();
        if (!stale) setProblem(words("The paired workbench could not be read.", err));
      },
    );
    return () => {
      stale = true;
    };
  }, [changes, asked, onSignedOut]);

  const live = overview?.pairings.find((p) => p.state !== "ended") ?? null;
  const ended = live === null ? (overview?.pairings.find((p) => p.state === "ended") ?? null) : null;
  return (
    <section aria-labelledby="settings-paired" data-testid="paired-workbench" className="flex flex-col gap-3">
      <SectionHeading id="settings-paired">Paired workbench</SectionHeading>
      <About>Pair with one other person's workbench to send each other questions and answers about a repository you both work on.</About>
      <More about="A paired workbench">
        <p>You approve every message before it leaves, and decide what to do with every message that arrives. A message never runs anything.</p>
      </More>
      {problem !== null && (
        <Note tone="error" role="alert">
          {problem}
        </Note>
      )}
      {overview === null && problem === null && <Reading>Reading the paired workbench.</Reading>}
      {overview !== null && overview.listening === null && (
        <Panel className="flex flex-col gap-1 p-5" data-testid="pairing-off">
          <h3 className="text-base font-semibold">Pairing is off</h3>
          <About>
            {"To pair, add "}
            <code className="text-foreground">{LISTEN_SETTING}</code>
            {" to Botbench's settings file, with this Mac's loopback address or an address on a private network the two of you share, then start Botbench again. Botbench does not start with a public address there."}
          </About>
        </Panel>
      )}
      {overview !== null && overview.listening !== null && live !== null && <PairingView pairing={live} onChanged={again} onSignedOut={onSignedOut} />}
      {overview !== null && overview.listening !== null && live === null && (
        <>
          {ended !== null && (
            <Note tone="note" testId="pairing-ended">
              <span data-ds-content="">{`The pairing with ${ended.peer.name} ended${ended.endedAt === null ? "" : ` on ${fullDate(ended.endedAt)}`}. Its messages are refused, and nothing more is sent to it. To work together again, one of you sends a new invite.`}</span>
            </Note>
          )}
          <Panel className="divide-y">
            <div className="flex flex-col gap-3 px-5 py-4">
              <About>{`The first version pairs with one workbench at a time, on one repository. Both workbenches' listeners must be on this Mac's loopback address or a private network; this one listens on ${overview.listening}.`}</About>
              {overview.fingerprint !== null && (
                <dl>
                  <Fact label="This workbench's fingerprint" mono testId="own-fingerprint">
                    {overview.fingerprint}
                  </Fact>
                </dl>
              )}
            </div>
            <Invite overview={overview} onChanged={again} onSignedOut={onSignedOut} />
            <Paste onPaired={again} onSignedOut={onSignedOut} />
          </Panel>
        </>
      )}
    </section>
  );
}
