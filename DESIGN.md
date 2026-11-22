---
version: alpha
name: Botbench
# Generated: everything from here to the closing line is web/vendor/design-system/themes/botbench.design-tokens.md
# (the design system 0.7.0, Botbench theme), unchanged but for the name above. Do not edit it here. After a sync, copy that file over this block again.
colors:
  accent: "#AD5D02"
  accent-hover: "#914D01"
  on-accent: "#FFFFFF"
  surface: "#FAF8F4"
  surface-raised: "#FFFFFF"
  surface-sunken: "#EEEBE4"
  on-surface: "#121417"
  muted: "#535E6E"
  border: "#DDD8CE"
  border-strong: "#8F8B81"
  focus: "#CC6F01"
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
  accent: "#F59E0B"
  accent-hover: "#E18A0F"
  on-accent: "#121417"
  surface: "#121417"
  surface-raised: "#181B20"
  surface-sunken: "#0D0F12"
  on-surface: "#F8FAFC"
  muted: "#94A3B8"
  border: "#2B313B"
  border-strong: "#646B76"
  focus: "#F59E0B"
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
    fontFamily: "IBM Plex Sans"
    fontSize: 12px
    fontWeight: 400
    lineHeight: 1.4
  mono:
    fontFamily: "IBM Plex Mono"
    fontSize: 13px
    fontWeight: 400
    lineHeight: 1.5
  ui:
    fontFamily: "IBM Plex Sans"
    fontSize: 14px
    fontWeight: 400
    lineHeight: 1.4
  lg:
    fontFamily: "IBM Plex Sans"
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.4
  xl:
    fontFamily: "IBM Plex Sans"
    fontSize: 20px
    fontWeight: 400
    lineHeight: 1.25
  2xl:
    fontFamily: "IBM Plex Sans"
    fontSize: 24px
    fontWeight: 400
    lineHeight: 1.2
fontWeights:
  normal: 400
  medium: 500
  semibold: 600
rounded:
  sm: 4px
  md: 6px
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
breakpoint: 768px
---

# Design

Dense technical tool. Phone-first. One primary action per screen. Information over decoration.

## Overview
High-density developer interface. Closer to a well-made terminal or Linear than a friendly AI product. Minimal chrome. Status and evidence first.

## Design system
The interface is built from the owner's shared design system, vendored at `web/vendor/design-system/` (read-only; changed in its own repository and synced), under its Botbench theme (`themes/botbench.css`, loaded after `design-system.css`). The theme is dark by default, with an amber primary action; the root carries no `data-theme`, and no screen offers a light mode yet. Before any UI work read `web/vendor/design-system/rules/core.md`, and look each component up in `web/vendor/design-system/components.json` before writing markup.
- Colour, border, radius, shadow and type come from `ds-` components. Screen markup uses Tailwind utilities for layout, spacing and sizing only.
- What the catalogue lacks is an app-local component under the `bb-` prefix, declared in `web/design-gaps.json`. Keep that list short.
- `npm test` runs the system's static scan and fails on a finding. `npm run e2e` runs its rendered check on every screen and open dialog.

## Tokens
Use only the values above. No arbitrary spacing, radii, or colors. The block is generated from the design system; a value changes there, never here. Typefaces: IBM Plex Sans, and IBM Plex Mono for code, both served by Botbench itself.

## Never
- Purple, indigo, or violet gradients (background or text)
- Gradient text
- Inter, Roboto, or system-ui as brand type
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
