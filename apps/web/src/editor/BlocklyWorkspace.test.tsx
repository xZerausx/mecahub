// @vitest-environment jsdom
import { StrictMode, act, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BlocklyWorkspace, type WorkspaceApi } from "./BlocklyWorkspace.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const start = () => ({
  blocks: {
    languageVersion: 0,
    blocks: [{ type: "mh_icon_when_start", id: "flag", x: 10, y: 10 }],
  },
  variables: [],
});

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

const props = (apiRef: ReturnType<typeof createRef<WorkspaceApi | null>>) => ({
  level: "icons" as const,
  locale: "en" as const,
  apiRef: apiRef as { current: WorkspaceApi | null },
  initialState: start,
  highlightedBlockId: undefined,
  errorBlockIds: [] as string[],
  label: "workspace",
});

describe("BlocklyWorkspace", () => {
  it("leaves exactly one workspace after React StrictMode's mount, unmount, mount", () => {
    const apiRef = createRef<WorkspaceApi | null>() as { current: WorkspaceApi | null };
    act(() =>
      root.render(
        <StrictMode>
          <BlocklyWorkspace {...props(apiRef)} />
        </StrictMode>,
      ),
    );
    expect(host.querySelectorAll(".blocklySvg")).toHaveLength(1);
    expect(host.querySelectorAll(".injectionDiv")).toHaveLength(1);
    const saved = apiRef.current?.save() as { blocks: { blocks: { type: string }[] } };
    expect(saved.blocks.blocks.map((b) => b.type)).toEqual(["mh_icon_when_start"]);
  });

  it("unmounts without throwing while a block is highlighted (the workspace is disposed first)", () => {
    const apiRef = { current: null as WorkspaceApi | null };
    act(() => root.render(<BlocklyWorkspace {...props(apiRef)} highlightedBlockId="flag" />));
    expect(() => act(() => root.render(<div />))).not.toThrow();
    expect(host.querySelectorAll(".blocklySvg")).toHaveLength(0);
  });

  it("keeps the program when the level changes", () => {
    const apiRef = { current: null as WorkspaceApi | null };
    act(() => root.render(<BlocklyWorkspace {...props(apiRef)} />));
    act(() => root.render(<BlocklyWorkspace {...props(apiRef)} level="advanced" />));
    expect(host.querySelectorAll(".blocklySvg")).toHaveLength(1);
    const saved = apiRef.current?.save() as { blocks: { blocks: { id: string }[] } };
    expect(saved.blocks.blocks.map((b) => b.id)).toEqual(["flag"]);
  });
});
