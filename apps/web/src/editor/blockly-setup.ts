import {
  BLOCK_STYLES,
  blockDefinitions,
  toolbox,
  type Level,
  type Messages,
} from "@mecahub/blocks";
import * as Blockly from "blockly/core";
import * as blocklyEn from "blockly/msg/en";
import * as blocklyEs from "blockly/msg/es";
import en from "../../../../content/i18n/en.json";
import es from "../../../../content/i18n/es.json";
import type { Locale } from "../i18n.js";

// Everything that touches the Blockly runtime lives in apps/web (packages/blocks stays Node-only).

export const THEME_NAME = "mecahub";

const MESSAGES: Record<Locale, Messages> = { en, es };
const BLOCKLY_MESSAGES: Record<Locale, Record<string, string>> = {
  en: blocklyEn as unknown as Record<string, string>,
  es: blocklyEs as unknown as Record<string, string>,
};

let registeredFor: Locale | undefined;

/**
 * Registers the Blockly UI messages and all of our block definitions (both levels: a saved program
 * opens on either) for `locale`. Idempotent: calling it again for the same locale does nothing;
 * a different locale registers the new labels (Blockly then logs that it replaced the old ones).
 */
export function ensureBlockly(locale: Locale): void {
  if (registeredFor === locale) return;
  Blockly.setLocale(BLOCKLY_MESSAGES[locale]);
  Blockly.common.defineBlocksWithJsonArray(blockDefinitions(MESSAGES[locale]));
  registeredFor = locale;
}

/** Advanced shows the workspace through the flyout: only its background is translucent. */
export const ADVANCED_FLYOUT_OPACITY = 0.6;

const themes = new Map<Level, Blockly.Theme>();

/**
 * Blockly's classic theme plus `BLOCK_STYLES`: without it the hats render without their cap. Icons
 * and Advanced get separate themes because `flyoutOpacity` (a component style, applied to the
 * flyout background only, never to the blocks) differs; the Icons one is left as it was.
 */
export function mecahubTheme(level: Level = "icons"): Blockly.Theme {
  let theme = themes.get(level);
  if (!theme) {
    theme = Blockly.Theme.defineTheme(level === "icons" ? THEME_NAME : `${THEME_NAME}-${level}`, {
      name: level === "icons" ? THEME_NAME : `${THEME_NAME}-${level}`,
      base: Blockly.Themes.Classic,
      blockStyles: BLOCK_STYLES,
      ...(level === "advanced"
        ? { componentStyles: { flyoutOpacity: ADVANCED_FLYOUT_OPACITY } }
        : {}),
    });
    themes.set(level, theme);
  }
  return theme;
}

/** Scale of the Icons level: bigger blocks and targets for small fingers. */
export const ICONS_START_SCALE = 1.5;

/** Options for `Blockly.inject`. Icons: zelos renderer, a flat always-open flyout, no categories. */
export function workspaceOptions(level: Level, locale: Locale): Blockly.BlocklyOptions {
  ensureBlockly(locale);
  const icons = level === "icons";
  return {
    theme: mecahubTheme(level),
    renderer: icons ? "zelos" : "geras",
    toolbox: toolbox(MESSAGES[locale], level),
    // Blockly's sprites and cursors default to https://static.blockly.com: serve our own copy
    // (public/blockly-media, copied from the blockly package; no audio) so nothing leaves the app.
    media: `${import.meta.env.BASE_URL}blockly-media/`,
    // No sound files: the app makes no network requests and ships no audio.
    sounds: false,
    trashcan: true,
    zoom: { startScale: icons ? ICONS_START_SCALE : 1, controls: false, wheel: false },
    move: { scrollbars: true, drag: true, wheel: true },
  };
}
