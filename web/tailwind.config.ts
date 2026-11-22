import type { Config } from "tailwindcss";

/*
 * DESIGN.md is the authority. Every scale below REPLACES Tailwind's default
 * (nothing is under `extend`), so only the design tokens exist as classes.
 */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    colors: {
      accent: "#1A1A1A",
      surface: "#FAFAF9",
      "on-surface": "#171717",
      border: "#E5E5E5",
      muted: "#737373",
      transparent: "transparent",
      current: "currentColor",
    },
    spacing: { 0: "0", xs: "4px", sm: "8px", md: "12px", lg: "16px", xl: "24px", "2xl": "32px" },
    borderRadius: { none: "0", sm: "4px", md: "8px" },
    borderWidth: { DEFAULT: "1px", 0: "0" },
    fontFamily: {
      ui: ['"Geist"', '"Helvetica Neue"', "Arial", "sans-serif"],
      mono: ['"Geist Mono"', "ui-monospace", "Menlo", "monospace"],
    },
    fontSize: { ui: ["14px", "1.4"], mono: ["13px", "1.5"] },
    fontWeight: { normal: "400", medium: "500", semibold: "600" },
    boxShadow: { none: "none" },
    outlineOffset: { xs: "4px" },
    textUnderlineOffset: { xs: "4px" },
    backgroundImage: { none: "none" },
    // Sizes that are not spacing: the 44px touch target and the reading column.
    minHeight: { 0: "0", touch: "44px", screen: "100dvh" },
    minWidth: { 0: "0", touch: "44px" },
    maxWidth: { column: "480px", transcript: "720px", full: "100%" },
    maxHeight: { input: "160px" },
    height: { screen: "100dvh" },
  },
} satisfies Config;
