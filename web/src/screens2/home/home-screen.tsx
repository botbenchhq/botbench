import { useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { Check, ChevronRight, Circle, CirclePause, Clock, ListChecks, SquareCheck, TriangleAlert, type LucideIcon } from "lucide-react";
import { buttonVariants } from "@/ui/button";
import { Card } from "@/ui/card";
import { Skeleton } from "@/ui/skeleton";
import { cn } from "@/ui/lib/utils";
import { ApiError, getHome, type Cause, type Home, type HomeItem } from "../../api/client.ts";
import { PeerChangesContext, WorkChangesContext } from "../../app/approvals.tsx";
import { arrive, tabTitle } from "../../app/arrival.ts";
import { agentName } from "../../app/chat.ts";
import { folderName } from "../../app/composer.ts";
import { counted, number, plural } from "../../app/format.ts";
import { PeerCardsContext } from "../../app/peer-cards.tsx";
import { PeerCardView } from "../../components/peer-card.tsx";
import { NextShell } from "../../shell/shell.tsx";
import { acceptedLine, CAUSE_WORDS, countedNames, endedLine, facts, failedLine, headline, hrefOf, lasted, need, ORDER_LINE, progressLine, subline, summarized, triesAgain, waitLine } from "./home-model.ts";

/*
 * Home, the queue (the approved boards V2Home, V2HomeMany, V2HomeFifty, V2MHome, V2Home768): the situation in one
 * line; everything that needs the owner, whole, in the server's order, the first lifted with the screen's one primary
 * action; then what is in progress, what waits and for what, and what was completed. Which group a run, a task or a
 * chat is in, why, in what order and how many there are is the server's (/api/home): this screen only lays it out.
 * A lower group is shown row by row while the server sent all of it, and as counted rows with its first two once
 * there are more, with a link to all of it in Work, so the screen reads the same at three items and at fifty.
 *
 * The layout follows the width the screen really has beside the navigation, not the window's (container queries):
 * under 42rem it is the phone's one column, from 42rem rows end in their buttons and the lower groups stand in two
 * columns, and from 64rem a summarized Home has three.
 */

const NEED_ICON: Partial<Record<Cause, LucideIcon>> = { approval: CirclePause, failure: TriangleAlert, plan: ListChecks, result: SquareCheck };

/** A title on one line: the full name is on hover and focus, and on the screen it leads to. */
function Title({ children, className }: { children: string; className?: string }) {
  return (
    <span data-ds-content="" title={children} className={cn("block truncate font-semibold text-foreground", className)}>
      {children}
    </span>
  );
}

/** A command or a path an agent wrote, set as code inside a sentence. */
const Code = ({ children }: { children: string }) => (
  <code data-ds-content="" className="break-all text-foreground">
    {children}
  </code>
);

/** How long a wait has lasted, as a time element. */
function Waited({ since, now, prefix, className }: { since: string; now: number; prefix?: string; className?: string }) {
  const { words, iso } = lasted(since, now);
  return (
    <span className={cn("shrink-0 text-meta font-normal whitespace-nowrap text-muted-foreground tabular-nums", className)}>
      {prefix}
      <time dateTime={iso}>{words}</time>
    </span>
  );
}

/** The first thing that needs the owner, lifted: what it is, and the screen's one primary action. */
function FirstNeed({ item, now }: { item: HomeItem; now: number }) {
  const n = need(item);
  const Icon = NEED_ICON[item.cause ?? "result"] ?? SquareCheck;
  return (
    <Card data-testid="first-need" className="gap-0 py-0">
      <div className="flex flex-col gap-4 p-5 @2xl:flex-row @2xl:items-center">
        <Icon aria-hidden="true" className="hidden size-5 shrink-0 text-attention @2xl:block" />
        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-2 text-meta font-semibold text-attention">
            <Icon aria-hidden="true" className="size-4 shrink-0 @2xl:hidden" />
            <span className="min-w-0 flex-1">{`${n.label} · ${n.lead}`}</span>
            {/* On a phone the wait is at the card's top and the action spans it. */}
            <Waited since={item.since} now={now} className="self-start @2xl:hidden" />
          </p>
          <h3 className="mt-1 text-base font-semibold">
            <Title className="whitespace-normal">{item.title}</Title>
          </h3>
          <p className="mt-1 line-clamp-3 text-base text-foreground">
            {n.words}
            {n.code !== null && <> <Code>{n.code}</Code></>}
          </p>
          <p data-ds-content="" className="mt-1 text-meta text-muted-foreground">
            {facts(item)}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-4 @2xl:justify-end">
          <Waited since={item.since} now={now} prefix="Waiting " className="@max-2xl:hidden" />
          <a href={hrefOf(item)} className={cn(buttonVariants(), "min-w-36 @max-2xl:flex-1")}>
            {n.action}
          </a>
        </div>
      </div>
    </Card>
  );
}

/** Every other thing that needs the owner: one row each, its action a link that takes the whole row under a finger. */
function NeedRow({ item, now }: { item: HomeItem; now: number }) {
  const n = need(item);
  const Icon = NEED_ICON[item.cause ?? "result"] ?? SquareCheck;
  return (
    <li className="relative flex items-center gap-3 px-4 py-3 @2xl:gap-4 @2xl:px-5">
      <Icon aria-hidden="true" className={cn("size-4 shrink-0", item.cause === "approval" ? "text-attention" : "text-muted-foreground")} />
      <div className="min-w-0 flex-1">
        <Title>{item.title}</Title>
        <p className="truncate text-meta text-muted-foreground">
          <span className="font-semibold text-foreground">{n.label}</span>
          {" · "}
          {n.words}
          {n.code !== null && <> <Code>{n.code}</Code></>}
          <span data-ds-content="">{` · ${facts(item)}`}</span>
        </p>
      </div>
      <Waited since={item.since} now={now} />
      {/*
        Where the screen is narrow the action is the row itself, drawn as a chevron; where it is wide, a button at the
        row's end. The button's pressed look moves it by a pixel, which would make the link the box its own stretched
        target is measured from and shrink that target under the finger: on the narrow row it does not move.
      */}
      <a href={hrefOf(item)} aria-label={`${n.action}: ${item.title}`} data-ds-content-label="" className={cn(buttonVariants({ variant: "outline" }), "@max-2xl:size-auto @max-2xl:border-0 @max-2xl:bg-transparent @max-2xl:p-0 @max-2xl:after:absolute @max-2xl:after:inset-0 @max-2xl:active:not-aria-[haspopup]:translate-none @2xl:min-w-36")}>
        <span className="@max-2xl:hidden">{n.action}</span>
        <ChevronRight aria-hidden="true" className="text-muted-foreground @2xl:hidden" />
      </a>
    </li>
  );
}

/** A lower group's heading: its name, its true count, and a quiet line or a link at its end. */
function GroupHead({ name, total, quiet, children }: { name: string; total: number; quiet?: boolean; children?: ReactNode }) {
  return (
    <div className="mb-3 flex min-h-8 items-center justify-between gap-4">
      <h2 className={cn("text-base font-semibold", quiet && "text-muted-foreground")}>
        {name} <span className="font-normal text-muted-foreground tabular-nums">{number(total)}</span>
      </h2>
      {children}
    </div>
  );
}

/** A quiet link to Work, where all of a group is. */
function ToWork({ href, children }: { href: string; children: string }) {
  return (
    <a href={href} className="inline-flex min-h-(--control-small) items-center gap-1 text-meta text-muted-foreground hover:text-foreground">
      {children}
      <ChevronRight aria-hidden="true" className="size-4" />
    </a>
  );
}

const quietNote = "text-meta text-muted-foreground";

/** One row of a lower group: a mark, the title as the link to it, a line under it, and something at its end. */
function Row({ item, icon: Icon, tone, line, end, whole = false }: { item: HomeItem; icon: LucideIcon; tone: string; line: ReactNode; end?: ReactNode; whole?: boolean }) {
  return (
    <li className="relative flex items-center gap-3 px-4 py-3">
      <Icon aria-hidden="true" className={cn("size-4 shrink-0", tone)} />
      <div className="min-w-0 flex-1">
        <a href={hrefOf(item)} className="block rounded-sm after:absolute after:inset-0">
          <Title className="font-medium">{item.title}</Title>
        </a>
        <p data-ds-content="" className={cn("text-meta text-muted-foreground", !whole && "truncate")}>
          {line}
        </p>
      </div>
      {end}
    </li>
  );
}

/** A counted row of a summarized group: numbers with what they count. */
function Counted({ icon: Icon, tone, children }: { icon?: LucideIcon; tone?: string; children: ReactNode }) {
  return (
    <li className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3 text-sm text-muted-foreground">
      {Icon !== undefined && <Icon aria-hidden="true" className={cn("size-4 shrink-0", tone)} />}
      {children}
    </li>
  );
}
const Num = ({ children }: { children: number }) => <span className="font-semibold text-foreground tabular-nums">{number(children)}</span>;

function InProgress({ group, now }: { group: Home["inProgress"]; now: number }) {
  const many = summarized(group);
  const rows = many ? group.items.slice(0, 2) : group.items;
  return (
    <section aria-label="In progress" data-testid="in-progress">
      <GroupHead name="In progress" total={group.total}>
        {many ? <ToWork href="#/work?state=in-progress">{`Show all ${number(group.total)} in Work`}</ToWork> : <span className={quietNote}>Nothing to do here</span>}
      </GroupHead>
      <Card className="gap-0 py-0">
        <ul className="divide-y">
          {many && (
            <>
              <Counted>
                {countedNames(group.agents, 3, agentName).map((one) => (
                  <span key={one.name}>
                    <Num>{one.count}</Num> {one.name}
                  </span>
                ))}
              </Counted>
              <Counted>
                {countedNames(group.repos, 2, folderName).map((one) => (
                  <span key={one.name} data-ds-content="">
                    <Num>{one.count}</Num> {one.name}
                  </span>
                ))}
              </Counted>
            </>
          )}
          {rows.map((item, i) => (
            <Row key={`${item.kind} ${item.id}`} item={item} icon={Circle} tone="text-primary" line={many && i === 0 ? `Longest · ${progressLine(item)}` : progressLine(item)} end={<Waited since={item.since} now={now} />} />
          ))}
        </ul>
      </Card>
    </section>
  );
}

function Waiting({ group, now }: { group: Home["waiting"]; now: number }) {
  const many = summarized(group);
  return (
    <section aria-label="Waiting" data-testid="waiting">
      <GroupHead name="Waiting" total={group.total}>
        {many ? <ToWork href="#/work?state=waiting">{`Show all ${number(group.total)} in Work`}</ToWork> : <span className={quietNote}>{plural(group.total, "Goes on by itself", "Each goes on by itself")}</span>}
      </GroupHead>
      <Card className="gap-0 py-0">
        <ul className="divide-y">
          {many
            ? group.causes.map((one) => (
                <Counted key={one.cause} icon={Clock}>
                  <span>
                    <span className="font-semibold text-foreground">{CAUSE_WORDS[one.cause]}</span> <Num>{one.count}</Num>
                  </span>
                  {triesAgain(one.retryAt, now) !== null && <span>{`The first ${triesAgain(one.retryAt, now)}`}</span>}
                </Counted>
              ))
            : group.items.map((item) => (
                <Row
                  key={`${item.kind} ${item.id}`}
                  item={item}
                  icon={Clock}
                  tone="text-muted-foreground"
                  line={
                    <>
                      <span className="font-semibold text-foreground">{CAUSE_WORDS[item.cause ?? "usage-limit"]}</span>
                      {` · ${waitLine(item, now)}`}
                    </>
                  }
                  whole
                />
              ))}
          {many && <li className="px-4 py-3 text-meta text-muted-foreground">Each goes on by itself. Nothing to do here.</li>}
        </ul>
      </Card>
    </section>
  );
}

function Completed({ home }: { home: Home }) {
  const group = home.completed;
  const many = summarized(group);
  const ended = endedLine(home.ended);
  const failed = failedLine(home.failed);
  const withYou = group.total - group.withoutYou;
  if (group.total === 0 && ended === null && failed === null) return null;
  return (
    <section aria-label="Completed" data-testid="completed">
      <GroupHead name="Completed" total={group.total} quiet>
        {group.total > 0 && <ToWork href="#/work?state=completed">{many ? `Show all ${number(group.total)} in Work` : "Show all in Work"}</ToWork>}
      </GroupHead>
      {group.total > 0 && (
        <Card className="gap-0 bg-transparent py-0">
          <ul className="divide-y">
            {many ? (
              <>
                {withYou > 0 && (
                  <Counted icon={Check} tone="text-success">
                    <span>
                      <Num>{withYou}</Num> accepted
                    </span>
                    {group.pullRequests > 0 && <span className="ml-auto">{`${counted(group.pullRequests, "pull request", "pull requests")} opened`}</span>}
                  </Counted>
                )}
                {group.withoutYou > 0 && (
                  <Counted icon={Check} tone="text-success">
                    <span>
                      <Num>{group.withoutYou}</Num> accepted without you
                    </span>
                    {withYou === 0 && group.pullRequests > 0 && <span className="ml-auto">{`${counted(group.pullRequests, "pull request", "pull requests")} opened`}</span>}
                  </Counted>
                )}
              </>
            ) : (
              group.items.map((item) => <Row key={`${item.kind} ${item.id}`} item={item} icon={Check} tone="text-success" line={acceptedLine(item)} />)
            )}
          </ul>
        </Card>
      )}
      {/* What ended any other way is never hidden: it is in Work, with its real state. */}
      <div className="mt-2 flex flex-col items-start">
        {ended !== null && <ToWork href="#/work?state=ended">{ended}</ToWork>}
        {failed !== null && <ToWork href="#/work?state=failed">{failed}</ToWork>}
      </div>
    </section>
  );
}

/** Home with nothing on it at all: what it will hold, and the one way to start something. */
function Nothing() {
  return (
    <Card data-testid="home-empty" className="items-start gap-3 p-6">
      <h2 className="text-heading font-semibold tracking-tight">No work yet</h2>
      <p className="max-w-prose text-base text-muted-foreground">A task or a run you start from Chat is listed here while it is in progress, and comes to the top when it needs you: an approval, a plan to read, a result to accept or reject.</p>
      <a href="#/turn" className={buttonVariants()}>
        New chat or task
      </a>
    </Card>
  );
}

export default function HomeScreen({ onSignedOut }: { onSignedOut: () => void }) {
  const [home, setHome] = useState<Home | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const work = useContext(WorkChangesContext);
  const peerChanges = useContext(PeerChangesContext);
  const { cards, problem: peerProblem } = useContext(PeerCardsContext);
  const reads = useRef(0);
  const heading = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    const read = ++reads.current;
    getHome().then(
      (found) => {
        if (read !== reads.current) return;
        setHome(found);
        setFailed(null);
        setNow(Date.now());
      },
      (err: unknown) => {
        if (err instanceof ApiError && err.status === 401) return onSignedOut();
        if (read !== reads.current) return;
        setFailed(err instanceof ApiError ? `Home could not be read. ${err.message}` : "Home could not be read: Botbench could not be reached.");
      },
    );
  }, [work, peerChanges, onSignedOut]);
  // The waits are said in whole minutes, so the screen counts them on twice a minute.
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);
  // The heading is drawn at once, named Home until the situation is read, so it takes focus on arrival as any screen's does.
  useEffect(() => {
    document.title = tabTitle("Home");
    arrive(heading.current);
  }, []);

  const messages = cards ?? [];
  const [first, ...rest] = home?.needsYou.items ?? [];
  const lower = home !== null && (summarized(home.inProgress) || summarized(home.waiting) || summarized(home.completed));
  const sub = home === null ? null : subline(home);
  const empty = home !== null && home.total === 0 && home.needsYou.total === 0 && messages.length === 0;
  return (
    <NextShell open={null} current="Home" bar={<span className="text-sm font-semibold">Home</span>}>
      <main className="@container mx-auto w-full max-w-[76rem] px-4 pt-6 pb-16 md:px-8">
        {failed !== null && (
          <p role="alert" className="mb-4 text-base text-destructive">
            {failed}
          </p>
        )}
        <h1 ref={heading} tabIndex={-1} data-testid={home === null ? undefined : "headline"} className="text-title font-semibold tracking-tight outline-none">
          {home === null || empty ? "Home" : headline(home)}
        </h1>
        {home === null ? (
          failed === null && (
            <div role="status" aria-label="Reading Home" className="mt-6">
              <Skeleton className="h-32 w-full" />
            </div>
          )
        ) : (
          <>
            {sub !== null && <p className="mt-1 text-meta text-muted-foreground">{sub}</p>}
            {empty ? (
              <div className="mt-6">
                <Nothing />
              </div>
            ) : (
              <>
                {(first !== undefined || messages.length > 0) && (
                  <section aria-label="Needs you" data-testid="needs-you" className="mt-6">
                    <div className="mb-3 flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
                      <h2 className="text-heading font-semibold tracking-tight">
                        Needs you <span className="font-normal text-muted-foreground tabular-nums">{number(home.needsYou.total)}</span>
                      </h2>
                      {home.needsYou.items.length > 1 && <p className={quietNote}>{ORDER_LINE}</p>}
                    </div>
                    <div className="flex flex-col gap-3">
                      {first !== undefined && <FirstNeed item={first} now={now} />}
                      {rest.length > 0 && (
                        <Card className="gap-0 py-0">
                          <ul className="divide-y">
                            {rest.map((item) => (
                              <NeedRow key={`${item.kind} ${item.id}`} item={item} now={now} />
                            ))}
                          </ul>
                        </Card>
                      )}
                      {/* The paired workbench's messages that wait for an answer, each on its own card, as before. */}
                      {messages.length > 0 && (
                        <ul aria-label="Messages with the paired workbench" data-testid="peer-cards" className="flex flex-col gap-3">
                          {messages.map((card) => (
                            <li key={`${card.direction} ${card.pairingId} ${card.messageId}`}>
                              <PeerCardView card={card} onSignedOut={onSignedOut} />
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  </section>
                )}
                {peerProblem !== null && (
                  <p role="alert" className="mt-4 text-base text-destructive">
                    {peerProblem}
                  </p>
                )}
                <div className={cn("mt-8 grid grid-cols-[minmax(0,1fr)] items-start gap-x-8 gap-y-8 @2xl:grid-cols-2", lower && "@5xl:grid-cols-3")}>
                  {(home.inProgress.total > 0 || home.waiting.total > 0) && (
                    <div className={cn("flex flex-col gap-8", lower && "@5xl:contents")}>
                      {home.inProgress.total > 0 && <InProgress group={home.inProgress} now={now} />}
                      {home.waiting.total > 0 && <Waiting group={home.waiting} now={now} />}
                    </div>
                  )}
                  <Completed home={home} />
                </div>
              </>
            )}
          </>
        )}
      </main>
    </NextShell>
  );
}
