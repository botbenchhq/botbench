import { useEffect, useState } from "react";
import { Check } from "lucide-react";
import { Button } from "@/ui/button";
import { Card } from "@/ui/card";
import { Tabs, TabsList, TabsTrigger } from "@/ui/tabs";
import { cn } from "@/ui/lib/utils";
import type { ChatTarget } from "../../api/client.ts";
import { agentName, CLAUDE, type CompareCard } from "../../app/chat.ts";
import { counted } from "../../app/format.ts";
import type { Turn } from "../../app/use-turn.ts";
import { useWide } from "../../app/wide.ts";
import { TARGET } from "./composer.tsx";
import { MarkdownView } from "../../components/markdown-view.tsx";
import { callLine, workedFor } from "../../components/tool-summary.ts";

const COLUMNS: Record<number, string> = { 2: "lg:grid-cols-2", 3: "lg:grid-cols-3", 4: "lg:grid-cols-4" };

/** An agent's two letters, for the mark beside its name: "Cc" for Claude Code, "Co" for Codex. */
const initials = (name: string): string => {
  const words = name.split(" ");
  return words.length > 1 ? `${words[0]![0]}${words[1]![0]!.toLowerCase()}` : name.slice(0, 2);
};

/**
 * The answers of a round several agents were asked, side by side: equal cards from 1024px, each with who answered, its
 * model, the answer whole, and how it ended; on a narrower screen one card at a time behind a switch that names each
 * agent. Each agent answered alone and has not read the others, and the screen says so. Nothing here ranks the answers
 * or says where they agree: that is a question for an agent, asked with the one action under the cards.
 */
export function CompareCards({ cards, turn }: { cards: CompareCard[]; turn: Turn }) {
  const wide = useWide();
  const [picked, setPicked] = useState(cards[0]!.attemptId);
  const shown = cards.some((card) => card.attemptId === picked) ? picked : cards[0]!.attemptId;
  const answered = cards.filter((card) => card.state !== "working").length;
  return (
    <section data-testid="compare" aria-label="The agents' answers" className="flex flex-col gap-3">
      <p className="text-meta text-muted-foreground">
        <span data-testid="compare-count" className="font-semibold text-foreground">{`${answered} of ${cards.length} answered.`}</span>{" "}
        {`${counted(cards.length, "separate opinion", "separate opinions")}. Each agent answered alone and has not read the others' answers to this message; they are not working together.`}
      </p>
      {!wide && (
        <Tabs value={String(shown)} onValueChange={(value) => setPicked(Number(value))}>
          <TabsList data-testid="compare-switch" aria-label="Whose answer to show" className="w-full group-data-horizontal/tabs:h-auto">
            {cards.map((card) => (
              <TabsTrigger key={card.attemptId} value={String(card.attemptId)} className="h-(--control) min-w-0 data-active:bg-card data-active:text-foreground">
                <span className="truncate">{agentName(card.agent)}</span>
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
      )}
      <div className={cn("grid gap-4", COLUMNS[cards.length] ?? "lg:grid-cols-2")}>
        {cards
          .filter((card) => wide || card.attemptId === shown)
          .map((card) => (
            <AnswerCard key={card.attemptId} card={card} turn={turn} />
          ))}
      </div>
    </section>
  );
}

function AnswerCard({ card, turn }: { card: CompareCard; turn: Turn }) {
  const name = agentName(card.agent);
  const took = card.from !== null && card.to !== null ? workedFor(card.from, card.to) : null;
  return (
    <Card data-testid="compare-card" data-agent={card.agent} className="min-w-0 gap-4 p-4 md:p-5">
      <header className="flex items-center gap-3">
        <span aria-hidden="true" className="flex size-8 shrink-0 items-center justify-center rounded-full bg-fill text-xs font-semibold">
          {initials(name)}
        </span>
        <div className="min-w-0">
          <h3 className="text-base font-semibold">{name}</h3>
          <p data-testid="compare-model" className="truncate text-meta text-muted-foreground" title={card.model ?? undefined}>
            {card.model === null ? `${name}'s default model` : <span data-ds-content="">{turn.nameOf(card.model)}</span>}
          </p>
        </div>
      </header>
      <div className="flex min-w-0 flex-1 flex-col gap-3 text-base">
        {card.texts.map((text, i) => (
          <MarkdownView key={i} text={text} testId="compare-answer" className="ds-message__body ds-stack ds-gap-sm" />
        ))}
        {card.errors.map((message, i) => (
          <p key={i} data-ds-content="" role="alert" className="rounded-lg border border-destructive/60 bg-destructive-subtle px-3 py-2 text-meta text-destructive">
            {message}
          </p>
        ))}
        {card.state === "failed" && (
          <p data-testid="compare-failed" role="alert" className="rounded-lg border border-destructive/60 bg-destructive-subtle px-3 py-2 text-meta text-destructive">
            {card.detail === null ? "Ended with an error." : "Ended with an error: "}
            {card.detail !== null && <span data-ds-content="">{card.detail}</span>}
          </p>
        )}
        {(card.state === "answered" || card.state === "stopped") && card.texts.length === 0 && card.errors.length === 0 && <p className="text-meta text-muted-foreground">{`${name} gave no answer.`}</p>}
      </div>
      <footer className="flex flex-col gap-2 border-t pt-3 text-meta text-muted-foreground">
        {card.state === "working" ? (
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span role="status">{`${name} is working.`}</span>
            <Button variant="outline" size="sm" onClick={() => turn.stop(card.attemptId)} className={TARGET}>
              {`Stop ${name}`}
            </Button>
          </div>
        ) : (
          <p data-testid="compare-ended" className="flex items-center gap-2">
            {card.state === "answered" && <Check aria-hidden="true" className="size-4 shrink-0" />}
            {card.state === "answered" ? `Answered${took === null ? "" : ` in ${took}`}.` : card.limited ? "Stopped here because the usage limit was reached." : card.state === "stopped" ? "Stopped before it finished." : "Did not finish."}
          </p>
        )}
        {card.calls.length > 0 && (
          <ul aria-label={`What ${name} did`} className="flex flex-wrap gap-1.5">
            {card.calls.map((call) => {
              const line = callLine(call.name, call.input, call.refused ? "refused" : call.failed ? "failed" : card.state === "working" ? "running" : "done");
              return (
                <li key={call.id} className="max-w-full truncate rounded-md border px-2 py-0.5">
                  {`${line.verb ?? line.tool} `}
                  <span data-ds-content="">{line.object}</span>
                  {line.note === "" ? "" : ` (${line.note})`}
                </li>
              );
            })}
          </ul>
        )}
      </footer>
    </Card>
  );
}

/**
 * Under a round several agents answered: the one action, which asks one agent, chosen here, to compare the answers.
 * Nothing is sent until an agent is pressed. While it is sent, the pressed agent's button is busy and keeps the focus,
 * and the others wait.
 */
export function CompareAction({ turn, onCompare }: { turn: Turn; onCompare: (to: ChatTarget) => void }) {
  const { agents, models, starting: busy } = turn;
  const offered = (agents.offer.known ?? []).filter((a) => a.problem === null);
  const request = models.request();
  const [pressed, setPressed] = useState<string | null>(null);
  const asking = busy ? pressed : null;
  // A send that ended leaves no button pressed: the next one may be the composer's.
  useEffect(() => {
    if (!busy) setPressed(null);
  }, [busy]);
  return (
    <section data-testid="compare-action" aria-labelledby="compare-action-heading" className="flex flex-col gap-3 rounded-xl bg-card p-4 md:p-5">
      <div className="min-w-0 flex-1">
        <h3 id="compare-action-heading" className="text-base font-semibold">
          Ask one to compare the answers
        </h3>
        <p className="text-meta text-muted-foreground">It is sent the question and each answer, and asked where they agree, where they differ and which it would act on.</p>
      </div>
      <div className="flex flex-wrap gap-2">
        {offered.map((a) => (
          <Button
            key={a.agent}
            variant="outline"
            aria-busy={asking === a.agent || undefined}
            disabled={(busy && asking !== a.agent) || (a.agent === CLAUDE && !request.ok)}
            onClick={() => {
              if (busy) return;
              setPressed(a.agent);
              onCompare(a.agent === CLAUDE ? { agent: a.agent, ...(request.ok && request.model !== undefined ? { model: request.model } : {}) } : { agent: a.agent, model: agents.choice.models[a.agent] ?? null });
            }}
          >
            {asking === a.agent ? "Sending" : `Ask ${a.name}`}
          </Button>
        ))}
      </div>
    </section>
  );
}
