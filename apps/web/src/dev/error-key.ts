import { TransportError } from "@mecahub/transport";
import type { MessageKey } from "../i18n.js";

const byCode: Record<TransportError["code"], MessageKey> = {
  cancelled: "dev.connect.error.cancelled",
  unsupported: "dev.connect.error.unsupported",
  gatt: "dev.connect.error.gatt",
  "no-device": "dev.connect.error.no-device",
  "not-connected": "dev.connect.error.not-connected",
};

export function errorKey(err: unknown): MessageKey {
  return err instanceof TransportError ? byCode[err.code] : "dev.connect.error.unknown";
}
