---
version: alpha
name: Botbench
# Generated: everything from here to the closing line is web/vendor/groundwork/design-tokens.md
# (Groundwork 0.4.0), unchanged. Do not edit it here. After a sync, copy that file over this block again.
colors:
  accent: "#1A1A1A"
  accent-hover: "#3D3D3A"
  on-accent: "#FAFAF9"
  surface: "#FAFAF9"
  surface-raised: "#FFFFFF"
  surface-sunken: "#F3F2EF"
  on-surface: "#171717"
  muted: "#737373"
  border: "#E5E5E5"
  border-strong: "#8A8A86"
  focus: "#1F5C99"
  success: "#1E6B3A"
  success-subtle: "#E8F2EA"
  warning: "#7A5200"
  warning-subtle: "#F7EEDC"
  danger: "#A8281F"
  danger-subtle: "#F9E9E7"
  info: "#1F5C99"
  info-subtle: "#E6EEF6"
colors-dark:
  accent: "#EDEDEB"
  accent-hover: "#CFCFCB"
  on-accent: "#171717"
  surface: "#141413"
  surface-raised: "#1C1C1A"
  surface-sunken: "#0E0E0D"
  on-surface: "#EDEDEB"
  muted: "#A3A3A0"
  border: "#2E2E2B"
  border-strong: "#6B6B67"
  focus: "#86B7EA"
  success: "#7CC796"
  success-subtle: "#15281B"
  warning: "#E0B45C"
  warning-subtle: "#2B2210"
  danger: "#F0928A"
  danger-subtle: "#331917"
  info: "#86B7EA"
  info-subtle: "#14243A"
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
  md: 8px
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
The interface is built from Groundwork, the shared design system vendored at `web/vendor/groundwork/` (read-only; changed in its own repository and synced). Before any UI work read `web/vendor/groundwork/rules/core.md`, and look each component up in `web/vendor/groundwork/components.json` before writing markup.
- Colour, border, radius, shadow and type come from `gw-` components. Screen markup uses Tailwind utilities for layout, spacing and sizing only.
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
