# Learnings

This folder holds short notes on lessons from earlier work on this repository. Botbench gives them to the planner and the builder of every later run here (`docs/adr/0005-shared-memory-learnings-and-store.md`).

## Where a note comes from

When you reject a task in Botbench and write a note, Botbench saves that note to a file here: `rejected-<task title>.md`. Each file has frontmatter (title, date, the task's number) and three sections: what went wrong, the reason, and how to recognise it next time. If you reject a task with the same title again, your new note is added to the same file as a dated line.

The file holds only your note and the task's plan title. Nothing from the task's prompt, an issue or its comments is ever written to it.

## Reviewing a new note

Botbench never writes into your checkout. It commits the file on a branch of its own, `botbench-lesson/<workbench>/task-<number>`, which starts at the commit the task started from and holds only that file's change. Your files, your current branch and `git status` are as they were. Nothing is pushed or merged. The rejection's entry in Activity names the branch and the file. Read the branch, then:
- **keep it:** merge it like any change, so later runs here, every clone of the repository and every other workbench learn from it;
- **improve it:** edit the wording on the branch, or after merging, then commit it;
- **drop it:** delete the branch.

A note reaches later runs only once you have merged it. Until then no planner or builder is given it.

## Removing a stale or wrong note

Delete the file, or edit it, and commit that like any other change. There is nothing else to clear: the next run reads this folder as it is.

## What a run reads

- **Which files:** every `.md` file here, and in one level of subfolders, except this README.
- **Order and limits:** newest first by `last_updated`, else `date`, at most 10 notes and 16,000 characters in all. The prompt says how many were left out.
- **Skipped files:** a file with no frontmatter or no real `date`, one over 1 MB, and a link are skipped. A note over 4,000 characters is given with its start and its end, where the newest reason is.

Notes written by hand, or by other tools in the same form (compound-engineering's `ce-compound`), are read the same way.
