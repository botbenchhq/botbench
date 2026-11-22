import type { Config } from "tailwindcss";
import preset from "./vendor/design-system/tailwind-preset.js";

/*
 * The design system (vendor/design-system) is the authority. Its preset replaces every Tailwind scale with the
 * system's tokens, and its stylesheet carries the reset, so preflight is off and this app writes no base-layer rule.
 * Screens use utilities for layout, spacing and sizing only; the static scan in `npm test` enforces it.
 */
export default {
  presets: [preset as Partial<Config>],
  corePlugins: { preflight: false },
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
} satisfies Config;
