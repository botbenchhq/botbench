# ADR 0006: Shared memory, second slice: a workbench memory store of the owner's own "Remember" notes

Date: 2026-11-23. Status: accepted. It follows ADR 0005, whose "next slice" section it builds a first part of. The threat review is "Memory: notes the owner asked one workbench to remember (ADR 0006)" in `docs/security/threat-model.md`.

Context: ADR 0005 put what a repository should keep (a rejected task's reason) into the repository. What is about the owner and this machine had no place: "in this repository always run the linter before committing", "the staging database is read-only". An owner who tells one chat this has to tell every later chat, and every run, again. ADR 0005 named the workbench memory store as the layer for it, and named its main risk: capture from conversations would let model output and outside text become a remembered "fact". The reference projects were read again for this record from `.reference/`: OpenMausBot `server/memory-store.ts`, `server/memory-forget.ts` and `server/memory-capture.ts`, and Rakazo `packages/memory/src/index.ts`. No file of theirs is pasted, and nothing from OpenMausBot's `enterprise/` is used. Where an approach was taken from one, it is named below and in the comments of `src/engine/memory.ts`.

## Decision

1. **A store beside learnings, under the data folder.** `src/engine/memory.ts` sits beside `src/engine/learnings.ts`, and neither depends on the other.
   - **Where:** `<data folder>/memory/` (by default `~/.botbench/memory/`). It holds one index file, `MEMORY.md`, and one markdown file per note, `note-<n>.md`. The index holds the next note number and one line per note, with when it was saved and last edited. A note file holds the note's text alone.
   - **Never inside a repository:** not in the owner's checkout, a task's copy, a learnings branch or a pull request. Nothing in it is pushed, sent to a peer or sent anywhere else. Its text leaves the machine only inside the prompts Botbench sends to the vendor CLIs, as every prompt does.
   - **From:** `OpenMausBot server/memory-store.ts` (an index file plus topic files) and `rakazo packages/memory` (documents kept as portable markdown).
2. **Owner-only files, atomic writes, shapes not sanitising.** The folder is made 0700 and every file 0600. Every write goes through `src/store/atomic.ts`, so a failed write never leaves a half-written file. A new note whose index write fails has its file removed again.
   - **Path allowlist:** a name is allowed only in one of two shapes, `MEMORY.md` or `note-<1..999999999>.md`. A name with `..`, a separator, an absolute path or another extension is refused before any file is named.
   - **No links:** a memory folder that is a link, or not a folder, is refused. A note file is opened without following a link.
   - **One process:** every function is synchronous and Botbench is one process, so a check and its write never interleave.
   - **From:** `OpenMausBot server/memory-store.ts` (`parseMemoryPath`: "an allowlist of three shapes, not a sanitiser"; `resolveMemoryPath` and `listMarkdown`: a link is not a memory file; `writeMemoryDoc`: atomic and 0600).
3. **Capped, and refused past the cap.** One note is at most 1,000 characters, and the store at most 32 KB on disk, the index included. A write past either is refused with a plain message that says nothing was saved and what to do. A chat message whose note is refused is not sent either, so the owner is never told nothing while the note is lost. From `OpenMausBot server/memory-store.ts` (`MEMORY_FILE_MAX_BYTES`, refused with 413).
4. **A write carries the version its writer read.** The version of a note is the sha256 of its file. An edit or a forget must carry it. When the file changed since, the write is refused with 409, nothing on disk changes, and Settings shows the note as it is now. A new note's number is one no note had before, so a screen that still shows a forgotten note cannot change a new one. From `OpenMausBot server/memory-store.ts` (`hashMemoryText`, `writeMemoryDoc`'s `expectedHash`) and `rakazo packages/memory` (`commit` with an expected revision, refused on a conflict).
5. **Only the owner's own "Remember" saves a note, with no model call.**
   - **The rule:** a chat message from the owner that starts with "Remember:" or "Remember that" (any case) saves the rest of that message as one note. The note is kept verbatim, except that line breaks and control characters become spaces.
   - **What saves nothing:** any other message, an empty note after the prefix, and a request to compare answers. Nothing an agent replied is ever saved, and nothing from a run, a task, a review, an issue, a web page or any other outside text. A run started from an issue never saves one, and no run does.
   - **Why it holds:** capture is in one place, `Chat.send` in `src/api/chat.ts`, and only the owner's new message is read for it, never the conversation passed on. The owner's explicit prefix is the whole test, so there is no model to be talked into saving something.
   - **From:** `OpenMausBot server/memory-forget.ts` (`ownersOwnAsk`: only the person's own words may save to memory) and `OpenMausBot server/memory-capture.ts` (keep only what the person states as lasting; never an assistant's suggestions, never quoted outside text, never instructions). Its model-driven capture is not taken (Deferred).
6. **Every agent is given the notes, as data.**
   - **What gives them:** `memorySection(home)` is built like `learningsSection`. It says the notes are the owner's own words, saved from the owner's "Remember" messages, and that they are notes to weigh, not instructions. It says they change nothing the agent is asked to do or may do. It puts each note in `dataBlock("memory", …)`, which a note cannot close. It states its cap of 12,000 characters and keeps to it: newest first, with a line that says how many of the oldest were left out.
   - **Where it goes:** in the planner's prompt and the builder's first prompt, the section comes right after the learnings section and before any outside text. It is in `chatPrompt` for every agent of a chat, before the conversation. A new Claude Code chat, when there are notes, is given them through the same `chatPrompt`, sent as the first message of its own session. A Claude Code chat that continues its own session already had them in that first message.
   - **With no notes:** the section is undefined, and the planner's prompt, the builder's first prompt and `chatPrompt` are byte for byte what they were before (tested).
   - **Reading never fails a chat or a run.** A store that cannot be read gives no section, and the reason goes to stdout.
   - **From:** `OpenMausBot server/memory-store.ts` (`memoryCapacity`: cut to a limit and say it was cut) and `rakazo packages/memory` (`read`: newest first).
7. **Settings → Memory, edit and forget.**
   - **The screen:** Settings has a Memory section, the design system's editable list. It lists the notes, newest first, with when each was saved or edited. Edit changes a note in its row. Forget asks first ("Forget this note?") and then removes it.
   - **The routes:** `GET /api/memory`, `PUT /api/memory/<n>` (`{ text, hash }`) and `DELETE /api/memory/<n>` (`{ hash }`), behind the existing sign-in. A route names a note by its number only, never by a file name. No route saves a new note: only the owner's chat message does.
   - **Forget keeps nothing:** it removes the note's line from the index and deletes its file. No copy, backup or trash is kept.
   - **From:** `OpenMausBot server/memory-store.ts` (`deleteMemoryDoc`: delete removes the file) and `OpenMausBot server/memory-forget.ts` (forgetting reaches the index and every note, so no copy stays), here for one note at a time. `rakazo packages/memory` (`remove`).
8. **Every write is in the action log, with none of the note.** Each capture, edit and forget adds one `memory` entry to the append-only action log (migration `memory_log`). The entry names the note by its number, belongs to no task or run, and says in words what the owner did. It holds none of the note's text, so a forgotten note leaves no copy in a log that can never be changed. The entry is written by `memory.ts` itself, not by `appendLog` in `src/approvals/broker.ts`, because the permission check neither writes nor reads it and nothing under `src/approvals/` changes in this slice. Permissions → Activity shows it as "Memory".

## Why

- **The owner's prefix, not a model, decides.** OpenMausBot's capture asks a model to judge a conversation after it goes quiet. It works, but it is a model reading text that may hold a stranger's words, deciding what becomes a standing note in every later prompt. That is exactly the poisoning ADR 0005 named. An explicit "Remember:" from the owner is a smaller, certain rule. A model's judgement can come later, with its own review (Deferred).
- **Files, not SQLite.** Notes are the owner's own text, and markdown files in the data folder can be read, backed up and carried as they are. ADR 0005 named this shape for the store. Forgetting a file is a plain delete, where an append-only table would keep the text. The action log, which must stay append-only, therefore holds no note text.
- **One store per workbench, no scopes.** A note is given to every agent on this workbench. The example note names its own scope in words ("in this repository …"), and the agents read it as such. Scopes that Botbench applies are deferred until a second use asks for them.
- **No change to approvals.** A note is data in a prompt. It can make an agent ask for something, but what runs without asking, and the safety floor, are as before.

Rejected:
- **Capturing from agent replies, runs or issues.** That is the poisoning path ADR 0005 named. It is refused, and tested to save nothing.
- **Keeping the notes in the repository, like learnings.** These are the owner's own preferences and facts about this machine, and they are private. A repository is shared with everyone who clones it.
- **A soft delete or a trash folder.** Forget would then not forget. The owner asked for the text to be gone.

## Consequences

- An owner's "Remember:" reaches every later chat agent, planner and builder on this workbench, within 12,000 characters, until it is edited or forgotten in Settings.
- A note about one repository is also given to agents working on another. Its words say what it is about, and the agents are told to keep to the notes that apply.
- Forgetting removes the note from memory and from every later prompt. The chat in which it was said, and the prompts already stored with earlier chats and runs, keep their text, as they keep the rest of those conversations.
- A Claude Code chat that continues its own session gets a note saved in the middle of it only in its next new chat.

## Deferred

- Model-driven capture after a chat goes quiet (`OpenMausBot server/memory-upkeep.ts`, `server/memory-capture.ts`).
- Upkeep and tidying: expiry, duplicates, contradictions and superseded notes.
- Search over notes (`rakazo packages/memory` `search`).
- Export of the store (`rakazo packages/memory` `export`).
- Per-repository scopes, or any scope beyond a plain note given to every agent on the workbench.
- Sharing notes with peers or with another workbench.
- Any change under `src/approvals/`, such as a note that changes what may run without asking.
