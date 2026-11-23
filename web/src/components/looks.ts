/**
 * How each state Botbench shows is drawn: one icon and one tone, the same wherever the state appears. The first thirteen
 * are the design system's status set (the badge's `statusSet`), as it gives them. The rest are Botbench's own states,
 * which the set does not name.
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
  failed: { tone: "danger", icon: "circle-x" },
  done: { tone: "success", icon: "check" },
  accepted: { tone: "success", icon: "thumbs-up" },
  rejected: { tone: "neutral", icon: "x" },
  // Not in the set (a run's planning and a task's resuming are work, drawn as Working is). A run that ended with no task ever ready for review: nothing was built to decide on. Drawn as an end that is not a success.
  nothingToReview: { tone: "neutral", icon: "circle-slash" },
  // Not in the set, and no tone of the set says "where this came from": a run or task that read a GitHub issue, which
  // people outside the project wrote. Drawn neutral, with words that say it.
  outsideText: { tone: "neutral", icon: "info" },
  // Not in the set: a task waiting for its agent's usage limit to reset, which Botbench resumes by itself at a time. Not
  // Needs input (nothing is asked of the reader) and not Stopped (it goes on alone); a clock in the warning tone.
  usageLimit: { tone: "warning", icon: "clock" },
} as const satisfies Record<string, { tone: Tone; icon: string }>;
// Each icon is checked against the sprite's names where it is drawn, in status.tsx.

export type Tone = "neutral" | "info" | "success" | "warning" | "danger" | "approval" | "blocked";
export type Look = (typeof LOOKS)[keyof typeof LOOKS];
