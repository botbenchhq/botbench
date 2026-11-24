import { useCallback, useLayoutEffect, useRef, type ChangeEvent } from "react";
import { ChevronLeft, ChevronRight, X } from "lucide-react";
import { Button } from "@/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/ui/dialog";
import { useIsMobile } from "@/ui/hooks/use-mobile";
import { Sheet, SheetContent, SheetTitle } from "@/ui/sheet";
import { returnsToList, type Row } from "../../app/composer.ts";
import { ROW, View, type SheetState, type SheetView } from "../../components/composer-sheet.tsx";

/**
 * The Add context sheet: a dialog from 768px, a sheet from the bottom on a phone. Its rows are the composer's own
 * (`rowsFor`, app/composer.ts), each with its value; a row opens that setting's view in the same sheet, with Back to
 * the rows. Choosing sets the value at once. The views are the ones the sheet always had (components/composer-sheet.tsx).
 */
export function ContextSheet({ open, onOpenChange, view, setView, state }: { open: boolean; onOpenChange: (open: boolean) => void; view: SheetView; setView: (view: SheetView) => void; state: SheetState }) {
  const phone = useIsMobile();
  /** The row whose view is open, so Back can put the focus on it again. */
  const pressed = useRef<Row | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  /** Whether the last choice in a view was made by pointer: a choice made with the arrow keys stays in the view, so the next arrow still works. */
  const byPointer = useRef(false);
  const shown: SheetView = view !== "rows" && !state.rows.includes(view) ? "rows" : view;
  const run = state.rows.includes("spec");
  const title = shown === "rows" ? "Add context" : shown === "models" && run ? "Models" : shown === "models" ? "Agent and model" : ROW[shown].title;
  /** A choice made by tapping an option goes back to the list, one tap less, unless the option opens a field (`returnsToList`). */
  const chosen = (event: ChangeEvent<HTMLDivElement>): void => {
    const input = event.target;
    if (shown === "rows" || !byPointer.current || !(input instanceof HTMLInputElement) || input.type !== "radio") return;
    if (returnsToList({ view: shown, value: input.value, run })) setView("rows");
  };
  const close = (next: boolean): void => {
    onOpenChange(next);
    if (!next) setView("rows");
  };

  // A view takes the focus on its chosen option (else its first control); the rows give it back to the row that was pressed.
  const focus = (): void => {
    const body = bodyRef.current;
    if (body === null) return;
    if (shown === "rows") {
      if (pressed.current !== null) body.querySelector<HTMLElement>(`[data-row="${pressed.current}"]`)?.focus();
      return;
    }
    pressed.current = shown;
    (body.querySelector<HTMLElement>("input:checked") ?? body.querySelector<HTMLElement>("input:not([disabled]), button, textarea"))?.focus();
  };
  useLayoutEffect(() => {
    if (open) focus();
  }, [shown, open]);
  // The dialog draws its content after it opens: the view's own control takes the focus when the content arrives, once.
  const focusNow = useRef(focus);
  focusNow.current = focus;
  const setBody = useCallback((el: HTMLDivElement | null) => {
    bodyRef.current = el;
    if (el !== null) focusNow.current();
  }, []);

  const content = (
    <>
      <div className="flex items-center gap-1 border-b px-2 py-2">
        {shown !== "rows" && (
          <Button variant="ghost" size="icon" aria-label="Back to Add context" className="size-(--control)" onClick={() => setView("rows")}>
            <ChevronLeft aria-hidden="true" />
          </Button>
        )}
        {phone ? <SheetTitle className="min-w-0 flex-1 px-2 text-heading font-semibold">{title}</SheetTitle> : <DialogTitle className="min-w-0 flex-1 px-2 text-heading leading-normal font-semibold">{title}</DialogTitle>}
        <Button variant="ghost" size="icon" aria-label="Close Add context" className="size-(--control)" onClick={() => close(false)}>
          <X aria-hidden="true" />
        </Button>
      </div>
      <div
        ref={setBody}
        data-testid="context-body"
        className="min-h-0 flex-1 overflow-y-auto px-4 py-3"
        onPointerDown={() => (byPointer.current = true)}
        onKeyDown={() => (byPointer.current = false)}
        onChange={chosen}
      >
        {shown === "rows" ? (
          <ul aria-label="Settings of what you send" className="flex flex-col">
            {state.rows.map((row) => (
              <li key={row} className="border-b last:border-b-0">
                <button type="button" data-row={row} onClick={() => setView(row)} className="flex min-h-12 w-full items-center gap-3 rounded-lg px-1 py-2 text-left text-base outline-none hover:bg-fill focus-visible:ring-3 focus-visible:ring-ring/50">
                  <span data-testid="context-row-label" className="shrink-0 font-medium">
                    {row === "models" && run ? "Models" : ROW[row].label}
                  </span>{" "}
                  <span data-testid="context-row-value" className={state.warning[row] === true ? "ml-auto min-w-0 truncate text-attention" : "ml-auto min-w-0 truncate text-muted-foreground"}>
                    {state.values[row]}
                  </span>
                  <ChevronRight aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <View row={shown} state={state} />
        )}
      </div>
    </>
  );
  return phone ? (
    <Sheet open={open} onOpenChange={close}>
      <SheetContent side="bottom" showCloseButton={false} data-testid="context-sheet" className="max-h-[85svh] gap-0 rounded-t-xl">
        {content}
      </SheetContent>
    </Sheet>
  ) : (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent showCloseButton={false} data-testid="context-sheet" className="flex max-h-[85svh] flex-col gap-0 p-0 sm:max-w-lg">
        {content}
      </DialogContent>
    </Dialog>
  );
}
