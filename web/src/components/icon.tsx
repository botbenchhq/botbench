import sprite from "../../vendor/design-system/icons.svg";

/** The design system's icons this client uses. Each is a symbol in the vendored sprite, which Botbench itself serves. */
export type IconName =
  | "terminal"
  | "file"
  | "plus"
  | "circle-check"
  | "clock"
  | "circle-alert"
  | "circle-dashed"
  | "circle-pause"
  | "circle-slash"
  | "circle-stop"
  | "circle-x"
  | "copy"
  | "eye"
  | "git-branch"
  | "loader"
  | "search"
  | "settings"
  | "thumbs-up"
  | "check"
  | "x";

/** A decorative icon from the sprite. `className` is the icon class of the component it sits in. */
export function Icon({ name, className }: { name: IconName; className: string }) {
  return (
    <svg className={className} aria-hidden="true">
      <use href={`${sprite}#ds-icon-${name}`} />
    </svg>
  );
}
