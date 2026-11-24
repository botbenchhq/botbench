/*
 * The six groups of Settings, in the order the navigation lists them, and the address of each. Plain data, so the
 * addresses are tested without a browser (test/route.test.ts) and the navigation, the phone's list and the screen read
 * one list.
 */

export type SettingsGroup = "agents" | "environments" | "identity" | "permissions" | "usage" | "connections";

export const GROUPS: readonly { group: SettingsGroup; name: string; about: string }[] = [
  { group: "agents", name: "Agents and models", about: "Which agents can take work now, and the order they are tried in" },
  { group: "environments", name: "Execution environments", about: "Where each repository's commands run, and its setup and checks" },
  { group: "identity", name: "Workbench identity", about: "Its name, how it looks, its version and its memory" },
  { group: "permissions", name: "Permissions and autonomy", about: "The default mode, what is always allowed, and what ran" },
  { group: "usage", name: "Usage and limits", about: "How much each agent did, and what happens at a usage limit" },
  { group: "connections", name: "Connections and peers", about: "A paired workbench, signed-in devices and notifications" },
];

export const groupHref = (group: SettingsGroup): string => `#/settings/${group}`;

export const isGroup = (value: string): value is SettingsGroup => GROUPS.some((g) => g.group === value);

/** The group each address of the Settings before the six groups now opens. */
export const OLD_SECTIONS: Readonly<Record<string, SettingsGroup>> = { appearance: "identity", workbench: "identity", notifications: "connections", devices: "connections", paired: "connections" };
