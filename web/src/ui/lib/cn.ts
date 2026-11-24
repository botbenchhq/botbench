import { createCn } from "cn/config";

/*
 * The class merger every shadcn/ui component imports as "cn" (vite.config.ts sends that import here). It is told the
 * theme's own text sizes (styles/theme.css: meta, heading, title). Without that it takes `text-meta` for a colour, and
 * drops the colour that stands beside it: a small filled button lost its text colour, and a muted line its size.
 */
export const cn = createCn({ extend: { classGroups: { "font-size": [{ text: ["meta", "heading", "title"] }] } } });
