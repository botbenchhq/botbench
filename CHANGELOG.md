# Changelog

## [0.3.2](https://github.com/botbenchhq/botbench/compare/v0.3.1...v0.3.2) (2026-11-24)


### Bug Fixes

* the paired conversation's bar is one line, and nine small leftovers of the redesign ([#248](https://github.com/botbenchhq/botbench/issues/248)) ([62a4959](https://github.com/botbenchhq/botbench/commit/62a4959bd30742a1f32e39a38f7fd6268513381a))

## [0.3.1](https://github.com/botbenchhq/botbench/compare/v0.3.0...v0.3.1) (2026-11-24)


### Bug Fixes

* long branches, paths, commands and file names stay readable and inside the task and run screens ([#243](https://github.com/botbenchhq/botbench/issues/243)) ([b5c932f](https://github.com/botbenchhq/botbench/commit/b5c932f110bd517a2597495e47efe79678261b91))
* long titles and names stay readable on Home, Work and New chat or task ([#242](https://github.com/botbenchhq/botbench/issues/242)) ([6f859e0](https://github.com/botbenchhq/botbench/commit/6f859e07f3f110e4c9de2c70ba5de1197467d294))
* on a phone, Home's lists stay inside the screen and long titles are cut short ([#240](https://github.com/botbenchhq/botbench/issues/240)) ([ff02c33](https://github.com/botbenchhq/botbench/commit/ff02c33ad152ddfe113236e87ee10449b793ea6f))
* the mark is in the top bar under 1024px, and the shell and Settings hold long and many things ([#246](https://github.com/botbenchhq/botbench/issues/246)) ([79ebcb7](https://github.com/botbenchhq/botbench/commit/79ebcb742c51d3fba60a6ebd528bd8966bff3fbe))
* Work's title keeps at least 45% of the table, and Home's rows give the title the row on a phone ([#244](https://github.com/botbenchhq/botbench/issues/244)) ([18a8f18](https://github.com/botbenchhq/botbench/commit/18a8f189805b7a9a30753dad04434a282ab6e217))

## [0.3.0](https://github.com/botbenchhq/botbench/compare/v0.2.0...v0.3.0) (2026-11-24)


### Features

* evidence is tied to the commit under review; out-of-date or differing evidence takes Accept away ([7bd1b25](https://github.com/botbenchhq/botbench/commit/7bd1b25beab8b5ec365c4d6a91cccdbcc77f2a62))
* shadcn/ui and Tailwind 4 as the interface's foundation, with the review screen rebuilt on them (ADR 0012) ([#228](https://github.com/botbenchhq/botbench/issues/228)) ([5a732cd](https://github.com/botbenchhq/botbench/commit/5a732cd0f84b76b73a1dbeab50aff572b24ab1c4))
* the redesigned interface: Home, Work, tasks, chat, runs and Settings on the new stack ([5faceaf](https://github.com/botbenchhq/botbench/commit/5faceafb73b9ba005c9f16da7dc44b1bef16b5ad))
* the run screen rebuilt: the plan as cards, the run's controls as a menu ([2ca64b9](https://github.com/botbenchhq/botbench/commit/2ca64b9658fa83afe04dce4a1867a45031a13fa8))
* the two-tone mark is the product's mark in the interface ([#230](https://github.com/botbenchhq/botbench/issues/230)) ([387555d](https://github.com/botbenchhq/botbench/commit/387555d9ea1203db2d94b710721a3af48dbe434e))


### Bug Fixes

* a button stays enabled and focused while its action runs ([f907eab](https://github.com/botbenchhq/botbench/commit/f907eabc5c2b3274852c86c039f6b2eb37b02474))
* dates, clocks, durations and plurals follow the reader's region ([62b55f1](https://github.com/botbenchhq/botbench/commit/62b55f18ef928f009664e627e7dc505642e641c3))
* the page can be zoomed, Enter sends, tabs are named, focus lands on arrival, and unsaved plan edits are guarded ([0f31463](https://github.com/botbenchhq/botbench/commit/0f314633ca7ea38578e7570f341c52f39ec2efc6))
* the paired-workbench journey, Discard after a failed setup and arrival focus work again on the redesigned screens ([#238](https://github.com/botbenchhq/botbench/issues/238)) ([df30944](https://github.com/botbenchhq/botbench/commit/df309444ceac0cf5ae8c45064c2782449020e91e))

## [0.2.0](https://github.com/jon-lange/botbench/compare/v0.1.0...v0.2.0) (2026-11-23)


### Features

* versioned releases with release-please, and Botbench updating itself to a published release ([#183](https://github.com/jon-lange/botbench/issues/183)) ([1b35315](https://github.com/jon-lange/botbench/commit/1b35315006ffc6339a384f1cf8601b5f16d055f6))


### Bug Fixes

* Codex reviews and chats no longer fail with "Codex can only review or chat" ([#200](https://github.com/jon-lange/botbench/issues/200)) ([10733b7](https://github.com/jon-lange/botbench/commit/10733b7f55f10d8e67882bac8bd0a0578a8eae87))
* the rows API test no longer drives a real build, and API tests close the server before removing its folder ([#204](https://github.com/jon-lange/botbench/issues/204)) ([a554711](https://github.com/jon-lange/botbench/commit/a5547119ca2ef5b56e42c58b3ba3a4ae83079262))
