// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { ICON_NAMES, ICONS, iconSrc, type IconName } from "./icons.js";

// Drawn by us (48x48, thick strokes); no text, scripts, images or external references.

const XMLNS = ' xmlns="http://www.w3.org/2000/svg"';

describe("icons", () => {
  it("has an SVG for every name and nothing else", () => {
    expect(Object.keys(ICONS).sort()).toEqual([...ICON_NAMES].sort());
    expect(new Set(ICON_NAMES).size).toBe(ICON_NAMES.length);
  });

  describe.each(ICON_NAMES)("%s", (name: IconName) => {
    const svg = ICONS[name];

    it("parses as an SVG with a 48x48 viewBox", () => {
      const doc = new DOMParser().parseFromString(svg, "image/svg+xml");
      expect(doc.getElementsByTagName("parsererror")).toHaveLength(0);
      expect(doc.documentElement.localName).toBe("svg");
      expect(doc.documentElement.getAttribute("viewBox")).toBe("0 0 48 48");
      expect(doc.documentElement.getAttribute("xmlns")).toBe("http://www.w3.org/2000/svg");
    });

    it("carries no text, scripts, images or references", () => {
      const rest = svg.replace(XMLNS, "");
      expect(rest).not.toMatch(/<text|<script|<image|<foreignObject|href|url\(|http|on\w+=/i);
    });

    it("is small", () => {
      expect(svg.length).toBeLessThan(2048);
    });

    it("becomes an svg data URI", () => {
      const src = iconSrc(name);
      expect(src.startsWith("data:image/svg+xml,")).toBe(true);
      expect(decodeURIComponent(src.slice("data:image/svg+xml,".length))).toBe(svg);
    });
  });
});
