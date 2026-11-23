import type { DetailedHTMLProps, HTMLAttributes } from "react";

// The design system's ds-menu element (web/vendor/design-system/behaviors/menu.js, loaded in main.tsx): it wraps a
// list whose rows end in a menu and gives each menu its keyboard. It takes no attributes of its own.
declare module "react" {
  namespace JSX {
    interface IntrinsicElements {
      "ds-menu": DetailedHTMLProps<HTMLAttributes<HTMLElement>, HTMLElement>;
    }
  }
}
