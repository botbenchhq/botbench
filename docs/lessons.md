# Lessons

Patterns from corrections and misses, so they do not repeat. Newest first.

## 2026-11-22: the first safety floor passed its own table and was walked round fourteen ways (unit 9)
Found by the critique pass, before merge. The floor's tests listed the dangerous commands as their author would type them, and the rules passed. A critic acting as the agent got past `rm -r` with an operand that starts with a dash (`rm -rf sub -x/../../outside`, checked against the real `rm`), reached guarded files through `~user`, `~+` and option values (`--output=/path`, `-o/path`, `of=/path`), pushed with `git subtree push` and a `git config alias`, and hid a command inside one quoted argument (`env -S 'sudo ls'`). Also: the server code was written before the live and browser tests, so their failing lines had to be taken against a copy of the previous source. Rules going forward:
- A rule that reads a command line is tested by someone trying to get round it, in a fresh context, running the real functions: not by its author's table alone. Every way round becomes a row in the table.
- A reader of command lines treats a word as a path wherever a program might: after `=`, glued to an option, and as an operand that starts with a dash. What the shell may rewrite (`~…`) is unknown, and unknown asks.
- Live and browser tests are written, and seen failing, before the first line of the code they exercise, the server's included.

## 2026-11-22: a process's start time was read in the wrong time zone, and "after a restart" was judged without a clock (unit 8)
Found by the critique pass, before merge. To tell its own surviving CLI process from an unrelated one under a reused number, Smelt compared the start time `ps` printed with the attempt's time; `ps` printed local time and Node read it in Smelt's own zone, so with a different `TZ` a survivor was left running beside a re-driven agent, or a stranger killed. And an answer the owner gave while start-up recovery was still running was taken for one left by the previous run, and thrown away. Rules going forward:
- A time taken from another program's output is asked for in UTC and read as UTC, and its test runs under two far-apart `TZ` values.
- "From the last run" is decided by comparing a stored time with this process's own start, never by "it was already there when I looked": the API answers while recovery is still running.

## 2026-11-22: a git process with no time limit left the New task screen on "Checking." (unit 6)
The owner entered a repository on an external drive. Smelt runs as a macOS login service, macOS did not let that service read the drive, and the `git rev-parse` behind `/api/repos/check` never returned: the screen stayed on "Checking.", "Start task" ended with "Smelt could not be reached", and five git processes were left under the server. Rules going forward:
- Any child process started on behalf of a request has a time limit and is killed, with its process group, when it passes it. The test for it uses a real process that really stalls (for git: a repository whose `.git/config` is a named pipe nobody writes to) and checks with `ps` that nothing is left.
- A client request that fills a status line has its own time limit, so no screen waits on the server without end.
- The service's environment is not a terminal's. Under launchd, external volumes, protected folders and the environment differ; a path that works in a shell can stall or be refused for the service. Check new file and process access as the service, not only from a terminal.

## 2026-11-22: browser and live tests were written after the code (unit 4)
The API tests came first, but the live tests and most end-to-end tests were written after the code they exercise. Rule going forward: for every scenario, including live and browser ones, the test is written and seen failing before the code. A brief to a builder must say so for each test layer by name, and the report must give the failing output for each.

## 2026-11-22: stacked pull requests merged into the wrong branch (units 2 and 5)
Pull requests were opened against another feature branch. When the owner merged them, the code landed on that branch and not on `main`. Rule going forward: every pull request targets `main`. A unit that needs unmerged work waits, or its branch merges that work in and is still opened against `main`.

## 2026-11-22: a design direction was built before the owner's design file existed
A first UI reference used colours and type the owner then replaced with `DESIGN.md`. Rule going forward: read `DESIGN.md` before any UI work, and ask for it before inventing a direction when none exists.
