# ADR 0011: A headless library for interactive primitives (Base UI), and the rule for client dependencies

**The library choice here is superseded by [ADR 0012](0012-the-interface-is-built-on-shadcn-ui-and-tailwind.md): the interface is built on shadcn/ui (on Base UI) and Tailwind CSS. The rule for client dependencies below stands, and its table continues there.**

Date: 2026-11-23. Status: **accepted for the headless library**, by the owner's instruction to proceed, relayed to this session on 2026-11-23 with the words "If our product looks bad it won't get much attention, so let's not be super strict here"; **proposed for each optional addition** in "Optional additions", to be taken up when its work starts. Nothing is installed and no source is changed by this record; where it names a test, a rule or a line that is not in the repository yet, that is what the pull requests after it would add. The design system's side of the same decision is its `docs/adr/0001-a-headless-library-for-the-react-layer.md`.

## Context

- The audit of 23 November found that the interactive half of the design system (menu, select, combobox, popover, tooltip, hover card, sheet, tabs, toast) lacks what a headless library exists for: placement that avoids the edge of the screen, submenus, typeahead, delay groups, drag, and exits (the design system's `docs/audits/2026-11-23-skills-audit.md`, "What the C grades share" and decision 1).
- Its addendum measured that a closing dialog or popover is gone at once in Firefox 159 and WebKit 27.2, so every exit needs script outside Chrome (`docs/audits/2026-11-23-skills-audit-addendum.md`, section 7).
- The same section measured CSS anchor positioning, with its fallbacks, as working in all three engines, and says "collision-aware placement of overlays can be built on the platform". So placement alone is not a reason for a library. What the platform does not give is submenus, typeahead over several letters, delay groups, drag, and exits outside Chrome.
- The owner decided: a headless React layer for the interactive components, emitting the same `ds-` classes so the checker and the closed vocabulary carry on; the vanilla behaviour modules stay for an app without React; one library, not two.
- Botbench's client has two runtime dependencies today, `react` and `react-dom` (`web/package.json`). The server has none. `CLAUDE.md` says "zero runtime dependencies unless an ADR says why". This is that ADR.
- The design system ships React source that the app compiles. It publishes no npm package, so it cannot declare a dependency that npm would resolve. The dependency has to be declared where the code is compiled: here.

## Decision

1. **The library is Base UI**, the npm package `@base-ui/react`, at 1.9.0 or a later 1.x. It is the only one of the three compared that has every component on the owner's list, none of them exported under an unstable name in 1.9.0 (table below) [B1][B9].
2. **It is declared in `web/package.json`** as `"@base-ui/react": "^1.9.0"`, with the lockfile committed. The design system documents the same range as a requirement of its React files and does not install it for the app. The root `package.json`, the server, stays at zero runtime dependencies.
3. **Botbench's screens do not import it.** Only the design system's React files (`web/vendor/design-system/react/`) do. A screen imports those files, so the library can be replaced behind them (see "If the library is abandoned").
4. **Imports are by component path** (`@base-ui/react/menu`, not the package root), so a screen that uses a menu does not carry the combobox. The package sets `"sideEffects": false` and exports one path per component.
5. **The first pull request installs it for one component, the menu, and is not merged until two things are measured in it**: Botbench's own content security policy with the menu open (see "Security notes"), and the size of the built client before and after. Both go in that pull request's evidence. If the policy refuses the menu's placement, the pull request is closed and this record is revisited.
6. **Adoption is one component at a time**, in the numbered order of the design system's ADR ("Order of work"). A component that does not need the library does not get it.

## The rule for client dependencies

`CLAUDE.md`, Engineering standards, today:

> Dependencies and secrets: zero runtime dependencies unless an ADR says why. `npm audit` clean, lockfile committed, no secret or token in the repo, logs or responses.

Replacement, to be made in the pull request that installs the library, not in this one:

> Dependencies and secrets: the server has zero runtime dependencies. The client may have a small number, each one where it makes the interface clearly better and would be done worse by hand. Each is a row in the table of ADR 0011 (name, what it is for, licence, size, why not hand-built, how it would be replaced) before it is installed. None may make a network request or collect telemetry. `npm audit` clean, lockfile committed, no secret or token in the repo, logs or responses.

The design system's `AGENTS.md`, today:

> No runtime dependencies. Development dependencies are for tests (React and esbuild only build a test fixture) and for `npm run vendor`, which copies font and icon files from `node_modules` into `base/`. The build never reads `node_modules`.

Replacement:

> No runtime dependencies in the stylesheet, the tokens, the checker, the behaviour modules or the build. A file in `react/` may import a client dependency that is a row in the table of Botbench's ADR 0011 and is named in `docs/adr/0001`; the app installs it. Development dependencies are for tests (React, those client dependencies and esbuild only build a test fixture) and for `npm run vendor`, which copies font and icon files from `node_modules` into `base/`. The build never reads `node_modules`.

What changes: the client's bar moves from "none without an ADR each" to "few, each a row here with its reasons". What does not: the server stays at zero and nothing is added to it under this record; the audit and lockfile rules; no network use.

### The table

A row is added by a pull request that amends this record. "Size" is the registry's unpacked size, then the whole package minified and gzipped by Bundlephobia [S1]; neither is the cost in Botbench's build, which each installing pull request measures.

| Name | Status | What it is for | Licence | Size | Why not hand-built | How it would be replaced |
|---|---|---|---|---|---|---|
| `react`, `react-dom` ^19.3 | In use | The client | MIT | Not looked up for this record | | |
| `@base-ui/react` ^1.9.0 | Accepted | Menu, select, combobox, popover, tooltip, hover card, context menu, toast, sheet, dialog, tabs, disclosure | MIT [B2] | 10,377,319 bytes unpacked; 166,427 gzipped whole; about 130 kB gzipped for the full list by bundlejs [S3] | Submenus, typeahead, delay groups, drag and exits in three engines are the work the audit found missing | One file of the design system's `react/` at a time, behind the same props and `ds-` classes |
| `@tanstack/react-virtual` | Proposed: adopt when the transcript is virtualised | Rendering only the rows of a long transcript that are on screen | MIT [V1] | 65,103 bytes unpacked, and 690,700 for `@tanstack/virtual-core`; 10,773 gzipped | Measured row heights with the view held at the end while a reply arrives is easy to get subtly wrong; the library documents exactly that case [V3] | Behind `use-transcript.ts`; another virtualiser or none |
| A syntax highlighter (`sugar-high`, or `shiki` by language) | Proposed: adopt when code blocks and the diff are rebuilt | Colour for code in replies, tool output and diffs | MIT, both [H1][H2] | `sugar-high`: 102,775 unpacked; 11,507 gzipped. `shiki`: 601,994 unpacked without its grammars (`@shikijs/langs` 8,650,980) | A tokeniser for thirty-odd languages is not Botbench's work | Behind the code block's file; a block with no highlighter is plain mono text, as now |
| `diff` | Proposed: adopt when the diff is rebuilt | Word-level marks inside a changed line | BSD-3-Clause [D1] | 615,597 unpacked; 7,851 gzipped | A correct shortest-edit algorithm is a known, tested thing | One function call behind the diff component |
| `motion` | Not adopted | | | | See below | |
| `cmdk` | Not adopted | | | | See below | |
| `lucide-react` | Not adopted | | | | See below | |

## What was compared

Read on 2026-11-23. Versions, licences, dependencies and sizes are from the npm registry (`npm view`); the rest is from each project's own documentation and from the text of the published packages, downloaded to a scratch folder and searched, never run. Sources are numbered in "Evidence".

### Coverage of the owner's list

| Needed | Base UI 1.9.0 | React Aria Components 1.22.1 | Radix UI 1.8.1 |
|---|---|---|---|
| Menu with submenus and typeahead | Provided: `Menu`, `Menu.SubmenuRoot`; typeahead in the menu's source [B1][B9] | Provided: `Menu`, `SubmenuTrigger`. Typeahead is named only in one prop's description [A6] | Provided: Dropdown Menu, "Supports submenus", "Typeahead support" [R5] |
| Select | Provided [B1] | Provided [A1] | Provided [R1] |
| Combobox | Provided: `Combobox`, `Autocomplete` [B1] | Provided: `ComboBox` [A1] | Absent: no combobox among the 55 packages `radix-ui` depends on [R1] |
| Popover | Provided [B1] | Provided [A1] | Provided [R1] |
| Tooltip with delay groups | Provided: `Tooltip.Provider`, "once a tooltip becomes visible, the adjacent tooltips will be shown instantly" [B6] | Provided: a "warmup" delay, then "other tooltips display immediately". No delay prop was found on its page: the text read has no table under `TooltipTrigger` [A5] | Provided: `Tooltip.Provider` with `delayDuration` and `skipDelayDuration` [R6] |
| Hover card | Provided: `PreviewCard` [B1] | Provided: `PreviewTrigger`. Its page does not say whether it is stable [A7] | Provided: Hover Card [R1] |
| Context menu | Provided: `ContextMenu` [B1] | Provided, as `trigger="contextMenu"` on the menu's trigger, not as a component of its own [A6] | Provided [R1] |
| Toast stack | Provided: `Toast`, with a limit, a stacking index, swipe to dismiss and F6 to reach the region [B7] | Partial: exported only as `UNSTABLE_Toast`, `UNSTABLE_ToastRegion`, `UNSTABLE_ToastQueue` [A2][A8] | Provided: Toast [R1] |
| Sheet with drag to dismiss | Provided: `Drawer`, stable since 1.3.0 (12 March 2026), with `swipeDirection`, `snapPoints` and `modal={false}` [B5][B8] | Provided: `Sheet`, "swipeable", with `snapPoints`. First listed in 1.22.0, published 8 October 2026 [A1][A9] | Absent: no drawer or sheet among the packages [R1] |
| Dialog | Provided: `Dialog`, `AlertDialog` [B1] | Provided: `Modal`, `Dialog` [A1] | Provided: Dialog, Alert Dialog [R1] |
| Tabs and segmented control | Provided: `Tabs`; `ToggleGroup` and `RadioGroup` for a segmented control [B1] | Provided: `Tabs`, `ToggleButtonGroup` [A1] | Provided: Tabs, Toggle Group [R1] |
| Disclosure | Provided: `Collapsible`, `Accordion` [B1] | Provided: `Disclosure`, `DisclosureGroup` [A1] | Provided: Collapsible, Accordion [R1] |
| Count | 12 provided | 11 provided, 1 partial | 10 provided, 2 absent |

### The three libraries

| | Base UI | React Aria Components | Radix UI |
|---|---|---|---|
| Package and version | `@base-ui/react` 1.9.0, published 2026-10-09. 1.0.0 was 2025-12-11. `@base-ui-components/react` is the old name and is deprecated on the registry [B2] | `react-aria-components` 1.22.1, published 2026-10-09. 1.0.0 was 2023-12-20 [A2] | `radix-ui` 1.8.1, published 2026-10-12. 1.0.0 was 2022-12-21 [R1] |
| React 19 | Peer range `^17 \|\| ^18 \|\| ^19`; "Base UI supports React 17 and newer versions" [B2][B3] | Peer range `^16.8.0 \|\| ^17.0.0-rc.1 \|\| ^18.0.0 \|\| ^19.0.0-rc.1`. No sentence about React 19 on the page read [A2][A3] | Peer range includes `^19.0`; "Full React 19 compatability" in the release of 19 June 2024 [R1][R3] |
| Licence | MIT, Copyright (c) 2019 Material-UI SAS [B2][B10] | Apache-2.0 [A2] | MIT, "Copyright © 2022-present WorkOS" [R1][R2] |
| Who maintains it | A team of seven named on its About page; the repository is `mui/base-ui` [B3][B11] | Adobe; the repository is `adobe/react-spectrum` [A10] | The repository is `radix-ui/primitives`; its README names WorkOS only as copyright holder [R2][R7] |
| Releases | Eleven stable versions on the registry, 1.0.0 (2025-12-11) to 1.9.0 with one patch, 1.4.1: about one a month. The last six: 20 April, 19 May, 18 June, 4 August, 4 September, 9 October 2026 [B2][B5] | About one a month in 2026: 14 April, 28 May, 18 June, 31 July, 1 and 4 September, 8 and 9 October [A2] | The project's release page lists nothing between 13 August 2025 and 6 June 2026, then four entries in June and July 2026; the registry shows 1.7.0 to 1.8.1 on 5 to 12 October 2026 [R1][R3] |
| Exits | A closing popup stays rendered with `[data-ending-style]` "until its closing animation finishes". CSS transitions are the recommended form; CSS animations are "always detected". The source waits on the element's `getAnimations()`. `onOpenChangeComplete` reports the end [B4][B9] | `[data-exiting]`; components "wait for any animations to complete before being removed from the DOM"; "supports both CSS transitions and keyframe animations" [A4] | "suspend unmount while your animation plays out", shown with `@keyframes` only. The presence source listens for `animationstart`, `animationend` and `animationcancel` and has no transition listener, so an exit has to be a keyframe animation [R4][R8] |
| Placement | Its own copy of Floating UI's React hooks inside the package, on the packages `@floating-ui/react-dom` and `@floating-ui/utils`. Props `side`, `align`, `sideOffset` and collision options on each `Positioner` [B2][B6][B9] | Its own code in `react-aria`; no Floating UI in the dependency tree. Props `placement`, `shouldFlip`, `containerPadding`, `offset` [A2][A5] | `@radix-ui/react-popper` on `@floating-ui/react-dom`. Props `avoidCollisions`, `collisionBoundary`, `collisionPadding` [R1][R6] |
| Packages npm installs, itself included | 9 [B12] | 13 [B12] | 74 [B12] |
| Styling | No classes of its own and no CSS. `className` takes a string or a function of state; state is in `data-` attributes; a `render` prop swaps or composes the element [B13][B14] | "each component includes a default class name following the `react-aria-ComponentName` naming convention"; `className` takes a string or a function; state is in `data-` attributes [A4] | "Components ship without styles"; state is in `data-state` and `data-side` [R5][R9] |
| Accessibility practice, as stated | "adhere to the WAI-ARIA Authoring Practices"; "tested on a broad spectrum of browsers, devices, platforms, screen readers". No screen reader is named [B15] | Names what it tests: VoiceOver on macOS in Safari and Chrome, JAWS and NVDA on Windows in Firefox and Chrome, VoiceOver on iOS, TalkBack on Android [A11] | "tested in a wide selection of modern browsers and commonly used assistive technologies". None is named [R10] |
| Network use | No statement in the documentation. A search of the published `.js`, `.mjs` and `.cjs` text of 1.9.0 and of each of its eight dependencies for `fetch(`, `XMLHttpRequest`, `sendBeacon`, `new WebSocket` and `EventSource(` found no file. No package in the tree has an install script [B9][B12] | No statement on the pages read. The same search of `react-aria-components` 1.22.1 found no file; `react-aria` and `react-stately`, where most of its code lives, were not searched [A12] | No statement on the pages read. The same search of `radix-ui` 1.8.1 and two of its 55 packages found no file; the other 53 were not searched [R8] |
| TypeScript | Ships `.d.ts` and `.d.mts`. Every part has `Props` and `State` types under its name (`Tooltip.Root.Props`). Optional props are written `\| undefined`, which the design system's `exactOptionalPropertyTypes` fixture needs. 1.9.0 exports the `DataAttributes` and `CssVariables` types [B9][B16] | Ships types (`dist/types`). Not examined further [A2] | Ships `.d.ts` and `.d.mts`. Not examined further [R1] |

### Size

Three different numbers. None is the cost in Botbench's own build, which is measured in the first pull request.

| What the number is | Base UI 1.9.0 | React Aria Components 1.22.1 | Radix UI 1.8.1 |
|---|---|---|---|
| Unpacked size of the package on the registry: every file npm writes to disk, with both module formats, types and maps. Not what a browser loads [B2][A2][R1] | 10,377,319 bytes, 3,451 files | 6,935,582 bytes, 1,446 files (and `react-aria` 15,746,744, `react-stately` 5,910,496) | 105,530 bytes, 262 files (re-exports only; the code is in 55 further packages) |
| The whole package in one bundle, minified and gzipped, by Bundlephobia. An app that imports by component loads less [S1] | 166,427 bytes | 279,108 bytes | 74,339 bytes |
| One export bundled alone, minified and gzipped, by Bundlephobia. Each figure includes code the others share, so they do not add up [S2] | Menu 56,306; Combobox 46,978; ContextMenu 45,493; Select 41,117; Popover 37,540; Drawer 34,268; Tooltip 30,757; PreviewCard 29,999; Toast 23,707; Dialog 20,932; Tabs 11,738; Collapsible 6,658; ToggleGroup 5,810 | ComboBox 42,545; Select 29,453; Menu 25,315 (MenuTrigger 17,719 and MenuItem 18,717 are separate exports); Popover 21,657; Sheet 20,390; Modal 18,033; PreviewTrigger 15,375; Tab 15,157 | DropdownMenu 30,294; ContextMenu 30,427; Select 30,403; Popover 23,481; Tooltip 19,255; HoverCard 17,517; Dialog 13,199; Toast 11,743; Tabs 8,928; ToggleGroup 8,219; Collapsible 4,808 |
| Fifteen exports that cover the twelve items of the owner's list, in one bundle, React left out, minified and gzipped, by bundlejs [S3] | 393,951 bytes minified, 129,787 gzipped | Not established: the service returned an error on three tries | Not established: the service returned an error on three tries |
| `Menu` alone in one bundle, the same way, by bundlejs: what the first migrated component costs [S3] | 180,846 bytes minified, 61,222 gzipped | Not asked | Not asked |

For scale: the client built in the owner's checkout on 2026-11-23 is one script of 619,451 bytes, 174,410 gzipped (`web/dist/assets/index-oEhUVWQM.js`, measured with `gzip`). If every component on the list were imported, Base UI would add up to about 130 kB gzipped to that, and the menu alone about 61 kB, since most of the placement and focus code arrives with the first overlay. Base UI is the heaviest of the three per component by the Bundlephobia figures.

## Why Base UI

- **It is the only one that meets "one library".** Radix has no combobox and no sheet, so it would need a second package for each, which is the "two libraries" the owner ruled out. (A drawer built on Radix's dialog exists as `vaul` 1.1.2, MIT; the registry shows it last modified on 2024-12-14 [O3].) React Aria Components has everything but exports its toast only under an `UNSTABLE_` name, and its sheet is six weeks old.
- **Exits are done the way the addendum says they must be, by its documentation and source.** They say the library keeps the closing element in the page and waits, in script, for its animations to finish [B4][B9], so nothing would depend on `overlay` or `allow-discrete`, which Firefox and WebKit lack. This was not run in any engine for this record. The stylesheet keeps writing transitions; it gains `[data-starting-style]` and `[data-ending-style]` selectors.
- **It adds no class of its own** [B13]. The design system's files pass a fixed `ds-` class to each part and nothing else reaches the page. This is a small difference, not a deciding one: React Aria Components gives a part a `react-aria-` class only when the file gives it none [A4], so there an omission would show up as an unknown class.
- **The smallest tree.** Nine packages against thirteen and seventy-four; the nine are all MIT and none has an install script [B12].
- **Released about monthly**, with a stable 1.0 eleven months old [B2].

What speaks against it, plainly:

- **It is the heaviest of the three per component**, and the only measured figure for the full set is about 130 kB gzipped.
- **It names no screen reader it is tested with.** React Aria Components does, and is the stronger choice if that evidence is weighed above coverage. The design system has not run a screen reader in any engine either (`docs/browser-support.md`), so this gap is not closed by either side today.
- **It renders `<div>` elements with roles, not the native `<dialog>` and `popover` the design system uses now** ("Renders a `<div>` element" in the types of `Dialog.Popup`, `Menu.Popup` and `Drawer.Popup` [B9]). The design system's ADR says what that changes in its stylesheet and examples.
- **It has no table, tree or resizable panel.** React Aria Components has `Table` with a column resizer, `Tree` and `Virtualizer` [A1]. Those stay hand-built here (below).

## Alternatives, and why not

- **React Aria Components (Adobe).** The closest. Not chosen because the toast is `UNSTABLE_`, the sheet is new, it brings date, number and string internationalisation packages and "localized strings for 30+ languages" [A11] that an English-only tool does not use, and its whole-package figure is the largest. It would be the choice if the toast and sheet were hand-built, or if named screen-reader testing decides.
- **Radix UI Primitives.** Not chosen: no combobox, no sheet, exits by keyframe animation only, seventy-four packages, and a release page with no entry for ten months before June 2026.
- **Ariakit.** Not shortlisted: `@ariakit/react` is at 0.4.44 (published 2026-11-22), so there is no stable 1.0, and its component list has no toast, context menu or sheet [O1].
- **Headless UI (Tailwind Labs).** Not shortlisted: `@headlessui/react` 2.2.10 lists sixteen components with no tooltip, toast, context menu, hover card or sheet; its last publish was April 2026; and it depends on `@floating-ui/react`, `@react-aria/focus`, `@react-aria/interactions` and `@tanstack/react-virtual` [O2].
- **No library: script the exits and add vanilla behaviours.** The audit's stated alternative. Placement could stay on CSS anchor positioning, which the addendum measured in all three engines. Not chosen by the owner: it leaves submenus, typeahead over several letters, delay groups, drag and every exit to be written and tested here in three engines.
- **Two libraries, each for what it does best.** Ruled out by the owner.

## Consequences

**Supply chain**

- `web/package-lock.json` gains nine packages: `@base-ui/react`, `@base-ui/utils`, `@floating-ui/react-dom`, `@floating-ui/dom`, `@floating-ui/core`, `@floating-ui/utils`, `reselect`, `use-sync-external-store`, `@babel/runtime`. The optional peers `date-fns` and `@date-fns/tz` are not installed.
- `npm audit --prefix web` already runs in CI and fails on high or critical. It now covers those nine. An advisory against any of them blocks `main` until it is updated or the component is taken off the library.
- `NOTICE`, under "Bundled at build time", gains one line for Base UI (MIT, Copyright (c) 2019 Material-UI SAS) and one for the Floating UI packages, `reselect`, `use-sync-external-store` and `@babel/runtime` with their copyright lines, read from each package's licence file when it is installed. No file is copied into the repository, so "Copied files" does not change.
- Updates arrive by the existing Dependabot rule for `/web`: weekly, a release 14 days old at least, minor and patch grouped, majors ignored. A Base UI major is a deliberate upgrade with its own pull request, and the design system's range moves first.
- The design system states the range its files were tested with. A test to be added in the installing pull request compares that range with `web/package.json` and fails when they disagree.
- `docs/security/threat-model.md` has two passages the installing pull request rewrites, since both become untrue: "Botbench has no runtime dependency (CLAUDE.md)" in the part on the packages a release's lockfiles name, and the row on the vendored design system, which says it brings no dependency.

**If the library is abandoned**

- Every screen imports the design system's React files, and those emit `ds-` classes and ARIA. The stylesheet, the checker, the examples and the vanilla behaviour modules do not depend on the library.
- The exit path is one file at a time: rewrite a primitive on another library or by hand behind the same props and the same classes; the browser tests of that primitive say when it is done. No screen changes.
- Signs to act on: no release for six months, an open advisory with no fix, or a React major it does not support.

**Cost**

- The client grows. By how much is measured in the first pull request and recorded there; the upper figure known today is about 130 kB gzipped for the full set.
- The interactive components stop being framework-independent in their best form: an app without React keeps the behaviour modules, at their present level.
- The client now has a dependency that changes monthly. Each update is a pull request that runs the browser tests in three engines.

## Security notes

- **No new trust boundary.** The library runs in the owner's browser as part of Botbench's own client. It handles no credential, no agent output as code, and no approval decision: an approval is still answered by the server, through the permission check, whatever drew the button. The threat model's supply-chain passages are rewritten in the installing pull request (Consequences); no boundary is added.
- **A dependency that runs in the client.** It is code from npm in the page that shows approvals, so a compromised release could draw or press anything the owner can. The controls are the ones React already has here: the committed lockfile with integrity hashes, `npm audit` in CI, the 14-day cooldown, and no install scripts in the tree (checked on the registry for all nine).
- **No network call found.** This is a search result, not a promise by the project: the published text of 1.9.0 and its eight dependencies holds none of `fetch(`, `XMLHttpRequest`, `sendBeacon`, `new WebSocket`, `EventSource(` [B9][B12]. The search does not cover a dynamic `import()`, an element given a `src` or `href`, or a navigation. Botbench's policy (`default-src 'self'`, `src/api/static.ts`) refuses fetch, XHR, WebSocket, script, style and font requests to another origin whatever the code does; it does not stop a navigation.
- **The content security policy.** The policy has no `'unsafe-inline'`, so an inline `<style>` element is refused. Base UI's documentation says two parts render one, `ScrollArea.Viewport` and `Select` "when `alignItemWithTrigger` is enabled", and that `CSPProvider` with `disableStyleElements` stops it [B17]. The design system's files will set that and will not use the scroll area. The library also positions popups through the element's style; its documentation says that with client-only rendering "no inline styles are present in the initial HTML" [B17], and Botbench renders on the client only. Whether a popup is placed correctly under Botbench's real policy is not established here: it is the first thing the first pull request proves, in a test that serves the page with the real header and fails on any policy violation in the console.
- **Agent text.** Text from an agent or a repository that is shown inside a menu, tooltip or toast is passed as React children, as today, never as markup.

## What the library does not cover

Stays hand-built, in the design system or in Botbench:

- The transcript and following it (`use-transcript.ts`), a virtualised transcript, the prose renderer, the diff, the log viewer, terminal output.
- The tree, the resizable split panel and the data table. Base UI has none of the three.
- The approval card and the busy button: native buttons with ARIA, nothing to position or trap.
- The elapsed time, the activity announcer and the one live region for a run. Only the toast region's own `aria-live` comes from the library.
- The shortcut registry and its help overlay. The command palette is a composition (the library's dialog and combobox) with ranking and pages written here.
- The calendar and date field.

The new composite components of the approved visual direction:

| Composite | Needs the library | What it is built from |
|---|---|---|
| Evidence rows | No | Rows with the native disclosure. The library's collapsible only if a fold must animate in Firefox and a grid-row transition will not do: the addendum (section 7) found that Firefox does not move a height to `auto`. |
| Decision surface with five levels | No | Buttons, the busy button and the approval's markup. Its keys are Botbench's. |
| Work queue row | Not the row. Its actions menu and a right-click menu do. | A link row; `Menu` and `ContextMenu`. |
| Dense work table | Not the table. A row menu and a tooltip on a cut-off cell do. | A native `<table>`; sorting, column widths and virtualising are hand-built. |
| Intent choice cards | No | Native radio inputs, as the segmented control uses now. The segmented control itself stays native too. |
| Progress track | No | A list with the run's status set. |
| Docked sheet | Yes | `Drawer` with `modal={false}`, which the documentation describes as opting "out of focus trapping"; a docked use is not described as such there, so it is tried before it is promised [B8]. |

## Optional additions

Each was looked up on 2026-11-23 from the registry and the project's own pages. None was installed or run. Verdicts: adopt now, adopt when its work starts, or do not adopt.

| Addition | Candidate, version, licence | React 19 | Verdict |
|---|---|---|---|
| Motion | `motion` 14.14.0, MIT; it depends on `framer-motion` 14.14.0 (8,509,787 bytes unpacked), which depends on `motion-dom` (5,210,334) [M1] | Peer range `^18.0.0 \|\| ^19.0.0`; "only compatible with React versions `18.2` and higher" [M1][M2] | Do not adopt now. Look again when list motion in the work queue is built. |
| Syntax highlighter | `sugar-high` 2.7.0, MIT, no dependencies; `shiki` 4.6.0, MIT [H1][H2] | Neither needs React | Adopt when its work starts: `sugar-high` first. |
| List virtualiser | `@tanstack/react-virtual` 3.14.28, MIT [V1] | Peer range includes `^19.0.0` [V1] | Adopt when its work starts. |
| Diff computation | `diff` 9.0.0, BSD-3-Clause, no dependencies [D1] | Does not use React | Adopt when its work starts. |
| Command palette | `cmdk` 1.1.1, MIT [C1] | Peer range `^18 \|\| ^19` [C1] | Do not adopt. Base UI covers it. |
| Icons | `lucide-react` 1.78.0, ISC [L1] | Peer range includes `^19.0.0` [L1] | Do not adopt. Keep the sprite. |
| Typeface | IBM Plex Sans, or Geist; both SIL Open Font License 1.1 [F1] | Not a script | Do not adopt now. It is the owner's call, and `DESIGN.md` forbids it as written. |
| shadcn/ui | Not a dependency: component source to copy, MIT [U1] | | Use as a reference for structure. Do not take its styling. |

**Motion.** What it would be for: the dialog, sheet, list and approval entrances and exits.

- Entrances are already CSS in all three engines (`@starting-style`, addendum section 7), so the approval's entrance needs nothing.
- Exits of the dialog, sheet, menu, popover, tooltip and toast are what Base UI is adopted for: it holds the closing element while a CSS transition runs.
- What Motion has that those two do not: layout animation (a row sliding to its new place when a list reorders, inserts or removes), springs that can be interrupted mid-way, and drag. Drag for the sheet comes with Base UI's drawer.
- The cost by Motion's own figures: the `motion` component cannot be made "smaller than 43kb"; the lazy form is "just over 5kb" plus 24kb for the set with exit animations, or plus 38kb for the set with "pan/drag gestures and layout animations" [M3]. So the one thing it would be wanted for, layout animation, is the 38kb set. Bundlephobia gives 64,323 bytes gzipped for the whole package [S1].
- Judgement: for dialogs, sheets and the approval it would not look noticeably better than CSS transitions with the right easing and durations, which the audit's motion plan already specifies. For a reordering work queue it might. Same-document view transitions are supported in all three engines by the addendum's table and cost nothing; they are tried first. If rows still jump, Motion's lazy form is proposed then, with a measured size.

**Syntax highlighter.**

- Shiki is the accurate one (the grammars editors use) and the heavy one. Its own page gives the full bundle as "6.4 MB (minified), 1.2 MB (gzip), async chunks included" and the web bundle as "3.8 MB (minified), 695 KB (gzip)", and says "it's always better to use the fine-grained bundles" [H3]. Its JavaScript engine "doesn't require loading a large WebAssembly file" [H4]; the default engine is WebAssembly, which Botbench's policy has no allowance for.
- `sugar-high` is the light one: no dependencies, more than thirty built-in languages that can be imported one by one, 5.16 KiB gzipped for a TypeScript-only bundle by its own benchmark, token colours through CSS custom properties, which suits the system's tokens [H5].
- Verdict: `sugar-high` when the code block is rebuilt, a few languages only. Shiki by language with the JavaScript engine, loaded only when a block needs it, if `sugar-high`'s colouring proves too coarse on real transcripts.
- A condition for either: agent text is never set as markup here. Both libraries return HTML strings in their simplest use [H5]; the one adopted must be used through a form that gives tokens for React to render, or its output must be shown to escape every character of its input by a test. Which form each offers was not checked for this record.

**List virtualiser.** TanStack Virtual "does not ship with or render any markup or styles" [V2], so the rows keep the system's classes. Its documentation names Botbench's case: "Set `anchorTo: 'end'` for chat, logs, and reverse/inverted feeds", it "keeps an end-pinned viewport pinned when the last item grows during streaming output", and "the follow only happens if the viewport was already at the end before the append" [V3], which is the rule `use-transcript.ts` implements by hand today. The addendum's section 3 measured the cost of long transcripts without it. The alternative looked at, `virtua` 0.55.0 (MIT, no dependencies, 10,193 gzipped), has no 1.0 [V4]. Verdict: adopt when the transcript is virtualised; the pull request shows the addendum's numbers before and after.

**Diff computation.** `diff` is "a JavaScript text differencing implementation" with `diffWords`, which treats "each word and each punctuation mark as a token", on Myers' O(ND) algorithm; it ships its own types since version 8 [D2]. Botbench's diff shows what git produced, line by line; word-level marks inside a changed line need a second, smaller diff of the two lines, in the client. Its licence, BSD-3-Clause, is permissive and needs its notice kept, as MIT does. Verdict: adopt when the diff is rebuilt.

**Command palette.** `cmdk` "composes Radix UI's Dialog component" and depends on four `@radix-ui` packages [C1][C2], so it would bring a second headless library into the client, which the owner ruled out. Its registry entry was last modified on 2025-08-27. Base UI has the parts: `Dialog`, and `Autocomplete` ("Input with a filtered list of options") or `Combobox` [B1]. Ranking and nested pages are written here either way: `cmdk`'s README shows pages "implemented with simple state" by the app [C2]. Verdict: do not adopt.

**Icons.** `lucide-react` gives each icon as "a standalone component that renders an optimized inline SVG", tree-shaken to the icons imported [L2]. The design system already ships the same icons as one sprite: 42 icons from `lucide-static` 1.77.0, 11,360 bytes in Botbench's copy, one cached file, with the names the checker knows. Inline components would put each icon's paths in the script instead. Nothing would look different. Verdict: do not adopt; a missing icon is added to the sprite in the design system.

**Typeface.**

- Today: the Botbench theme sets `system-ui` and `ui-monospace`, and `DESIGN.md` says "Botbench loads no font of its own" and, under Never, "Inter or Roboto as brand type, or any font set by Botbench itself". So this is not adopted without the owner changing that line.
- What it would cost: the design system's copy already holds IBM Plex Sans as one variable file, Latin subset, 45,712 bytes, and IBM Plex Mono at three weights, 14,708, 14,888 and 15,620 bytes [F1]. One typeface for the interface is about 46 kB and one more request; with mono at two weights about 75 kB. No npm dependency is added: the files are already in the vendored copy and the theme would stop overriding them.
- What it would buy: the same letterforms, widths and figures on every device, so the dense table, the work queue and screenshots line up the same on a Mac, an iPhone and anything else; a recognisable look that the platform font, by definition, does not give. What it loses: the platform's own rendering, which is what readers of each device are used to, and a first paint with no font to wait for.
- Candidates, neither banned: **IBM Plex Sans** (SIL OFL 1.1, already in the copy and already measured against the system's tokens) and **Geist** (SIL OFL 1.1 by its Fontsource package, 5.3.0; its file size was not measured) [F1]. Plex is the cheaper to try, since it is a one-line change in the theme.
- Verdict: do not adopt now. If the owner wants a face of its own, try Plex in the theme on a branch and look at the real screens before deciding.

**shadcn/ui.** In its own words "This is not a component library. It is how you build your component library": it "hands you the actual component code" [U2]. That code is React components on a headless library, styled with Tailwind classes: "Components are styled using Tailwind CSS", and a manual install adds `class-variance-authority`, `lucide-react` and `tw-animate-css` [U3]. Its changelog has "Base UI as the Default" in July 2026 [U4]. Taking its components would put Tailwind utility classes and its own look where the `ds-` classes and tokens are, outside the closed vocabulary the checker holds. Its Base UI components are, though, a worked example of how the parts of each primitive are composed, and that is how to use it: read for structure when writing a file of the design system's `react/`, copy no styling, and list any file actually copied in `NOTICE`.

## Evidence

All read on 2026-11-23, local time (US Central); the last reads fell on 2026-11-24 UTC, which is why two rows show a push dated the 24th.

| | Source | What it gave |
|---|---|---|
| B1 | https://base-ui.com/llms.txt | The list of Base UI's components and release notes with dates |
| B2 | `npm view @base-ui/react` and `npm view @base-ui-components/react` (registry.npmjs.org) | Version 1.9.0, MIT, dependencies, peer ranges, optional peers, unpacked size 10,377,319, 3,451 files, `sideEffects: false`, the export map, publish dates, the deprecation of the old name |
| B3 | https://base-ui.com/react/overview/about | The team, "supports React 17 and newer versions", "unstyled, don't bundle CSS" |
| B4 | https://base-ui.com/react/handbook/animation | `data-starting-style`, `data-ending-style`, waiting for the closing animation, `keepMounted`, `actionsRef` |
| B5 | https://base-ui.com/react/overview/releases | Release dates; "Drawer is now stable" in 1.3.0 |
| B6 | https://base-ui.com/react/components/tooltip.md | `Tooltip.Provider`, `delay`, `closeDelay`, `timeout`; `side`, `align`, `sideOffset` |
| B7 | https://base-ui.com/react/components/toast.md | `limit`, `--toast-index`, `swipeDirection`, `priority`, F6 |
| B8 | https://base-ui.com/react/components/drawer.md | "Drawer supports swipe gestures to dismiss", `snapPoints`, `modal={false}` |
| B9 | The published package `@base-ui/react` 1.9.0 and `@base-ui/utils` 0.5.0 (`npm pack`, searched as text) | `useTypeahead` in `menu/root/MenuRoot.mjs`; `getAnimations` in `internals/useAnimationsFinished.mjs`; "Renders a `<div>` element"; `onOpenChangeComplete`; `aria-live: 'polite'` in the toast viewport; the type declarations; the changelog of 1.9.0; no network call |
| B10 | `LICENSE` in the package | MIT, Copyright (c) 2019 Material-UI SAS |
| B11 | `gh api repos/mui/base-ui` (api.github.com) | MIT, not archived, last push 2026-11-24 UTC, 350 open issues by search |
| B12 | `npm view <package> dependencies scripts`, followed through every dependency, and `npm pack` of Base UI's eight dependencies | 9, 13 and 74 packages; no `preinstall`, `install` or `postinstall` script in any; no network call in Base UI's eight; `"license": "MIT"` in the `package.json` of each of the nine |
| B13 | https://base-ui.com/react/handbook/styling | `className` as string or function, data attributes, CSS variables |
| B14 | https://base-ui.com/react/handbook/composition.md | The `render` prop |
| B15 | https://base-ui.com/react/overview/accessibility | The accessibility statements quoted |
| B16 | https://base-ui.com/react/handbook/typescript.md | `Props`, `State`, `ChangeEventDetails`, `Actions` types |
| B17 | https://base-ui.com/react/utils/csp-provider.md | Which parts render `<style>`, `disableStyleElements`, inline style attributes |
| B18 | https://base-ui.com/react/overview/quick-start.md | "Base UI is tree-shakable"; the package's rename |
| A1 | https://react-aria.adobe.com/llms.txt | The list of components; no context menu component; `Sheet` and `PreviewTrigger` |
| A2 | `npm view react-aria-components`, `react-aria`, `react-stately`; the published package 1.22.1 | Version, Apache-2.0, dependencies, peer ranges, sizes, publish dates, `UNSTABLE_Toast` in the exports |
| A3 | https://react-aria.adobe.com/getting-started | "does not include any styles by default"; no React version statement |
| A4 | https://react-aria.adobe.com/styling | Default class names, `data-entering`, `data-exiting`, waiting for animations |
| A5 | https://react-aria.adobe.com/Tooltip (read twice) | Warmup and cooldown, the `Tooltip` props table (`placement`, `shouldFlip`, `containerPadding`, `offset`; no `delay`), a `TooltipTrigger` heading with no table in the text read, "Tooltips are not shown on touch screen interactions" |
| A6 | https://react-aria.adobe.com/Menu | `SubmenuTrigger`, `trigger="contextMenu"`, typeahead named in `textValue` |
| A7 | https://react-aria.adobe.com/PreviewTrigger | "displays a non-modal popover on hover, focus, or long press" |
| A8 | https://react-aria.adobe.com/Toast | `UNSTABLE_` imports, landmark region, F6, focus restored |
| A9 | https://react-aria.adobe.com/Sheet | "a swipeable overlay", `snapPoints`, `swipeDirection` |
| A10 | `gh api repos/adobe/react-spectrum` | Apache-2.0, last push 2026-11-24 UTC, 552 open issues by search (the whole repository, Spectrum included) |
| A11 | https://react-aria.adobe.com/quality | The screen readers and browsers tested; "localized strings for 30+ languages" |
| A12 | The published package `react-aria-components` 1.22.1, searched as text | No network call in this package |
| R1 | `npm view radix-ui`, `@radix-ui/react-dropdown-menu`, `@radix-ui/react-popper` | Version 1.8.1, MIT, the 55 packages it depends on, peer ranges, sizes, publish dates |
| R2 | https://raw.githubusercontent.com/radix-ui/primitives/main/README.md | "Licensed under the MIT License, Copyright © 2022-present WorkOS" |
| R3 | https://www.radix-ui.com/primitives/docs/overview/releases | Release entries and dates; React 19 on 19 June 2024 |
| R4 | https://www.radix-ui.com/primitives/docs/guides/animation | "suspend unmount while your animation plays out", `forceMount` |
| R5 | https://www.radix-ui.com/primitives/docs/components/dropdown-menu | Submenus, typeahead, `data-state`, `data-side` |
| R6 | https://www.radix-ui.com/primitives/docs/components/tooltip | `delayDuration`, `skipDelayDuration`, collision props |
| R7 | `gh api repos/radix-ui/primitives` | MIT, last push 2026-10-14, 145 open issues by search |
| R8 | The published packages `radix-ui` 1.8.1, `@radix-ui/react-presence` 1.1.11, `@radix-ui/react-tooltip` 1.4.1, searched as text | Animation events only in presence; no network call in these three |
| R9 | https://www.radix-ui.com/primitives/docs/overview/introduction | "ship without styles", "tree-shakeable", `npm install radix-ui` |
| R10 | https://www.radix-ui.com/primitives/docs/overview/accessibility | The accessibility statements quoted |
| O1 | `npm view @ariakit/react`; https://ariakit.com/components | 0.4.44, MIT, published 2026-11-22; the component list |
| O2 | `npm view @headlessui/react`; https://headlessui.com/ | 2.2.10, MIT, last modified 2026-04-13, dependencies; the component list |
| O3 | `npm view vaul` | 1.1.2, MIT, depends on `@radix-ui/react-dialog`, last modified 2024-12-14 |
| M1 | `npm view motion`, `framer-motion`, `motion-dom`; `gh api repos/motiondivision/motion` | 14.14.0, MIT, dependencies, peer ranges, sizes; modified 2026-11-13 |
| M2 | https://motion.dev/docs/react-installation | "only compatible with React versions `18.2` and higher" |
| M3 | https://motion.dev/docs/react-reduce-bundle-size | 43kb, 5kb, +24kb, +38kb and what each set includes |
| H1 | `npm view sugar-high` | 2.7.0, MIT, no dependencies, 102,775 bytes, modified 2026-11-13 |
| H2 | `npm view shiki`, `@shikijs/core`, `@shikijs/langs`, `@shikijs/themes`; also `highlight.js` (11.12.0, BSD-3-Clause, 307,085 gzipped whole) and `prismjs` (1.30.0, MIT), looked at and not taken further | 4.6.0, MIT, dependencies, sizes, modified 2026-11-02 |
| H3 | https://shiki.style/guide/bundles | The bundle sizes quoted |
| H4 | https://shiki.style/guide/regex-engines | The JavaScript and Oniguruma engines |
| H5 | https://raw.githubusercontent.com/huozhi/sugar-high/main/packages/sugar-high/README.md | Languages, output, sizes, CSS custom properties |
| V1 | `npm view @tanstack/react-virtual`, `@tanstack/virtual-core` | 3.14.28, MIT, peer range, sizes, modified 2026-11-22 |
| V2 | https://tanstack.com/virtual/latest/docs/introduction | "does not ship with or render any markup or styles" |
| V3 | https://tanstack.com/virtual/latest/docs/api/virtualizer | `measureElement`, `anchorTo: 'end'` and the sentences quoted |
| V4 | `npm view virtua` | 0.55.0, MIT, no dependencies |
| D1 | `npm view diff` | 9.0.0, BSD-3-Clause, no dependencies, 615,597 bytes, modified 2026-04-13 |
| D2 | https://raw.githubusercontent.com/kpdecker/jsdiff/master/README.md | `diffWords`, the algorithm, types since version 8 |
| C1 | `npm view cmdk` | 1.1.1, MIT, four `@radix-ui` dependencies, peer range, modified 2025-08-27 |
| C2 | https://raw.githubusercontent.com/pacocoursey/cmdk/main/README.md | "Composes Radix UI's Dialog component"; pages by the app's own state |
| L1 | `npm view lucide-react`, `lucide-static` | 1.78.0, ISC, 40,042,183 bytes unpacked, peer range; 216,851 gzipped whole |
| L2 | https://lucide.dev/guide/packages/lucide-react | Tree-shaking, inline SVG, ISC |
| F1 | `web/vendor/design-system/fonts/` in this repository (file sizes, licence texts); `npm view @fontsource-variable/ibm-plex-sans`, `@fontsource-variable/geist` | The byte counts; OFL-1.1 for both; Geist package 180,843 bytes unpacked, all subsets |
| U1 | `gh api repos/shadcn-ui/ui` | MIT, last push 2026-11-23 |
| U2 | https://ui.shadcn.com/docs | The self-description quoted |
| U3 | https://ui.shadcn.com/docs/installation/manual | Tailwind, and the packages a manual install adds |
| U4 | https://ui.shadcn.com/docs/changelog | "Base UI as the Default", July 2026; Base UI, React Aria and Radix variants |
| S1 | `https://bundlephobia.com/api/size?package=<name>@<version>` | Whole-package minified and gzipped sizes |
| S2 | `https://bundlephobia.com/api/exports-sizes?package=<name>@<version>` | Per-export minified and gzipped sizes |
| S3 | `https://deno.bundlejs.com/` with `q=@base-ui/react@1.9.0`, `treeshake=[{Menu,ContextMenu,Select,Combobox,Popover,Tooltip,PreviewCard,Toast,Dialog,AlertDialog,Drawer,Tabs,ToggleGroup,Toggle,Collapsible}]`, React external | 393,951 bytes, 129,787 gzipped; with `treeshake=[{Menu}]`, 180,846 and 61,222. The full-set query for the other two returned an error |

## Not established

- That exits work in Firefox and WebKit with Base UI. The documentation and the source say how; nothing was run.
- Whether React Aria's tooltip takes a delay prop: none was found on its page, and the trigger's table was missing from the text read.
- The cost in Botbench's own build. Only services' figures are here.
- A comparable full-set figure for React Aria Components and Radix UI.
- Whether Base UI is tested against React 19.3 in particular; the statement found is "React 17 and newer" and the peer range `^19`.
- Which screen readers Base UI and Radix UI test with. Neither says.
- Whether a Base UI popup is placed correctly under Botbench's content security policy.
- That React Aria's and Radix's full trees make no network call: only the packages named in A12 and R8 were searched.
- Whether React Aria's `PreviewTrigger` and `Sheet` are considered stable; their pages do not say.
- For the optional additions: nothing but the registry and each project's pages. Not established: whether any of them makes a network request (none was searched as Base UI was; that search is a condition of each one's installing pull request); the size of any in Botbench's build; whether `sugar-high` or Shiki offers tokens rather than an HTML string in the form needed; Geist's file size; how Motion's layout animation compares with view transitions on the real work queue.
- How any of the three behaves in iOS Safari or with VoiceOver. Nothing was run; this record is from documentation, the registry and package text.
