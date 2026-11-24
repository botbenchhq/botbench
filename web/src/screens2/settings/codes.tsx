import { useId, useState } from "react";
import { Copy } from "lucide-react";
import { Button } from "@/ui/button";
import { Input } from "@/ui/input";
import { FieldLabel } from "./parts.tsx";

/** Copy `text`, and say whether it was copied: the clipboard is only there on a secure page and may still refuse. */
function useCopy(text: string, done: string, refused: string): { said: string; copy: () => void } {
  const [said, setSaid] = useState("");
  const copy = (): void => {
    const written = navigator.clipboard === undefined ? Promise.reject(new Error("no clipboard")) : navigator.clipboard.writeText(text);
    written.then(
      () => setSaid(done),
      () => setSaid(refused),
    );
  };
  return { said, copy };
}

/** The code as issued, for a screen reader, and in its groups for the eye, with Copy code. */
export function DeviceCode({ code, testId = "connect-code" }: { code: string; testId?: string }) {
  const { said, copy } = useCopy(code, "Code copied", "Not copied. Select the code and copy it by hand.");
  return (
    <div className="flex flex-wrap items-center gap-3">
      <p data-testid={testId} className="rounded-lg bg-sunken px-3 py-2 font-mono text-heading font-semibold tracking-widest">
        <span className="sr-only">Code: {code}</span>
        <span aria-hidden="true">{code}</span>
      </p>
      <Button type="button" variant="outline" size="sm" onClick={copy}>
        <Copy aria-hidden="true" />
        Copy code
      </Button>
      <span role="status" className="text-meta text-muted-foreground">
        {said}
      </span>
    </div>
  );
}

/** A value to copy as it stands (a command, an invite): shown whole in a field that cannot be changed, with Copy. */
export function CopyField({ label, value, testId, buttonName, disabled = false, done = "Copied", refused = "Not copied. Select it and copy it by hand." }: { label: string; value: string; testId: string; buttonName: string; disabled?: boolean; done?: string; refused?: string }) {
  const id = useId();
  const { said, copy } = useCopy(value, done, refused);
  return (
    <div className="flex flex-col gap-1.5">
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <div className="flex flex-wrap items-center gap-2">
        <Input id={id} data-testid={testId} type="text" readOnly value={value} className="min-w-0 flex-1 basis-48 font-mono text-meta md:text-meta" />
        <Button type="button" variant="outline" aria-label={buttonName} disabled={disabled} onClick={copy}>
          Copy
        </Button>
      </div>
      <p data-testid={`${testId}-copy-state`} role="status" className="text-meta text-muted-foreground">
        {said}
      </p>
    </div>
  );
}
