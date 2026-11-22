import type { ReactNode } from "react";
import { Icon } from "./icon.tsx";
import type { Look, Tone } from "./looks.ts";

const TONE_CLASS: Record<Tone, string> = {
  neutral: "ds-badge",
  info: "ds-badge ds-badge--info",
  success: "ds-badge ds-badge--success",
  warning: "ds-badge ds-badge--warning",
  danger: "ds-badge ds-badge--danger",
  approval: "ds-badge ds-badge--approval",
  blocked: "ds-badge ds-badge--blocked",
};

/** A state as the design system's badge: its icon, then its words. The words say the state; the icon and tone only repeat it. */
export function StatusBadge({ look, children }: { look: Look; children: ReactNode }) {
  return (
    <span className={TONE_CLASS[look.tone]}>
      <Icon name={look.icon} className="ds-badge__icon" />
      {children}
    </span>
  );
}
