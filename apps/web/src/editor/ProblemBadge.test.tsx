// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import en from "../../../../content/i18n/en.json";
import es from "../../../../content/i18n/es.json";
import { createTranslator } from "../i18n.js";
import { ProblemBadge } from "./ProblemBadge.js";
import type { ProblemKind } from "./problem.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLElement;
let root: Root;
beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const mount = (problem: ProblemKind | undefined, locale: "en" | "es" = "en") => {
  const onDismiss = vi.fn();
  act(() =>
    root.render(
      <ProblemBadge problem={problem} onDismiss={onDismiss} t={createTranslator(locale)} />,
    ),
  );
  return { onDismiss };
};

const LABEL: Record<ProblemKind, keyof typeof en> = {
  "connect-failed": "editor.problem.connectFailed",
  "link-lost": "editor.problem.linkLost",
  "missing-device": "editor.problem.missingDevice",
  "sensor-timeout": "editor.problem.sensorTimeout",
  "hub-error": "editor.problem.hubError",
  "stop-failed": "editor.problem.stopFailed",
};

describe("ProblemBadge", () => {
  it("is a polite live region that exists (empty) before any problem, so it can announce one", () => {
    mount(undefined);
    const region = host.querySelector("[role=status]");
    expect(region?.getAttribute("aria-live")).toBe("polite");
    expect(region?.querySelector("button")).toBeNull();
  });

  it.each(Object.keys(LABEL) as ProblemKind[])(
    "%s: a pictogram for the child and a hidden label for the screen reader (en and es)",
    (kind) => {
      for (const [locale, catalog] of [
        ["en", en],
        ["es", es],
      ] as const) {
        mount(kind, locale);
        const region = host.querySelector("[role=status]");
        expect(region?.querySelector("svg[aria-hidden=true]"), `${kind} ${locale}`).not.toBeNull();
        expect(region?.querySelector(".visually-hidden")?.textContent).toBe(catalog[LABEL[kind]]);
        expect(host.querySelector(".problem-badge")?.getAttribute("data-problem")).toBe(kind);
      }
    },
  );

  it("shows no visible words: the only text is visually hidden", () => {
    mount("link-lost");
    const clone = host.cloneNode(true) as HTMLElement;
    for (const hidden of clone.querySelectorAll(".visually-hidden")) hidden.remove();
    expect(clone.textContent?.trim()).toBe("");
  });

  it("tapping it dismisses it", () => {
    const { onDismiss } = mount("hub-error");
    const tap = host.querySelector<HTMLButtonElement>("button.problem-badge");
    // the accessible name says WHAT is wrong and how to close it
    expect(tap?.getAttribute("aria-label")).toContain(en["editor.problem.hubError"]);
    expect(tap?.getAttribute("aria-label")).toContain(en["editor.problem.dismiss"]);
    act(() => tap?.click());
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});
