import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ArrowDown, CirclePlus, Info, Plus } from "lucide-react";
import { Button } from "@/ui/button";
import { Separator } from "@/ui/separator";
import { Sheet, SheetContent, SheetTitle } from "@/ui/sheet";
import { cn } from "@/ui/lib/utils";
import type { Approval } from "../../api/client.ts";
import { arrive, tabTitle } from "../../app/arrival.ts";
import { agentName, CLAUDE, compareRound } from "../../app/chat.ts";
import { readName } from "../../app/composer.ts";
import { clock } from "../../app/format.ts";
import { MAKE_RUN } from "../../app/run-source.ts";
import { useFollow, type Turn } from "../../app/use-turn.ts";
import { useThreePanes } from "../../app/wide.ts";
import { visible } from "../../components/approval-words.ts";
import { jumpCount } from "../../components/follow.ts";
import { MakeRunDialog } from "../../components/make-run.tsx";
import { approvalWords } from "../../components/tool-summary.ts";
import { Transcript } from "../../components/transcript.tsx";
import { NextShell } from "../../shell/shell.tsx";
import { ApprovalDecision, DecisionWhat } from "../decision/decision-surface.tsx";
import { CompareAction, CompareCards } from "./compare.tsx";
import { Composer, TARGET } from "./composer.tsx";

/** The first line of the chat's first message, as its name on the screen and in the navigation. */
function titleOf(turn: Turn): string {
  const first = turn.chat.events.find((event) => event.payload.type === "user_prompt");
  const text = first !== undefined && first.payload.type === "user_prompt" ? first.payload.text.trim().split("\n")[0]!.trim() : "";
  return text === "" ? "Chat" : text;
}

/**
 * A request standing in the transcript where it was asked: that Claude Code asks and is paused, what it asks for, and
 * its own reason. The answer is given on the decision surface (the pane at the right from 1280px, above the message box under it).
 */
function Asked({ approval, onShow }: { approval: Approval; onShow: () => void }) {
  const said = approvalWords(approval.tool, approval.command);
  const question = approval.question !== null;
  return (
    <div data-testid="approval-asked" data-approval-id={approval.id} className="flex flex-col gap-3 rounded-xl border bg-card p-4">
      <div className="flex items-start gap-3">
        <CirclePlus aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-attention" />
        <div className="min-w-0">
          <p className="text-base font-semibold">{question ? "Claude Code has a question" : approval.tool === "Bash" ? "Claude Code asks to run a command" : `Claude Code asks to use ${approval.tool}`}</p>
          <p className="text-meta text-muted-foreground">{`Asked at ${clock(approval.createdAt)}. It is paused until you ${question ? "answer" : "allow or decline"}.`}</p>
        </div>
      </div>
      {!question && <DecisionWhat ours={said.line !== null}>{said.line ?? visible(approval.command)}</DecisionWhat>}
      {approval.reason !== null && (
        <p className="text-sm">
          <span className="text-muted-foreground">{"Claude Code's reason, in its own words: "}</span>
          <span data-ds-content="">{visible(approval.reason)}</span>
        </p>
      )}
      <div>
        <Button variant="outline" size="sm" onClick={onShow} className={TARGET}>
          {question ? "Go to the question" : "Go to the decision"}
        </Button>
      </div>
    </div>
  );
}

/** What the product knows of this chat: who answers and with which model, and the repository it reads, if any. */
function ChatFacts({ turn }: { turn: Turn }) {
  const last = turn.conversation.at(-1);
  const asked = [...new Set(turn.conversation.map((id) => turn.infos.get(id)?.agent).filter((agent): agent is string => agent !== undefined))];
  const rows = [
    // Who answered, once Botbench has said: nothing is guessed before.
    ...(asked.length === 0 ? [] : [{ name: asked.length > 1 ? "Agents" : "Agent", value: asked.map(agentName).join(", "), theirs: false }]),
    { name: "Next message", value: `${turn.chip.value}${turn.chip.qualifier === null ? "" : ` ${turn.chip.qualifier}`}`, theirs: false },
    ...(turn.readAttached ? [{ name: "Next message reads", value: readName(turn.readPick, turn.known), theirs: true }] : []),
    ...(last === undefined ? [] : [{ name: "Messages", value: String(turn.chat.events.filter((event) => event.payload.type === "user_prompt").length), theirs: false }]),
  ];
  return (
    <section aria-labelledby="chat-facts-heading">
      <h2 id="chat-facts-heading" className="mb-1 text-meta font-semibold text-muted-foreground">
        This chat
      </h2>
      <dl data-testid="chat-facts" className="flex flex-col text-sm">
        {rows.map((row, i) => (
          <div key={row.name}>
            {i > 0 && <Separator />}
            <div className="flex justify-between gap-4 py-2.5">
              <dt className="shrink-0 text-muted-foreground">{row.name}</dt>
              <dd data-ds-content={row.theirs ? "" : undefined} className="min-w-0 text-right break-words">
                {row.value}
              </dd>
            </div>
          </div>
        ))}
      </dl>
      <p className="mt-2 text-meta text-muted-foreground">Botbench keeps every chat, and Work lists them.</p>
    </section>
  );
}

/**
 * A chat: its transcript, each request standing where it was asked, the answers of several agents side by side, and
 * the message box. The decision on a waiting request is in the pane at the right from 1280px, and above the message
 * box on a narrower screen, where it stays in reach while the transcript scrolls. Everything it does is `useTurn`'s.
 */
export function ChatView({ turn, onSignedOut }: { turn: Turn; onSignedOut: () => void }) {
  const panes = useThreePanes();
  const follow = useFollow();
  // Whoever sends wants to see the answer: the composer's Send goes to the newest row through this.
  turn.jumpRef.current = follow.jumpToLatest;
  const heading = useRef<HTMLHeadingElement>(null);
  const decision = useRef<HTMLDivElement>(null);
  const [factsOpen, setFactsOpen] = useState(false);
  const [at, setAt] = useState(0);
  useEffect(() => {
    document.title = tabTitle("Chat");
    arrive(heading.current);
    // A chat opens on its newest row, and follows from there.
    follow.jumpToLatest();
  }, []);
  const { waitingHere, working, running, stopping, infos, chat, conversation } = turn;
  const title = titleOf(turn);
  const current = waitingHere[Math.min(at, waitingHere.length - 1)];

  // The newest round, when several agents were asked: its answers stand side by side under the question, not one after another.
  const round = useMemo(() => compareRound(turn.shown, infos, conversation), [turn.shown, infos, conversation]);
  const events = useMemo(() => {
    if (round === null) return chat.events;
    const inCards = new Set(round.cards.map((card) => card.attemptId));
    return chat.events.filter((event) => event.id === -round.roundId || !inCards.has(event.attemptId));
  }, [chat.events, round]);
  const placed = useMemo(() => new Set(events.flatMap((event) => (event.payload.type === "permission_request" ? [`${event.attemptId}:${event.payload.toolCallId}`] : []))), [events]);

  /** Counts the times "Go to the decision" was pressed: the surface's heading takes the focus each time, once it shows that request. */
  const [shownFor, setShownFor] = useState(0);
  const show = useCallback(
    (id: number) => {
      setAt(Math.max(0, waitingHere.findIndex((approval) => approval.id === id)));
      setShownFor((n) => n + 1);
    },
    [waitingHere],
  );
  useEffect(() => {
    if (shownFor === 0) return;
    decision.current?.scrollIntoView({ block: "nearest" });
    decision.current?.querySelector<HTMLElement>("h2")?.focus();
  }, [shownFor]);
  const asking = useCallback(
    (attemptId: number, toolCallId: string): ReactNode => {
      const approval = waitingHere.find((a) => a.attemptId === attemptId && a.toolCallId === toolCallId);
      return approval === undefined ? null : <Asked approval={approval} onShow={() => show(approval.id)} />;
    },
    [waitingHere, show],
  );
  const one = working.length <= 1 && (round === null || !round.cards.some((card) => card.state === "working"));
  const worker = agentName(infos.get(working[0]?.attemptId ?? 0)?.agent ?? (turn.askedCount === 1 && turn.targets.ok ? turn.targets.targets[0]!.agent : CLAUDE));
  const status = !running || !one ? null : waitingHere.some((a) => working.some((w) => w.attemptId === a.attemptId)) && !stopping ? `${agentName(CLAUDE)} is waiting for your answer.` : stopping ? `Stopping ${worker}.` : `${worker} is working.`;

  const surface = current !== undefined && (
    <div ref={decision} data-testid="chat-decision">
      <ApprovalDecision key={current.id} approval={current} on="chat" onSignedOut={onSignedOut} {...(waitingHere.length > 1 ? { position: { at: Math.min(at, waitingHere.length - 1), of: waitingHere.length, onNext: () => setAt((Math.min(at, waitingHere.length - 1) + 1) % waitingHere.length) } } : {})} className={panes ? undefined : "max-h-[55svh] overflow-y-auto"} />
    </div>
  );

  return (
    <NextShell
      current="Chat"
      showing={waitingHere.map((approval) => approval.id)}
      open={{ title, href: "#/turn" }}
      bar={
        <>
          <nav aria-label="Where you are" className="flex min-w-0 items-center gap-2 text-sm">
            <span className="shrink-0 text-muted-foreground">Chat</span>
            <span aria-hidden="true" className="text-muted-foreground">
              /
            </span>
            <span data-ds-content="" className="truncate font-semibold" title={title}>
              {title}
            </span>
          </nav>
          <div className="ml-auto flex shrink-0 items-center gap-1">
            {!panes && (
              <Button variant="ghost" size="icon" aria-label="This chat" aria-haspopup="dialog" onClick={() => setFactsOpen(true)} className="size-(--control)">
                <Info aria-hidden="true" />
              </Button>
            )}
            <Button variant="ghost" size="icon" aria-label="New chat" onClick={() => (window.location.hash = "#/new")} className="size-(--control)">
              <Plus aria-hidden="true" />
            </Button>
          </div>
        </>
      }
      aside={
        panes && (
          <aside aria-label="This chat" className="flex flex-col gap-6 border-l bg-pane px-6 py-6 xl:min-h-svh">
            {surface}
            <ChatFacts turn={turn} />
          </aside>
        )
      }
    >
      <main data-testid="screen" className="flex h-[calc(100svh-3.5rem-1px)] min-h-0 min-w-0 flex-col max-md:h-[calc(100svh-7rem-2px)]">
        <div ref={follow.scrollerRef} role="region" aria-label="Transcript" tabIndex={0} className="min-h-0 flex-1 overflow-y-auto outline-none">
          <div ref={follow.setLog} className={cn("mx-auto flex w-full min-w-0 flex-col gap-4 px-4 py-6 md:px-8", round === null ? "max-w-3xl" : "max-w-6xl")}>
            <header className="flex flex-col gap-1">
              <h1 ref={heading} tabIndex={-1} data-ds-content="" className="line-clamp-3 text-[1.5rem] leading-[1.875rem] font-bold tracking-tight text-balance outline-none">
                {title}
              </h1>
              {turn.problem !== null && (
                <p data-testid="driver-state" className="text-meta text-muted-foreground">
                  {turn.problem}
                </p>
              )}
            </header>
            <Transcript
              events={events}
              asking={asking}
              working={status}
              modelName={turn.nameOf}
              modelDiffers={turn.differs}
              who={chat.who}
              after={
                // A request whose place in the transcript has not arrived yet still stands here.
                waitingHere
                  .filter((a) => !placed.has(`${a.attemptId}:${a.toolCallId}`))
                  .map((a) => (
                    <li key={`asked-${a.id}`}>
                      <Asked approval={a} onShow={() => show(a.id)} />
                    </li>
                  ))
              }
            />
            {round !== null && <CompareCards cards={round.cards} turn={turn} />}
            {chat.compare !== null && !running && <CompareAction turn={turn} onCompare={(to) => turn.sendChat("", [to], chat.compare!.roundId)} />}
            {/* The owner's feedback in this chat, made into a run: a note of their own, or one of their messages. Offered
                while a reply still runs too: only the owner's words go with it, and those are stored. */}
            <div data-testid="make-run-chat">
              <Button variant="ghost" size="sm" aria-haspopup="dialog" onClick={() => turn.setMakingRun(true)} className={cn(TARGET, "text-muted-foreground")}>
                {MAKE_RUN}
              </Button>
            </div>
          </div>
        </div>

        <div className="relative flex h-0 justify-center" hidden={follow.newCount === 0}>
          <Button variant="outline" size="sm" {...follow.jumpButtonProps} className="absolute bottom-2 z-10 h-(--control) rounded-full bg-card">
            <ArrowDown aria-hidden="true" />
            <span>{jumpCount(follow.newCount)}</span> Jump to latest
          </Button>
        </div>

        <div className={cn("mx-auto flex w-full min-w-0 flex-col gap-3 px-4 pb-4 md:px-8", round === null ? "max-w-3xl" : "max-w-6xl")}>
          {!panes && surface}
          <Composer turn={turn} tight={!panes && current !== undefined} />
        </div>

        {/* The repository the chat reads here, if any, is the one the composer opens on; the owner can choose another. */}
        {turn.makingRun && <MakeRunDialog attemptId={conversation[0]!} {...(turn.readPick.kind !== "none" && turn.reading.status.state === "usable" ? { repo: turn.readPick.path.trim() } : {})} onClose={() => turn.setMakingRun(false)} onSignedOut={onSignedOut} />}
        {!panes && (
          <Sheet open={factsOpen} onOpenChange={setFactsOpen}>
            <SheetContent side="bottom" data-testid="chat-facts-sheet" className="rounded-t-xl p-5">
              <SheetTitle className="sr-only">This chat</SheetTitle>
              <ChatFacts turn={turn} />
            </SheetContent>
          </Sheet>
        )}
      </main>
    </NextShell>
  );
}
