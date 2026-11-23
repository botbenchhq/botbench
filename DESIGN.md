---
version: alpha
name: Botbench
# Generated: everything from here to the closing line is web/vendor/design-system/themes/botbench.design-tokens.md
# (the design system 0.11.2, Botbench theme), unchanged but for the name above. Do not edit it here. After a sync, copy that file over this block again.
colors:
  accent: "#1C1C1E"
  accent-hover: "#3A3A3C"
  on-accent: "#FFFFFF"
  surface: "#F2F2F7"
  surface-raised: "#FFFFFF"
  surface-sunken: "#EDEDF1"
  fill: "#E9E9EE"
  on-surface: "#1C1C1E"
  muted: "#636366"
  border: "#E6E6EB"
  border-strong: "#86868B"
  focus: "#0066CC"
  success: "#037A54"
  success-subtle: "#DCF8E9"
  warning: "#736C02"
  warning-subtle: "#F3F2D7"
  danger: "#BA1C1C"
  danger-subtle: "#FEEBE8"
  info: "#2360E8"
  info-subtle: "#E9F0FF"
  approval: "#8F6202"
  approval-subtle: "#FEF3C7"
  blocked: "#6A31C4"
  blocked-subtle: "#F1EDFF"
  peer: "#03748F"
  peer-subtle: "#DCF5FE"
  tainted: "#BC4100"
  tainted-subtle: "#FFEBE5"
colors-dark:
  accent: "#F5F5F7"
  accent-hover: "#D8D8DC"
  on-accent: "#161618"
  surface: "#161618"
  surface-raised: "#212124"
  surface-sunken: "#0F0F10"
  fill: "#2C2C30"
  on-surface: "#F5F5F7"
  muted: "#A1A1A8"
  border: "#29292D"
  border-strong: "#75757C"
  focus: "#4C9DFF"
  success: "#34D399"
  success-subtle: "#09291D"
  warning: "#FDE047"
  warning-subtle: "#292306"
  danger: "#F25050"
  danger-subtle: "#2F1614"
  info: "#60A5FA"
  info-subtle: "#132438"
  approval: "#FBBF24"
  approval-subtle: "#2D2106"
  blocked: "#B285F8"
  blocked-subtle: "#261D35"
  peer: "#06B6D4"
  peer-subtle: "#002830"
  tainted: "#FB7C2E"
  tainted-subtle: "#341C0F"
typography:
  xs:
    fontFamily: "system-ui"
    fontSize: 12px
    fontWeight: 400
    lineHeight: 1.4
  mono:
    fontFamily: "ui-monospace"
    fontSize: 13px
    fontWeight: 400
    lineHeight: 1.5
  ui:
    fontFamily: "system-ui"
    fontSize: 15px
    fontWeight: 400
    lineHeight: 1.45
  lg:
    fontFamily: "system-ui"
    fontSize: 17px
    fontWeight: 400
    lineHeight: 1.4
  xl:
    fontFamily: "system-ui"
    fontSize: 22px
    fontWeight: 400
    lineHeight: 1.25
  2xl:
    fontFamily: "system-ui"
    fontSize: 28px
    fontWeight: 400
    lineHeight: 1.2
fontWeights:
  normal: 400
  medium: 500
  semibold: 600
rounded:
  sm: 10px
  md: 22px
  full: 9999px
spacing:
  xs: 4px
  sm: 8px
  md: 12px
  lg: 16px
  xl: 24px
  2xl: 32px
borderWidth: 1px
elevation:
  overlay: "0 8px 24px 0 rgb(0 0 0 / 0.16)"
elevation-dark:
  overlay: "0 8px 24px 0 rgb(0 0 0 / 0.5)"
motion:
  duration:
    fast: 100ms
    base: 160ms
    slow: 240ms
  easing: "cubic-bezier(0.2, 0, 0, 1)"
layers:
  sticky: 100
  overlay: 200
  dialog: 300
  toast: 400
sizes:
  touch: 44px
  column: 480px
  transcript: 720px
  wide: 1200px
breakpoint: 768px
---

# Design

Dense technical tool. Phone-first. One primary action per screen. Information over decoration.

## Overview
High-density developer interface. Closer to a well-made terminal or Linear than a friendly AI product. Minimal chrome. Status and evidence first.

## Design system
The interface is built from the owner's shared design system, vendored at `web/vendor/design-system/` (read-only; changed in its own repository and synced), under its Botbench theme (`themes/botbench.css`, loaded after `design-system.css`). The theme is dark by default: neutral grey surfaces, the platform's own typeface, pill-shaped controls, and a monochrome primary action (near-white in dark, near-black in light). Amber is a status only, Needs input. Settings offers Dark, Light and Match device, remembered on each device: the root always carries `data-theme` (`dark`, `light` or `auto`; never absent, since without it the page's `color-scheme` stays light), set before the first paint by the one inline script in `index.html` and kept by `web/src/app/appearance.ts`, which also sets the browser bar's colour for the mode shown. The header's mark (`web/src/brand/mark.tsx`, the Shared Seam monochrome mark) is inline and drawn in `currentColor`, so it follows the text colour in every mode; the two-tone mark, with its cyan second bracket, is for the app icons and the README only, since cyan in the interface means another agent. Before any UI work read `web/vendor/design-system/rules/core.md`, and look each component up in `web/vendor/design-system/components.json` before writing markup.
- Colour, border, radius, shadow and type come from `ds-` components. Screen markup uses Tailwind utilities for layout, spacing and sizing only.
- What the catalogue lacks is an app-local component under the `bb-` prefix, declared in `web/design-gaps.json`. Keep that list short.
- `npm test` runs the system's static scan and fails on a finding. `npm run e2e` runs its rendered check on every screen and open dialog.

## Tokens
Use only the values above. No arbitrary spacing, radii, or colors. The block is generated from the design system; a value changes there, never here. Typefaces: the platform's own (system-ui, and ui-monospace for code), as the theme sets them; Botbench loads no font of its own.

## Never
- Purple, indigo, or violet gradients (background or text)
- Gradient text
- Inter or Roboto as brand type, or any font set by Botbench itself (the theme's platform typeface is the one choice)
- Emoji as icons
- Identical feature cards (especially three-up)
- Glassmorphism or frosted panels
- Glowing or colored shadows
- Decorative orbs or abstract AI backgrounds
- Bounce or elastic hover effects
- Color as the only signal
- Centered body text wider than ~480px
- Shadows on every element

## Prefer
- Background shift or 1px border over elevation
- Density on runs board, transcripts, diffs
- 44px minimum touch targets
- Navigation that lists only existing screens
- Approval cards, status, and evidence over decoration

## Components
- Buttons: primary uses accent. One primary action per screen; an open dialog is a view of its own. An action repeated for each row of a list is never primary.
- Approvals: a view that shows one approval may make Allow its primary action. In a queue of several, each card is in its own list item and Allow is secondary.
- Cards: borderless or subtle background shift. No heavy borders + shadows. The one shadow is the system's, on overlays (dialogs) only.
- Inputs and diffs: readable at phone width. Mono for code, commands, paths and tool output; transcript prose is in the interface typeface, as the system's message component draws it.

Read this before any UI change. Tokens and bans override defaults.
