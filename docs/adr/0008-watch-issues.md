# ADR 0008: Watch a repository for labelled issues

Date: 2026-11-23. Status: accepted. Issue #73. The threat review is "Watching a repository for labelled issues" in `docs/security/threat-model.md`.

Context: a run can start from a GitHub issue the owner names in the composer (Intake, B14). The owner wants the issues that are ready for Botbench to show up without having to look for them. Maintainers mark them with a label. Botbench must not start anything by itself.

## Decision

1. **A background poller, one per store.** `src/engine/watch.ts` runs one registered watch per store, started with the server and stopped before the store on shutdown. Each repository whose settings have `"watch": { "label": "...", "intervalMinutes": 10 }` gets its own timer. It is polled at start, then at its interval. A poll asked for while one is under way is that one, so a repository is never polled twice at once. This is the shape of paperclip's `chat-channels/github/chat-github-cloud-ingress.ts`: one registered poller, a timer per source, an in-flight guard. No code was copied.
2. **The owner's gh, read only.** A poll runs the owner's `gh issue list --label=<label> --state=open --json=number,title,author,url,labels`, through `RunGh` with its 1-minute limit. Nothing is written to GitHub. When that fails on GitHub's limits, one `gh api -i` read gives the status and headers. A 429, or a 403 with retry-after or x-ratelimit-remaining 0, waits until GitHub says. Otherwise a capped backoff applies. This rewrites the approach of paperclip's `chat-channels/github/retry.ts` (`githubProviderRetry`, `githubRetryDelay`) in Botbench's terms, with no dependency. Any other failure shows on Settings and Work with what gh said and the next try. Nothing is stored, and the next interval tries again.
3. **The label is the gate.** Only open issues of the same repository that carry the label are kept. Pull requests and closed issues are dropped (approach from paperclip's `chat-github-events.ts`: keep an event only about the one source and kind asked for). Whoever can apply the label decides what is proposed, and anyone with triage access can, so the label is not trust: Settings says so, and each proposal shows who wrote the issue and how GitHub says they relate to the repository (`author_association`, read once when the issue is first seen).
4. **The seen table.** `watched_issues` holds each issue once, by (repository, number), with when it was first seen. Its state is `proposed`, or `dismissed` once the owner dismisses it, never back. Rows are never deleted. An issue already in the table is never proposed again, after a restart too. A row is the durable claim, written once, and the timer only says when to look again, as in paperclip's task checkout and heartbeat services.
5. **A proposal starts nothing.** Work lists each proposal with its title and author as plain text, and Start and Dismiss buttons. Start opens the composer's From an issue row with the issue attached. From there, today's rules for a run from an issue apply: semi-autonomous at most, plan approval, outside text. A proposal leaves Work when a run is started from its issue or it is dismissed. Each new proposal sends one notification, "An issue is ready to start", with nothing of the issue in it.

## Consequences

- The watch is set in the settings file, which Botbench never writes. Settings shows it but does not change it.
- A poll sees at most 1,000 labelled open issues; gh pages through GitHub's answers of 100 up to that.
- After GitHub's GraphQL limit, which the REST headers do not show, the watch waits the capped backoff rather than the exact reset.
- Rejected: webhooks, which would need a public address (Never); GitHub Actions, which would put Botbench's trust in a hosted runner; and starting a run automatically, which the issue rules out.
