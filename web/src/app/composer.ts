import type { Delivery, IssueChoice, KnownRepository, ModelList, OnLimit, ReviewerChoice, RunMode, RunSourceRef, UpdateWithMain } from "../api/client.ts";
import { chipWords } from "./chat.ts";
import { noteProblem, sourceRepoProblem, type ComposerSource } from "./run-source.ts";
import { MODE_NAMES } from "./run-words.ts";

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
  /** The repository a chat lets its agents read, and what the server said of it; left out for none. Only a chat has one. */
  read?: { pick: ReadPick; status: RepoStatus };
  /** The agents a chat asks, for what a repository to read needs of them; left out when not known. */
  asked?: readonly Reader[];
  /** Whether the agents are being checked now, so an agent's `reads` not yet known may still be learned. */
  agentsChecking?: boolean;
  /** The finished task or chat this run is made from ("Make this a run"); it applies only to a run in a repository. Left out for none. */
  source?: ComposerSource | null;
}

/** The source a run is made from, when the composer holds one and is planning a run in a repository; else null. */
const sourceOf = (f: Pick<Facts, "source" | "repo" | "kind">): ComposerSource | null => (f.source != null && inRepository(f.repo) && f.kind === "run" ? f.source : null);

/**
 * A repository a chat lets its agents read, never change: none, one Botbench knows of, or a folder the owner typed. It is
 * not the Repository row's, which starts a task or a run: nothing is worked on in it, and it is never remembered.
 */
export type ReadPick = { kind: "none" } | { kind: "known"; path: string } | { kind: "other"; path: string };

/** An agent a chat asks, by name, and whether it reads a repository attached to the chat; null while that is not known. */
export interface Reader {
  name: string;
  reads: boolean | null;
}

/** What the view and the line under the box say of a repository a chat reads. */
export const READ_ABOUT = "The agents you ask can read its files and its history, and never change it: nothing in it is written, committed or pushed.";

/** Why a chat with a repository to read cannot be sent yet, in words that say what to do; null when it can. */
function readStop(f: Facts): string | null {
  if (f.repo.kind !== "none" || f.read === undefined || f.read.pick.kind === "none") return null;
  if (f.read.pick.path.trim() === "") return "Enter the full path of a git repository on this Mac for the chat to read, or choose None.";
  if (f.read.status.state === "checking") return "Checking the repository for the chat to read.";
  if (f.read.status.state === "refused") return `${f.read.status.words} Choose another repository for the chat to read, or choose None.`;
  const cannot = (f.asked ?? []).filter((a) => a.reads === false);
  if (cannot.length === 0) {
    // A check kept from before the server said who reads: wait for the one under way rather than send a likely refusal.
    if (f.agentsChecking === true && (f.asked ?? []).some((a) => a.reads === null)) return "Checking which agents can read the repository.";
    return null;
  }
  const why = cannot.map((a) => (a.name === "Claude Code" ? "Claude Code works on a repository only as a task, in a separate copy, so a chat does not give it one." : `${a.name} cannot read a repository: it answers from the conversation alone.`));
  return `${why.join(" ")} The repository is read only by the other agents: ask only them, or choose None for the repository to read.`;
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
  | { do: "chat"; prompt: string; model: string | null | undefined; repository?: string }
  | { do: "task"; repo: string; prompt: string; model: string | null | undefined; preapproved: string[]; agent?: Builder }
  | ({ do: "run"; repo: string; model: string | null | undefined; buildModel?: string | null; preapproved: string[]; reviewer: ReviewerChoice | null; mode: RunMode; delivery: Delivery; oneTask: boolean; onLimit: OnLimit; updateWithMain?: UpdateWithMain; issue?: IssueChoice; takeOver?: string[]; agent?: Builder; source?: RunSourceRef; approvalLimitMinutes?: number } & ({ prompt: string } | { specPath: string } | {}));

/** The usage-limit view's question and its two choices (docs/product/voice.md); Wait is the default. */
export const LIMIT_WORDS = {
  title: "When the builder reaches its usage limit",
  wait: { name: "Wait for it to reset", value: "Wait", description: "The task waits, its work kept, and Botbench tries the same agent once more by itself when the limit resets." },
  switch: { name: "Switch to the next agent", value: "Switch", description: "The task moves at once to the next agent on the list in Settings, in the same copy and on the same branch, with a note of what was done so far. With no agent left to take it, it waits." },
} as const;

/** The approval time limits a run can be started with, in minutes; null for none, which is the default. */
export const APPROVAL_LIMITS: readonly (number | null)[] = [null, 15, 60, 240, 1440];

/** An approval time limit in words: "Off", "15 minutes", "1 hour", "4 hours", "1 day". */
export function limitName(minutes: number | null): string {
  if (minutes === null) return "Off";
  if (minutes % 1440 === 0) return minutes === 1440 ? "1 day" : `${minutes / 1440} days`;
  if (minutes % 60 === 0) return minutes === 60 ? "1 hour" : `${minutes / 60} hours`;
  return minutes === 1 ? "1 minute" : `${minutes} minutes`;
}

/** What the Approval time limit view and the run's screen say of it (docs/product/voice.md). */
export const APPROVAL_LIMIT_WORDS = {
  hint: "If nobody answers a request of this run in this time, Botbench denies it and tells the agent nobody answered. Nothing is ever allowed this way. It cannot be changed once the run starts.",
  off: "Requests wait for your answer, however long that takes.",
  on: (minutes: number): string => `A request nobody answers within ${limitName(minutes).toLowerCase()} is denied.`,
} as const;

/** An agent other than Claude Code that builds a task or a run's tasks when the owner chooses it. */
export type Builder = "codex";

/** What the Builder view says of each choice (docs/product/voice.md). */
export const BUILDER_WORDS = {
  claude: "Works in its own sandbox and asks you before each command the safety rules name. It also plans a run.",
  codex: "Works in its own sandbox, in the task's copy, with no network. It asks you each time it wants to run something outside that sandbox; a fully autonomous run refuses those. Claude Code still plans a run.",
  hint: "It cannot be changed once the work starts. The reviewer must be a different model.",
} as const;

/** The Builder row's value. */
export const builderName = (builder: Builder | null): string => (builder === "codex" ? "Codex" : "Claude Code");

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
    // A run made from a task or a chat: the note is checked as the server checks it, and a task's run stays in its repository.
    const source = sourceOf(f);
    if (source !== null) {
      const wrong = sourceRepoProblem(source, f.repo.path.trim());
      if (wrong !== null) return say(wrong, "repository");
      const note = noteProblem(f.text);
      if (note !== null) return say(note);
    }
  }
  const read = readStop(f);
  if (read !== null) return say(read);
  if (run && f.mode === "full" && f.hasChecks === false) return say("Fully autonomous needs a check command for this repository. Add one to Botbench's settings file, or choose Semi-autonomous.");
  if (!f.model.ok) return say(`Model: ${f.model.why}`);
  if (run && f.buildModel !== null && !f.buildModel.ok) return say(`Build model: ${f.buildModel.why}`);
  if (inRepository(f.repo) && f.commandTyped) return say("Add the command you typed to Allowed commands, or clear it: it is not on the list yet.");
  return null;
}

/**
 * Whether a run is kept to one task: as the owner chose it here, or, not chosen, on in Fully autonomous and off in the
 * other modes, as the server decides when a request leaves it out.
 */
export const oneTaskFor = (chosen: boolean | null, mode: RunMode | null): boolean => chosen ?? mode === "full";

export function sendFor(f: Facts, extras: { preapproved: string[]; reviewer: ReviewerChoice | null; delivery: Delivery; oneTask: boolean; onLimit?: OnLimit; updateWithMain?: UpdateWithMain; takeOver?: string[]; builder?: Builder | null; approvalLimitMinutes?: number | null }): Send {
  // Sent only when it is not the server's default (ask).
  const main = extras.updateWithMain === undefined || extras.updateWithMain === "ask" ? {} : { updateWithMain: extras.updateWithMain };
  const stop = blocked(f);
  if (stop !== null) return { do: "blocked", reason: stop.reason };
  const prompt = f.text.trim() === "" ? null : f.text;
  // blocked() has made sure the model can be sent.
  const model = f.model.ok ? f.model.model : undefined;
  if (!inRepository(f.repo)) {
    if (prompt === null) return { do: "focus" };
    // blocked() has made sure a repository to read is only in a chat, checked, and asked of agents that read it.
    const read = f.repo.kind === "none" && f.read !== undefined && f.read.pick.kind !== "none" ? { repository: f.read.pick.path.trim() } : {};
    return { do: "chat", prompt, model, ...read };
  }
  const repo = f.repo.path.trim();
  // Codex builds on its own default model: the models chosen here are Claude Code's, which still plans a run.
  const codex = extras.builder === "codex";
  if (f.kind === "task") return prompt === null ? { do: "focus" } : codex ? { do: "task", repo, prompt, model: undefined, preapproved: extras.preapproved, agent: "codex" } : { do: "task", repo, prompt, model, preapproved: extras.preapproved };
  // Sent only when the owner chose one: left out, the run has none.
  const limit = extras.approvalLimitMinutes === undefined || extras.approvalLimitMinutes === null ? {} : { approvalLimitMinutes: extras.approvalLimitMinutes };
  // A run made from a task or a chat sends the note alone: no spec file and no issue (blocked() has checked the note).
  const source = sourceOf(f);
  if (source !== null) return { do: "run", repo, prompt: f.text, model, ...(codex ? { agent: "codex" as const } : f.buildModel !== null && f.buildModel.ok ? { buildModel: f.buildModel.model ?? null } : {}), preapproved: extras.preapproved, reviewer: extras.reviewer, mode: f.mode!, delivery: extras.delivery, oneTask: extras.oneTask, onLimit: extras.onLimit ?? "wait", ...main, source: source.ref, ...limit };
  const spec = f.specPath.trim();
  const issue = f.issue ? { issue: { fetchId: f.issue.fetchId, allowHosts: f.issue.allowHosts } } : {};
  if (prompt === null && spec === "" && !f.issue) return { do: "focus" };
  const build = codex ? { agent: "codex" as const } : f.buildModel !== null && f.buildModel.ok ? { buildModel: f.buildModel.model ?? null } : {};
  const given = prompt !== null ? { prompt } : f.issue ? {} : { specPath: spec };
  // Old claims of other workbenches the owner confirmed taking over (web/src/app/peers.ts oldClaims); the server checks each again.
  const takeOver = extras.takeOver !== undefined && extras.takeOver.length > 0 ? { takeOver: extras.takeOver } : {};
  return { do: "run", repo, ...given, ...issue, model, ...build, preapproved: extras.preapproved, reviewer: extras.reviewer, mode: f.mode!, delivery: extras.delivery, oneTask: extras.oneTask, onLimit: extras.onLimit ?? "wait", ...main, ...takeOver, ...limit };
}

/** A row of the Add context sheet, in the order they are shown. */
export type Row = "repository" | "read" | "kind" | "builder" | "issue" | "spec" | "mode" | "tasks" | "review" | "delivery" | "limit" | "approvalLimit" | "main" | "commands" | "models";

/**
 * The rows that apply: a chat has a repository to work in, one to read and a model; a start in a repository adds what to
 * do, mode and commands; a run adds its own settings. Come to start a task or a run (a repository needed), there is
 * nothing to read.
 */
export function rowsFor(f: { repo: RepoPick; kind: Kind; reviewOffered: boolean; commandsKnown: boolean; issueOffered?: boolean; builderOffered?: boolean; sourced?: boolean }): Row[] {
  if (f.repo.kind === "none") return ["repository", "read", "models"];
  if (!inRepository(f.repo)) return ["repository", "models"];
  const run = f.kind === "run";
  // A run made from a task or a chat takes the owner's note alone: it offers no issue and no spec file.
  if (run && f.sourced === true) return rowsFor({ ...f, sourced: false, issueOffered: false }).filter((row) => row !== "spec");
  return [
    "repository",
    "kind",
    // Only when another agent than Claude Code can build now (Codex, once its check found it can).
    ...(f.builderOffered === true ? (["builder"] as const) : []),
    // Only a repository whose remote is on GitHub has issues Botbench can read.
    ...(run && f.issueOffered === true ? (["issue"] as const) : []),
    ...(run ? (["spec"] as const) : []),
    "mode",
    // Offered in every mode; its default follows the mode (`oneTaskFor`).
    ...(run ? (["tasks"] as const) : []),
    ...(run && f.reviewOffered ? (["review"] as const) : []),
    ...(run ? (["delivery"] as const) : []),
    // What a builder's usage limit does in the run: Wait (the default) or Switch to the next agent.
    ...(run ? (["limit"] as const) : []),
    // Off unless chosen; for a run only, whose requests may wait while nobody is looking.
    ...(run ? (["approvalLimit"] as const) : []),
    // What happens when main moved on as a task is handed to you: Ask (the default), bring it up to date, or Off.
    ...(run ? (["main"] as const) : []),
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
  /** The mode last chosen here, for the repository it was chosen for and that one alone (`modeFor`); Fully autonomous too, which `startMode` falls back from where it cannot start. */
  mode: ChosenMode | null;
  /** The reviewer's select value: "" for Off. */
  review: string;
  delivery: Delivery;
  /** Whether a run builds on its planning model; false when a build model of its own was chosen (the model itself is kept by its picker). */
  sameBuild: boolean;
}

export const DEFAULTS: Remembered = { repo: { kind: "none" }, kind: "task", mode: null, review: "", delivery: "branch", sameBuild: true };

export const writeRemembered = (r: Remembered): string => JSON.stringify(r);

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
    sameBuild: typeof r.sameBuild === "boolean" ? r.sameBuild : DEFAULTS.sameBuild,
  };
}

/** A remembered mode: Manual, Semi-autonomous or Fully autonomous for a named repository. Anything else, a bare mode an earlier version kept among it, is no choice. */
function rememberedMode(value: unknown): ChosenMode | null {
  if (typeof value !== "object" || value === null) return null;
  const { repo, mode } = value as Record<string, unknown>;
  return typeof repo === "string" && repo !== "" && (mode === "manual" || mode === "semi" || mode === "full") ? { repo, mode } : null;
}

/**
 * The mode a run starts in, and why when it is not the one remembered. A Fully autonomous remembered for this repository
 * (`remembered`: not chosen on this visit) that cannot start here, on a repository with no check command or from a
 * GitHub issue, falls back to Semi-autonomous, which is stricter, and says why; the owner can still choose another. A
 * mode chosen on this visit is left as it is, and Send then says why it is disabled (`blocked`). Never looser.
 */
export function startMode(mode: RunMode | null, o: { remembered: boolean; hasChecks: boolean | null; issue: boolean }): { mode: RunMode | null; why: string | null } {
  if (mode !== "full" || !o.remembered) return { mode, why: null };
  if (o.issue) return { mode: "semi", why: "A run started from a GitHub issue cannot be fully autonomous, so this run starts Semi-autonomous, not Fully autonomous as you last chose for this repository." };
  if (o.hasChecks === false) return { mode: "semi", why: "Fully autonomous, your last choice for this repository, needs a check command, and this repository has none, so this run starts Semi-autonomous." };
  return { mode, why: null };
}

/** The line under the box that names the mode a run starts in before Send, and why when it fell back; null while the mode is read. */
export function modeLine(start: { mode: RunMode | null; why: string | null }): string | null {
  if (start.mode === null) return null;
  return start.why === null ? `Mode: ${MODE_NAMES[start.mode]}.` : `Mode: ${MODE_NAMES[start.mode]}. ${start.why}`;
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
 * The chip next to the box when the composer starts work in a repository: the model and, as its qualifier, the agent
 * that uses it. With Claude Code building, its model (and for a run, its build model after it). With Codex chosen as
 * the builder, Codex and the model it builds on (its own default, `codexModel`, as Codex names it, or "Codex's default"
 * when it has not said): a task is Codex's alone, and a run is planned by Claude Code first.
 */
export function builderChip(o: { run: boolean; builder: Builder | null; sameBuild: boolean; plan: string; build: string; codexModel: string | null }): { value: string; qualifier: string | null } {
  const claude = chipWords(chipModel(o), "Claude Code");
  if (o.builder !== "codex") return claude;
  const codex = chipWords(o.codexModel ?? "Codex's default", "Codex");
  if (!o.run) return codex;
  const plan = chipWords(o.plan, "Claude Code");
  return { value: `${plan.value}${plan.qualifier === null ? "" : ` ${plan.qualifier}`}, then ${codex.value}`, qualifier: codex.qualifier ?? "Codex" };
}

/**
 * Whether choosing an option in a setting's view goes back to the list of settings at once: yes, unless the option
 * opens a field to fill in (Another folder…, Other…), the view is a field itself, it holds a second choice (Models), or
 * the option carries a warning to read (Fully autonomous).
 */
export function returnsToList(o: { view: Row; value: string; run: boolean }): boolean {
  if (o.view === "spec" || o.view === "commands" || o.view === "issue") return false;
  if (o.view === "repository" || o.view === "read") return o.value !== "?other";
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

/** The Read a repository row's value: None, or the repository's name. */
export function readName(read: ReadPick, known: readonly KnownRepository[]): string {
  if (read.kind === "none") return "None";
  return repoName(read, known);
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
