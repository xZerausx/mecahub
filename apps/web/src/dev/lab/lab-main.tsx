import { createWebBleTransport, isWebBluetoothAvailable } from "@mecahub/transport/web";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createTranslator, detectLocale } from "../../i18n.js";
import { LabPage } from "./LabPage.js";
import { copyToClipboard } from "./lab-ui.js";
import { createLabController } from "./lab-controller.js";
import "../connect.css";
import "./lab.css";

const root = document.getElementById("root");
if (!root) throw new Error("Root element not found");

const locale = detectLocale(navigator.language);
const t = createTranslator(locale);
document.documentElement.lang = locale;
document.title = t("dev.lab.title");

const controller = createLabController({
  webBluetoothAvailable: isWebBluetoothAvailable(),
  createRealTransport: createWebBleTransport,
  now: () => performance.now(),
});

/** Offers a file through a Blob URL: nothing leaves the page. */
function save(name: string, text: string, type: string): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

const reactRoot = createRoot(root);
// Vite hot reload re-runs this module: unmount the page (its listeners go), then STOP, drop the link
// and release the previous hub.
import.meta.hot?.dispose(() => {
  reactRoot.unmount();
  void controller.dispose();
});

reactRoot.render(
  <StrictMode>
    <LabPage
      controller={controller}
      t={t}
      copy={(text) => copyToClipboard(navigator, text)}
      save={save}
    />
  </StrictMode>,
);
