import { useCallback, useContext, useEffect, useId, useState, type ReactNode } from "react";
import {
  ApiError,
  confirmInvite,
  confirmPairing,
  endPairing,
  getPeerFriction,
  getPeerKinds,
  getPeerMessages,
  getPeerOverview,
  makeInvite,
  pasteInvite,
  refusePairing,
  setPeerKind,
  withdrawInvite,
  type KindSettings,
  type MessageKind,
  type Pairing,
  type PairingFriction,
  type PastedInvite,
  type PeerMessage,
  type PeerOverview,
} from "../api/client.ts";
import { ConfirmAction } from "../components/confirm.tsx";
import { Alert } from "../components/header.tsx";
import { NewQuestion } from "../components/new-question.tsx";
import { RepoChoice } from "../components/repo-choice.tsx";
import { PeerChangesContext } from "./approvals.tsx";
import { PeerCardsContext } from "./peer-cards.tsx";
import { clock, counted, fullDate } from "./format.ts";
import { frictionWords, inviteLife, pairingCards, threadHref, threadsOf } from "./paired-words.ts";

/** The settings file's words for turning pairing on, as the server's own refusal says them (src/peers/service.ts). */
export const LISTEN_SETTING = '"peers": { "listen": { "address": "127.0.0.1", "port": 4790 } }';

const words = (what: string, err: unknown): string => (err instanceof ApiError ? `${what} ${err.message}` : `${what} Botbench could not be reached.`);

/** One fact of the pairing: its label, then its value, which is the other workbench's words when `theirs`. */
function Fact({ label, mono = false, theirs = false, testId, children }: { label: string; mono?: boolean; theirs?: boolean; testId?: string; children: ReactNode }) {
  return (
    <div className="ds-key-value__item">
      <dt className="ds-key-value__label">{label}</dt>
      <dd data-testid={testId} data-ds-content={theirs ? "" : undefined} className={mono ? "ds-key-value__value ds-key-value__value--mono" : "ds-key-value__value"}>
        {children}
      </dd>
    </div>
  );
}

/** The two fingerprints the owners compare, side by side in the same words on both screens. */
function Fingerprints({ peer, own }: { peer: { name: string; fingerprint: string }; own: string }) {
  return (
    <dl className="ds-key-value" data-testid="fingerprints">
      <Fact label={`${peer.name}'s fingerprint`} mono theirs testId="peer-fingerprint">
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
  const [busy, setBusy] = useState(false);
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
    setBusy(true);
    setProblem(null);
    makeInvite(repo)
      .then((invite) => {
        setMade(invite);
        setCopied("");
        onChanged();
      }, failed("No invite was made."))
      .finally(() => setBusy(false));
  };
  const withdraw = (inviteId: string): void => {
    setBusy(true);
    setProblem(null);
    withdrawInvite(inviteId)
      .then(() => {
        if (made?.id === inviteId) setMade(null);
        onChanged();
      }, failed("The invite was not withdrawn."))
      .finally(() => setBusy(false));
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
    <div className="ds-stack ds-gap-sm" data-testid="invite">
      <div className="ds-settings-row">
        <div className="ds-settings-row__text">
          <p className="ds-settings-row__label">Invite</p>
          <p className="ds-settings-row__description" id={`${id}-about`}>
            A one-line invite for the other workbench's owner to paste. Pass it to them yourself, in a message you trust. It works once, for 15 minutes.
          </p>
        </div>
      </div>
      {shown === null && <RepoChoice label="The repository to pair on" value={repo} onChange={setRepo} onSignedOut={onSignedOut} />}
      {shown === null && (
        <div className="ds-cluster">
          <button type="button" className="ds-button" aria-describedby={`${id}-about`} disabled={busy || repo === null} onClick={make}>
            Make an invite
          </button>
        </div>
      )}
      {shown !== null && life !== null && (
        <div className="ds-stack ds-gap-sm">
          <dl className="ds-key-value">
            <Fact label="To pair on" mono theirs testId="invite-repository">
              {shown.repository}
            </Fact>
          </dl>
          <div className="ds-field">
            <label className="ds-field__label" htmlFor={`${id}-line`}>
              Invite
            </label>
            <div className="ds-copy-field">
              <input data-testid="invite-line" className="ds-copy-field__value" id={`${id}-line`} type="text" readOnly value={life.open ? shown.invite : ""} />
              <button type="button" className="ds-button" aria-label="Copy the invite" disabled={!life.open} onClick={copy}>
                Copy
              </button>
              <p className="ds-copy-field__status" role="status">
                {copied}
              </p>
            </div>
          </div>
          <p data-testid="invite-life">{life.words}</p>
          <div className="ds-cluster">
            {life.open ? (
              <button type="button" className="ds-button" disabled={busy} onClick={() => withdraw(shown.id)}>
                Withdraw
              </button>
            ) : (
              <button type="button" className="ds-button" disabled={busy} onClick={() => setMade(null)}>
                Make a new invite
              </button>
            )}
          </div>
        </div>
      )}
      {others.map((open) => (
        <div key={open.id} className="ds-settings-row" data-testid="open-invite">
          <div className="ds-settings-row__text">
            <p className="ds-settings-row__label">An invite is open</p>
            <p className="ds-settings-row__description">{`Until ${clock(open.expiresAt)}. Botbench shows an invite only once, when it is made.`}</p>
            <dl className="ds-key-value">
              <Fact label="To pair on" mono theirs>
                {open.repository}
              </Fact>
            </dl>
          </div>
          <div className="ds-settings-row__control">
            <button type="button" className="ds-button" disabled={busy} onClick={() => withdraw(open.id)}>
              Withdraw
            </button>
          </div>
        </div>
      ))}
      {problem !== null && (
        <Alert tone="error" role="alert">
          {problem}
        </Alert>
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
    if (repo === null || text.trim() === "") return;
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
    <div className="ds-stack ds-gap-sm" data-testid="paste">
      <div className="ds-settings-row">
        <div className="ds-settings-row__text">
          <p className="ds-settings-row__label">Paste an invite</p>
          <p className="ds-settings-row__description">An invite another workbench's owner gave you. Botbench shows who it is from before anything is sent.</p>
        </div>
      </div>
      {pasted === null ? (
        <form
          className="ds-stack ds-gap-sm"
          onSubmit={(e) => {
            e.preventDefault();
            check();
          }}
        >
          <div className="ds-field">
            <label className="ds-field__label" htmlFor={`${id}-invite`}>
              Invite
            </label>
            <input id={`${id}-invite`} data-testid="paste-invite" type="text" autoComplete="off" autoCapitalize="none" spellCheck={false} className="ds-field__control" value={text} onChange={(e) => setText(e.currentTarget.value)} />
          </div>
          <RepoChoice label="Your copy of the repository" value={repo} onChange={setRepo} onSignedOut={onSignedOut} />
          <div className="ds-cluster">
            <button type="submit" className="ds-button" disabled={busy || repo === null || text.trim() === ""}>
              Check the invite
            </button>
          </div>
        </form>
      ) : (
        <div className="ds-stack ds-gap-sm" data-testid="pasted">
          <p>{`This invite is from ${pasted.name}'s workbench. Ask ${pasted.name} to read out the fingerprint their screen shows for their workbench, and check it is this one. Confirm only if it is.`}</p>
          <dl className="ds-key-value">
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
          <p>{`Confirm sends ${pasted.name}'s workbench this workbench's name, address and key, and nothing else. Nothing more is sent until ${pasted.name} confirms your fingerprint too.`}</p>
          <div className="ds-cluster ds-gap-sm">
            <button type="button" className="ds-button" aria-busy={busy || undefined} disabled={busy} onClick={confirm}>
              Confirm
            </button>
            <button type="button" className="ds-button" disabled={busy} onClick={() => setPasted(null)}>
              Cancel
            </button>
          </div>
        </div>
      )}
      {problem !== null && (
        <Alert tone="error" role="alert">
          {problem}
        </Alert>
      )}
    </div>
  );
}

const KIND_WORDS: Record<MessageKind, string> = { question: "questions", answer: "answers" };

/** The per-kind switches (ADR 0004 decision 11): what this workbench sends to the other, and what it takes from it. */
function Kinds({ pairing, onSignedOut }: { pairing: Pairing; onSignedOut: () => void }) {
  const id = useId();
  const changes = useContext(PeerChangesContext);
  const [kinds, setKinds] = useState<KindSettings | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
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
    // The switch moves at once, as the design system's switch does; a refusal puts it back and says so.
    const before = kinds;
    if (kinds !== null) setKinds({ ...kinds, [direction]: { ...kinds[direction], [kind]: allowed } });
    setBusy(true);
    setProblem(null);
    setPeerKind(pairing.id, direction, kind, allowed)
      .then(setKinds, (err: unknown) => {
        if (err instanceof ApiError && err.status === 401) return onSignedOut();
        setKinds(before);
        setProblem(words(`It was not changed, and is still ${before?.[direction][kind] ? "on" : "off"}.`, err));
      })
      .finally(() => setBusy(false));
  };
  const row = (direction: "send" | "receive", kind: MessageKind) => {
    const key = `${id}-${direction}-${kind}`;
    const label = direction === "send" ? `Send ${KIND_WORDS[kind]} to ${name}` : `Take ${KIND_WORDS[kind]} from ${name}`;
    const about =
      direction === "send"
        ? kinds !== null && !kinds.peerReceives[kind]
          ? `${name}'s workbench does not take ${KIND_WORDS[kind]} from you now, so none is sent whatever this says.`
          : `Off, Botbench sends no ${kind} to ${name}, also one you already pressed Send on that has not left yet.`
        : `Off, ${name}'s workbench is told, and Botbench refuses every ${kind} from it, whatever it sends.`;
    // An On/Off select, as Settings' other on-or-off rows are: the design system's switch draws its thumb at a corner
    // off its own radius scale, which the rendered check refuses (listed as a gap for the design system).
    return (
      <div key={key} className="ds-settings-row">
        <div className="ds-settings-row__text">
          <label className="ds-settings-row__label" htmlFor={key}>
            {label}
          </label>
          <p className="ds-settings-row__description" id={`${key}-about`}>
            {about}
          </p>
        </div>
        <div className="ds-settings-row__control">
          <div className="ds-select">
            <select data-testid={`kind-${direction}-${kind}`} className="ds-field__control ds-select__control" id={key} value={kinds === null ? "" : kinds[direction][kind] ? "on" : "off"} disabled={kinds === null || busy} aria-describedby={`${key}-about`} onChange={(e) => change(direction, kind, e.currentTarget.value === "on")}>
              {kinds === null && <option value="">Checking</option>}
              <option value="on">On</option>
              <option value="off">Off</option>
            </select>
          </div>
        </div>
      </div>
    );
  };
  return (
    <div className="ds-stack ds-gap-sm" data-testid="kinds">
      {row("send", "question")}
      {row("send", "answer")}
      {row("receive", "question")}
      {row("receive", "answer")}
      {problem !== null && (
        <Alert tone="error" role="alert">
          {problem}
        </Alert>
      )}
    </div>
  );
}

/** The pairing's conversations, newest first, each a link to its thread view, and the friction numbers. */
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
    <div className="ds-stack ds-gap-sm" data-testid="conversations">
      <h3 className="ds-settings-row__heading">Conversations</h3>
      {problem !== null && (
        <Alert tone="error" role="alert">
          {problem}
        </Alert>
      )}
      {messages !== null && threads.length === 0 && <p>No message yet. A question you send, or one from {pairing.peer.name}, starts a conversation here.</p>}
      {threads.length > 0 && (
        <ul className="ds-list" aria-label={`Conversations with ${pairing.peer.name}`} data-ds-content-label="">
          {threads.map((t) => (
            <li key={t.contextId} className="ds-list__row">
              <a href={threadHref(pairing.id, t.contextId)} className="ds-list__link" data-testid="thread-link">
                <span className="ds-list__body">
                  <span data-ds-content="" className="ds-list__primary">
                    {t.first}
                  </span>
                  <span className="ds-list__secondary">{`${counted(t.rows.length, "message", "messages")}${t.waiting ? " · Waits for you" : ""} · ${t.rows.at(-1)!.state}`}</span>
                </span>
              </a>
            </li>
          ))}
        </ul>
      )}
      {total !== null && (
        <div data-testid="friction" className="ds-stack ds-gap-xs">
          <p className="ds-settings-row__label">What these messages cost you</p>
          <p data-testid="friction-total">{`${total.answered} ${total.waited} ${total.asDrafted}`}</p>
          <p className="ds-settings-row__description">Counted from when a signed-in device first showed you each card to your choice on it. Each conversation's own numbers are on its screen.</p>
        </div>
      )}
    </div>
  );
}

/** The pairing in force, or on its way: its facts, the fingerprints, the owner's steps, and End pairing. */
function PairingView({ pairing, onChanged, onSignedOut }: { pairing: Pairing; onChanged: () => void; onSignedOut: () => void }) {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const name = pairing.peer.name;
  const step = (what: string, run: () => Promise<unknown>) => (): void => {
    setBusy(true);
    setProblem(null);
    run()
      .then(onChanged, (err: unknown) => {
        if (err instanceof ApiError && err.status === 401) return onSignedOut();
        setProblem(words(what, err));
      })
      .finally(() => setBusy(false));
  };
  return (
    <div className="ds-stack ds-gap-md" data-testid="pairing" data-state={pairing.state}>
      <p role="status" data-testid="pairing-words" data-ds-content="">
        {pairing.words}
      </p>
      <dl className="ds-key-value">
        <Fact label="Workbench" theirs testId="pairing-name">
          {name}
        </Fact>
        <Fact label="Repository" mono theirs testId="pairing-repository">
          {pairing.repository}
        </Fact>
        <Fact label={pairing.state === "in_force" ? "Paired since" : "Asked"}>{fullDate(pairing.createdAt)}</Fact>
      </dl>
      <Fingerprints peer={pairing.peer} own={pairing.ownFingerprint} />
      {pairing.state === "waiting_for_owner" && (
        <div className="ds-stack ds-gap-sm">
          <p>{`Ask ${name} to read out the fingerprint their screen shows for their workbench. Confirm only if it is the one above; ${name} checks yours the same way.`}</p>
          <div className="ds-cluster ds-gap-sm">
            <button type="button" className="ds-button" disabled={busy} onClick={step("Nothing was confirmed.", () => confirmPairing(pairing.id))}>
              Confirm
            </button>
            <button type="button" className="ds-button" disabled={busy} onClick={step("Nothing was refused.", () => refusePairing(pairing.id))}>
              Refuse
            </button>
          </div>
        </div>
      )}
      {pairing.state === "in_force" && <Kinds pairing={pairing} onSignedOut={onSignedOut} />}
      {pairing.state === "in_force" && <NewQuestion pairingId={pairing.id} peer={name} onSignedOut={onSignedOut} />}
      {pairing.state === "in_force" && <Conversations pairing={pairing} onSignedOut={onSignedOut} />}
      {problem !== null && (
        <Alert tone="error" role="alert">
          {problem}
        </Alert>
      )}
      <div className="ds-settings-row ds-settings-row--danger">
        <div className="ds-settings-row__text">
          <p className="ds-settings-row__label">End pairing</p>
          <p className="ds-settings-row__description">{`${name}'s workbench can no longer send you messages, and nothing more is sent to it.`}</p>
        </div>
        <div className="ds-settings-row__control">
          <ConfirmAction label="End pairing" title={`End pairing with ${name}?`} confirmLabel="End pairing" cancelLabel="Keep the pairing" disabled={busy} losing testId="end-pairing-dialog" onConfirm={step("The pairing did not end.", () => endPairing(pairing.id))}>
            <p>{`${name}'s workbench can no longer send you messages, and nothing more is sent to it. To work together again, one of you sends a new invite.`}</p>
          </ConfirmAction>
        </div>
      </div>
    </div>
  );
}

/**
 * Settings → Paired workbench (Peers P5, ADR 0004): pairing this workbench with one other person's, the pairing's
 * facts and switches, its conversations, and End pairing. With the listener for paired workbenches off in the settings
 * file, it says so and how to switch it on, and offers no control.
 */
export function PairedSettings({ onSignedOut }: { onSignedOut: () => void }) {
  const id = useId();
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
    <div className="ds-settings-row__group" role="group" aria-labelledby={`${id}-heading`} data-testid="paired-workbench">
      <h2 className="ds-settings-row__heading" id={`${id}-heading`}>
        Paired workbench
      </h2>
      <p className="ds-settings-row__description">
        Pair with one other person's workbench to send each other questions and answers about a repository you both work on. You approve every message before it leaves, and decide what to do with every message that arrives. A message never runs anything.
      </p>
      {problem !== null && (
        <Alert tone="error" role="alert">
          {problem}
        </Alert>
      )}
      {overview === null && problem === null && (
        <p role="status" className="ds-spinner">
          Reading the paired workbench.
        </p>
      )}
      {overview !== null && overview.listening === null && (
        <div className="ds-settings-row" data-testid="pairing-off">
          <div className="ds-settings-row__text">
            <p className="ds-settings-row__label">Pairing is off</p>
            <p className="ds-settings-row__description">
              {"To pair, add "}
              <code>{LISTEN_SETTING}</code>
              {" to Botbench's settings file, with this Mac's loopback address or an address on a private network the two of you share, then start Botbench again. Botbench does not start with a public address there."}
            </p>
          </div>
        </div>
      )}
      {overview !== null && overview.listening !== null && live !== null && <PairingView pairing={live} onChanged={again} onSignedOut={onSignedOut} />}
      {overview !== null && overview.listening !== null && live === null && (
        <>
          {ended !== null && (
            <p data-testid="pairing-ended">{`The pairing with ${ended.peer.name} ended${ended.endedAt === null ? "" : ` on ${fullDate(ended.endedAt)}`}. Its messages are refused, and nothing more is sent to it. To work together again, one of you sends a new invite.`}</p>
          )}
          <p className="ds-settings-row__description">{`The first version pairs with one workbench at a time, on one repository. Both workbenches' listeners must be on this Mac's loopback address or a private network; this one listens on ${overview.listening}.`}</p>
          {overview.fingerprint !== null && (
            <dl className="ds-key-value">
              <Fact label="This workbench's fingerprint" mono testId="own-fingerprint">
                {overview.fingerprint}
              </Fact>
            </dl>
          )}
          <Invite overview={overview} onChanged={again} onSignedOut={onSignedOut} />
          <Paste onPaired={again} onSignedOut={onSignedOut} />
        </>
      )}
    </div>
  );
}
