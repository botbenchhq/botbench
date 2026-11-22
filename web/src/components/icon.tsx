import sprite from "../../vendor/groundwork/icons.svg";

/** The design system's icons this client uses. Each is a symbol in the vendored sprite, which Smelt itself serves. */
export type IconName = "terminal" | "file" | "plus" | "circle-check" | "copy";

/** A decorative icon from the sprite. `className` is the icon class of the component it sits in. */
export function Icon({ name, className }: { name: IconName; className: string }) {
  return (
    <svg className={className} aria-hidden="true">
      {/* gw-waive dynamic-class: this is the id of a symbol in the vendored icon sprite, not a class name; the checker reads any gw- word in script as a class */}
      <use href={`${sprite}#gw-icon-${name}`} />
    </svg>
  );
}
