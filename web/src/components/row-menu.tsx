import { useEffect, useId, useRef, type KeyboardEvent, type MouseEvent, type PointerEvent, type ReactNode } from "react";
import type { RowAction, RowMenuItem } from "../app/row-menu.ts";
import { Icon } from "./icon.tsx";

/*
 * One row of a list with its More menu, as the design system's context menu draws it: the row is a link, and a More
 * actions button named for the row ends it. The button opens the menu (the browser does that from popovertarget; Down
 * on the button opens it too), and so do a right-click, Shift+F10 or the Menu key on the row, and a long press on a
 * phone: the same menu, in the same place. Inside the menu the keyboard is the design system's own: the list wraps its
 * rows in the vendored ds-menu element (behaviors/menu.js), which moves focus to the first item when the menu opens and
 * handles Up, Down, Home, End and letters; Escape is the browser's, which closes the menu and gives focus back to the
 * button, and Tab closes it with focus back on the button too. The approach is from OpenMausBot's src/components/SidebarThreadRow.tsx (a row that opens its actions
 * from a button, a right-click and Shift+F10 alike), written again on the design system's menu.
 */

/** How long a finger rests on a row before its menu opens, and how far it may move meanwhile. */
const LONG_PRESS_MS = 500;
const LONG_PRESS_SLOP_PX = 10;

/** The popover's options as browsers that place it by its source take them; the DOM types do not have them yet. */
type ShowPopover = (options?: { source?: HTMLElement }) => void;

/** `nameHasContent`: the button's name holds somebody's own words (a chat's title), so the voice check leaves it alone. */
export function MenuRow({ href, name, nameHasContent, items, onAction, children }: { href: string; name: string; nameHasContent: boolean; items: readonly RowMenuItem[]; onAction: (action: RowAction) => void; children: ReactNode }) {
  const id = useId();
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const press = useRef<{ timer: number; x: number; y: number; opened: boolean } | null>(null);

  const open = (): void => {
    const popover = menu.current;
    if (popover === null || popover.matches(":popover-open")) return;
    (popover.showPopover as ShowPopover).call(popover, { source: button.current ?? undefined });
  };
  const choose = (action: RowAction): void => {
    menu.current?.hidePopover();
    onAction(action);
  };

  useEffect(() => () => window.clearTimeout(press.current?.timer), []);

  const row = {
    onContextMenu: (event: MouseEvent) => {
      event.preventDefault();
      open();
    },
    onKeyDown: (event: KeyboardEvent) => {
      if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
        event.preventDefault();
        open();
      }
    },
    // A long press, for the phones whose browsers fire no contextmenu event on a link.
    onPointerDown: (event: PointerEvent) => {
      window.clearTimeout(press.current?.timer);
      press.current = null;
      if (event.pointerType !== "touch") return;
      const held = { x: event.clientX, y: event.clientY, opened: false, timer: 0 };
      held.timer = window.setTimeout(() => {
        held.opened = true;
        open();
      }, LONG_PRESS_MS);
      press.current = held;
    },
    onPointerMove: (event: PointerEvent) => {
      const held = press.current;
      if (held !== null && !held.opened && Math.hypot(event.clientX - held.x, event.clientY - held.y) > LONG_PRESS_SLOP_PX) {
        window.clearTimeout(held.timer);
        press.current = null;
      }
    },
    onPointerUp: () => window.clearTimeout(press.current?.timer),
    onPointerCancel: () => {
      window.clearTimeout(press.current?.timer);
      press.current = null;
    },
    // The finger that opened the menu lifts off the row: that is not a tap on the link.
    onClick: (event: MouseEvent) => {
      if (press.current?.opened === true) event.preventDefault();
      press.current = null;
    },
  };

  // Tab closes the menu with focus back on its button, as Escape does (the menu's onKeyDown below). The ds-menu element
  // has already closed it, its listener being nearer the item than React's, so there the key only stops moving focus on.
  const plain = items.filter((item) => !item.danger);
  const losing = items.filter((item) => item.danger);
  const itemButton = (item: RowMenuItem) => (
    <button key={item.action} type="button" role="menuitem" tabIndex={-1} onClick={() => choose(item.action)} className={item.danger ? "ds-menu__item ds-menu__item--danger" : "ds-menu__item"}>
      {item.icon !== null && <Icon name={item.icon} className="ds-menu__icon" />}
      {item.label}
    </button>
  );

  return (
    <li className="ds-list__row">
      <a href={href} className="ds-list__link bb-row-press" {...row}>
        {children}
      </a>
      <div className="ds-list__action">
        <div className="ds-context-menu">
          <button
            ref={button}
            type="button"
            popoverTarget={id}
            aria-haspopup="menu"
            aria-label={name}
            data-ds-content-label={nameHasContent ? "" : undefined}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown") {
                event.preventDefault();
                open();
              }
            }}
            className="ds-button ds-button--quiet ds-icon-button ds-context-menu__button"
          >
            <Icon name="ellipsis" className="ds-button__icon" />
          </button>
          <div
            ref={menu}
            id={id}
            popover="auto"
            role="menu"
            aria-label={name}
            data-ds-content-label={nameHasContent ? "" : undefined}
            onKeyDown={(event) => {
              if (event.key !== "Tab") return;
              event.preventDefault();
              if (menu.current?.matches(":popover-open")) menu.current.hidePopover();
              button.current?.focus();
            }}
            className="ds-menu ds-context-menu__menu"
          >
            {plain.map(itemButton)}
            {losing.length > 0 && <hr className="ds-menu__divider" />}
            {losing.map(itemButton)}
          </div>
        </div>
      </div>
    </li>
  );
}
