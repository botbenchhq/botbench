# Security policy

## Reporting a problem

Please report a security problem privately, through GitHub's private vulnerability reporting: open the repository's
**Security** tab and choose **Report a vulnerability**, or go to
<https://github.com/botbenchhq/botbench/security/advisories/new>. Do not open a public issue, pull request or
discussion for it.

Say what you found, how to reproduce it, and what someone could do with it. Botbench is built by one person in spare
time, so there is no fixed time for an answer, but every report is read, and you are credited in the advisory unless
you ask not to be.

## Supported versions

Only `main` for now: fixes land there. There are no releases yet. When there are, this section will say which
versions get fixes.

## How Botbench is meant to run

Read a report in light of this:

- **On the owner's own Mac.** One person, one installation. The server listens on `127.0.0.1` only. A phone reaches
  it through a private network that gives the Mac an HTTPS name, such as Tailscale, and every device must be signed
  in.
- **It drives the coding tools the owner already has** (Claude Code, Codex, Gemini CLI, Grok, Antigravity) and never
  reads or stores their sign-ins. API-key variables are removed from what an agent starts with.
- **Commands an agent runs are confined** with macOS's own sandbox: they may write only in the task's copy and reach
  only the hosts the owner allowed. A task's separate copy (a git worktree) separates changes; it is not a sandbox
  on its own.
- **Nothing leaves the Mac** except what each coding tool sends its own provider, and a push or pull request the
  owner chose. Botbench pushes only a task's own branch, never the default branch, never by force, and never merges.

## What the threat model covers

[`docs/security/threat-model.md`](docs/security/threat-model.md) is the full list, by trust boundary (STRIDE). It
covers:

- The HTTP API and signed-in devices: sign-in, sessions, the phone, live updates.
- The coding tools as child processes, the permission check between them and the Mac, the safety rules every
  command passes, approvals and standing permissions, and the modes (manual, semi-autonomous, fully autonomous).
- The confinement of commands with `sandbox-exec`, and each tool's own sandbox where Botbench uses it.
- Repository content as untrusted data: files, settings and hooks in a repository, GitHub issues and their comments.
- Delivery to GitHub with the owner's own `git` and `gh`, watched repositories, and peer workbenches that see or
  message each other.
- The data folder `~/.botbench`, notifications to the phone, dictation, and model output drawn on screen.

In scope, for example:

- A way for a repository, an issue, a web page or a model's output to run a command, read a file or reach a host that
  Botbench's rules do not allow, or to get round an approval.
- Leaking a sign-in, a session, the login token or a device key (to logs, the database, a response, a pull request or
  another workbench).
- Signing in, or acting as a signed-in device, without the owner's consent.
- A push to a branch other than the task's own, a forced push, or a merge.

Out of scope:

- Problems that exist only because Botbench was put on the public internet against the guidance above.
- Problems in the coding tools themselves, or in their providers. Report those to the vendor.
- What a vendor's provider keeps of the prompts and code its own tool sends it.
