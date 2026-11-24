import { useEffect, useRef } from "react";
import { arrive, tabTitle } from "../../app/arrival.ts";
import { NextShell } from "../../shell/shell.tsx";

/** The screen shown for an address that names none. Its heading names the tab and takes focus as any screen's does. */
export default function NotFoundScreen({ what }: { what: string }) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    document.title = tabTitle("No such screen");
    arrive(heading.current);
  }, []);
  return (
    <NextShell open={null} bar={<span className="text-sm font-semibold">No such screen</span>}>
      <main data-testid="not-found" className="mx-auto flex w-full max-w-[47.5rem] flex-col gap-2 px-4 py-8 md:px-8">
        <div role="alert" className="flex flex-col gap-2">
          <h1 ref={heading} tabIndex={-1} className="text-[1.5rem] leading-[1.875rem] font-bold tracking-tight outline-none">
            {"There is no screen at "}
            <span data-ds-content="" className="break-all">
              {what}
            </span>
            .
          </h1>
          <p className="text-base text-muted-foreground">The address may be mistyped. The navigation lists every screen there is.</p>
        </div>
      </main>
    </NextShell>
  );
}
