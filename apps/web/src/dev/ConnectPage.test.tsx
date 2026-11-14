import { encodeHubProperty } from "@mecahub/lwp3";
import { FakeTransport } from "@mecahub/transport";
import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import en from "../../../../content/i18n/dev.en.json";
import es from "../../../../content/i18n/dev.es.json";
import { createDevTranslator } from "./dev-i18n.js";
import { ConnectPage } from "./ConnectPage.js";
import { createHubProbe } from "./hub-probe.js";

const copy = () => Promise.resolve();

describe("ConnectPage", () => {
  it("renders the idle page from i18n", () => {
    const probe = createHubProbe(new FakeTransport());
    const html = renderToString(
      <ConnectPage probe={probe} t={createDevTranslator("en")} copy={copy} />,
    );
    for (const key of [
      "dev.connect.title",
      "dev.connect.connect",
      "dev.connect.disconnect",
      "dev.connect.copyLog",
      "dev.connect.state.idle",
    ] as const) {
      expect(html, key).toContain(en[key]);
    }
  });

  it("renders in Spanish", () => {
    const probe = createHubProbe(new FakeTransport());
    const html = renderToString(
      <ConnectPage probe={probe} t={createDevTranslator("es")} copy={copy} />,
    );
    expect(html).toContain(es["dev.connect.connect"]);
  });

  it("shows the browser help when Web Bluetooth is unavailable", () => {
    const html = renderToString(
      <ConnectPage probe={undefined} t={createDevTranslator("en")} copy={copy} />,
    );
    expect(html).toContain(en["dev.connect.unsupported"]);
    expect(html).toContain("chrome://flags/#enable-experimental-web-platform-features");
    expect(html).not.toContain(en["dev.connect.connect"]);
  });

  it("shows name and battery once the hub reports them", async () => {
    const transport = new FakeTransport();
    const probe = createHubProbe(transport);
    await probe.connect();
    transport.emitNotify(
      encodeHubProperty({
        type: "hubProperty",
        operation: "update",
        property: "advertisingName",
        value: "Move Hub",
      }),
    );
    transport.emitNotify(
      encodeHubProperty({
        type: "hubProperty",
        operation: "update",
        property: "batteryPercent",
        value: 87,
      }),
    );
    const html = renderToString(
      <ConnectPage probe={probe} t={createDevTranslator("en")} copy={copy} />,
    );
    expect(html).toContain("Move Hub");
    expect(html).toContain("87%");
    expect(html).toContain(en["dev.connect.state.connected"]);
  });

  it("announces state changes politely and labels the log by its heading", () => {
    const probe = createHubProbe(new FakeTransport());
    const html = renderToString(
      <ConnectPage probe={probe} t={createDevTranslator("en")} copy={copy} />,
    );
    expect(html).toContain('aria-live="polite"');
    const labelledby = /<pre[^>]*aria-labelledby="([^"]+)"/.exec(html)?.[1];
    expect(labelledby).toBeTruthy();
    expect(html).toContain(`id="${labelledby}"`);
  });

  it("disables Connect and shows the choosing state while the chooser is open", () => {
    const transport = new FakeTransport();
    vi.spyOn(transport, "requestDevice").mockReturnValue(new Promise(() => undefined));
    const probe = createHubProbe(transport);
    void probe.connect();
    const html = renderToString(
      <ConnectPage probe={probe} t={createDevTranslator("en")} copy={copy} />,
    );
    expect(html).toContain(en["dev.connect.state.choosing"]);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Connect<\/button>/);
  });

  it("marks name and battery as last known after a disconnect", async () => {
    const transport = new FakeTransport();
    const probe = createHubProbe(transport);
    await probe.connect();
    transport.emitNotify(
      encodeHubProperty({
        type: "hubProperty",
        operation: "update",
        property: "batteryPercent",
        value: 55,
      }),
    );
    const render = () =>
      renderToString(<ConnectPage probe={probe} t={createDevTranslator("en")} copy={copy} />);
    expect(render()).not.toContain(en["dev.connect.lastKnown"]);
    transport.emitDisconnect();
    const html = render();
    expect(html).toContain("55%");
    expect(html).toContain(en["dev.connect.lastKnown"]);
  });
});
