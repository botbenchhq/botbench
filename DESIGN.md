---
version: alpha
name: Smelt
colors:
  accent: "#1A1A1A"
  surface: "#FAFAF9"
  on-surface: "#171717"
  border: "#E5E5E5"
  muted: "#737373"
typography:
  ui:
    fontFamily: "Geist"
    fontSize: 14px
    fontWeight: 400
  mono:
    fontFamily: "Geist Mono"
    fontSize: 13px
rounded:
  sm: 4px
  md: 8px
spacing:
  xs: 4px
  sm: 8px
  md: 12px
  lg: 16px
  xl: 24px
  2xl: 32px
---

# Design

Dense technical tool. Phone-first. One primary action per screen. Information over decoration.

## Overview
High-density developer interface. Closer to a well-made terminal or Linear than a friendly AI product. Minimal chrome. Status and evidence first.

## Tokens
Use only the values above. No arbitrary spacing, radii, or colors.

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
- Buttons: primary uses accent. One primary action per screen.
- Cards: borderless or subtle background shift. No heavy borders + shadows.
- Inputs and diffs: readable at phone width. Mono for code and transcripts.

Read this before any UI change. Tokens and bans override defaults.
