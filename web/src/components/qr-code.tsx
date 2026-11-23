import { useMemo } from "react";
import { qrModules } from "../app/qr.ts";

/** Quiet zone: 4 light modules on every side, as the QR specification asks. */
const QUIET = 4;

/**
 * A QR code of `text`, drawn by Botbench's own encoder (app/qr.ts) as one SVG path. It is dark on light in both modes
 * (bb-qr), as a phone's camera reads it most surely. `label` names it for a screen reader; what it holds is also on the
 * screen as text, so nothing is only in the picture.
 */
export function QrCode({ text, label, testId }: { text: string; label: string; testId?: string }) {
  const modules = useMemo(() => qrModules(text), [text]);
  const side = modules.length + 2 * QUIET;
  const path = modules.flatMap((row, y) => row.map((dark, x) => (dark ? `M${x + QUIET} ${y + QUIET}h1v1h-1z` : ""))).join("");
  return (
    <svg className="bb-qr" viewBox={`0 0 ${side} ${side}`} role="img" aria-label={label} shapeRendering="crispEdges" data-testid={testId}>
      <path d={path} fill="currentColor" />
    </svg>
  );
}
