import { createWebBleTransport, isWebBluetoothAvailable } from "@mecahub/transport/web";
import type { BleTransport } from "@mecahub/transport";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { EditorPage } from "./editor/EditorPage.js";
import { createEditorController } from "./editor/editor-controller.js";
import { createTranslator, detectLocale } from "./i18n.js";

const root = document.getElementById("root");
if (!root) throw new Error("Root element not found");

const locale = detectLocale(navigator.language);
const t = createTranslator(locale);
document.documentElement.lang = locale;
document.title = t("app.title");

/**
 * The way to reach a real hub, or `undefined` where the browser has no Web Bluetooth (the editor
 * then explains it and stays on the simulator). The only door to `navigator.bluetooth` is the
 * transport package.
 */
async function hubTransportFactory(): Promise<(() => BleTransport) | undefined> {
  // Browser tests only: a build-time constant, `false` in production, so the whole branch (and the
  // fake hub module) is dropped from the bundle. The page must also ask for it with `?fakeHub=1`.
  if (
    import.meta.env.VITE_E2E_FAKE_HUB === "1" &&
    new URLSearchParams(location.search).get("fakeHub") === "1"
  ) {
    return (await import("./editor/e2e-fake-hub.js")).createFakeHubTransport;
  }
  return isWebBluetoothAvailable() ? () => createWebBleTransport() : undefined;
}

// Created once, outside React: StrictMode mounts twice and must not build two simulated hubs.
// Starts on the simulator; a click on the Bluetooth button switches to a real hub.
const createHubTransport = await hubTransportFactory();
const controller = createEditorController(createHubTransport ? { createHubTransport } : {});

createRoot(root).render(
  <StrictMode>
    <EditorPage controller={controller} locale={locale} t={t} />
  </StrictMode>,
);
