import { ManualClock, defaultMoveHubConfig, type SimPortConfig } from "@mecahub/simulator";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import en from "../../../../content/i18n/dev.en.json";
import es from "../../../../content/i18n/dev.es.json";
import { createDevTranslator } from "./dev-i18n.js";
import { SimulatorPage } from "./SimulatorPage.js";
import { createSimController } from "./sim-controller.js";

const copy = () => Promise.resolve();
const render = (locale: "en" | "es") =>
  renderToString(
    <SimulatorPage
      controller={createSimController({ clock: new ManualClock() })}
      t={createDevTranslator(locale)}
      copy={copy}
    />,
  );

describe("SimulatorPage", () => {
  it("renders every section from i18n (en)", () => {
    const html = render("en");
    for (const key of [
      "dev.sim.title",
      "dev.sim.hubHeading",
      "dev.sim.appHeading",
      "dev.sim.battery",
      "dev.sim.buttonLabel",
      "dev.sim.tiltX",
      "dev.sim.tiltY",
      "dev.sim.color",
      "dev.sim.distance",
      "dev.sim.faultsHeading",
      "dev.sim.dropLink",
      "dev.sim.stall",
      "dev.sim.latency",
      "dev.sim.motorsHeading",
      "dev.sim.aForward",
      "dev.sim.bForward",
      "dev.sim.abForward",
      "dev.sim.stop",
      "dev.sim.stopLatency",
      "dev.sim.stopIdle",
      "dev.connect.connect",
      "dev.connect.copyLog",
      "dev.connect.state.idle",
    ] as const) {
      expect(html, key).toContain(en[key]);
    }
    expect(html).toContain("Motor A");
    expect(html).toContain("Motor B");
  });

  it("renders in Spanish", () => {
    const html = render("es");
    expect(html).toContain(es["dev.sim.title"]);
    expect(html).toContain("Motor A");
    expect(html).not.toContain(en["dev.sim.aForward"]);
  });

  it("shows the app intro of the simulator, not the real-hub one", () => {
    const html = render("en");
    expect(html).toContain(en["dev.sim.appIntro"]);
    expect(html).not.toContain(en["dev.connect.intro"]);
  });

  it("announces states in live regions and has a keyboard-reachable STOP button", () => {
    const html = render("en");
    expect(html).toContain('aria-live="polite"');
    expect(html).toMatch(/<button[^>]*>STOP<\/button>/);
    expect(html).not.toContain('tabindex="-1"');
  });

  it("uses a toggle button (aria-pressed) for the hub button", () => {
    expect(render("en")).toMatch(/<button[^>]*aria-pressed="false"[^>]*>Hub button<\/button>/);
  });

  it("shows a failed STOP as such, never as in flight", async () => {
    const controller = createSimController({ clock: new ManualClock() });
    await controller.stop(); // not connected: the write fails
    const html = renderToString(
      <SimulatorPage controller={controller} t={createDevTranslator("en")} copy={copy} />,
    );
    expect(html).toContain(en["dev.sim.stopFailed"]);
    expect(html).not.toContain(en["dev.sim.stopPending"]);
  });

  it("renders one readout per motor port of the config", () => {
    const base = defaultMoveHubConfig();
    const html = renderToString(
      <SimulatorPage
        controller={createSimController({
          clock: new ManualClock(),
          config: {
            ...base,
            ports: [...base.ports, { ...(base.ports[0] as SimPortConfig), port: 2 }],
          },
        })}
        t={createDevTranslator("en")}
        copy={copy}
      />,
    );
    expect(html).toContain("Motor C");
  });

  it("starts with the motors still and no STOP measurement", () => {
    const html = render("en");
    expect(html).toContain("0 degrees");
    expect(html).toContain("0%");
  });
});
