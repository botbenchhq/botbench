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
  | "external-link"
  | "git-branch"
  | "loader"
  | "search"
  | "settings"
  | "thumbs-up"
  | "check"
  | "x"
  | "folder"
  | "shield"
  | "cpu"
  | "mic"
  | "chevron-left"
  | "ellipsis"
  | "info"
  | "chevron-right"
  | "message";

/** A decorative icon from the sprite. `className` is the icon class of the component it sits in. */
export const SPRITE = sprite;

export function Icon({ name, className }: { name: IconName; className: string }) {
  // The design system has no speech-bubble icon yet: this one is Lucide's message-circle (ISC, listed in NOTICE), drawn
  // with the same attributes as the sprite's symbols, so it takes the same size and colour from its class.
  if (name === "message")
    return (
      <svg className={className} aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
        <path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z" />
      </svg>
    );
  return (
    <svg className={className} aria-hidden="true">
      <use href={`${sprite}#ds-icon-${name}`} />
    </svg>
  );
}
