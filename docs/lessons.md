# Lessons

Patterns from corrections and misses, so they do not repeat. Newest first.

## 2026-11-22: browser and live tests were written after the code (unit 4)
The API tests came first, but the live tests and most end-to-end tests were written after the code they exercise. Rule going forward: for every scenario, including live and browser ones, the test is written and seen failing before the code. A brief to a builder must say so for each test layer by name, and the report must give the failing output for each.

## 2026-11-22: stacked pull requests merged into the wrong branch (units 2 and 5)
Pull requests were opened against another feature branch. When the owner merged them, the code landed on that branch and not on `main`. Rule going forward: every pull request targets `main`. A unit that needs unmerged work waits, or its branch merges that work in and is still opened against `main`.

## 2026-11-22: a design direction was built before the owner's design file existed
A first UI reference used colours and type the owner then replaced with `DESIGN.md`. Rule going forward: read `DESIGN.md` before any UI work, and ask for it before inventing a direction when none exists.
