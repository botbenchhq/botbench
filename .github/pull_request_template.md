## What and why

<!-- What does this change, and why? Link the issue: "Fixes #123" or "Part of #123". -->

## How it was checked

<!-- The tests added or changed, and their counts from the run. Any check by hand: on the phone, light and dark.
Say what was not checked, and why. -->

## Checklist

- [ ] `npm run typecheck` and `npm test` pass. The browser suite (`npm run e2e`) ran once at the end if the screens
      changed.
- [ ] Tests come first, use a real temporary git repository, real SQLite and a real HTTP server, and need no network
      or sign-in. Live tests (`test/live/`) only for what needs the real coding tool.
- [ ] Nothing fake: no mocks, fake tools, demo data or empty screens. A control or status only when the behaviour
      behind it exists.
- [ ] No new runtime dependency (or an ADR in `docs/adr/` that says why).
- [ ] No secrets or personal details: no tokens, keys, cookies, `.env` files, email addresses or `/Users/<name>`
      paths.
- [ ] Words a person sees follow `docs/product/voice.md`; screens follow `DESIGN.md` and the design system.
- [ ] A new or changed trust boundary is in `docs/security/threat-model.md`.
- [ ] Files copied from another project are listed in `NOTICE`.
