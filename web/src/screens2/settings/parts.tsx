import { useId, useState, type ComponentProps, type ReactNode } from "react";
import { ChevronDown, CircleAlert, CircleCheck, Info, TriangleAlert } from "lucide-react";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/ui/alert-dialog";
import { Button } from "@/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/ui/collapsible";
import { cn } from "@/ui/lib/utils";

/*
 * The small pieces Settings, the paired-workbench conversation and sign-in are built from, on shadcn/ui and the theme's
 * tokens (ADR 0012). Each keeps the behaviour of the piece it replaces: a button whose action is running stays in
 * place, enabled and focused, and says what is happening; an action that takes something away asks first, with the
 * focus on the button that changes nothing.
 */

type ButtonProps = ComponentProps<typeof Button>;

/** A button whose action is being sent: it carries aria-busy, shows `busyLabel`, ignores presses and keeps the focus. */
export function Busy({ busy, busyLabel, onClick, children, variant = "outline", ...props }: ButtonProps & { busy: boolean; busyLabel: string }) {
  return (
    <Button
      variant={variant}
      aria-busy={busy || undefined}
      {...props}
      onClick={(event) => {
        if (busy) return event.preventDefault();
        onClick?.(event);
      }}
    >
      {busy ? busyLabel : children}
    </Button>
  );
}

/**
 * An action taken in two steps: its button opens an alert dialog that states what will happen, and the action runs when
 * that is confirmed. The cancel button comes first and takes the focus; Escape changes nothing. While the confirmed
 * action is sent (`busy`) the button says `busyLabel` and then `opener.object`, what the action is about, so one of
 * several in a list still says which it is. `disabled` is for another action's running, never its own.
 */
export function Confirm({ label, opener, variant = "outline", size, title, confirmLabel, cancelLabel, disabled, busy = false, busyLabel, losing = false, testId, onConfirm, className, children }: { label: string; opener?: { name: string; object?: string; theirs?: boolean }; variant?: ButtonProps["variant"]; size?: ButtonProps["size"]; title: ReactNode; confirmLabel: string; cancelLabel: string; disabled: boolean; busy?: boolean; busyLabel?: string; losing?: boolean; testId: string; onConfirm: () => void; className?: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const saysBusy = busy && busyLabel !== undefined;
  const name = saysBusy ? undefined : opener?.name;
  return (
    <>
      <Button type="button" variant={variant} size={size} disabled={disabled} aria-busy={busy || undefined} aria-label={name} data-ds-content-label={name === undefined ? undefined : ""} className={className} onClick={() => busy || setOpen(true)}>
        {saysBusy ? busyLabel : label}
        {saysBusy && opener?.object !== undefined && (
          <span className="sr-only" data-ds-content={opener.theirs === true ? "" : undefined}>
            {` ${opener.object}`}
          </span>
        )}
      </Button>
      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogContent data-testid={testId}>
          <AlertDialogHeader>
            <AlertDialogTitle className="text-heading font-semibold">{title}</AlertDialogTitle>
            <AlertDialogDescription render={<div />} className="flex flex-col gap-2 text-left">
              {children}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{cancelLabel}</AlertDialogCancel>
            <AlertDialogAction
              variant={losing ? "destructive" : "outline"}
              disabled={disabled}
              onClick={() => {
                setOpen(false);
                onConfirm();
              }}
            >
              {confirmLabel}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

const NOTE_LOOK = {
  error: { box: "border-destructive/60 bg-destructive-subtle", mark: "text-destructive", Mark: CircleAlert, word: "Error" },
  warning: { box: "border-attention/50 bg-attention-subtle", mark: "text-attention", Mark: TriangleAlert, word: "Warning" },
  note: { box: "border-border bg-transparent", mark: "text-muted-foreground", Mark: Info, word: "Note" },
  success: { box: "border-success/50 bg-success-subtle", mark: "text-success", Mark: CircleCheck, word: "Done" },
} as const;

/** A message set apart from the page: what went wrong, a warning, a note, or that something is done. Its mark repeats its kind, which a screen reader hears as a word. */
export function Note({ tone, role, title, action, testId, id, className, children }: { tone: keyof typeof NOTE_LOOK; role?: "alert" | "status"; title?: string; action?: ReactNode; testId?: string; id?: string; className?: string; children: ReactNode }) {
  const look = NOTE_LOOK[tone];
  return (
    <div role={role} id={id} data-testid={testId} data-tone={tone} className={cn("flex items-start gap-3 rounded-xl border px-4 py-3 text-sm", look.box, className)}>
      <look.Mark aria-hidden="true" className={cn("mt-0.5 size-4 shrink-0", look.mark)} />
      <div className="min-w-0 flex-1">
        <span className="sr-only">{`${look.word}: `}</span>
        {title !== undefined && <p className="font-semibold">{title}</p>}
        <div className="wrap-anywhere">{children}</div>
      </div>
      {action}
    </div>
  );
}

/** What is being read, said while it is: a line a screen reader announces. */
export function Reading({ children }: { children: ReactNode }) {
  return (
    <p role="status" className="text-sm text-muted-foreground">
      {children}
    </p>
  );
}

/**
 * A choice of two or three, all in view: On and Off, or Allow, Ask and Off. A radio group named by `label`, each choice a
 * real radio button that covers its segment, so the keyboard, a screen reader and a finger each get the control they know.
 * `value` is null while the choice is being read. `data-value` is the choice as stored, for a test to read.
 */
export function Segmented<T extends string>({ label, value, options, disabled = false, busy = false, describedBy, testId, onChange }: { label: string; value: T | null; options: readonly { value: T; label: string }[]; disabled?: boolean; busy?: boolean; describedBy?: string; testId?: string; onChange: (value: T) => void }) {
  const name = useId();
  return (
    <div role="radiogroup" aria-label={label} aria-describedby={describedBy} aria-busy={busy || undefined} data-testid={testId} data-value={value ?? ""} data-ds-content-label="" className="inline-flex shrink-0 self-start rounded-lg border border-border bg-sunken p-0.5 sm:self-auto">
      {options.map((option) => (
        <label key={option.value} className="relative flex h-(--control-small) min-w-12 items-center justify-center rounded-md px-3 text-sm font-medium text-muted-foreground has-checked:bg-card has-checked:font-semibold has-checked:text-foreground has-checked:ring-1 has-checked:ring-border has-focus-visible:ring-3 has-focus-visible:ring-ring/50 has-disabled:opacity-50">
          <input type="radio" name={name} value={option.value} checked={value === option.value} disabled={disabled || value === null} onChange={() => onChange(option.value)} className="absolute inset-0 size-full cursor-pointer appearance-none opacity-0 disabled:cursor-not-allowed" />
          {option.label}
        </label>
      ))}
    </div>
  );
}

export const ON_OFF = [
  { value: "on", label: "On" },
  { value: "off", label: "Off" },
] as const;

/** The browser's own select, drawn as the theme's control: nothing is written into the page to place it. */
export function Select({ className, children, ...props }: ComponentProps<"select">) {
  return (
    <span className={cn("relative inline-flex min-w-0", className)}>
      <select {...props} className="h-(--control) w-full min-w-0 appearance-none truncate rounded-lg border border-input bg-transparent pr-9 pl-3 text-sm font-medium outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50">
        {children}
      </select>
      <ChevronDown aria-hidden="true" className="pointer-events-none absolute top-1/2 right-3 size-4 -translate-y-1/2 text-muted-foreground" />
    </span>
  );
}

/** A box of several lines, drawn as the theme's field. */
export function Textarea({ className, ...props }: ComponentProps<"textarea">) {
  return <textarea {...props} className={cn("min-h-20 w-full min-w-0 rounded-lg border border-input bg-sunken px-3 py-2 text-base outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 aria-invalid:border-destructive md:text-sm", className)} />;
}

/** A field's label, in the theme's small bold. */
export function FieldLabel({ className, ...props }: ComponentProps<"label">) {
  return <label {...props} className={cn("text-sm font-semibold", className)} />;
}

/** The line under a label or a heading that says what it is for. */
export function About({ className, ...props }: ComponentProps<"p">) {
  return <p {...props} className={cn("text-meta text-muted-foreground", className)} />;
}

/** A raised card of Settings: a group of rows, or one thing with its facts. */
export function Panel({ className, ...props }: ComponentProps<"div">) {
  return <div {...props} className={cn("rounded-xl border border-border bg-card", className)} />;
}

/** One setting in a panel: its name and what it does at the left, its control at the right; the control goes under the words on a narrow screen. */
export function Row({ label, about, control, className, children }: { label: ReactNode; about?: ReactNode; control?: ReactNode; className?: string; children?: ReactNode }) {
  return (
    <div className={cn("flex flex-col gap-3 px-5 py-4 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between sm:gap-x-6", className)}>
      <div className="flex min-w-0 flex-col gap-1 sm:min-w-56 sm:flex-1">
        <div className="text-sm font-semibold">{label}</div>
        {about}
        {children}
      </div>
      {control !== undefined && <div className="flex shrink-0 flex-wrap items-center gap-2">{control}</div>}
    </div>
  );
}

/** A section's heading, with what stands at its right. */
export function SectionHeading({ id, right, children, ...props }: { id?: string; right?: ReactNode; children: ReactNode } & Omit<ComponentProps<"h2">, "children" | "id">) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
      <h2 id={id} {...props} className="text-heading font-semibold tracking-tight outline-none">
        {children}
      </h2>
      {right}
    </div>
  );
}

/**
 * The longer explanation of a setting, behind a button that works with a finger, a mouse and the keyboard. `about` names
 * what it explains, for a screen reader, since every one of them reads "More about this".
 */
export function More({ about, children }: { about: string; children: ReactNode }) {
  return (
    <Collapsible>
      <CollapsibleTrigger aria-label={`More about this: ${about}`} data-ds-content-label="" render={<Button variant="link" className="h-auto min-h-(--control-small) justify-start p-0 text-meta font-medium" />}>
        More about this
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="flex flex-col gap-2 pt-1 text-meta text-muted-foreground">{children}</div>
      </CollapsibleContent>
    </Collapsible>
  );
}

/** A value a program made (a fingerprint, a command, a path), in the code typeface. `theirs`: somebody else's words. */
export function Mono({ theirs = false, className, ...props }: ComponentProps<"code"> & { theirs?: boolean }) {
  return <code data-ds-content={theirs ? "" : undefined} {...props} className={cn("wrap-anywhere text-foreground", className)} />;
}

/** One fact: its label, then its value. */
export function Fact({ label, mono = false, theirs = false, testId, className, children }: { label: string; mono?: boolean; theirs?: boolean; testId?: string; className?: string; children: ReactNode }) {
  return (
    <div className={cn("flex min-w-0 flex-col gap-1", className)}>
      <dt className="text-meta text-muted-foreground">{label}</dt>
      <dd data-testid={testId} data-ds-content={theirs ? "" : undefined} className={cn("min-w-0 wrap-anywhere text-sm", mono && "font-mono text-meta")}>
        {children}
      </dd>
    </div>
  );
}

/** A state as a word with its mark: a dot in the state's colour, which only repeats the word. */
export function StateWord({ tone, testId, role, children }: { tone: "good" | "attention" | "quiet" | "peer"; testId?: string; role?: "status"; children: ReactNode }) {
  const look = { good: "bg-success-subtle text-success", attention: "bg-attention-subtle text-attention", quiet: "bg-fill text-muted-foreground", peer: "bg-peer-subtle text-peer" }[tone];
  return (
    <span className={cn("inline-flex h-6 w-fit shrink-0 items-center gap-1.5 rounded-sm px-2 text-xs font-semibold whitespace-nowrap", look)}>
      <span aria-hidden="true" className="size-1.5 rounded-full bg-current" />
      <span data-testid={testId} role={role}>
        {children}
      </span>
    </span>
  );
}

/** The small, consistent mark on everything another workbench wrote, in the peer colour. Not pressable. */
export function OutsideMark({ className }: { className?: string }) {
  return (
    <span data-testid="outside-text-mark" className={cn("inline-flex h-6 w-fit shrink-0 items-center rounded-sm border border-peer/60 bg-peer-subtle px-2 text-xs font-semibold whitespace-nowrap text-peer", className)}>
      Outside text
    </span>
  );
}
