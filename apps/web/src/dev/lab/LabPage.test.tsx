import { FakeTransport } from "@mecahub/transport";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import en from "../../../../../content/i18n/en.json";
import es from "../../../../../content/i18n/es.json";
import { createTranslator, type MessageKey, type Translate } from "../../i18n.js";
import { LabPage } from "./LabPage.js";
import { needsLeaveGuard } from "./lab-ui.js";
import { createLabController, type LabControllerOptions } from "./lab-controller.js";
import type { LabController } from "./lab-types.js";

const made: LabController[] = [];

function lab(options: LabControllerOptions = {}): LabController {
  vi.useFakeTimers();
  const controller = createLabController(options);
  made.push(controller);
  return controller;
}

async function connected(): Promise<LabController> {
  const controller = lab();
  const connecting = controller.connect();
  await vi.advanceTimersByTimeAsync(3000);
  await connecting;
  await vi.advanceTimersByTimeAsync(1000);
  return controller;
}

afterEach(() => {
  for (const c of made.splice(0)) c.dispose();
  vi.useRealTimers();
});

const noop = () => undefined;
const copy = () => Promise.resolve();

const render = (controller: LabController, t: Translate = createTranslator("en")) =>
  renderToString(<LabPage controller={controller} t={t} copy={copy} save={noop} />);

describe("LabPage", () => {
  it("renders every section from i18n (en)", () => {
    const html = render(lab());
    for (const key of [
      "dev.lab.title",
      "dev.lab.intro",
      "dev.lab.connection.heading",
      "dev.lab.mode.simulator",
      "dev.lab.connect",
      "dev.lab.devices.heading",
      "dev.lab.motors.heading",
      "dev.lab.sensors.heading",
      "dev.lab.measure.heading",
      "dev.lab.tool.writeLatency",
      "dev.lab.tool.motorSpeed",
      "dev.lab.tool.multiMessageWrite",
      "dev.lab.tool.stopOnLinkLoss",
      "dev.lab.tool.feedback",
      "dev.lab.diag.heading",
      "dev.lab.export.heading",
      "dev.lab.export.copy",
      "dev.lab.export.json",
    ] as const) {
      expect(html, key).toContain(en[key]);
    }
  });

  it("renders in Spanish", () => {
    const html = render(lab(), createTranslator("es"));
    expect(html).toContain(es["dev.lab.title"]);
    expect(html).toContain(es["dev.lab.connect"]);
    expect(html).not.toContain(en["dev.lab.connection.heading"]);
  });

  it("has an always-visible STOP button that the Escape key also triggers", () => {
    const html = render(lab());
    expect(html).toMatch(/<button[^>]*class="lab-stop"[^>]*>STOP<\/button>/);
    expect(html).toContain('aria-keyshortcuts="Escape"');
    expect(html).toContain(en["dev.lab.stopHint"]);
    expect(html).toContain(en["dev.lab.stopIdle"]);
  });

  it("tells that the STOP button always works and that its time is not the motors' stopping time", () => {
    expect(en["dev.lab.stopHint"]).toMatch(/always works/);
    expect(en["dev.lab.stopLatency"]).toMatch(/not the time the motors physically stopped/);
    expect(es["dev.lab.stopLatency"]).toMatch(/no es el tiempo/);
    const html = render(lab());
    expect(html).toContain(en["dev.lab.stopHint"]);
    expect(html).toContain(en["dev.lab.stopLatency"]);
  });

  it("STOP is usable even when nothing is connected", () => {
    const stop = /<button[^>]*class="lab-stop"[^>]*>/.exec(render(lab()))?.[0];
    expect(stop).toBeDefined();
    expect(stop).not.toContain("disabled");
  });

  it("announces state and results in live regions", () => {
    const html = render(lab());
    expect(html.match(/aria-live="polite"/g)?.length).toBeGreaterThanOrEqual(3);
  });

  it("disables every measurement until a hub is connected", () => {
    const html = render(lab());
    for (const key of [
      "dev.lab.tool.writeLatency.run",
      "dev.lab.tool.motorSpeed.run",
      "dev.lab.tool.multiMessageWrite.run",
      "dev.lab.tool.feedback.run",
      "dev.lab.linkLoss.start",
    ] as const) {
      expect(html, key).toMatch(new RegExp(`<button[^>]*disabled=""[^>]*>${en[key]}</button>`));
    }
  });

  it("requires the safety confirmation: a warning, an unchecked box, and a disabled start", async () => {
    const html = render(await connected());
    expect(html).toContain(en["dev.lab.linkLoss.warning"]);
    expect(html).toMatch(/<input[^>]*type="checkbox"(?![^>]*checked)[^>]*\/>/);
    expect(html).toContain(`>${en["dev.lab.linkLoss.confirm"]}</label>`);
    expect(html).toMatch(
      new RegExp(`<button[^>]*disabled=""[^>]*>${en["dev.lab.linkLoss.start"]}</button>`),
    );
    // Other measurements are enabled once connected.
    expect(html).toMatch(
      new RegExp(`<button(?![^>]*disabled)[^>]*>${en["dev.lab.tool.writeLatency.run"]}</button>`),
    );
  });

  it("asks for the safety confirmation before the motor speed test too", async () => {
    const html = render(await connected());
    expect(html).toContain(en["dev.lab.tool.motorSpeed.warning"]);
    expect(html.match(/type="checkbox"/g)?.length).toBe(3);
    expect(html).toMatch(
      new RegExp(`<button[^>]*disabled=""[^>]*>${en["dev.lab.tool.motorSpeed.run"]}</button>`),
    );
  });

  it("asks for the safety confirmation before the feedback capture too", async () => {
    const html = render(await connected());
    expect(html).toContain(en["dev.lab.tool.feedback.warning"]);
    expect(html).toMatch(
      new RegExp(`<button[^>]*disabled=""[^>]*>${en["dev.lab.tool.feedback.run"]}</button>`),
    );
  });

  it("says that STOP cannot reach the hub while the link is down", async () => {
    expect(en["dev.lab.linkLoss.awaiting"]).toMatch(/STOP cannot reach the hub/);
    expect(en["dev.lab.linkLoss.awaiting"]).toMatch(/switch the hub off/);
    expect(es["dev.lab.linkLoss.awaiting"]).toMatch(/STOP no llega al hub/);
    const controller = await connected();
    const testing = controller.testStopOnLinkLoss({ confirmed: true });
    await vi.advanceTimersByTimeAsync(1000);
    await testing;
    const html = render(controller);
    expect(html).toContain(en["dev.lab.linkLoss.awaiting"]);
    // Connect stays disabled until the answer is given.
    expect(html).toMatch(
      new RegExp(`<button[^>]*disabled=""[^>]*>${en["dev.lab.connect"]}</button>`),
    );
  });

  it("labels the speed as a lower bound", () => {
    expect(en["dev.lab.speed.run"]).toMatch(/at least/);
    expect(es["dev.lab.speed.run"]).toMatch(/al menos/);
  });

  it("offers the real hub only when Web Bluetooth is available", () => {
    const realOption = (html: string) => /<input[^>]*value="real"[^>]*>/.exec(html)?.[0] ?? "";
    const without = render(lab());
    expect(without).toContain(en["dev.lab.mode.unavailable"]);
    expect(realOption(without)).toContain('disabled=""');
    const withBt = render(
      lab({ webBluetoothAvailable: true, createRealTransport: () => new FakeTransport() }),
    );
    expect(withBt).not.toContain(en["dev.lab.mode.unavailable"]);
    expect(realOption(withBt)).not.toContain("disabled");
    expect(realOption(withBt)).toContain('checked=""');
  });

  it("shows motors, readings, devices and timings once connected", async () => {
    const html = render(await connected());
    expect(html).toContain("Motor A");
    expect(html).toContain("Motor B");
    expect(html).toContain(en["dev.lab.motor.ab"]);
    expect(html).toContain("97%");
    expect(html).toContain("Move Hub");
    expect(html).toContain(en["dev.lab.kind.colorDistance"]);
    expect(html).toContain(en["dev.lab.timings.registry"]);
    expect(html).toContain(en["dev.connect.state.connected"]);
    expect(html).toMatch(/<select[^>]*>.*Red.*<\/select>/s);
  });

  it("shows a measurement result after it ran", async () => {
    const controller = await connected();
    const running = controller.measureWriteLatency(3);
    await vi.advanceTimersByTimeAsync(2000);
    await running;
    const html = render(controller);
    expect(html).toContain("3 of 3 writes done");
    expect(html).toContain("median");
  });

  it("shows the observation buttons while the link-loss test waits", async () => {
    const controller = await connected();
    const testing = controller.testStopOnLinkLoss({ confirmed: true });
    await vi.advanceTimersByTimeAsync(1000);
    await testing;
    const html = render(controller);
    expect(html).toContain(en["dev.lab.linkLoss.awaiting"]);
    expect(html).toContain(en["dev.lab.linkLoss.stopped"]);
    expect(html).toContain(en["dev.lab.linkLoss.keptRunning"]);
    expect(html).toContain(en["dev.lab.linkLoss.fromSim"]);
  });

  it("shows a STOP result with its time", async () => {
    const controller = await connected();
    const stopping = controller.stop();
    await vi.advanceTimersByTimeAsync(100);
    await stopping;
    const html = render(controller);
    expect(html).toMatch(/\d+(\.\d)? ms until every STOP write finished, within the 200 ms limit/);
  });

  it("keeps the leave guard on while a cut-short timed run may still be turning the motor", async () => {
    const controller = await connected();
    const running = controller.runFor("a", 5000, 50);
    await vi.advanceTimersByTimeAsync(100);
    controller.sim?.transport.dropLink();
    await vi.advanceTimersByTimeAsync(100);
    await running;
    await controller.stop(); // the link is down: this STOP does not reach the hub
    expect(needsLeaveGuard(controller.getSnapshot())).toBe(true);
  });

  it("lists diagnostics", async () => {
    const controller = await connected();
    controller.sim?.transport.dropLink();
    await vi.advanceTimersByTimeAsync(10);
    expect(render(controller)).toContain(en["dev.lab.diag.link-lost"]);
  });

  it("takes every visible string and label from i18n", async () => {
    // A translator that wraps each message: any text or label outside the markers is hardcoded.
    const marked: Translate = (key: MessageKey, params) =>
      `§${createTranslator("en")(key, params)}§`;
    for (const controller of [lab(), await connected()]) {
      const html = render(controller, marked);
      // The hub's own name is data, not UI copy.
      const text = html
        .replace(/<[^>]*>/g, " ")
        .replace(/§[^§]*§/g, " ")
        .replace("Move Hub", " ");
      expect(text.replace(/[^A-Za-z]/g, ""), text.replace(/\s+/g, " ")).toBe("");
      for (const match of html.matchAll(/(?:aria-label|title|placeholder|alt)="([^"]*)"/g)) {
        expect(match[1], match[0]).toMatch(/^§/);
      }
    }
  });
});
