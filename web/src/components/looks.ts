/**
 * How each state Botbench shows is drawn: one icon and one tone, the same wherever the state appears. The first nine
 * are the design system's status set (the badge's `statusSet`), as it gives them. The rest are Botbench's own states,
 * which the set does not name; each takes the look of the state in the set it is nearest to, or one of its own.
 */
export const LOOKS = {
  queued: { tone: "neutral", icon: "circle-dashed" },
  working: { tone: "info", icon: "loader" },
  checking: { tone: "info", icon: "search" },
  needsInput: { tone: "approval", icon: "circle-pause" },
  readyForReview: { tone: "success", icon: "eye" },
  stopped: { tone: "blocked", icon: "circle-stop" },
  cancelled: { tone: "neutral", icon: "circle-slash" },
  checkPassed: { tone: "success", icon: "circle-check" },
  checkFailed: { tone: "danger", icon: "circle-alert" },
  // Not in the set. Failed is drawn as a failed check is; a run's planning and a task's resuming are work, drawn as Working is.
  failed: { tone: "danger", icon: "circle-alert" },
  accepted: { tone: "success", icon: "check" },
  rejected: { tone: "neutral", icon: "x" },
  done: { tone: "success", icon: "circle-check" },
} as const satisfies Record<string, { tone: Tone; icon: string }>;
// Each icon is checked against the sprite's names where it is drawn, in status.tsx.

export type Tone = "neutral" | "info" | "success" | "warning" | "danger" | "approval" | "blocked";
export type Look = (typeof LOOKS)[keyof typeof LOOKS];
