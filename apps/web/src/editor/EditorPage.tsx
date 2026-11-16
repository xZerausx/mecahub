import type { Level } from "@mecahub/blocks";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { Locale, Translate } from "../i18n.js";
import { BlocklyWorkspace, type WorkspaceApi } from "./BlocklyWorkspace.js";
import type { EditorController } from "./editor-controller.js";
import { SimPreview } from "./SimPreview.js";
import "./editor.css";

interface Props {
  controller: EditorController;
  locale: Locale;
  t: Translate;
}

/** A fresh program: the start flag already on the workspace, so a child can begin with the moves. */
const startState = (): Record<string, unknown> => ({
  blocks: { languageVersion: 0, blocks: [{ type: "mh_icon_when_start", x: 48, y: 40 }] },
  variables: [],
});

const LEVELS: readonly Level[] = ["icons", "advanced"];

export function EditorPage({ controller, locale, t }: Props) {
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const [level, setLevel] = useState<Level>("icons");
  const api = useRef<WorkspaceApi | null>(null);

  useEffect(() => {
    controller.connect().catch(() => undefined); // a failure shows when Run reports it
  }, [controller]);

  const stop = useCallback(() => controller.stop(), [controller]);

  // Esc is a second STOP: it works wherever the focus is, also inside Blockly.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") controller.stop();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [controller]);

  const run = () => {
    const state = api.current?.save();
    if (state !== undefined) void controller.run(state);
  };

  return (
    <main className="editor" data-level={level}>
      <header className="editor-bar">
        <button
          type="button"
          className="big-button run"
          aria-label={t("editor.run")}
          disabled={snapshot.running}
          onClick={run}
        >
          <svg viewBox="0 0 48 48" aria-hidden="true">
            <path d="M14 7L41 24L14 41Z" />
          </svg>
        </button>
        <button
          type="button"
          className="big-button stop"
          aria-label={t("editor.stop")}
          onClick={stop}
        >
          <svg viewBox="0 0 48 48" aria-hidden="true">
            <path d="M17 5H31L43 17V31L31 43H17L5 31V17Z" />
          </svg>
        </button>
        <div className="level-toggle" role="group" aria-label={t("editor.levelLabel")}>
          {LEVELS.map((value) => (
            <button
              key={value}
              type="button"
              className={`level-button level-${value}`}
              aria-label={t(`editor.level.${value}`)}
              aria-pressed={level === value}
              onClick={() => setLevel(value)}
            >
              <svg viewBox="0 0 48 48" aria-hidden="true">
                {value === "icons" ? (
                  <>
                    <rect x="6" y="6" width="16" height="16" rx="4" />
                    <rect x="26" y="6" width="16" height="16" rx="4" />
                    <rect x="6" y="26" width="16" height="16" rx="4" />
                    <rect x="26" y="26" width="16" height="16" rx="4" />
                  </>
                ) : (
                  <path d="M6 12H42M6 24H30M6 36H38" />
                )}
              </svg>
            </button>
          ))}
        </div>
        <SimPreview snapshot={snapshot} t={t} />
      </header>
      <BlocklyWorkspace
        level={level}
        locale={locale}
        apiRef={api}
        initialState={startState}
        highlightedBlockId={snapshot.highlightedBlockId}
        errorBlockIds={snapshot.errorBlockIds}
        label={t("editor.workspace")}
      />
    </main>
  );
}
