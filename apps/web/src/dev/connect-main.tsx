import { isWebBluetoothAvailable, createWebBleTransport } from "@mecahub/transport/web";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createDevTranslator } from "./dev-i18n.js";
import { detectLocale } from "../i18n.js";
import { ConnectPage } from "./ConnectPage.js";
import { createHubProbe } from "./hub-probe.js";
import "./connect.css";

const root = document.getElementById("root");
if (!root) throw new Error("Root element not found");

const locale = detectLocale(navigator.language);
const t = createDevTranslator(locale);
document.documentElement.lang = locale;
document.title = t("dev.connect.title");
const probe = isWebBluetoothAvailable() ? createHubProbe(createWebBleTransport()) : undefined;

createRoot(root).render(
  <StrictMode>
    <ConnectPage probe={probe} t={t} copy={(text) => navigator.clipboard.writeText(text)} />
  </StrictMode>,
);
