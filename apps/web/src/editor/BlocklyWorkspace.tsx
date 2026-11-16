import type { Level } from "@mecahub/blocks";
import * as Blockly from "blockly/core";
import { useEffect, useRef, type RefObject } from "react";
import type { Locale } from "../i18n.js";
import { workspaceOptions } from "./blockly-setup.js";

/** What the page can ask of the live workspace. */
export interface WorkspaceApi {
  /** The JSON of `Blockly.serialization.workspaces.save`. */
  save(): unknown;
}

export const ERROR_CLASS = "mh-block-error";

interface Props {
  level: Level;
  locale: Locale;
  apiRef: RefObject<WorkspaceApi | null>;
  /** The state a fresh workspace starts with (only used before anything was saved). Keep it stable. */
  initialState: () => Record<string, unknown>;
  highlightedBlockId: string | undefined;
  errorBlockIds: readonly string[];
  label: string;
}

/**
 * Mounts Blockly. The workspace is injected in an effect and disposed in its cleanup, so React
 * StrictMode's mount/unmount/mount leaves exactly one. Changing `level` re-injects (the renderer
 * and the toolbox cannot change in place) and carries the program over, but NOT the undo history,
 * scroll position or zoom (they belong to the old workspace).
 */
export function BlocklyWorkspace(props: Props) {
  const { level, locale, apiRef, initialState } = props;
  const container = useRef<HTMLDivElement>(null);
  const workspace = useRef<Blockly.WorkspaceSvg | null>(null);
  /** The program between two injections. */
  const saved = useRef<Record<string, unknown> | null>(null);

  useEffect(() => {
    const host = container.current;
    if (!host) return;
    const ws = Blockly.inject(host, workspaceOptions(level, locale));
    workspace.current = ws;
    Blockly.serialization.workspaces.load(saved.current ?? initialState(), ws);
    apiRef.current = { save: () => Blockly.serialization.workspaces.save(ws) };
    const resize = () => Blockly.svgResize(ws);
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(resize);
    observer?.observe(host);
    return () => {
      observer?.disconnect();
      saved.current = Blockly.serialization.workspaces.save(ws);
      apiRef.current = null;
      workspace.current = null;
      ws.dispose();
    };
  }, [level, locale, apiRef, initialState]);

  const { highlightedBlockId, errorBlockIds } = props;
  useEffect(() => {
    const ws = workspace.current;
    if (!ws || highlightedBlockId === undefined) return;
    ws.highlightBlock(highlightedBlockId, true);
    return () => {
      // the injection effect's cleanup (which disposes ws) may have run first
      if (workspace.current === ws) ws.highlightBlock(highlightedBlockId, false);
    };
  }, [highlightedBlockId, level, locale]);

  useEffect(() => {
    const ws = workspace.current;
    if (!ws) return;
    const marked = errorBlockIds.flatMap((id) => {
      const root = ws.getBlockById(id)?.getSvgRoot();
      return root ? [root] : [];
    });
    for (const root of marked) root.classList.add(ERROR_CLASS);
    return () => {
      for (const root of marked) root.classList.remove(ERROR_CLASS);
    };
  }, [errorBlockIds, level, locale]);

  return (
    <div ref={container} className="editor-workspace" role="application" aria-label={props.label} />
  );
}
