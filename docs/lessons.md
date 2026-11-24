# Lessons

Patterns from corrections and misses, so they do not repeat. Newest first.

## 2026-11-23: a rename across the repository broke every test that replays a recording, and one test waited without end
The move to botbenchhq/botbench (#213) replaced the old address in the tests too. The sessions recorded from the real `gh` still name jon-lange/botbench, as they must, so replayed calls no longer matched: 21 tests of the fast suite failed, and one of them waited for a poll to be "checked" that had failed, under mocked timers, so `npm test` never ended. Three more tests had been failing since the 0.2.0 release: they wrote the installed version as "0.1.0" while installing this checkout's own files. Caught by running the suite on `main` with a time limit for each test. Rules going forward:
- A rename is not applied to `test/recordings/` nor to what replays it: a test that replays a recording names the repository the recording was captured from, with a comment where the name is set. A live test names the repository as it is today.
- After a search-and-replace, the whole fast suite is run and seen to end before the merge.
- A test that waits for an outcome ends the wait on every outcome, the failing ones too, and registers its clean-up before the first assertion.
- A test does not write as a number what it reads from this checkout (its version): it reads it.

## 2026-11-23: test runs left thousands of botbench-* folders in the temporary folder, and two timing tests failed under load (task 21 of run 17)
The owner's temporary folder held hundreds of `botbench-*` leftovers, and a sandboxed builder's thousands. Four causes: a probe file named by the shell's `$$`, which the test could not know to remove; `t.after` hooks run first in, first out, so a fixture that added its removal first removed the folder before the server or engine added after it had closed, and closing wrote `home/worktrees` back; a setup that threw (a socket the sandbox refused) before the fixture added its removal; and Playwright loading a test file once just to list its tests, so a folder made at the top of the file was made twice and removed once. Separately, the sign-in slow-down tests timed one request against a wait counted from the request before it, and a loaded machine spent that wait delivering the earlier answer. Rules going forward:
- Make temporary folders with `tempDir` (test/support/repo.ts, e2e/botbench.ts), or wrap `mkdtemp` in `removedAtEnd`: they are removed after every hook of the file at the latest. A file a test writes into the temporary folder is named by the test, which removes it.
- In a teardown, remove folders before checking anything with `expect`, and nothing made at the top of a Playwright file outlives it: make it in a fixture.
- `npm test`, `npm run test:live` and `npm run e2e` fail when a run leaves a `botbench-*` entry (test/no-leftovers.ts).
- A timing test bounds only what load cannot shorten: from sending one attempt to the answer of the next, not one request alone. An upper bound sits far from the wrong value (half of it), never near the right one. Check each by breaking the code it guards (no wait, a wait that does not grow, no reset) and seeing it fail.

## 2026-11-23: a builder was stopped for silence during its own long test run, and its scratch copy was committed (task 17 of run 16)
Inside Botbench's sandbox the engine tests that run check commands are skipped, so the builder made an unconfined scratch copy of `src` and `test` inside the task's copy to exercise them, then started the whole suite there in the foreground. It printed nothing for 10 minutes, Botbench stopped it for silence, and Botbench's commit of the copy took the scratch folder with it (later deleted). Rules going forward:
- A run that may take minutes goes in the background, or is cut to the files changed; nothing in the foreground waits longer than the silence limit.
- Scratch work inside a task's copy is committed with everything else when the turn ends. Keep it out of the copy where the sandbox allows, or delete it before the turn can end, and check `git show --stat` for it after a stop.

## 2026-11-22: a day of work went on things around the product before the product had proven its value (owner correction)
The owner: "we need to be doing least effort to prove value… you should get to functional milestones that you can then do into a browser test, like, hey, is this doing what we have as our North Star, yes or no?" Rules going forward:
- State the North Star in one sentence and the next functional milestone toward it. Each milestone has ONE end-to-end test that answers yes or no.
- Build the thinnest slice that makes that test pass. Polish, edge cases, extra variants, audits and documentation wait until the milestone is proven; say what was deferred.
- Independent work runs in parallel, each unit in its own worktree. Hold back only what depends on unfinished work.
- Use the product to build the product once it can: a real run on this repository is both progress and the best test.
- Report progress as milestones reached, not units merged.

## 2026-11-22: the expensive tests were run as if they were the cheap ones (owner correction)
Every unit ran the full browser suite at least twice (once by its builder, once again before merge), and 23 of its 41 tests start a real model turn. A unit cost about an hour, most of it waiting. The owner's correction: test constantly, but with cheap, fast tests; keep the big browser tests for the end, as the safety net. Rules going forward:
- **Shape.** Most tests are unit tests (pure functions, no process) and integration tests (real SQLite, real temporary git repository, real HTTP server, no model). They run in seconds and are the only tests run while building.
- **Lowest layer that can prove it.** A scenario is tested at the lowest layer that can fail for the right reason. Wording, ordering, state rules, validation and refusals are unit or API tests. A browser test exists only for what needs a browser: a journey across screens, live updates, focus, layout at phone width.
- **Live model turns are the smallest layer.** A live test proves one thing about the real CLI (a turn runs, a permission is asked, a sandbox blocks). It never carries assertions that a cheaper test could carry.
- **When each layer runs.** While building: the tests for the files being changed. Before a unit's commit: type checks, all unit and integration tests, and only the browser and live tests for what the unit touched. Once per batch of merged units, on `main`: the full browser and live suites, and any failure is fixed before the next batch.
- **No second full run.** A branch already on the latest `main` whose builder ran a layer is not run through that layer again by the reviewer; the reviewer reads the diff and runs the fast tests.
- **Spec to test.** Each acceptance example in the plan names the one test that proves it and that test's layer, before code is written.
- **Guard against hollow tests.** A fast test must be seen failing first, and its assertion must be on behaviour, not on the test's own setup.

## 2026-11-22: two ways a run could stand still for good, found by the critique (units 12 and 13)
The tests covered a cancel and a resume of the task at work, but not of a task parked on an answer across a restart: a cancel left it at building with nothing to end it, and a resume that gave up returned before the tasks behind it were started, so the run stayed running. Also, a command's time limit could still fire in the moment after it had ended by itself, recording a pass as timed out. Rules going forward:
- Every way a station can be left (done, failed, given up, cancelled, stopped, thrown) is followed to the line's next step; a `finally` carries the "go on" step, not the happy path.
- A cancel covers each state a task of the run can be in, parked included, and the test for it starts from that state.
- Once a process has ended, nothing changes how it is recorded as having ended.

## 2026-11-22: the build line's own tests hid what they meant to test (unit 12)
Three test mistakes, each caught by a failing run, not by reading. Eight tests across five files compared the schema version and the list of tables with literals (`9`, a fixed table list), so adding one migration broke them all for no reason of their own. The engine test of "an approval pending in task 1 keeps task 2 queued" pre-approved, in its shared run fixture, the very command the recorded turn asks for, so nothing was ever asked and the test could only time out. And "the background child of a timed-out command is gone" read a killed process as alive under load: a killed process stays in the table until its parent's exit lets the system clear it. Rules going forward:
- A test of the current schema compares with `MIGRATIONS.length` and reads the table list it needs; a literal version belongs only in a test of migrating from that version.
- A shared fixture grants nothing a scenario might need to be asked about. A test that waits for a card checks first that no grant covers the command.
- "Gone" for a process is waited for, with a limit, not read once after a kill.

## 2026-11-22: screens were labelled with Smelt's own engineering words (Botbench was then called Smelt)
The owner's correction: "I don't think anyone referred to a chat as a turn in the UI… This should be intuitive and familiar, anyone could approach this." The plan's domain terms are the names in code, and they had gone straight onto the screens: Turn, attempt, worktree, standing permission, pre-approved, Trust, driver, "Turn completed.", raw tool arguments as a transcript line, and server errors that spoke of the permission gate and the broker. The owner added a limit on the fix: "be careful when hiding certain things like tool calls… people like to see that as it builds trust, so don't just blindly change it." Rules going forward:
- A name in code is not a word for a screen. Every string a person sees, the server's included, takes its words from `docs/product/voice.md`, which says what each means internally and which words are never shown.
- The list is enforced, not remembered: the browser tests read every screen they reach for the banned words (`checkWords`, called by `checkDesign`), and a unit test reads every sentence the server builds. A new internal word goes into the glossary's third column, in that one place.
- Plain does not mean hidden or vague. Each action of the agent stays in the transcript as one line made from its real name and arguments; the command, output and change are one tap away, the raw arguments a level deeper, and what failed or waits is open. Where no true plain line can be made, the real name and argument are shown.
- Before naming a screen, a state or a button, look at what the products people already use call it (`docs/product/ui-copy-research.md`), and say which findings were verified.

## 2026-11-22: a cancelled run came back, and two screens promised a start nobody would make (unit 11)
Found by the critique pass, before merge. Start-up recovery read a run, awaited git, then wrote its state without reading it again, so a cancel in between was undone and the run could be approved. A planning worktree outlived a cancel followed by a kill, because recovery looked only at runs still planning. A queued task of an approved plan said "It starts when the tasks before it have finished" on its own screen, and a run waiting its turn said a planner was reading. A criterion could hold line breaks that the owner's screen folded away and the builder's prompt kept. Also: a live test of "the planner cannot write" passed nothing, because the model obeyed the prompt and never tried. Rules going forward:
- A state read before an `await` is read again, inside the write's transaction, before it is changed; ends are also made ends in the store.
- Clean-up at start goes by what is on disk, not only by what the rows say.
- When a unit adds a new way to reach an old state (a queued task nothing builds), every screen that shows that state is read again for sentences that are no longer true.
- Text the owner approves is the text that is sent: what a screen would fold or hide is refused at validation.
- A live test of an enforcement asks for the forbidden thing outright, through the same launch path, without the product's own prompt telling the model not to.

## 2026-11-22: a standing permission was wider than its card, four ways (unit 10)
Found by the critique pass, before merge. Tests were written first in every layer this time and all passed; the critic still got: `cat '~/x'` allowed three times earning a grant that ran `cat ~/x` (the word reader drops quotes, and a leading `~` is the one plain word a shell rewrites); `curl -d @.env …`, `npm publish` and `python3 -c …` offered standing permission, against "approvals before anything leaves the machine"; one repository's approvals counting for another after a link was re-pointed (the path was resolved again at every request); and a directory that was a link out of the worktree recorded by its name. Rules going forward:
- A fact that scopes trust (repository, directory) is resolved once, stored, and compared as stored. Resolving it again at use time lets whatever changed in between inherit the trust.
- When a reader throws information away (quotes, case, links), list what the thrown-away part could have changed, and refuse those cases where the result becomes lasting.
- A permission that outlives its task is checked against the hard rules as if nobody were watching: what could it send, publish or start, forever, with no card?
- Append-only is tested with `INSERT OR REPLACE` as well as `UPDATE` and `DELETE`.

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

## 2026-11-23: a competitive claim implied a capability nobody else has
The first competitive library said "none of the projects" does something and that Botbench "is alone". The owner asked for "not demonstrated in the projects and source reviewed". Rule going forward: a statement about competitors describes the projects and commits that were read, never the market, and Botbench never claims to be the only one.

## 2026-11-23: a document was called wrong from a commit title
The library said the README was out of date about Codex because a merged commit was titled "Make Codex a builder". The commit changed no behaviour, and the driver's declared capabilities said Codex cannot build. Rule going forward: before saying what Botbench can do, read the capability in the code (`src/drivers/*`, `src/engine/roles.ts`), not a title, a pull request description or an issue.

## 2026-11-24: the phone had no mark, and the screens were only tested with short content
The owner found on their phone that no screen under 1024px showed the Botbench mark: it stood only in the navigation's pane, which is not drawn there. The same day a list ran off the screen's edge because the test data had only short titles. Rule going forward: a part of the shell that one layout carries (the mark, the workbench, what waits) is checked at every layout, and a screen's browser test seeds long and many things (`e2e/stress.e2e.ts`, `e2e/fit.ts`), not only what fits.
