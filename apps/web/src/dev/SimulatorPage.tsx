import type { MotorState } from "@mecahub/simulator";
import { useId, useSyncExternalStore, type ReactNode } from "react";
import type { MessageKey, Translate } from "../i18n.js";
import { ProbePanel } from "./ConnectPage.js";
import {
  COLOR_NONE,
  STOP_BUDGET_MS,
  type DriveTarget,
  type SimController,
  type SimSnapshot,
} from "./sim-controller.js";

export interface SimulatorPageProps {
  controller: SimController;
  t: Translate;
  copy: (text: string) => Promise<void>;
}

/** Color ids the sensor can report (LWP3 color table) and their label keys. */
const COLORS: readonly [number, MessageKey][] = [
  [COLOR_NONE, "dev.sim.color.none"],
  [0, "dev.sim.color.black"],
  [3, "dev.sim.color.blue"],
  [6, "dev.sim.color.green"],
  [7, "dev.sim.color.yellow"],
  [9, "dev.sim.color.red"],
  [10, "dev.sim.color.white"],
];

export function SimulatorPage({ controller, t, copy }: SimulatorPageProps) {
  const snap = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  );
  return (
    <main className="sim">
      <h1>{t("dev.sim.title")}</h1>
      <p>{t("dev.sim.intro")}</p>
      <div className="sim-columns">
        <section className="sim-panel" aria-labelledby="sim-hub-heading">
          <h2 id="sim-hub-heading">{t("dev.sim.hubHeading")}</h2>
          <HubControls controller={controller} snap={snap} t={t} />
          <Motors snap={snap} t={t} />
        </section>
        <section className="sim-panel" aria-labelledby="sim-app-heading">
          <h2 id="sim-app-heading">{t("dev.sim.appHeading")}</h2>
          <div className="connect">
            <ProbePanel probe={controller.probe} t={t} copy={copy} intro="dev.sim.appIntro" />
          </div>
          <MotorTest controller={controller} snap={snap} t={t} />
        </section>
      </div>
    </main>
  );
}

interface PartProps {
  controller: SimController;
  snap: SimSnapshot;
  t: Translate;
}

function Range(props: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  shown: string;
  onChange: (value: number) => void;
  hint?: string;
}) {
  const id = useId();
  return (
    <div className="field">
      <label htmlFor={id}>{props.label}</label>
      <input
        id={id}
        type="range"
        min={props.min}
        max={props.max}
        step={props.step ?? 1}
        value={props.value}
        onChange={(e) => props.onChange(Number(e.target.value))}
        aria-describedby={props.hint ? `${id}-hint` : undefined}
      />
      <output htmlFor={id}>{props.shown}</output>
      {props.hint ? <small id={`${id}-hint`}>{props.hint}</small> : null}
    </div>
  );
}

function HubControls({ controller, snap, t }: PartProps) {
  const colorId = useId();
  return (
    <>
      <fieldset>
        <legend>{t("dev.sim.inputsHeading")}</legend>
        <Range
          label={t("dev.sim.battery")}
          value={snap.battery}
          min={0}
          max={100}
          shown={t("dev.connect.batteryValue", { percent: snap.battery })}
          onChange={(v) => controller.setBattery(v)}
        />
        <p>
          <button
            type="button"
            aria-pressed={snap.button}
            onClick={() => controller.setButton(!snap.button)}
          >
            {t("dev.sim.buttonLabel")}
          </button>{" "}
        </p>
        <Range
          label={t("dev.sim.tiltX")}
          value={snap.tilt.x}
          min={-90}
          max={90}
          shown={t("dev.sim.degreesValue", { value: snap.tilt.x })}
          onChange={(v) => controller.setTilt(v, snap.tilt.y)}
        />
        <Range
          label={t("dev.sim.tiltY")}
          value={snap.tilt.y}
          min={-90}
          max={90}
          shown={t("dev.sim.degreesValue", { value: snap.tilt.y })}
          onChange={(v) => controller.setTilt(snap.tilt.x, v)}
        />
        <div className="field">
          <label htmlFor={colorId}>{t("dev.sim.color")}</label>
          <select
            id={colorId}
            value={snap.color}
            onChange={(e) => controller.setColor(Number(e.target.value))}
          >
            {COLORS.map(([id, key]) => (
              <option key={id} value={id}>
                {t(key)}
              </option>
            ))}
          </select>
        </div>
        <Range
          label={t("dev.sim.distance")}
          value={snap.distance}
          min={0}
          max={10}
          shown={String(snap.distance)}
          onChange={(v) => controller.setDistance(v)}
          hint={t("dev.sim.sensorsNote")}
        />
      </fieldset>
      <fieldset>
        <legend>{t("dev.sim.faultsHeading")}</legend>
        <p>
          <button type="button" onClick={() => controller.dropLink()}>
            {t("dev.sim.dropLink")}
          </button>
        </p>
        <p>
          <label>
            <input
              type="checkbox"
              checked={snap.stalled}
              onChange={(e) => controller.setStalled(e.target.checked)}
            />{" "}
            {t("dev.sim.stall")}
          </label>{" "}
          <button type="button" disabled={!snap.stalled} onClick={() => controller.releaseWrite()}>
            {t("dev.sim.releaseWrite")}
          </button>
        </p>
        <Range
          label={t("dev.sim.latency")}
          value={snap.writeLatencyMs}
          min={0}
          max={500}
          step={10}
          shown={t("dev.sim.latencyValue", { ms: snap.writeLatencyMs })}
          onChange={(v) => controller.setWriteLatency(v)}
          hint={t("dev.sim.latencyHint")}
        />
      </fieldset>
    </>
  );
}

function Motors({ snap, t }: Pick<PartProps, "snap" | "t">) {
  return (
    <section aria-labelledby="sim-motors-heading">
      <h3 id="sim-motors-heading">{t("dev.sim.motorsHeading")}</h3>
      <div className="motors">
        {snap.motors.map(({ port, state }) => (
          <Readout
            key={port}
            title={t("dev.sim.motor", { name: String.fromCharCode(65 + port) })}
            state={state}
            t={t}
          />
        ))}
      </div>
    </section>
  );
}

function Readout(props: { title: string; state: MotorState; t: Translate }): ReactNode {
  const { title, state, t } = props;
  return (
    <figure className="motor">
      <svg viewBox="0 0 64 64" width="64" height="64" aria-hidden="true" focusable="false">
        <circle cx="32" cy="32" r="29" className="dial" />
        <line
          x1="32"
          y1="32"
          x2="32"
          y2="7"
          className="needle"
          transform={`rotate(${state.position % 360} 32 32)`}
        />
      </svg>
      <figcaption>
        <strong>{title}</strong>
        <br />
        {t("dev.sim.position")}: {t("dev.sim.positionValue", { degrees: state.position })}
        <br />
        {t("dev.sim.speed")}: {t("dev.sim.speedValue", { percent: state.speed })}
      </figcaption>
    </figure>
  );
}

function MotorTest({ controller, snap, t }: PartProps) {
  const drive = (target: DriveTarget) => () => void controller.drive(target, 50);
  const stop = snap.stop;
  return (
    <section aria-labelledby="sim-test-heading">
      <h3 id="sim-test-heading">{t("dev.sim.testHeading")}</h3>
      <p>
        <button type="button" onClick={drive("a")}>
          {t("dev.sim.aForward")}
        </button>{" "}
        <button type="button" onClick={drive("b")}>
          {t("dev.sim.bForward")}
        </button>{" "}
        <button type="button" onClick={drive("ab")}>
          {t("dev.sim.abForward")}
        </button>
      </p>
      <button type="button" className="stop" onClick={() => void controller.stop()}>
        {t("dev.sim.stop")}
      </button>
      <p aria-live="polite">
        <strong>{t("dev.sim.stopLatency")}:</strong>{" "}
        {stop.status === "idle"
          ? t("dev.sim.stopIdle")
          : stop.status === "pending"
            ? t("dev.sim.stopPending")
            : stop.status === "failed"
              ? t("dev.sim.stopFailed")
              : t(stop.withinBudget ? "dev.sim.stopWithin" : "dev.sim.stopOver", {
                  ms: stop.ms,
                  budget: STOP_BUDGET_MS,
                })}
      </p>
    </section>
  );
}
