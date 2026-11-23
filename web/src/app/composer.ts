import type { Delivery, IssueChoice, KnownRepository, ModelList, ReviewerChoice, RunMode } from "../api/client.ts";

/*
 * The composer on the home screen: one box that sends a chat prompt, starts a task or plans a run, depending on what
 * the Add context sheet holds. Everything it decides is here, as plain functions, so it is tested without a browser.
 */

/** What a start in a repository is: one task, or a run that plans several tasks for the owner to approve. */
export type Kind = "task" | "run";

/**
 * The repository the composer works in: none (just chat), one Botbench knows of, a folder the owner typed, or none
 * yet while the owner came to start a task or run (New task, New run) and has not chosen one.
 */
export type RepoPick = { kind: "none" } | { kind: "known"; path: string } | { kind: "other"; path: string } | { kind: "needed" };

/** What the server said of the chosen path. */
export type RepoStatus = { state: "none" } | { state: "checking" } | { state: "usable" } | { state: "refused"; words: string } | { state: "unknown"; words: string };

/** What a request should carry for a model: a name, null for the CLI's own default, or nothing when the configured model applies. */
export type ModelRequest = { ok: true; model: string | null | undefined } | { ok: false; why: string };

/** What the composer holds when Send is pressed. */
export interface Facts {
  text: string;
  repo: RepoPick;
  repoStatus: RepoStatus;
  kind: Kind;
  specPath: string;
  /** The run's mode; null until the default from Settings is read. A task started on its own is always manual. */
  mode: RunMode | null;
  /** Whether the agent that builds, Claude Code, can take work now. */
  builder: { state: "checking" } | { state: "ready" } | { state: "problem"; words: string };
  model: ModelRequest;
  /** A run's build model when the owner chose one apart from the planning model; null for the same model. */
  buildModel: ModelRequest | null;
  /** A command typed in Allowed commands and not added. */
  commandTyped: boolean;
  /** Whether the repository has a check command configured; null while that is not known. */
  hasChecks: boolean | null;
  /** The GitHub issue attached to a run, as it was looked up; null or left out for none. */
  issue?: AttachedIssue | null;
}

/** An issue the owner looked up and attached: what is sent, and what its row shows. */
export interface AttachedIssue extends IssueChoice {
  number: number;
  title: string;
}

/** Why a run from an issue cannot be fully autonomous; the server says the same. */
export const ISSUE_NOT_FULL = "A run started from a GitHub issue cannot be fully autonomous: people outside this project wrote the issue, and a stranger's text must not lead to an accepted change and a pull request with nobody looking. Choose Manual or Semi-autonomous.";

/** What Send does. */
export type Send =
  | { do: "focus" }
  | { do: "blocked"; reason: string }
  | { do: "chat"; prompt: string; model: string | null | undefined }
  | { do: "task"; repo: string; prompt: string; model: string | null | undefined; preapproved: string[] }
  | ({ do: "run"; repo: string; model: string | null | undefined; buildModel?: string | null; preapproved: string[]; reviewer: ReviewerChoice | null; mode: RunMode; delivery: Delivery; issue?: IssueChoice } & ({ prompt: string } | { specPath: string } | {}));

/**
 * Why Send is disabled, in words that say what to do; `required` names the setting the required chip opens; `connect`
 * is true when the reason is that the agent cannot be used, and the reason then ends with the one link to connect one.
 */
export type Blocked = { reason: string; required: "repository" | null; connect?: true };

const inRepository = (repo: RepoPick): repo is { kind: "known" | "other"; path: string } => repo.kind === "known" || repo.kind === "other";

export const REPO_HINT = "Enter the full path of a git repository on this Mac.";

export function blocked(f: Facts): Blocked | null {
  const say = (reason: string, required: "repository" | null = null): Blocked => ({ reason, required });
  if (f.builder.state === "checking") return say("Checking that Claude Code is ready.");
  if (f.builder.state === "problem") return { ...say(`${f.builder.words} Nothing can be sent until this is fixed.`), connect: true };
  // Only New task and New run make a repository needed; with no repository otherwise, Send is a chat.
  if (f.repo.kind === "needed") return say("Choose a repository", "repository");
  const run = inRepository(f.repo) && f.kind === "run";
  if (inRepository(f.repo)) {
    if (f.repo.path.trim() === "") return say(REPO_HINT, "repository");
    if (f.repoStatus.state === "checking") return say("Checking the repository.");
    if (f.repoStatus.state === "refused") return say(f.repoStatus.words, "repository");
    if (run && f.mode === null) return say("Reading the default mode from Settings.");
    if (run && f.text.trim() !== "" && f.specPath.trim() !== "") return say("Give a message or a spec file, not both.");
    if (run && f.issue && f.specPath.trim() !== "") return say("A run from an issue takes your message, not a spec file. Clear the spec file, or remove the issue.");
    if (run && f.issue && f.mode === "full") return say(ISSUE_NOT_FULL);
  }
  if (run && f.mode === "full" && f.hasChecks === false) return say("Fully autonomous needs a check command for this repository. Add one to Botbench's settings file, or choose Semi-autonomous.");
  if (!f.model.ok) return say(`Model: ${f.model.why}`);
  if (run && f.buildModel !== null && !f.buildModel.ok) return say(`Build model: ${f.buildModel.why}`);
  if (inRepository(f.repo) && f.commandTyped) return say("Add the command you typed to Allowed commands, or clear it: it is not on the list yet.");
  return null;
}

export function sendFor(f: Facts, extras: { preapproved: string[]; reviewer: ReviewerChoice | null; delivery: Delivery }): Send {
  const stop = blocked(f);
  if (stop !== null) return { do: "blocked", reason: stop.reason };
  const prompt = f.text.trim() === "" ? null : f.text;
  // blocked() has made sure the model can be sent.
  const model = f.model.ok ? f.model.model : undefined;
  if (!inRepository(f.repo)) return prompt === null ? { do: "focus" } : { do: "chat", prompt, model };
  const repo = f.repo.path.trim();
  if (f.kind === "task") return prompt === null ? { do: "focus" } : { do: "task", repo, prompt, model, preapproved: extras.preapproved };
  const spec = f.specPath.trim();
  const issue = f.issue ? { issue: { fetchId: f.issue.fetchId, allowHosts: f.issue.allowHosts } } : {};
  if (prompt === null && spec === "" && !f.issue) return { do: "focus" };
  const build = f.buildModel !== null && f.buildModel.ok ? { buildModel: f.buildModel.model ?? null } : {};
  const given = prompt !== null ? { prompt } : f.issue ? {} : { specPath: spec };
  return { do: "run", repo, ...given, ...issue, model, ...build, preapproved: extras.preapproved, reviewer: extras.reviewer, mode: f.mode!, delivery: extras.delivery };
}

/** A row of the Add context sheet, in the order they are shown. */
export type Row = "repository" | "kind" | "issue" | "spec" | "mode" | "review" | "delivery" | "commands" | "models";

/** The rows that apply: a chat has a repository and a model; a start in a repository adds what to do, mode and commands; a run adds its own settings. */
export function rowsFor(f: { repo: RepoPick; kind: Kind; reviewOffered: boolean; commandsKnown: boolean; issueOffered?: boolean }): Row[] {
  if (!inRepository(f.repo)) return ["repository", "models"];
  const run = f.kind === "run";
  return [
    "repository",
    "kind",
    // Only a repository whose remote is on GitHub has issues Botbench can read.
    ...(run && f.issueOffered === true ? (["issue"] as const) : []),
    ...(run ? (["spec"] as const) : []),
    "mode",
    ...(run && f.reviewOffered ? (["review"] as const) : []),
    ...(run ? (["delivery"] as const) : []),
    ...(f.commandsKnown ? (["commands"] as const) : []),
    "models",
  ];
}

/** A mode the owner chose here, and the repository it was chosen for. */
export interface ChosenMode {
  repo: string;
  mode: RunMode;
}

/** What the composer remembers on this device, so the next start is: type, send. */
export interface Remembered {
  repo: Exclude<RepoPick, { kind: "needed" }>;
  kind: Kind;
  /** The mode chosen here, for the repository it was chosen for; never Fully autonomous, which is a default only when set in Settings. */
  mode: ChosenMode | null;
  /** The reviewer's select value: "" for Off. */
  review: string;
  delivery: Delivery;
}

export const DEFAULTS: Remembered = { repo: { kind: "none" }, kind: "task", mode: null, review: "", delivery: "branch" };

export const writeRemembered = (r: Remembered): string => JSON.stringify({ ...r, mode: r.mode?.mode === "full" ? null : r.mode });

/** What was remembered, each part checked on its own: a part that is not what it should be is the default. */
export function readRemembered(raw: string | null): Remembered {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw ?? "null");
  } catch {
    return DEFAULTS;
  }
  if (typeof parsed !== "object" || parsed === null) return DEFAULTS;
  const r = parsed as Record<string, unknown>;
  const repo = r.repo as Record<string, unknown> | null | undefined;
  return {
    repo: typeof repo === "object" && repo !== null && (repo.kind === "known" || repo.kind === "other") && typeof repo.path === "string" ? { kind: repo.kind, path: repo.path } : DEFAULTS.repo,
    kind: r.kind === "task" || r.kind === "run" ? r.kind : DEFAULTS.kind,
    mode: rememberedMode(r.mode),
    review: typeof r.review === "string" ? r.review : DEFAULTS.review,
    delivery: r.delivery === "branch" || r.delivery === "pull_request" ? r.delivery : DEFAULTS.delivery,
  };
}

/** A remembered mode: Manual or Semi-autonomous for a named repository. Anything else, a bare mode an earlier version kept among it, is no choice. */
function rememberedMode(value: unknown): ChosenMode | null {
  if (typeof value !== "object" || value === null) return null;
  const { repo, mode } = value as Record<string, unknown>;
  return typeof repo === "string" && repo !== "" && (mode === "manual" || mode === "semi") ? { repo, mode } : null;
}

/**
 * The mode a run would start in: the one chosen here when it was chosen for this repository, else the default from
 * Settings (Manual until the owner changes it there); null while that is being read.
 */
export function modeFor(chosen: ChosenMode | null, repoPath: string, settingsDefault: RunMode | null): RunMode | null {
  return chosen !== null && chosen.repo === repoPath ? chosen.mode : settingsDefault;
}

/** The model chip under the box: the model Send uses first, and for a run that builds on a model of its own, that one after it. */
export function chipModel(o: { run: boolean; sameBuild: boolean; plan: string; build: string }): string {
  return o.run && !o.sameBuild ? `${o.plan}, then ${o.build}` : o.plan;
}

/**
 * Whether choosing an option in a setting's view goes back to the list of settings at once: yes, unless the option
 * opens a field to fill in (Another folder…, Other…), the view is a field itself, it holds a second choice (Models), or
 * the option carries a warning to read (Fully autonomous).
 */
export function returnsToList(o: { view: Row; value: string; run: boolean }): boolean {
  if (o.view === "spec" || o.view === "commands" || o.view === "issue") return false;
  if (o.view === "repository") return o.value !== "?other";
  // The Models view holds two choices: the agent and its model in a chat, the planning and build models in a run.
  if (o.view === "models") return false;
  if (o.view === "review") return !o.value.endsWith(" ?other");
  // Fully autonomous stays in view with its warning, which is read before going on.
  if (o.view === "mode") return o.value !== "full";
  return true;
}

/**
 * Where the composer starts: what was remembered, or, coming from New task or New run, that kind. Coming from those
 * with no repository remembered, a repository is needed, and the Add context sheet opens on its view (`opens`): the
 * owner came to start work in a repository. On the home screen itself no kind is chosen, and no repository is a chat.
 */
export function arrive(remembered: Remembered, start: Kind | null): { repo: RepoPick; kind: Kind; opens: "repository" | null } {
  if (start === null) return { repo: remembered.repo, kind: remembered.kind, opens: null };
  const needed = remembered.repo.kind === "none";
  return { repo: needed ? { kind: "needed" } : remembered.repo, kind: start, opens: needed ? "repository" : null };
}

/** The last folder of a path, without a trailing slash: how a repository is named on a screen. */
export const folderName = (path: string): string => path.replace(/\/+$/, "").split("/").at(-1) ?? "";

/** The Repository row's value. */
export function repoName(repo: RepoPick, known: readonly KnownRepository[]): string {
  if (repo.kind === "none") return "None (just chat)";
  if (repo.kind === "needed") return "Choose";
  if (repo.kind === "known") return known.find((k) => k.path === repo.path)?.name ?? folderName(repo.path);
  return folderName(repo.path.trim()) || "Another folder";
}

/** The From an issue row's value: the issue's number and the start of its title, which people outside the project wrote. */
export function issueWords(issue: Pick<AttachedIssue, "number" | "title"> | null): string {
  if (issue === null) return "None";
  const title = issue.title.replace(/\s+/g, " ").trim();
  return `#${issue.number} · ${title.length > 30 ? `${title.slice(0, 30).trimEnd()}…` : title}`;
}

/** The Allowed commands row's value. */
export const commandsWords = (n: number): string => (n === 0 ? "None" : n === 1 ? "1 command" : `${n} commands`);

/** A path as the two parts the design system cuts in the middle: the folders before the last, and the last. */
export function splitPath(path: string): [string, string] {
  const at = path.replace(/\/+$/, "").lastIndexOf("/");
  return at === -1 ? ["", path] : [path.slice(0, at + 1), path.slice(at + 1)];
}

/** The model part of a reviewer value for the agent's own default; it holds a character no model name may. */
export const REVIEW_DEFAULT = "?default";
/** The model part of a reviewer value for a model name typed in. */
export const REVIEW_OTHER = "?other";

/** One reviewer option: the select value (`agent model`, apart by a space), the agent's name, and the model in words. */
export interface ReviewRow {
  value: string;
  agent: string;
  name: string;
  description: string;
  other: boolean;
}

/**
 * The reviewer options, by agent: the agent's own default model (with what the agent says it is), the model configured
 * for it in Botbench's settings when there is one, and Other… for any other name. An agent's every model is not listed:
 * the option picker holds about ten rows, and a list of all of them had no default among some forty-five.
 */
export function reviewRows(reviewers: readonly { agent: string; models: ModelList }[], nameOf: (agent: string) => string): ReviewRow[] {
  return reviewers.flatMap(({ agent, models }) => {
    const name = nameOf(agent);
    const row = (model: string, description: string): ReviewRow => ({ value: `${agent} ${model}`, agent, name, description, other: model === REVIEW_OTHER });
    return [
      row(REVIEW_DEFAULT, models.cliDefault === null ? "its default model" : `its default model (${models.cliDefault})`),
      ...(models.default === null ? [] : [row(models.default, `${models.default}, as configured`)]),
      row(REVIEW_OTHER, "Other model…"),
    ];
  });
}
