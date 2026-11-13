import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createTranslator, detectLocale } from "../i18n.js";
import { SimulatorPage } from "./SimulatorPage.js";
import { createSimController } from "./sim-controller.js";
import "./connect.css";
import "./simulator.css";

const root = document.getElementById("root");
if (!root) throw new Error("Root element not found");

const locale = detectLocale(navigator.language);
const t = createTranslator(locale);
document.documentElement.lang = locale;
document.title = t("dev.sim.title");
const controller = createSimController();
// Vite hot reload re-runs this module: release the previous hub, link and timers.
import.meta.hot?.dispose(() => controller.dispose());

createRoot(root).render(
  <StrictMode>
    <SimulatorPage
      controller={controller}
      t={t}
      copy={(text) => navigator.clipboard.writeText(text)}
    />
  </StrictMode>,
);
