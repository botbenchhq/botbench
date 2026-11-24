import { useState, type ReactNode } from "react";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/ui/alert-dialog";
import { Mic, Plus } from "lucide-react";
import { Button } from "@/ui/button";
import { cn } from "@/ui/lib/utils";
import { agentName, CLAUDE, sendWords } from "../../app/chat.ts";
import { modeLine, READ_ABOUT, readName, SEND_KEY_HINT } from "../../app/composer.ts";
import { AGENTS_ADDRESS, CONNECT } from "../../app/first-run.ts";
import { ago } from "../../app/format.ts";
import type { Turn } from "../../app/use-turn.ts";

/** The one link to connect an agent, at the end of a sentence that says the agent cannot be used. */
export function ConnectAgent({ first = false }: { first?: boolean }) {
  return (
    <>
      {`${first ? "" : " "}${CONNECT.before}`}
      <a href={AGENTS_ADDRESS} className="text-primary underline underline-offset-4">
        {CONNECT.link}
      </a>
      {CONNECT.after}
    </>
  );
}

const LINE = "text-meta text-muted-foreground";

/** A control drawn 32px high with a mouse still has a 40px pointer target (44px under a finger, where it is drawn that high). */
export const TARGET = "relative h-(--control-small) after:absolute after:inset-x-0 after:top-1/2 after:h-(--control) after:-translate-y-1/2 after:content-['']";

/** A value of what will be sent, as a chip that opens its setting in the Add context sheet. Its name says which setting it is. */
export function Chip({ name, value, qualifier, warning = false, theirs = false, compact = false, onClick, testId }: { /** Only the value is drawn; the name is still the button's. */ compact?: boolean; name: string; value: string; qualifier?: string | null; warning?: boolean; /** The value is somebody else's words (a repository's name). */ theirs?: boolean; onClick: () => void; testId?: string }) {
  return (
    <Button type="button" variant="secondary" size="sm" aria-haspopup="dialog" aria-label={`${name}: ${value}${qualifier == null ? "" : ` ${qualifier}`}`} data-ds-content-label={theirs ? "" : undefined} data-testid={testId} onClick={onClick} className={cn("max-w-full min-w-0 shrink gap-1.5 rounded-full px-3 font-normal", TARGET)}>
      {!compact && <span className="shrink-0 text-muted-foreground">{name}</span>}
      <span data-testid="chip-value" data-ds-content={theirs ? "" : undefined} className={cn("min-w-0 truncate font-medium", warning && "text-attention")}>
        {value}
      </span>
      {/* In the message box's own row on a phone there is room for the model alone; the button's name still says both. */}
      {qualifier != null && <span className={cn("shrink-0 text-muted-foreground", compact && "hidden sm:inline")}>{qualifier}</span>}
    </Button>
  );
}

/**
 * The composer: the message box, Add context, what is asked (the agent and its model, or the repository still to
 * choose), dictation where the Mac can transcribe, and Send, which is Stop while a chat's reply runs. Under it, every
 * line the composer always said: why Send cannot send, the mode a run starts in, who is asked, what the chat reads,
 * what other workbenches have in flight, and which key sends. Enter sends where there is a keyboard; Shift with Enter
 * starts a new line. `large`: New chat or task, where the box is the screen; `chips` stand in it then, and `children`
 * (the sentence that says what Send will start) follow the lines.
 */
export function Composer({ turn, large = false, tight = false, chips, children }: { turn: Turn; large?: boolean; /** A decision stands above the box on a small screen: the box grows less, so Send stays on it. */ tight?: boolean; chips?: ReactNode; children?: ReactNode }) {
  const { stopReason, showStop, working, infos, dictation, error, chatting, askedCount, starting, stopping, builderDown } = turn;
  const several = sendWords(askedCount);
  const mode = turn.run ? modeLine(turn.started) : null;
  return (
    <div className="flex flex-col gap-2">
      <form data-testid="composer" onSubmit={turn.submit} aria-busy={showStop || undefined} noValidate className={cn("flex flex-col rounded-xl border border-edge/60 bg-card focus-within:border-ring", large ? "gap-3 p-4" : "gap-1 p-2")}>
        {large && (
          <label htmlFor="prompt" className="text-sm font-semibold">
            {turn.label}
          </label>
        )}
        <textarea
          id="prompt"
          name="prompt"
          ref={turn.promptRef}
          rows={large ? 5 : 1}
          aria-label={turn.label}
          placeholder={turn.label}
          value={turn.prompt}
          disabled={builderDown}
          onChange={(event) => turn.setPrompt(event.target.value)}
          onKeyDown={turn.onKeyDown}
          aria-describedby={turn.boxDescribedBy}
          className={cn("field-sizing-content w-full resize-none", tight ? "max-h-[16svh]" : "max-h-[40svh]", " bg-transparent px-2 py-2 text-base outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-60", large ? "min-h-32" : "min-h-(--control)")}
        />
        {chips !== undefined && (
          <div data-testid="composer-chips" className="flex flex-wrap gap-2">
            {chips}
          </div>
        )}
        <div className={cn("flex items-center gap-2", large && "border-t pt-3")}>
          <Button type="button" variant={large ? "secondary" : "ghost"} size={large ? "default" : "icon"} aria-label={large ? undefined : "Add context"} aria-haspopup="dialog" onClick={() => turn.openSheet("rows")} className={large ? "" : "size-(--control)"}>
            <Plus aria-hidden="true" />
            {large && "Add context"}
          </Button>
          {!large &&
            (stopReason?.required === "repository" ? (
              <Button type="button" variant="outline" size="sm" aria-haspopup="dialog" aria-describedby="composer-reason" onClick={() => turn.openSheet("repository")} className={TARGET}>
                <span className="sr-only">Choose a </span>Repository
              </Button>
            ) : (
              <Chip name="Agent and model" compact value={turn.chip.value} qualifier={turn.chip.qualifier} onClick={() => turn.openSheet("models")} testId="agent-chip" />
            ))}
          <div className="ml-auto flex shrink-0 items-center gap-2">
            {turn.keysHint && (
              <p id="composer-keys" data-testid="composer-keys" className={cn(LINE, "hidden text-right md:block")}>
                {SEND_KEY_HINT}
              </p>
            )}
            {turn.canDictate && (
              <Button
                type="button"
                variant="ghost"
                size="icon"
                onClick={turn.toggleDictation}
                aria-label="Dictate"
                aria-pressed={dictation.kind === "listening"}
                aria-busy={dictation.kind === "transcribing" || undefined}
                aria-describedby={dictation.kind === "error" ? "dictation-error" : dictation.kind === "idle" ? undefined : "dictation-status"}
                className={cn("size-(--control)", dictation.kind === "listening" && "bg-fill text-primary")}
              >
                <Mic aria-hidden="true" />
              </Button>
            )}
            {showStop ? (
              <Button type="button" variant="outline" aria-busy={stopping || undefined} onClick={() => turn.stop()} aria-describedby="composer-reason">
                {stopping ? "Stopping" : "Stop"}
              </Button>
            ) : (
              <Button type="submit" aria-busy={starting || undefined} disabled={stopReason !== null && !starting} aria-describedby={turn.describedBy} {...(chatting && askedCount > 1 && !starting ? { "aria-label": several.label } : {})} className="min-w-20">
                {starting ? (chatting ? "Sending" : "Starting") : "Send"}
              </Button>
            )}
          </div>
        </div>
      </form>
      <div data-testid="composer-lines" className="flex flex-col gap-1 px-1 empty:hidden">
        {showStop ? (
          <p id="composer-reason" className={LINE}>
            {working.length > 1 ? "The agents are working. You can send again when each has answered or stopped." : `${agentName(infos.get(working[0]?.attemptId ?? 0)?.agent ?? CLAUDE)} is working. You can send again when it has answered.`}
          </p>
        ) : (
          stopReason !== null && (
            <p id="composer-reason" data-testid={builderDown ? "driver-problem" : "composer-reason"} className={LINE}>
              {stopReason.reason}
              {stopReason.connect && <ConnectAgent />}
            </p>
          )
        )}
        {!showStop && mode !== null && (
          <p data-testid="composer-mode" className={LINE}>
            {mode}
          </p>
        )}
        {!showStop && stopReason === null && chatting && several.line !== null && (
          <p data-testid="asked-line" className={LINE}>
            {several.line}
          </p>
        )}
        {turn.sourceLine !== null && (
          <p data-testid="run-source-line" className={LINE}>
            {turn.sourceLine}
          </p>
        )}
        {!showStop && turn.readAttached && (
          <p data-testid="read-line" className={LINE}>
            {`For the chat to read: ${readName(turn.readPick, turn.known)}. ${READ_ABOUT}`}
          </p>
        )}
        {turn.peerWarnings.map((line) => (
          <p key={line} data-testid="peer-warning" className={LINE}>
            {line}
          </p>
        ))}
        {turn.offeredClaims.map((claim) => (
          <TakeOver key={claim.branch} claim={claim} taken={turn.takeOver.includes(claim.branch)} disabled={starting} onTake={() => turn.setTakenOver((have) => [...have, claim.branch])} />
        ))}
        {turn.builder.state === "problem" && (
          // Asks the agent again, for real, once the owner has fixed what the reason names.
          <div>
            <Button type="button" variant="outline" size="sm" onClick={turn.checkDriver} className={TARGET}>
              Check again
            </Button>
          </div>
        )}
        {turn.keysHint && <p className={cn(LINE, "md:hidden")}>{SEND_KEY_HINT}</p>}
        {error !== null && (
          <p id="composer-error" role="alert" className="text-meta text-destructive">
            {error}
          </p>
        )}
        {(dictation.kind === "listening" || dictation.kind === "transcribing") && (
          <p id="dictation-status" role="status" className={LINE}>
            {dictation.kind === "listening" ? "Listening. Press Dictate again when you have finished." : "Transcribing"}
          </p>
        )}
        {dictation.kind === "error" && (
          <p id="dictation-error" role="alert" className="text-meta text-destructive">
            {dictation.message}
          </p>
        )}
        {children}
      </div>
    </div>
  );
}

/** Another workbench's old claim on the run's issue: taken over only after its statement is confirmed, and the run then goes ahead. */
function TakeOver({ claim, taken, disabled, onTake }: { claim: Turn["offeredClaims"][number]; taken: boolean; disabled: boolean; onTake: () => void }) {
  const [open, setOpen] = useState(false);
  if (taken)
    return (
      <p data-testid="peer-taken-over" className={LINE}>
        <span data-ds-content="">{claim.workbench}</span>
        {`'s claim on issue #${claim.issue} is taken over: your run goes ahead, and Botbench leaves its branches as they are.`}
      </p>
    );
  return (
    <div>
      <Button type="button" variant="outline" size="sm" aria-haspopup="dialog" aria-label={`Take over ${claim.workbench}'s claim on issue #${claim.issue}`} data-ds-content-label="" disabled={disabled} onClick={() => setOpen(true)} className={TARGET}>
        Take over
      </Button>
      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogContent data-testid="take-over-dialog">
          <AlertDialogHeader>
            <AlertDialogTitle className="text-heading font-semibold">
              {"Take over "}
              <span data-ds-content="">{claim.workbench}</span>
              {"'s claim?"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              <span data-ds-content="">{claim.workbench}</span>
              {` started on issue #${claim.issue} ${ago(claim.startedAt, Date.now())} and has opened no pull request. Your run goes ahead as if `}
              <span data-ds-content="">{claim.workbench}</span>
              {" had not started. Botbench leaves its branches on the remote as they are, and pushes only a branch of your own. If that workbench is still working on the issue, the two of you may do the same work twice."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>
              {"Leave "}
              <span data-ds-content="">{claim.workbench}</span>
              {"'s claim"}
            </AlertDialogCancel>
            <AlertDialogAction variant="outline" onClick={onTake}>
              Take over
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
