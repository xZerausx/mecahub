import type { Level } from "@mecahub/blocks";
import { useCallback, useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
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
  const tipBase = useId();
  const api = useRef<WorkspaceApi | null>(null);
  const runButton = useRef<HTMLButtonElement>(null);
  const stopButton = useRef<HTMLButtonElement>(null);

  // Run disables itself while the program runs, which would drop the keyboard focus on <body>:
  // hand it to STOP, the button the child needs next. Focus somewhere else is left alone.
  useEffect(() => {
    if (!snapshot.running) return;
    const focused = document.activeElement;
    if (focused === runButton.current || focused === document.body || focused === null) {
      stopButton.current?.focus();
    }
  }, [snapshot.running]);

  useEffect(() => {
    controller.connect().catch(() => undefined); // a failure shows when Run reports it
  }, [controller]);

  const stop = useCallback(() => controller.stop(), [controller]);

  // Esc is a second STOP: it works wherever the focus is, also inside Blockly.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        controller.stop(); // a pure STOP: it never changes the level or anything else
      }
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
          ref={runButton}
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
          ref={stopButton}
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
            <span key={value} className="level-item">
              <button
                type="button"
                className={`level-button level-${value}`}
                aria-label={t(`editor.level.${value}`)}
                aria-pressed={level === value}
                aria-describedby={`${tipBase}-${value}`}
                onClick={() => {
                  if (value === level) return;
                  // Any change of level (both directions) halts the robot first and closes any open
                  // Blockly dropdown; the program carries over.
                  controller.stop();
                  api.current?.hideChaff();
                  setLevel(value);
                }}
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
              <span id={`${tipBase}-${value}`} role="tooltip" className="level-tip">
                {t(`editor.levelHint.${value}`)}
              </span>
            </span>
          ))}
        </div>
        {/* The controller only drives the simulator today; "hub" arrives with the real-hub connection. */}
        <SimPreview source="simulator" snapshot={snapshot} t={t} />
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
