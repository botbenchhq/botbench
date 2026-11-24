import { useEffect, useRef } from "react";
import { Check } from "lucide-react";
import { Button } from "@/ui/button";
import { cn } from "@/ui/lib/utils";
import { arrive, tabTitle } from "../../app/arrival.ts";
import { agentList, agentName } from "../../app/chat.ts";
import { builderName, readName, type RepoPick } from "../../app/composer.ts";
import { FIRST_STEP } from "../../app/first-run.ts";
import { chooseIntent, intentOf, INTENTS, sendSentence, severalProblem, type Intent } from "../../app/new-work.ts";
import { claimNotice } from "../../app/peers.ts";
import type { Turn } from "../../app/use-turn.ts";
import { NextShell } from "../../shell/shell.tsx";
import { ApprovalDecision } from "../decision/decision-surface.tsx";
import { Chip, Composer, ConnectAgent, Disconnected, TARGET } from "./composer.tsx";

/**
 * New chat or task: what the owner came to do, chosen first and in words, beside the one composer. Four intents (ask a
 * question, start one task, plan a run, ask several agents), the context of what will be sent as chips (the
 * repository, the agent and its model, the mode: only those that apply), and one sentence that says exactly what Send
 * will start. Nothing starts before Send. Every other setting is one press away in the Add context sheet, as before.
 */
export function NewWork({ turn, onSignedOut }: { turn: Turn; onSignedOut: () => void }) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    document.title = tabTitle("New chat or task");
    arrive(heading.current);
  }, []);
  // With a keyboard the message box takes the focus once it can be typed in, as it always did on the home screen: on
  // arrival the heading has it (arrival.ts), and passes it on. Focus anywhere else is left where it is.
  useEffect(() => {
    if (!turn.fine || turn.builderDown) return;
    const frame = requestAnimationFrame(() => requestAnimationFrame(() => document.activeElement === heading.current && turn.promptRef.current?.focus()));
    return () => cancelAnimationFrame(frame);
  }, [turn.fine, turn.builderDown]);
  const { agents, repo, kind } = turn;
  const list = agentList({ known: agents.offer.known, checking: agents.offer.checking, failed: agents.offer.failed, inRepository: false });
  const intent = intentOf({ repo, kind, pick: agents.choice.pick });
  /** The repository last worked in on this visit: a chat takes it away, and a task or a run goes back to it. */
  const lastRepo = useRef<RepoPick | null>(null);
  if (repo.kind === "known" || repo.kind === "other") lastRepo.current = repo;
  const choose = (next: Intent): void => {
    const set = chooseIntent(next, { repo, pick: agents.choice.pick, lastRepo: lastRepo.current, tickable: list.several.tickable });
    if (set === null) return;
    turn.setRepo(set.repo);
    if (set.kind !== null) turn.setKind(set.kind);
    if (set.pick !== null) agents.pick(set.pick);
  };
  const inRepository = repo.kind === "known" || repo.kind === "other";
  const asked = agents.choice.pick.kind === "one" ? agents.choice.pick.agent : null;
  const said = sendSentence({
    intent,
    repo: inRepository ? turn.name : null,
    agent: intent === "task" ? builderName(turn.chosenBuilder) : asked === null ? "" : agentName(asked),
    asked: turn.askedCount,
    chatScope: asked === null ? null : (agents.offer.known?.find((o) => o.agent === asked)?.chat ?? null),
    reads: turn.readAttached ? readName(turn.readPick, turn.known) : null,
    run: {
      oneTask: turn.oneTask,
      codexBuilds: turn.chosenBuilder === "codex",
      plansUnasked: turn.mode === "full" || (turn.mode === "semi" && turn.issue.attached === null),
      pullRequest: turn.delivery === "pull_request",
      claim: claimNotice({ claimIssues: turn.repository.listed?.claimIssues === true, delivery: turn.delivery, attached: turn.issue.attached?.number ?? null, message: turn.prompt }),
    },
  });
  const several = severalProblem(list.several.tickable);
  const known = (agents.offer.known ?? []).filter((o) => o.problem === null || o.state !== "Not installed");

  return (
    <NextShell
      open={null}
      bar={
        <>
          <span className="shrink-0 text-sm font-semibold">New chat or task</span>
          {/* Each agent as its last check found it: a mark and its name, with its state in words when it cannot answer. */}
          <ul data-testid="agents-line" aria-label="Agents" className="ml-auto hidden min-w-0 flex-wrap items-center justify-end gap-x-4 gap-y-1 text-meta text-muted-foreground lg:flex">
            {known.map((o) => (
              <li key={o.agent} className="flex items-center gap-1.5">
                <span aria-hidden="true" className={cn("size-2 rounded-full", o.problem === null ? "bg-success" : "border border-edge")} />
                {o.problem === null ? o.name : `${o.name}: ${o.state.toLowerCase()}`}
              </li>
            ))}
          </ul>
        </>
      }
    >
      {!turn.connected && <Disconnected />}
      <div data-testid="screen" className="mx-auto flex w-full max-w-4xl min-w-0 flex-col gap-5 px-4 py-6 md:px-8 md:py-12">
        <div className="flex flex-col gap-1.5">
          <h1 ref={heading} tabIndex={-1} className="text-[1.5rem] leading-[1.875rem] font-bold tracking-tight outline-none md:text-title">
            What do you want to do?
          </h1>
          <p className="text-base text-muted-foreground">Choose one, then say it. Nothing starts before you press Send.</p>
          {turn.problem !== null && (
            <p data-testid="driver-state" className="text-meta text-muted-foreground">
              {turn.problem}
            </p>
          )}
        </div>

        <fieldset>
          <legend className="sr-only">What to do</legend>
          <div data-testid="intents" className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            {INTENTS.map((option) => {
              const off = option.intent === "several" && several !== null && intent !== "several";
              const on = intent === option.intent;
              return (
                <label key={option.intent} data-testid={`intent-${option.intent}`} className={cn("relative flex min-h-24 cursor-pointer flex-col gap-1.5 rounded-xl border bg-card p-3 has-focus-visible:ring-3 has-focus-visible:ring-ring/50 md:p-4", on ? "border-primary ring-1 ring-primary" : "hover:border-edge", off && "cursor-not-allowed opacity-60")}>
                  <span className="flex items-center gap-2 text-sm font-semibold">
                    <input type="radio" name="intent" value={option.intent} checked={on} disabled={off} onChange={() => choose(option.intent)} aria-describedby={`intent-${option.intent}-about`} className="peer sr-only" />
                    <span aria-hidden="true" className={cn("size-2 shrink-0 rounded-full border", on ? "border-primary bg-primary" : "border-edge")} />
                    <span className="min-w-0 flex-1">{option.name}</span>
                    {on && <Check aria-hidden="true" className="size-4 shrink-0 text-primary" />}
                  </span>
                  <span id={`intent-${option.intent}-about`} className="text-meta text-muted-foreground">
                    {off ? `${option.about} ${several}` : option.about}
                  </span>
                </label>
              );
            })}
          </div>
        </fieldset>

        {/* A first run: at most two plain lines, no tour and nothing over the screen. Gone once a chat, task or run is stored. */}
        {turn.welcome !== null && (
          <div data-testid="first-run" className="flex flex-col gap-1 text-meta text-muted-foreground">
            <p>{FIRST_STEP}</p>
            {turn.welcome.agent !== null && <p data-testid="first-run-agent">{turn.welcome.agent.connect ? <ConnectAgent first /> : turn.welcome.agent.words}</p>}
          </div>
        )}

        {/* A chat's request still waiting (asked on another device, or in a chat this device put away) is answered here. */}
        {turn.waitingHere.map((approval, at) => (
          <ApprovalDecision key={approval.id} approval={approval} on="chat" onSignedOut={onSignedOut} {...(turn.waitingHere.length > 1 ? { position: { at, of: turn.waitingHere.length, onNext: () => document.querySelector<HTMLElement>(`[data-approval-id="${turn.waitingHere[(at + 1) % turn.waitingHere.length]!.id}"]`)?.scrollIntoView({ block: "nearest" }) } } : {})} />
        ))}

        <Composer
          turn={turn}
          large
          chips={
            <>
              {turn.stopReason?.required === "repository" ? (
                <Button type="button" variant="outline" size="sm" aria-haspopup="dialog" aria-describedby="composer-reason" data-testid="repository-chip" onClick={() => turn.openSheet("repository")} className={cn("rounded-full", TARGET)}>
                  Choose a repository
                </Button>
              ) : (
                inRepository && <Chip name="Repository" value={turn.values.repository} theirs onClick={() => turn.openSheet("repository")} testId="repository-chip" />
              )}
              {turn.readAttached && <Chip name="Reads" value={turn.values.read} theirs onClick={() => turn.openSheet("read")} testId="read-chip" />}
              <Chip name="Agent and model" value={turn.chip.value} qualifier={turn.chip.qualifier} onClick={() => turn.openSheet("models")} testId="agent-chip" />
              {turn.rows.includes("mode") && <Chip name="Mode" value={turn.values.mode} warning={turn.run && turn.mode === "full"} onClick={() => turn.openSheet("mode")} testId="mode-chip" />}
            </>
          }
        >
          <p data-testid="composer-about" className="pt-1 text-base text-muted-foreground">
            <strong className="font-semibold text-foreground">{said.lead}</strong> {said.rest}
          </p>
        </Composer>
      </div>
    </NextShell>
  );
}
