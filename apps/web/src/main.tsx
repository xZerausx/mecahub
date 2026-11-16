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

// Created once, outside React: StrictMode mounts twice and must not build two simulated hubs.
// Device: the simulator. TODO: a real hub through the Web Bluetooth transport (follow-up PR).
const controller = createEditorController();

createRoot(root).render(
  <StrictMode>
    <EditorPage controller={controller} locale={locale} t={t} />
  </StrictMode>,
);
