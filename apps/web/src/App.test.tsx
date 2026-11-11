import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { App } from "./App.js";

describe("App", () => {
  it("renders the app title from i18n", () => {
    expect(renderToString(<App />)).toContain("mecahub");
  });
});
