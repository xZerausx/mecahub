// Icons of the Icons level, drawn for this project (original art: no resemblance to any toy line).
// Each one is a self-contained 48x48 SVG: thick dark outline, warm flat fills, so it reads on any
// block colour. No text, scripts, images or external references (icons.test.ts checks it).

export const ICON_NAMES = [
  "flag",
  "forward",
  "backward",
  "turn_left",
  "turn_right",
  "bulb",
  "hourglass",
  "stop",
  "swatch_green",
  "swatch_red",
  "swatch_blue",
  "swatch_yellow",
  "swatch_white",
  "swatch_off",
] as const;
export type IconName = (typeof ICON_NAMES)[number];

const INK = "#2b1d14";
const CREAM = "#fff4d6";
const SUN = "#ffd23f";

const svg = (body: string): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48" fill="none" stroke="${INK}" stroke-width="4" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;

const swatch = (fill: string): string => svg(`<circle cx="24" cy="24" r="17" fill="${fill}"/>`);

export const ICONS: Readonly<Record<IconName, string>> = {
  flag: svg(`<path d="M11 43V6"/><path d="M11 8L40 16L11 26Z" fill="${SUN}"/>`),
  forward: svg(`<path d="M24 5L43 26H31V43H17V26H5Z" fill="${CREAM}"/>`),
  backward: svg(`<path d="M24 43L43 22H31V5H17V22H5Z" fill="${CREAM}"/>`),
  turn_left: svg(
    `<path d="M33 43V27A11 11 0 0 0 22 16H16"/><path d="M19 6L5 16L19 26Z" fill="${CREAM}"/>`,
  ),
  turn_right: svg(
    `<path d="M15 43V27A11 11 0 0 1 26 16H32"/><path d="M29 6L43 16L29 26Z" fill="${CREAM}"/>`,
  ),
  bulb: svg(
    `<path d="M24 5A13 13 0 0 1 32 28V33H16V28A13 13 0 0 1 24 5Z" fill="${SUN}"/><path d="M18 40H30"/>`,
  ),
  hourglass: svg(
    `<path d="M11 5H37M11 43H37"/><path d="M14 5C14 19 24 21 24 24C24 27 14 29 14 43H34C34 29 24 27 24 24C24 21 34 19 34 5Z" fill="${CREAM}"/><path d="M19 40C20 34 24 32 24 32C24 32 28 34 29 40Z" fill="${SUN}" stroke-width="2"/>`,
  ),
  stop: svg(`<path d="M17 5H31L43 17V31L31 43H17L5 31V17Z" fill="#e4372c"/>`),
  swatch_green: swatch("#2fa84f"),
  swatch_red: swatch("#e4372c"),
  swatch_blue: swatch("#2a6fdb"),
  swatch_yellow: swatch(SUN),
  swatch_white: swatch("#ffffff"),
  swatch_off: svg(
    `<circle cx="24" cy="24" r="17" fill="#cfc3ad"/><path d="M17 17L31 31M31 17L17 31"/>`,
  ),
};

/** The icon as a `data:image/svg+xml` URI, for a Blockly `field_image` or dropdown image option. */
export const iconSrc = (name: IconName): string =>
  `data:image/svg+xml,${encodeURIComponent(ICONS[name])}`;
