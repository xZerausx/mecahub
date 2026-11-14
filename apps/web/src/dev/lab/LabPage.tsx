import { useEffect, useId, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import type { MessageKey, Translate } from "../../i18n.js";
import {
  STOP_BUDGET_MS,
  type FeedbackResult,
  type LabController,
  type LabSnapshot,
  type MeasurementName,
  type MotorSpeedResult,
  type MotorTarget,
  type MultiMessageResult,
  type StopOnLinkLossResult,
  type WriteLatencyResult,
} from "./lab-types.js";
import {
  COLOR_CHOICES,
  canMeasure,
  canStartLinkLoss,
  colorKey,
  installStopKey,
  labErrorKey,
  needsLeaveGuard,
} from "./lab-ui.js";

export interface LabPageProps {
  controller: LabController;
  t: Translate;
  copy: (text: string) => Promise<void>;
  /** Offers a text file to the user (a Blob URL on the page; never the network). */
  save: (name: string, text: string, type: string) => void;
}

const LETTERS = ["a", "b", "c", "d"] as const;
const portName = (port: number): string => String.fromCharCode(65 + port);
const hex = (n: number, width = 2): string => `0x${n.toString(16).padStart(width, "0")}`;

interface PartProps {
  controller: LabController;
  snap: LabSnapshot;
  t: Translate;
}

export function LabPage({ controller, t, copy, save }: LabPageProps) {
  const snap = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  );
  // Escape is the keyboard STOP, wherever the focus is (capture phase, repeats ignored).
  useEffect(() => installStopKey(window, () => void controller.stop()), [controller]);
  // Leaving now would strand a running motor: ask first.
  const leaveGuard = needsLeaveGuard(snap);
  useEffect(() => {
    if (!leaveGuard) return;
    const onLeave = (event: BeforeUnloadEvent): void => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", onLeave);
    return () => window.removeEventListener("beforeunload", onLeave);
  }, [leaveGuard]);

  return (
    <main className="lab">
      <header>
        <h1>{t("dev.lab.title")}</h1>
        <p>{t("dev.lab.intro")}</p>
      </header>
      <StopBar controller={controller} snap={snap} t={t} />
      <div className="lab-columns">
        <div>
          <Connection controller={controller} snap={snap} t={t} />
          <Devices snap={snap} t={t} />
          <Motors controller={controller} snap={snap} t={t} />
          <Readings controller={controller} snap={snap} t={t} />
        </div>
        <div>
          <Measurements controller={controller} snap={snap} t={t} />
          <Diagnostics snap={snap} t={t} />
          <Export controller={controller} t={t} copy={copy} save={save} />
        </div>
      </div>
    </main>
  );
}

function StopBar({ controller, snap, t }: PartProps) {
  const stop = snap.stop;
  const text =
    stop.status === "idle"
      ? t("dev.lab.stopIdle")
      : stop.status === "pending"
        ? t("dev.lab.stopPending")
        : !stop.ok
          ? t("dev.lab.stopFailed", { errors: stop.errors, ms: stop.ms })
          : t(stop.withinBudget ? "dev.lab.stopWithin" : "dev.lab.stopOver", {
              ms: stop.ms,
              budget: STOP_BUDGET_MS,
            });
  return (
    <section className="lab-stopbar" aria-label={t("dev.lab.stop")}>
      <button
        type="button"
        className="lab-stop"
        aria-keyshortcuts="Escape"
        onClick={() => void controller.stop()}
      >
        {t("dev.lab.stop")}
      </button>
      <p>{t("dev.lab.stopHint")}</p>
      <p aria-live="polite">
        <strong>{t("dev.lab.stopLatency")}</strong>
        <br />
        {text}
      </p>
    </section>
  );
}

function Row(props: { label: string; children: ReactNode }) {
  return (
    <>
      <dt>{props.label}</dt>
      <dd>{props.children}</dd>
    </>
  );
}

function Connection({ controller, snap, t }: PartProps) {
  const [notice, setNotice] = useState<MessageKey | undefined>();
  const awaitingAnswer =
    snap.running === "stopOnLinkLoss" &&
    snap.measurements.stopOnLinkLoss?.phase === "awaiting-observation";
  const idle = snap.connection === "idle" || snap.connection === "disconnected";
  const busy = snap.connection === "choosing" || snap.connection === "connecting";
  const ms = (value: number | undefined): string =>
    value === undefined ? t("dev.connect.unknown") : t("dev.lab.msValue", { ms: value });
  const fail = (err: unknown): void => setNotice(labErrorKey(err));
  const chooseMode = (mode: "simulator" | "real"): void => {
    setNotice(undefined);
    try {
      controller.setMode(mode);
    } catch (err) {
      fail(err);
    }
  };
  return (
    <section className="lab-panel" aria-labelledby="lab-connection">
      <h2 id="lab-connection">{t("dev.lab.connection.heading")}</h2>
      <fieldset>
        <legend>{t("dev.lab.mode.label")}</legend>
        <label>
          <input
            type="radio"
            name="lab-mode"
            value="simulator"
            checked={snap.mode === "simulator"}
            onChange={() => chooseMode("simulator")}
            disabled={!idle}
          />
          <span>{t("dev.lab.mode.simulator")}</span>
        </label>{" "}
        <label>
          <input
            type="radio"
            name="lab-mode"
            value="real"
            checked={snap.mode === "real"}
            onChange={() => chooseMode("real")}
            disabled={!idle || !snap.webBluetoothAvailable}
          />
          <span>{t("dev.lab.mode.real")}</span>
        </label>
        {snap.webBluetoothAvailable ? null : <p>{t("dev.lab.mode.unavailable")}</p>}
        {snap.mode === "simulator" ? <p>{t("dev.lab.mode.simulatorNote")}</p> : null}
      </fieldset>
      <p>
        {/* Straight from the click: Web Bluetooth needs the user gesture. */}
        <button
          type="button"
          onClick={() => {
            setNotice(undefined);
            controller.connect().catch(fail);
          }}
          disabled={!idle || awaitingAnswer}
        >
          {t("dev.lab.connect")}
        </button>{" "}
        <button
          type="button"
          onClick={() => {
            setNotice(undefined);
            controller.reconnect().catch(fail);
          }}
          disabled={snap.connection !== "disconnected"}
        >
          {t("dev.lab.reconnect")}
        </button>{" "}
        <button
          type="button"
          onClick={() => void controller.disconnect().catch(fail)}
          disabled={snap.connection !== "connected" && !busy}
        >
          {t("dev.lab.disconnect")}
        </button>
      </p>
      <p role="status">{notice ? t(notice) : ""}</p>
      <dl>
        <Row label={t("dev.connect.stateLabel")}>
          <span aria-live="polite">{t(`dev.connect.state.${snap.connection}`)}</span>
        </Row>
        <Row label={t("dev.lab.nameLabel")}>{snap.hubName ?? t("dev.connect.unknown")}</Row>
        <Row label={t("dev.lab.firmwareLabel")}>{snap.firmware ?? t("dev.connect.unknown")}</Row>
      </dl>
      <h3>{t("dev.lab.timings.heading")}</h3>
      <dl>
        <Row label={t("dev.lab.timings.chooser")}>{ms(snap.timings.chooserMs)}</Row>
        <Row label={t("dev.lab.timings.connect")}>{ms(snap.timings.connectMs)}</Row>
        <Row label={t("dev.lab.timings.registry")}>{ms(snap.timings.registryMs)}</Row>
        <Row label={t("dev.lab.timings.total")}>{ms(snap.timings.totalMs)}</Row>
      </dl>
    </section>
  );
}

function Devices({ snap, t }: Pick<PartProps, "snap" | "t">) {
  return (
    <section className="lab-panel" aria-labelledby="lab-devices">
      <h2 id="lab-devices">{t("dev.lab.devices.heading")}</h2>
      {snap.devices.length === 0 ? (
        <p>{t("dev.lab.devices.none")}</p>
      ) : (
        <ul>
          {snap.devices.map((d) => (
            <li key={d.port}>
              <strong>
                {d.port <= 3
                  ? t("dev.lab.devices.port", { name: portName(d.port) })
                  : t("dev.lab.devices.internal", { name: hex(d.port) })}
              </strong>
              {": "}
              {t(`dev.lab.kind.${d.kind}`)}
              {d.kind === "other"
                ? ` (${t("dev.lab.devices.ioType", { id: hex(d.ioType, 4) })})`
                : ""}
            </li>
          ))}
        </ul>
      )}
      {snap.hasAb ? <p>{t("dev.lab.devices.ab")}</p> : null}
    </section>
  );
}

function Motors({ controller, snap, t }: PartProps) {
  const ledId = useId();
  return (
    <section className="lab-panel" aria-labelledby="lab-motors">
      <h2 id="lab-motors">{t("dev.lab.motors.heading")}</h2>
      {snap.motors.length === 0 ? <p>{t("dev.lab.motors.none")}</p> : null}
      {snap.motors.map((m) => (
        <MotorPanel
          key={m.port}
          target={LETTERS[m.port] ?? "a"}
          controller={controller}
          snap={snap}
          t={t}
        />
      ))}
      {snap.hasAb ? <MotorPanel target="ab" controller={controller} snap={snap} t={t} /> : null}
      <div className="lab-field">
        <label htmlFor={ledId}>{t("dev.lab.led.label")}</label>
        <select
          id={ledId}
          value={snap.led ?? 255}
          disabled={!snap.ready}
          onChange={(e) => void controller.setLed(Number(e.target.value))}
        >
          {COLOR_CHOICES.map(([id, key]) => (
            <option key={id} value={id}>
              {t(key)}
            </option>
          ))}
        </select>
      </div>
      <p role="status">
        {snap.lastError ? t("dev.lab.error.command", { code: snap.lastError.code }) : ""}
      </p>
    </section>
  );
}

function MotorPanel({ target, controller, snap, t }: PartProps & { target: MotorTarget }) {
  const [speed, setSpeed] = useState(50);
  const [ms, setMs] = useState(1000);
  const [degrees, setDegrees] = useState(90);
  const id = useId();
  const ab = target === "ab";
  const ports = ab ? [0, 1] : [LETTERS.indexOf(target)];
  const off = !snap.ready;
  return (
    <fieldset className="lab-motor">
      <legend>
        {ab ? t("dev.lab.motor.ab") : t("dev.lab.motor.title", { name: target.toUpperCase() })}
      </legend>
      <div className="lab-field">
        <label htmlFor={`${id}-speed`}>{t("dev.lab.motor.speed")}</label>
        <input
          id={`${id}-speed`}
          type="range"
          min={-100}
          max={100}
          value={speed}
          onChange={(e) => setSpeed(Number(e.target.value))}
        />
        <output htmlFor={`${id}-speed`}>{t("dev.lab.motor.speedValue", { percent: speed })}</output>
      </div>
      {ab ? null : (
        <div className="lab-field">
          <label htmlFor={`${id}-ms`}>{t("dev.lab.motor.time")}</label>
          <input
            id={`${id}-ms`}
            type="number"
            min={1}
            max={32767}
            value={ms}
            onChange={(e) => setMs(Number(e.target.value))}
          />
          <span />
          <label htmlFor={`${id}-deg`}>{t("dev.lab.motor.degrees")}</label>
          <input
            id={`${id}-deg`}
            type="number"
            value={degrees}
            onChange={(e) => setDegrees(Number(e.target.value))}
          />
          <span />
        </div>
      )}
      <p>
        <button type="button" disabled={off} onClick={() => void controller.run(target, speed)}>
          {t("dev.lab.motor.run")}
        </button>{" "}
        {ab ? null : (
          <>
            <button
              type="button"
              disabled={off}
              onClick={() => void controller.runFor(target, ms, speed)}
            >
              {t("dev.lab.motor.runFor")}
            </button>{" "}
            <button
              type="button"
              disabled={off}
              onClick={() => void controller.rotate(target, degrees, speed)}
            >
              {t("dev.lab.motor.rotate")}
            </button>{" "}
          </>
        )}
        <button type="button" disabled={off} onClick={() => void controller.brake(target)}>
          {t("dev.lab.motor.brake")}
        </button>{" "}
        <button type="button" disabled={off} onClick={() => void controller.float(target)}>
          {t("dev.lab.motor.float")}
        </button>
      </p>
      <dl aria-live="off">
        {ports.map((port) => {
          const m = snap.motors.find((x) => x.port === port);
          return (
            <Row
              key={port}
              label={
                ab
                  ? t("dev.lab.motor.title", { name: portName(port) })
                  : t("dev.lab.motor.position")
              }
            >
              {m?.position === undefined
                ? t("dev.lab.motor.noPosition")
                : t("dev.lab.motor.positionValue", { degrees: m.position })}
              {" / "}
              {t("dev.lab.motor.commanded")}{" "}
              {t("dev.lab.motor.speedValue", { percent: m?.commandedSpeed ?? 0 })}
            </Row>
          );
        })}
      </dl>
    </fieldset>
  );
}

function Readings({ snap, t }: PartProps) {
  const none = t("dev.lab.sensors.none");
  const color =
    snap.color === undefined
      ? none
      : (() => {
          const key = colorKey(snap.color);
          return key ? t(key) : t("dev.lab.color.unknown", { id: snap.color });
        })();
  return (
    <section className="lab-panel" aria-labelledby="lab-readings">
      <h2 id="lab-readings">{t("dev.lab.sensors.heading")}</h2>
      <dl>
        <Row label={t("dev.lab.sensors.tilt")}>
          {snap.tilt ? t("dev.lab.sensors.tiltValue", snap.tilt) : none}
        </Row>
        <Row label={t("dev.lab.sensors.color")}>{color}</Row>
        <Row label={t("dev.lab.sensors.distance")}>
          {snap.distance === undefined
            ? none
            : t("dev.lab.sensors.distanceValue", { inches: snap.distance })}
        </Row>
        <Row label={t("dev.lab.sensors.button")}>
          {snap.button === undefined
            ? none
            : t(snap.button ? "dev.lab.sensors.pressed" : "dev.lab.sensors.released")}
        </Row>
        <Row label={t("dev.lab.sensors.battery")}>
          {snap.battery === undefined
            ? none
            : t("dev.connect.batteryValue", { percent: snap.battery })}
        </Row>
      </dl>
    </section>
  );
}

const TOOL_RUN_KEY = {
  writeLatency: "dev.lab.tool.writeLatency.run",
  motorSpeed: "dev.lab.tool.motorSpeed.run",
  multiMessageWrite: "dev.lab.tool.multiMessageWrite.run",
  feedback: "dev.lab.tool.feedback.run",
} as const;

function Measurements({ controller, snap, t }: PartProps) {
  const [notice, setNotice] = useState<MessageKey | undefined>();
  const [confirmed, setConfirmed] = useState(false);
  const [speedConfirmed, setSpeedConfirmed] = useState(false);
  const [feedbackConfirmed, setFeedbackConfirmed] = useState(false);
  const feedbackConfirmId = useId();
  const speedConfirmId = useId();
  const [port, setPort] = useState<"a" | "b" | "c" | "d">("a");
  const confirmId = useId();
  const portId = useId();
  const ready = canMeasure(snap);
  const motorPorts = snap.motors.flatMap((m) => {
    const letter = LETTERS[m.port];
    return letter ? [letter] : [];
  });
  const exec = (start: () => Promise<unknown>): void => {
    setNotice(undefined);
    start().catch((err: unknown) => setNotice(labErrorKey(err)));
  };
  const heading = (name: MeasurementName) => (
    <>
      <h3>{t(`dev.lab.tool.${name}`)}</h3>
      <p>{t(`dev.lab.tool.${name}.about`)}</p>
    </>
  );
  const none = <p>{t("dev.lab.measure.none")}</p>;
  const linkLoss = snap.measurements.stopOnLinkLoss;
  const awaiting = linkLoss?.phase === "awaiting-observation" && snap.running === "stopOnLinkLoss";
  return (
    <section className="lab-panel" aria-labelledby="lab-measure">
      <h2 id="lab-measure">{t("dev.lab.measure.heading")}</h2>
      <p>{t("dev.lab.measure.intro")}</p>
      <p aria-live="polite">
        {snap.running
          ? t("dev.lab.measure.running", { name: t(`dev.lab.tool.${snap.running}`) })
          : t("dev.lab.measure.idle")}
      </p>
      <p role="status">{notice ? t(notice) : ""}</p>

      <section aria-label={t("dev.lab.tool.writeLatency")}>
        {heading("writeLatency")}
        <button
          type="button"
          disabled={!ready}
          onClick={() => exec(() => controller.measureWriteLatency())}
        >
          {t(TOOL_RUN_KEY.writeLatency)}
        </button>
        <div aria-live="polite">
          {snap.measurements.writeLatency ? (
            <LatencyResult result={snap.measurements.writeLatency} t={t} />
          ) : (
            none
          )}
        </div>
      </section>

      <section aria-label={t("dev.lab.tool.motorSpeed")}>
        {heading("motorSpeed")}
        <div className="lab-field">
          <label htmlFor={portId}>{t("dev.lab.tool.motorPort")}</label>
          <select id={portId} value={port} onChange={(e) => setPort(e.target.value as typeof port)}>
            {motorPorts.map((p) => (
              <option key={p} value={p}>
                {t("dev.lab.motor.title", { name: p.toUpperCase() })}
              </option>
            ))}
          </select>
        </div>
        <p className="lab-warning" role="note">
          {t("dev.lab.tool.motorSpeed.warning")}
        </p>
        <p>
          <input
            id={speedConfirmId}
            type="checkbox"
            checked={speedConfirmed}
            onChange={(e) => setSpeedConfirmed(e.target.checked)}
          />{" "}
          <label htmlFor={speedConfirmId}>{t("dev.lab.linkLoss.confirm")}</label>
        </p>
        <button
          type="button"
          disabled={!ready || motorPorts.length === 0 || !speedConfirmed}
          onClick={() => {
            exec(() => controller.measureMotorSpeed(port, { confirmed: speedConfirmed }));
            setSpeedConfirmed(false);
          }}
        >
          {t(TOOL_RUN_KEY.motorSpeed)}
        </button>
        <div aria-live="polite">
          {snap.measurements.motorSpeed ? (
            <SpeedResult result={snap.measurements.motorSpeed} t={t} />
          ) : (
            none
          )}
        </div>
      </section>

      <section aria-label={t("dev.lab.tool.multiMessageWrite")}>
        {heading("multiMessageWrite")}
        <button
          type="button"
          disabled={!ready}
          onClick={() => exec(() => controller.testMultiMessageWrite())}
        >
          {t(TOOL_RUN_KEY.multiMessageWrite)}
        </button>
        <div aria-live="polite">
          {snap.measurements.multiMessageWrite ? (
            <MultiResult result={snap.measurements.multiMessageWrite} t={t} />
          ) : (
            none
          )}
        </div>
      </section>

      <section aria-label={t("dev.lab.tool.stopOnLinkLoss")}>
        {heading("stopOnLinkLoss")}
        <p className="lab-warning" role="note">
          {t("dev.lab.linkLoss.warning")}
        </p>
        <p>
          <input
            id={confirmId}
            type="checkbox"
            checked={confirmed}
            onChange={(e) => setConfirmed(e.target.checked)}
          />{" "}
          <label htmlFor={confirmId}>{t("dev.lab.linkLoss.confirm")}</label>
        </p>
        <button
          type="button"
          className="lab-danger"
          disabled={!canStartLinkLoss(confirmed, snap)}
          onClick={() => {
            exec(() => controller.testStopOnLinkLoss({ confirmed }));
            setConfirmed(false);
          }}
        >
          {t("dev.lab.linkLoss.start")}
        </button>
        {awaiting ? (
          <div>
            <p>{t("dev.lab.linkLoss.awaiting")}</p>
            <p>
              <button
                type="button"
                onClick={() => exec(() => controller.recordObservation("stopped"))}
              >
                {t("dev.lab.linkLoss.stopped")}
              </button>{" "}
              <button
                type="button"
                onClick={() => exec(() => controller.recordObservation("kept-running"))}
              >
                {t("dev.lab.linkLoss.keptRunning")}
              </button>{" "}
              {snap.mode === "simulator" ? (
                <button type="button" onClick={() => exec(() => controller.recordObservation())}>
                  {t("dev.lab.linkLoss.fromSim")}
                </button>
              ) : null}
            </p>
            <p>{t("dev.lab.linkLoss.reconnectNote")}</p>
          </div>
        ) : null}
        <div aria-live="polite">
          {linkLoss && !awaiting ? <LinkLossResult result={linkLoss} t={t} /> : null}
          {linkLoss ? null : none}
        </div>
      </section>

      <section aria-label={t("dev.lab.tool.feedback")}>
        {heading("feedback")}
        <p className="lab-warning" role="note">
          {t("dev.lab.tool.feedback.warning")}
        </p>
        <p>
          <input
            id={feedbackConfirmId}
            type="checkbox"
            checked={feedbackConfirmed}
            onChange={(e) => setFeedbackConfirmed(e.target.checked)}
          />{" "}
          <label htmlFor={feedbackConfirmId}>{t("dev.lab.linkLoss.confirm")}</label>
        </p>
        <button
          type="button"
          disabled={!ready || motorPorts.length === 0 || !feedbackConfirmed}
          onClick={() => {
            exec(() => controller.captureFeedback({ confirmed: feedbackConfirmed }));
            setFeedbackConfirmed(false);
          }}
        >
          {t(TOOL_RUN_KEY.feedback)}
        </button>
        <div aria-live="polite">
          {snap.measurements.feedback ? (
            <FeedbackResultView result={snap.measurements.feedback} t={t} />
          ) : (
            none
          )}
        </div>
      </section>
    </section>
  );
}

function Raw({ value, t }: { value: unknown; t: Translate }) {
  return (
    <details>
      <summary>{t("dev.lab.measure.json")}</summary>
      <pre className="lab-raw">{JSON.stringify(value, null, 2)}</pre>
    </details>
  );
}

function LatencyResult({ result, t }: { result: WriteLatencyResult; t: Translate }) {
  return (
    <>
      <p>
        {t("dev.lab.latency.counts", {
          completed: result.completed,
          requested: result.requested,
          errors: result.writeErrors,
          lost: result.lostReplies,
        })}
      </p>
      <p>
        {result.write
          ? t("dev.lab.latency.write", { ...result.write })
          : t("dev.lab.latency.noSamples")}
      </p>
      <p>
        {result.rtt ? t("dev.lab.latency.rtt", { ...result.rtt }) : t("dev.lab.latency.noSamples")}
      </p>
      {result.interrupted ? <p>{t("dev.lab.latency.interrupted")}</p> : null}
      <Raw value={result} t={t} />
    </>
  );
}

function SpeedResult({ result, t }: { result: MotorSpeedResult; t: Translate }) {
  return (
    <>
      {result.runs.map((run) => (
        <p key={run.speedPct}>
          {run.degPerSec === undefined
            ? t("dev.lab.speed.noData", { speed: run.speedPct, status: run.status })
            : t("dev.lab.speed.run", {
                speed: run.speedPct,
                degPerSec: run.degPerSec,
                wall: run.degPerSecWall,
                degrees: run.degrees,
                max: run.estimatedMaxDegPerSec ?? 0,
                status: run.status,
              })}
        </p>
      ))}
      {result.interrupted ? <p>{t("dev.lab.speed.interrupted")}</p> : null}
      <Raw value={result} t={t} />
    </>
  );
}

function MultiResult({ result, t }: { result: MultiMessageResult; t: Translate }) {
  return (
    <>
      <p>{t(`dev.lab.multi.${result.outcome}`)}</p>
      {result.writeError ? (
        <p>{t("dev.lab.multi.writeError", { error: result.writeError })}</p>
      ) : null}
      <Raw value={result} t={t} />
    </>
  );
}

function LinkLossResult({ result, t }: { result: StopOnLinkLossResult; t: Translate }) {
  const yes = (v: boolean | undefined) => t(v ? "dev.lab.yes" : "dev.lab.no");
  return (
    <>
      {result.phase === "aborted" ? <p>{t("dev.lab.linkLoss.aborted")}</p> : null}
      {result.phase === "done" && result.observation ? (
        <p>
          {t("dev.lab.linkLoss.done", {
            observation: t(`dev.lab.observation.${result.observation}`),
            reconnected: yes(result.reconnected),
            stop: result.stopAfterReconnect ? yes(result.stopAfterReconnect.ok) : yes(false),
          })}
        </p>
      ) : null}
      {result.phase === "done" && !result.reconnected ? (
        <p role="alert">{t("dev.lab.linkLoss.notReconnected")}</p>
      ) : null}
      <Raw value={result} t={t} />
    </>
  );
}

function FeedbackResultView({ result, t }: { result: FeedbackResult; t: Translate }) {
  const flags = result.frames.map((f) => hex(f.flags)).join(", ");
  return (
    <>
      <p>
        {t("dev.lab.feedback.result", {
          status: result.status,
          flags: flags === "" ? t("dev.lab.feedback.noFrames") : flags,
          idle: t(result.sawCompletedIdle ? "dev.lab.yes" : "dev.lab.no"),
        })}
      </p>
      <Raw value={result} t={t} />
    </>
  );
}

function Diagnostics({ snap, t }: Pick<PartProps, "snap" | "t">) {
  return (
    <section className="lab-panel" aria-labelledby="lab-diag">
      <h2 id="lab-diag">{t("dev.lab.diag.heading")}</h2>
      <div aria-live="polite">
        {snap.diagnostics.length === 0 ? (
          <p>{t("dev.lab.diag.none")}</p>
        ) : (
          <ul>
            {snap.diagnostics.map((d, i) => (
              <li key={i}>
                {t("dev.lab.msValue", { ms: d.at })} {t(`dev.lab.diag.${d.kind}`)}
                {d.detail === "" ? null : (
                  <>
                    {": "}
                    <code>{d.detail}</code>
                  </>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

function Export({
  controller,
  t,
  copy,
  save,
}: Pick<PartProps, "controller" | "t"> & Pick<LabPageProps, "copy" | "save">) {
  const [notice, setNotice] = useState<MessageKey | undefined>();
  const [fallback, setFallback] = useState<string | undefined>();
  const area = useRef<HTMLTextAreaElement>(null);
  const areaId = useId();
  // No clipboard: the text is shown selected so the user can copy it by hand.
  useEffect(() => {
    area.current?.focus();
    area.current?.select();
  }, [fallback]);
  const onCopy = (): void => {
    const text = controller.exportCapture();
    setFallback(undefined);
    copy(text).then(
      () => setNotice("dev.lab.export.copied"),
      () => {
        setFallback(text);
        setNotice("dev.lab.export.selected");
      },
    );
  };
  return (
    <section className="lab-panel" aria-labelledby="lab-export">
      <h2 id="lab-export">{t("dev.lab.export.heading")}</h2>
      <p>{t("dev.lab.export.note")}</p>
      <p>
        <button type="button" onClick={onCopy}>
          {t("dev.lab.export.copy")}
        </button>{" "}
        <button
          type="button"
          onClick={() => {
            const stamp = new Date().toISOString().replace(/[:.]/g, "-");
            save(`mecahub-lab-${stamp}.json`, controller.exportJson(), "application/json");
            setNotice("dev.lab.export.saved");
          }}
        >
          {t("dev.lab.export.json")}
        </button>
      </p>
      <p role="status">{notice ? t(notice) : ""}</p>
      {fallback === undefined ? null : (
        <p>
          <label htmlFor={areaId}>{t("dev.lab.export.textLabel")}</label>
          <textarea
            id={areaId}
            ref={area}
            className="lab-raw"
            readOnly
            rows={10}
            value={fallback}
          />
        </p>
      )}
    </section>
  );
}
