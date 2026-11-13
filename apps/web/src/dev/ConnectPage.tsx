import { useId, useState, useSyncExternalStore } from "react";
import type { MessageKey, Translate } from "../i18n.js";
import { errorKey } from "./error-key.js";
import type { HubProbe, LogEntry } from "./hub-probe.js";

export interface ConnectPageProps {
  /** Undefined when the browser has no Web Bluetooth. */
  probe: HubProbe | undefined;
  t: Translate;
  copy: (text: string) => Promise<void>;
}

const formatEntry = (e: LogEntry): string =>
  `${String(e.at).padStart(6)} ms  ${e.dir}  ${e.hex}${e.note === undefined ? "" : `  # ${e.note}`}`;

export function ConnectPage({ probe, t, copy }: ConnectPageProps) {
  return (
    <main className="connect">
      <h1>{t("dev.connect.title")}</h1>
      {probe ? (
        <ProbePanel probe={probe} t={t} copy={copy} intro="dev.connect.intro" />
      ) : (
        <>
          <p role="alert">{t("dev.connect.unsupported")}</p>
          <p>{t("dev.connect.unsupportedLinux")}</p>
        </>
      )}
    </main>
  );
}

/** Connect / disconnect / copy buttons, state, name, battery and the hex log of a hub probe. */
export function ProbePanel({
  probe,
  t,
  copy,
  intro,
}: ConnectPageProps & { probe: HubProbe; intro: MessageKey }) {
  const snapshot = useSyncExternalStore(probe.subscribe, probe.getSnapshot, probe.getSnapshot);
  const [message, setMessage] = useState<MessageKey | undefined>();
  const logHeadingId = useId();
  const busy = snapshot.state === "choosing" || snapshot.state === "connecting";
  // After a link loss the values are the last ones received, not current readings.
  const lastKnown = snapshot.state === "connected" ? "" : ` (${t("dev.connect.lastKnown")})`;
  const connected = snapshot.state === "connected";

  // Called straight from the click: Web Bluetooth needs the user gesture.
  const onConnect = (): void => {
    setMessage(undefined);
    probe.connect().catch((err: unknown) => setMessage(errorKey(err)));
  };
  const onDisconnect = (): void => {
    probe.disconnect().catch((err: unknown) => setMessage(errorKey(err)));
  };
  const onCopy = (): void => {
    copy(probe.exportLog()).then(
      () => setMessage("dev.connect.copied"),
      () => setMessage("dev.connect.copyFailed"),
    );
  };

  return (
    <>
      <p>{t(intro)}</p>
      <p>
        <button type="button" onClick={onConnect} disabled={busy || connected}>
          {t("dev.connect.connect")}
        </button>{" "}
        <button type="button" onClick={onDisconnect} disabled={!busy && !connected}>
          {t("dev.connect.disconnect")}
        </button>{" "}
        <button type="button" onClick={onCopy} disabled={snapshot.log.length === 0}>
          {t("dev.connect.copyLog")}
        </button>
      </p>
      <p role="status">{message ? t(message) : ""}</p>
      <dl>
        <dt>{t("dev.connect.stateLabel")}</dt>
        <dd aria-live="polite">{t(`dev.connect.state.${snapshot.state}`)}</dd>
        <dt>{t("dev.connect.nameLabel")}</dt>
        <dd>
          {snapshot.name === undefined ? t("dev.connect.unknown") : snapshot.name + lastKnown}
        </dd>
        <dt>{t("dev.connect.batteryLabel")}</dt>
        <dd>
          {snapshot.batteryPercent === undefined
            ? t("dev.connect.unknown")
            : t("dev.connect.batteryValue", { percent: snapshot.batteryPercent }) + lastKnown}
        </dd>
      </dl>
      <h2 id={logHeadingId}>{t("dev.connect.logLabel")}</h2>
      <pre className="log" tabIndex={0} aria-labelledby={logHeadingId}>
        {snapshot.log.length === 0
          ? t("dev.connect.logEmpty")
          : snapshot.log.map(formatEntry).join("\n")}
      </pre>
    </>
  );
}
