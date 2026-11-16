import type { EditorSnapshot, LedName, WheelState } from "./editor-controller.js";
import type { Translate } from "../i18n.js";

const LED_FILL: Record<LedName, string> = {
  off: "#cfc3ad",
  black: "#2b1d14",
  pink: "#ff8fb8",
  purple: "#8a4fd8",
  blue: "#2a6fdb",
  lightBlue: "#7cc4ff",
  cyan: "#22c7c7",
  green: "#2fa84f",
  yellow: "#ffd23f",
  orange: "#ff8a2a",
  red: "#e4372c",
  white: "#ffffff",
};

const ARROW: Record<WheelState, string> = {
  stopped: "",
  forward: "M20 34V10M10 20L20 8L30 20",
  backward: "M20 6V30M10 22L20 34L30 22",
};

function Wheel({ state, label, side }: { state: WheelState; label: string; side: "a" | "b" }) {
  return (
    <svg className={`wheel wheel-${side}`} viewBox="0 0 40 44" role="img" aria-label={label}>
      <rect x="4" y="2" width="32" height="40" rx="9" className="wheel-body" />
      {state !== "stopped" && <path d={ARROW[state]} className={`wheel-arrow ${state}`} />}
    </svg>
  );
}

export type PreviewSource = "simulator" | "hub";

/**
 * A tiny picture of the robot: the hub light and the two wheels, under a small label that says
 * whether it is the simulator or the real hub.
 */
export function SimPreview({
  snapshot,
  t,
  source,
}: {
  snapshot: EditorSnapshot;
  t: Translate;
  source: PreviewSource;
}) {
  return (
    <div
      className="sim-preview"
      role="group"
      aria-label={t("editor.preview")}
      data-led={snapshot.led}
      data-wheel-a={snapshot.wheels.a}
      data-wheel-b={snapshot.wheels.b}
      data-source={source}
    >
      <span className="sim-source">{t(`editor.source.${source}`)}</span>
      <div className="sim-robot">
        <Wheel
          side="a"
          state={snapshot.wheels.a}
          label={`${t("editor.wheelA")}: ${t(`editor.state.${snapshot.wheels.a}`)}`}
        />
        <svg className="hub" viewBox="0 0 64 64" role="img" aria-label={t("editor.previewLed")}>
          <rect x="4" y="4" width="56" height="56" rx="14" className="hub-body" />
          <circle
            cx="32"
            cy="32"
            r="14"
            className="hub-led"
            style={{ fill: LED_FILL[snapshot.led] }}
          />
        </svg>
        <Wheel
          side="b"
          state={snapshot.wheels.b}
          label={`${t("editor.wheelB")}: ${t(`editor.state.${snapshot.wheels.b}`)}`}
        />
      </div>
    </div>
  );
}
