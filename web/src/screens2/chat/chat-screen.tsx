import { useEffect, useRef, useState } from "react";
import { ApiError, getChat, type RunSourceRef } from "../../api/client.ts";
import { arrive, tabTitle } from "../../app/arrival.ts";
import type { Kind } from "../../app/composer.ts";
import { saveConversation, useTurn } from "../../app/use-turn.ts";
import { NextShell } from "../../shell/shell.tsx";
import { ChatView } from "./chat-view.tsx";
import { ContextSheet } from "./context-sheet.tsx";
import { NewWork } from "./new-work.tsx";

/**
 * Chat, and New chat or task: one screen with one composer, as the home screen always was. With no chat on this device
 * (or at New chat or task's own address) it is the four intents beside the composer; once a message is sent it is the
 * chat. Both are drawn from the same state (app/use-turn.ts), so what was typed and chosen stays across the two.
 */
export default function ChatScreen({ start, proposal, from, fresh, onSignedOut }: { start: Kind | null; proposal: number | null; from: RunSourceRef | null; fresh: boolean; onSignedOut: () => void }) {
  const turn = useTurn({ start, proposal, from, fresh, onSignedOut });
  // The view is drawn anew when the address changes (its state is the hook's, and stays): on a phone the navigation is
  // a sheet over the screen, and a destination chosen in it that is this same screen must still close it.
  const at = window.location.hash;
  return (
    <>
      {turn.conversation.length === 0 ? <NewWork key={at} turn={turn} onSignedOut={onSignedOut} /> : <ChatView key={at} turn={turn} onSignedOut={onSignedOut} />}
      <ContextSheet open={turn.sheetOpen} onOpenChange={turn.setSheetOpen} view={turn.view} setView={turn.setView} state={turn.sheet} />
    </>
  );
}

/**
 * A chat opened from its row on Work: its messages become the chat this device shows, and Chat opens on it. The chat
 * the device showed before is not lost: Botbench keeps every chat, and Work lists it.
 */
export function OpenChat({ id, onSignedOut }: { id: number; onSignedOut: () => void }) {
  const [problem, setProblem] = useState<string | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    document.title = tabTitle("Chat");
    arrive(heading.current);
  }, []);
  useEffect(() => {
    let live = true;
    getChat(id).then(
      (chat) => {
        if (!live) return;
        saveConversation(chat.attempts);
        window.location.replace("#/turn");
      },
      (err: unknown) => {
        if (!live) return;
        if (err instanceof ApiError && err.status === 401) return onSignedOut();
        setProblem(`The chat could not be opened. ${err instanceof ApiError ? err.message : "Botbench could not be reached."}`);
      },
    );
    return () => {
      live = false;
    };
  }, [id, onSignedOut]);
  return (
    <NextShell open={null} bar={<span className="text-sm font-semibold">Chat</span>}>
      <div data-testid="screen" className="mx-auto flex w-full max-w-3xl flex-col gap-3 px-4 py-8 md:px-8">
        <h1 ref={heading} tabIndex={-1} className="text-[1.5rem] leading-[1.875rem] font-bold tracking-tight outline-none">
          Chat
        </h1>
        {problem === null ? (
          <p role="status" className="text-base text-muted-foreground">
            Opening the chat.
          </p>
        ) : (
          <>
            <p role="alert" className="rounded-lg border border-destructive/60 bg-destructive-subtle px-3 py-2 text-meta text-destructive">
              {problem}
            </p>
            <p>
              <a href="#/work" className="text-primary underline underline-offset-4">
                Back to Work
              </a>
            </p>
          </>
        )}
      </div>
    </NextShell>
  );
}
