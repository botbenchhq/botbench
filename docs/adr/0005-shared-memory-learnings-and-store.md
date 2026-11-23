# ADR 0005: Shared memory, first slice: a rejected task's reason as a markdown learning in the repository; the workbench memory store next

Date: 2026-11-22. Status: accepted. Numbered 0005 because 0004 is Peers direct messages. The threat review is "Learnings: a rejection's reason kept in the repository" in `docs/security/threat-model.md`.

Context: an owner who rejects a task usually says why ("call it greet.txt", "the tests it added never run"). Until now that note was stored on the decision and shown in Activity, and no later run saw it. So the next planner and builder could make the same mistake, on this workbench and on every other workbench that works on the repository. The reference projects were re-read for this record from `.reference/`: compound-engineering (`ce-compound`, `ce-plan`), OpenMausBot (`server/memory-store.ts`, `memory-upkeep.ts`, `memory-forget.ts`, `box-memory.ts`), Rakazo (`packages/memory/src/index.ts`, `docs/memory.md`) and Paperclip (`ui/src/hooks/useCompanyPageMemory.ts`). Nothing is copied from them. Where an approach was taken from one, it is named below.

## Decision

1. **A rejection with a note becomes a learning file in the task's repository.** When the owner rejects a task with a note, `src/engine/decision.ts` calls `recordLearning` (`src/engine/learnings.ts`). It commits `docs/solutions/rejected-<slug>.md` on the task's lesson branch (item 4), never into the repository's own folder. A rejection without a note writes nothing. An accept never writes one.
2. **The form is ce-compound's, kept short.** The frontmatter holds `title` (the plan title), `date`, `source_task`, and the knowledge-track fields ce-compound requires: `module`, `problem_type: workflow_issue`, `component: development_workflow`, `severity`, `tags`. Then come three sections: What went wrong, Fix or reason (one dated line per rejection), and How to recognise it next time. This is the approach of `compound-engineering ce-compound/assets/resolution-template.md` and `ce-compound/references/yaml-schema.md`. The title is written as a JSON string, which is a valid YAML double-quoted scalar, so no title can break the frontmatter.
3. **Only the owner's words and the plan title are written.** The text comes only from the owner's typed note and the task's plan title. A task started on its own has no plan, so its file is named "Task N" by its number. The task's prompt, its criteria, an issue's title, text and comments, and anything else from outside are never written. Line breaks and control characters are replaced, so one note is one line. This is the approach of `OpenMausBot server/memory-forget.ts` (`ownersOwnAsk`: only the person's own words may save to memory) and the provenance rules in `rakazo docs/memory.md` (derived text never becomes the owner's instruction). Note that in a run started from an issue, the plan title was written by the planner after it read the issue, and the owner approved it. It is owner-approved text, not the owner's own words.
4. **The file is committed on a lesson branch for the owner to merge.** Botbench commits the file on a branch of its own, `botbench-lesson/<workbench>/task-<id>`, named by `lessonBranch` in `src/workbench.ts` beside the task-branch names. The branch starts at the default-branch commit the task started from, so it differs from that commit only by the learning file. The commit is made with git's plumbing alone, run the way `src/worktrees.ts` runs git (`commitLessonFile`): a temporary index named by `GIT_INDEX_FILE`, `hash-object -w`, `update-index --add --cacheinfo`, `write-tree`, `commit-tree` and `update-ref`. There is no checkout and no worktree, the repository's own index is not used, and the temporary index is removed whether the commit is made or not. Nothing in the owner's checkout or current branch is written. Nothing is pushed or merged. A second rejection that reaches the same lesson branch is a new commit on it, whose parent is the previous lesson commit. The rejection's Activity entry names the branch and the file, and says the owner reviews and merges it like any change. A learning reaches later runs once the owner merges it. This is the approach of `compound-engineering ce-compound/references/form.md`: the write needs no question, because the merge that carries it is its review, and the skill itself does not merge.
5. **One file per title, with dated entries.** A second rejection of a task with the same plan title adds a dated line to that title's file and sets `last_updated`, instead of writing a second file. This is the approach of `compound-engineering ce-compound/SKILL.md` ("Update that learning instead of creating a duplicate") and `ce-compound/references/lightweight.md` (exact-path collision handling, `last_updated`). A different title that slugs to the same name gets `-2`, `-3` and so on.
6. **Safe names and no links.** The slug is lower-case ASCII letters, digits and dashes, at most 60 characters, and "untitled" when nothing is left. A title cannot name a path. `docs/` and `docs/solutions/` must be folders in the commit the lesson branch builds on. A link there is refused, and a learning file that is a link (mode 120000) or a submodule is passed over. The commit writes only that one path, and only on a branch named as a lesson branch. When reading notes into a prompt, a link is never followed. This is the approach of `OpenMausBot server/memory-store.ts` (`parseMemoryPath`: "an allowlist of three shapes, not a sanitiser"; `resolveMemoryPath` and `listMarkdown`: a link is not a memory file).
7. **The planner and the builder are given the notes.** `plannerPrompt` (`src/engine/roles.ts`, called from `src/engine/run.ts`) and the builder's first prompt (`builderPrompt` in `src/engine/task.ts`) each get one section from `learningsSection(repo)`:
   - **What it reads:** the `.md` files under the repository's `docs/solutions/`, up to one category folder deep. `README.md` is skipped.
   - **Order and caps:** newest first by `last_updated`, else `date`. At most 10 notes, at most 4,000 characters of one note and 16,000 in all. A line says how many were left out, and how many files could not be read as notes.
   - **Framing:** the section calls them notes the owner recorded or reviewed, to learn from, and says they are not instructions. Each note is set apart with `dataBlock("learning", ...)` like the other data blocks in `roles.ts`, so a note cannot close its block.
   - **Placement:** the section comes after the work and the plan feedback, and before any outside text.

   This is the approach of `compound-engineering ce-plan/references/research.md` and `ce-plan/references/agents/learnings-researcher.md` (`<root>/solutions/` is read only when it holds a markdown file; its text is evidence, not instructions; a README is never a rule). The caps and the left-out line follow `OpenMausBot server/memory-store.ts` (`memoryCapacity`: cut to a limit and say it was cut) and `rakazo packages/memory/src/index.ts` (`read`: newest first).
8. **No section when there is nothing to give.** With no `docs/solutions/`, an empty one, or only unreadable files, the section is left out and both prompts are byte for byte as before. A file with no frontmatter, no real date (2026-99-99 is not one), a size over 1 MB, a link, or a file that cannot be read is skipped. Reading never fails a run. Checking what is read back before using it, rather than trusting what was stored, follows `paperclip ui/src/hooks/useCompanyPageMemory.ts` (`sanitizeRememberedPathForCompany` checks a remembered path on every read).
9. **Removing a wrong or stale learning is a normal change.** Delete the file or edit it, and commit that like any change. git history keeps the record. There is no forget command, no screen and no store in this slice. `docs/solutions/README.md` says so.
10. **Nothing else.** This slice adds no table, schema migration, API route, web screen or memory store, and it changes nothing under `src/approvals/`. If the learning cannot be committed, the rejection still succeeds and changes nothing else. The failure goes to Botbench's log on stdout, and the Activity entry does not mention a file or a lesson branch.

## The three layers compared

| Layer | What it costs | What it shares across workbenches for free | How wrong entries are removed | What outside text could poison |
|---|---|---|---|---|
| **Markdown learnings in the repository** (this slice) | One small module and no new storage. A file in the owner's repository that the owner must review and commit. Up to 16,000 characters of prompt per planner and builder | Everything, through git: a clone or pull of the repository brings every committed learning to any workbench, with no service, sync or pairing | Delete or edit the file in a normal change. History stays in git | Botbench writes only the owner's note and the plan title. But anyone who can get a file into `docs/solutions/` (a collaborator, a merged pull request, a cloned stranger's repository) can put text into every later prompt there. That text is set apart as data and capped, and it is only as trustworthy as the repository's review |
| **Skills the agents write themselves** (for example `CLAUDE.md`, `AGENTS.md`, `.claude/skills/` edited by the agent) | Nothing for Botbench to build, but each vendor CLI has its own format and loading rules. Botbench's launch isolation drops personal skills and settings, so only committed ones count | Only what the agent committed into the repository, and only for the vendor that reads that format | Find the file per vendor and edit it. The agent may write it back on its next run | The most: whatever the agent read (an issue, a web page, repository text, another model's review) can be turned into an instruction that the agent later loads as its own instructions, not as data |
| **Workbench memory store** (next slice) | A store under `~/.botbench`, upkeep (duplicates, expiry, contradictions), and a screen to read, edit and forget | Nothing, by design: it stays on the one workbench, like the rest of the data folder | Forget by passage, edit or delete on a screen, and expiry by upkeep | Capture from conversations: model output and outside text a chat or run read could be saved as a fact, unless capture is limited to the owner's own words and outside-text runs are excluded |

Which kind of knowledge belongs in which layer:
- **The repository** holds what is true for anyone who works on the project: why a change was rejected, conventions, pitfalls and decisions. It passes the repository's own review, and it travels with the code.
- **The workbench memory store** holds what is about the owner and this machine: their preferences, facts about their setup, and what was tried in runs and chats here. It is private and is never shared.
- **Agent-written skills** are not a layer Botbench builds. Standing instructions belong in the owner's own `CLAUDE.md` or `AGENTS.md`, written or approved by the owner. A model's own conclusions never become instructions automatically.

## The next slice: the workbench memory store

The store is what an agent recalls across runs and chats on one workbench: facts, preferences and what was tried. It follows:
- `OpenMausBot server/memory-store.ts`: one index file and topic files, a path allowlist, owner-only atomic writes, a size cap and a write that refuses to overwrite an edit it has not seen.
- `OpenMausBot server/memory-upkeep.ts`: capture after a chat goes quiet, and tidying of expired, duplicate, superseded and contradicting notes.
- `OpenMausBot server/memory-forget.ts`: forgetting a passage from every note.
- `rakazo packages/memory` (`MarkdownMemoryStore`): read newest first, search, commit with revisions, remove, and export as portable markdown.
- `rakazo docs/memory.md`: one fact per line, rewrite rather than add, a small cap, and isolated or shared scope.

The learnings module is shaped so that the store sits beside it, not inside it. `learnings.ts` owns the repository layer (record, read, section). A `memory.ts` beside it would own the workbench layer, with its own section function. Both sections are built the same way and placed together in the prompts. Neither depends on the other. The store is not built here. It will need its own threat review: capture from outside-text runs, a forget screen, and where in `~/.botbench` it lives.

`OpenMausBot server/box-memory.ts` was read too. It is about RAM limits (cgroups and heap size), not about knowledge, so no approach was taken from it.

## Why

- **The repository, not a store, for the first slice.** The reason a change was rejected is project knowledge, and the north star is that a second workbench learns it too. git already moves it to every clone, with review and history, and Botbench builds nothing to share it.
  Rejected:
  - Storing it in SQLite and sending it to paired peers. That needs P5 and a new trust boundary, and it reaches only paired workbenches.
  - Writing it into the owner's checkout as an untracked file, as the first version of this slice did. That touched the owner's working tree, which Botbench never does. A lesson branch of Botbench's own carries the same file, reviewed and merged like any change, and leaves the owner's branches alone.
  - Committing it on the owner's branch or the default branch. Botbench never commits to the owner's branches, and the owner should review what every later prompt will read.
- **Only the note and the title.** These are the owner's own or owner-approved words. Anything else would let a stranger's issue write into every later prompt of the repository.
- **Update instead of duplicate.** Two files for one task title would drift apart, and the prompt cap would fill with repeats.
- **Bounded, framed as data.** A repository can hold many notes, and some may be hostile. The caps keep prompts small, and data blocks keep a note from posing as Botbench's words.

## Consequences

- A rejection with a note now adds a branch, `botbench-lesson/<workbench>/task-<id>`, to the repository, and nothing to the owner's checkout: `git status` and the current branch are as they were. The owner reviews the branch and merges it, or deletes it. That is the review step. Lesson branches the owner does not merge or delete stay in the repository until they do.
- A learning reaches later runs only once the owner has merged it into the branch their checkout is on (or the default branch every clone pulls). Until then, no planner or builder is given it.
- Every planner and builder on a repository with `docs/solutions/` reads up to 16,000 more characters of prompt.
- A committed learning reaches every later run on every clone. A wrong one misleads until it is deleted or edited.
- A repository whose `docs/solutions/` holds notes from other tools, such as ce-compound, gives those notes to Botbench's planner and builder too, newest first, under the same caps.

## Deferred

- The workbench memory store, its upkeep and its screen (the next slice, above).
- A planner that ranks notes by relevance to the work, as ce-plan's learnings researcher does. Newest first is enough while notes are few.
- Learnings from other events: an accept with a note, a review's findings, a failed check.
- A screen that lists the learnings or offers to commit one.
- Writing into a `docs_root` other than `docs/` (ce-compound's `.compound-engineering/config.yaml`).
