# ADR 0012: The interface is built on shadcn/ui and Tailwind CSS

Date: 2026-11-23. Status: **accepted by the owner's instruction to use the widely used stack; the spike's results are evidence, not a second approval.** It supersedes the library choice of ADR 0011 and keeps its rule for client dependencies.

## Context

- The owner, on 23 November 2026: "we should do the common-sense off-the-shelf items that are widely used", "shadcn, Tailwind CSS etc.", and "if our product looks bad it won't get much attention, so let's not be super strict here".
- ADR 0011, merged an hour earlier, picked Base UI used directly behind the design system's own `ds-` classes, and said of shadcn/ui "use as a reference, do not take its styling". That was the less common road. The owner prefers the widely used stack as it is, styling included.
- The two meet: since July 2026 shadcn/ui's default component library is Base UI ("Base UI is the default component library in shadcn/ui"; Radix remains, `-b radix`) [1]. So the primitives ADR 0011 chose stay; what changes is that shadcn/ui's components and Tailwind's utilities draw the interface.
- The owner chose the typefaces the same day: Inter for the interface, JetBrains Mono for code, self-hosted.

## Decision

1. New and rebuilt screens are built with **shadcn/ui components on Base UI, styled with Tailwind CSS 4**, themed to Graphite + Glacier (direction A of the approved visual specification) through shadcn/ui's CSS variables.
2. shadcn/ui is set up the standard way: `npx shadcn@latest init -d` (CLI 4.23.0, preset `base-nova`, `web/components.json`), components added with `npx shadcn@latest add <name>` and copied into `web/src/ui/`. They are Botbench's code from then on and are changed where the design asks (control heights, radii, no blur, no cookie in the sidebar).
3. Two departures from the CLI's defaults, each for a concrete reason:
   - **The `shadcn` package is not a dependency.** The CLI adds it for one 16 kB stylesheet (`shadcn/tailwind.css`). Kept, it brings about 210 packages and 4 moderate `npm audit` findings (minimatch through ts-morph). The stylesheet is copied to `web/src/styles/shadcn-tailwind.css` and listed in `NOTICE`; the CLI is run with `npx`.
   - **Its default typeface (Geist) is not installed.** The owner chose Inter and JetBrains Mono.
4. Old and new stand side by side, screen by screen. A rebuilt screen is at its own address with `?new=1` until it passes its tests; then the flag goes and the old screen is deleted. `web/src/screens2/routes.tsx` is the one switch.

### The dependency table (continues ADR 0011's; ADR 0011's rule is unchanged)

Versions and licences from `npm view` on 2026-11-23; weekly downloads from `api.npmjs.org/downloads/point/last-week` for 16 to 22 November.

| Name | Status | What it is for | Licence | Unpacked size; weekly downloads | Why not hand-built | How it would be replaced |
|---|---|---|---|---|---|---|
| `react`, `react-dom` ^19.3.1 | In use | The client | MIT | | | |
| `@base-ui/react` ^1.9.0 | In use | The primitives under shadcn/ui's components | MIT | 10,377,319; 32.2 M | ADR 0011 | One file of `web/src/ui/` at a time |
| `class-variance-authority` ^0.7.1 (with `clsx` 2.1.1) | In use | Variants of a component's classes | Apache-2.0 (clsx MIT) | 22,073; 88.5 M | It is what every shadcn/ui component is written with | A small function |
| `cn` ^0.5.2 | In use | shadcn/ui's class-merging helper, which its components import since September 2026 | MIT | 394,324; 25.8 M | Merging conflicting Tailwind classes correctly is a table of every utility | `clsx` with `tailwind-merge` |
| `lucide-react` ^1.78.0 | In use | Icons, as shadcn/ui's components import them | ISC | 40,042,183; 143.9 M | The components come with them; only imported icons are built in | The design system's sprite |
| `tw-animate-css` ^1.4.0 | In use | The enter and exit animations shadcn/ui's components name; CSS only | MIT | 47,012; 52.3 M | It replaced `tailwindcss-animate` in shadcn/ui [2] | Keyframes in the theme |
| `tailwindcss` ^4.3.5, `@tailwindcss/vite` ^4.3.5 | In use, build only | The stylesheet; replaces Tailwind 3.4, PostCSS and autoprefixer | MIT | 787,200 and 12,016; 190.1 M and 70.4 M | | |
| `@fontsource-variable/inter` ^5.3.0, `@fontsource-variable/jetbrains-mono` ^5.3.0 | In use, build only | The two typefaces' files; the Latin subset of each is built into the client and served by Botbench | OFL-1.1 | 1,909,049 and 203,866 | | Vendored `.woff2` files |
| `sonner`, `vaul`, `cmdk`, `@tanstack/react-table`, `@tanstack/react-virtual` | Not installed | Toasts, drawer, command palette, tables, long lists: shadcn/ui's documented companions | MIT, all | 2.0.8, 1.1.2, 1.1.1, 9.3.1, 3.14.28 | | Each is a row here, with the policy test below, before it is installed. `vaul` and `cmdk` build on Radix; prefer Base UI's `Drawer` and shadcn/ui's Base UI command component if it offers one |

Packages installed in `web/` (`npm ls --all --parseable | wc -l`): 99 before, 65 after, because Tailwind 3's tree is larger than Tailwind 4's and everything added. `npm audit`: 0 vulnerabilities before and after.

## What the spike proved

One real screen: a task that is ready for review, at `#/tasks/<id>?new=1`, with the app shell (shadcn/ui's sidebar), the verification result and its kinds of claim, the changed file with its diff from the API, the decision panel wired to the real accept, reject and run-checks-again requests, and the server's evidence states (current, out of date, the copy differs, no checks). Pictures: `docs/design/spike/`. `e2e/next-review.e2e.ts` runs it against a real Botbench process with tasks stored through the engine.

Size of the built client, bytes, raw and gzip -9:

| | Before | After |
|---|---|---|
| Script every screen loads | 629,803; 177,086 | 632,787; 178,357 |
| Script only the rebuilt screen loads | none | 228,589; 74,067 |
| Stylesheet | 202,536; 24,643 | 282,126; 36,977 |
| Typefaces (already compressed) | none loaded | 48,256 (Inter), 40,404 (JetBrains Mono) |

Tailwind 3.4 to 4: the JavaScript config, the design system's preset and PostCSS are gone; the six spacing utilities the old screens use are written by name in `web/src/index.css`. Tailwind's reset lies in a layer under the design system and its utilities over it (`web/src/styles/layers.css`). 26 of the old screens' browser tests, chosen for their design checks, passed on the new build (one of them only on a second run); the whole browser suite was not run.

## The content security policy

The policy is unchanged: `default-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; script-src 'self' '<hash of the appearance script>'`.

- **The screen runs under it with no violation**: the browser test records every `securitypolicyviolation` event and console error across the sidebar, tabs, collapsibles, a tooltip, the alert dialog and the phone's sheet, and finds none. It then writes a `<style>` element itself to show the record would have caught one.
- **Positioning works.** Base UI and React set styles through the element's style object, which the policy does not govern (it governs `style` attributes in markup and `<style>` elements). The tooltip is placed under its trigger in the test.
- **One thing is refused, and is avoided, not allowed.** Base UI's scroll area writes a `<style>` element: with it on the page Chrome reports `style-src-elem refused inline`, measured. The shell sets Base UI's `CSPProvider disableStyleElements`, and the scroll area component is not installed; a block that scrolls uses the browser's own scrolling. A select aligned to its trigger is the other documented case [3].
- **No policy change is needed, and none was made.** `sonner` and `vaul` are known to write `<style>` elements and were not tried: whoever adds a toast or a drawer runs this test with it first, and prefers a component that needs nothing. If one ever needs it, the narrowest change is a per-response nonce in `style-src-elem`, never `'unsafe-inline'`.
- No new trust boundary: the code runs in the owner's page, as React does. `docs/security/threat-model.md` must say so in the same pull request: its sentence "Botbench has no runtime dependency" is corrected in this change; its row on the vendored design system and a fuller pass (the copied components as a supply-chain item, the fonts) are still owed.

## Consequences

- **The vendored design system** becomes the source of the tokens and the theme, as the CSS variables shadcn/ui reads (today they are written in `web/src/styles/theme.css` from the approved reference stylesheet; they move into the design system when it has them), and of the product's own composites: evidence rows, the decision surface, the queue row. Its `ds-` CSS components are retired screen by screen as each screen is rebuilt. ADR 0011's plan to wrap Base UI behind `ds-` classes is dropped.
- **The checks.** The design system's static scan and the rendered `checkDesign` hold the closed `ds-` vocabulary. They still run on every old screen. Left out of the scan, by listing what is scanned in `web/design-system.config.json`: `web/src/ui`, `web/src/shell`, `web/src/screens2`, `web/src/styles`. `test/design-check-scope.test.ts` fails if any other file goes unscanned. For rebuilt screens the guards are: colours only through the theme's tokens (to be enforced by a lint of class names: no palette colour such as `bg-blue-500`, no arbitrary colour); the voice check, which runs unchanged; the browser test's own checks (no policy violation, control heights of 40 and 44px, nothing under 12px, no sideways scroll); and screenshots against the boards. The lint does not exist yet. When the last old screen is gone the scan and `checkDesign` are removed.
- **Migration order:** the review (here), then the shell's remaining destinations and Home, Work, the run, the chat, Settings. Each is a folder under `web/src/screens2/`.
- **Risks:** two styling systems in one page until the migration ends (the design system's element rules reach rebuilt screens; `theme.css` overrides them under `[data-ui="next"]`); the stylesheet grew by half; Tailwind 4 needs Safari 16.4, Chrome 111, Firefox 128 [4]; Base UI dialogs are `div`s with roles, not the native `<dialog>`, so focus, Escape and the inert background are the library's and were checked only in Chrome, with no screen reader; `light-dark()` in the theme needs Safari 17.5; copied components drift from upstream and are updated by hand; the product's safety and voice rules are not the library's and must be kept by each screen (the rebuilt review takes every evidence sentence and every allowed action from the server).
- **The task's screen** is rebuilt whole since the unit after this one (`web/src/screens2/task/`): the old screen and the `?new=1` address are gone. A note to the agent, bringing the branch up to date with main, Stop, Resume with a note and Discard are drawn with the new components. Still drawn with the design system's classes inside it, unchanged, until the screens they are shared with are rebuilt (`web/src/screens2/task/legacy.tsx`): the approval card, a draft to a paired workbench, outside text, checking together, the pull request, Make this a run, the commands allowed in advance, setup, the requests refused without asking, what the agent can do, and Details. The shell has the four layouts of the approved design: three panes from 1280px, two and a rail of icons from 1024px, one pane with the navigation behind a menu button from 768px, and one pane with the navigation as a bar at the foot under that; under 1024px a screen's pane is a sheet and its main action stays at the foot of the window.

## Alternatives

- **Stay on ADR 0011's plan** (Base UI behind `ds-` classes, the closed vocabulary kept). Fewer bytes of CSS and one styling system, but every component's look is written here. Not what the owner asked for.
- **shadcn/ui on Radix** (`-b radix`). Still supported, 74 packages against 9, no longer the default. No reason to choose it.

## Sources (read 2026-11-23)

1. https://ui.shadcn.com/docs/changelog/2026-07-base-ui-default and `npx shadcn@latest init --help` ("--defaults: --template=next --preset=base-nova"; `-b base, radix, aria`).
2. https://ui.shadcn.com/docs/tailwind-v4 ("Only new projects start with Tailwind v4 and React 19"; "We've deprecated `tailwindcss-animate` in favor of `tw-animate-css`"); https://ui.shadcn.com/docs/installation/vite; https://ui.shadcn.com/docs/installation/manual; https://ui.shadcn.com/docs/theming.
3. https://base-ui.com/react/utils/csp-provider (as cited in ADR 0011, B17).
4. https://tailwindcss.com/docs/upgrade-guide.
5. `npm view <package> version license peerDependencies dist.unpackedSize time.modified` for each package named; shadcn/ui itself is MIT (`shadcn` 4.23.0).
