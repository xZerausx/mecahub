import { describe, expect, it } from "vitest";
import {
  ErrorCode,
  HubPropertyId,
  HubPropertyOperation,
  IoTypeId,
  MessageType,
} from "./constants.js";

// literal: ids copied from the doc: message types 3.3, hub properties and operations 3.5,
// error codes 3.9.2, I/O types 3.8.4 (the doc says the I/O list may not be current).
describe("constants", () => {
  it("message types", () => {
    expect(MessageType.HubProperties).toBe(0x01);
    expect(MessageType.GenericError).toBe(0x05);
    expect(MessageType.HubAttachedIo).toBe(0x04);
    expect(MessageType.PortOutputCommand).toBe(0x81);
    expect(MessageType.PortOutputCommandFeedback).toBe(0x82);
  });

  it("hub property ids and operations", () => {
    expect(HubPropertyId.AdvertisingName).toBe(0x01);
    expect(HubPropertyId.Button).toBe(0x02);
    expect(HubPropertyId.FirmwareVersion).toBe(0x03);
    expect(HubPropertyId.HardwareVersion).toBe(0x04);
    expect(HubPropertyId.Rssi).toBe(0x05);
    expect(HubPropertyId.BatteryVoltage).toBe(0x06);
    expect(HubPropertyId.PrimaryMacAddress).toBe(0x0d);
    expect(HubPropertyOperation.Set).toBe(0x01);
    expect(HubPropertyOperation.EnableUpdates).toBe(0x02);
    expect(HubPropertyOperation.DisableUpdates).toBe(0x03);
    expect(HubPropertyOperation.Reset).toBe(0x04);
    expect(HubPropertyOperation.RequestUpdate).toBe(0x05);
    expect(HubPropertyOperation.Update).toBe(0x06);
  });

  it("error codes", () => {
    expect(ErrorCode.Ack).toBe(0x01);
    expect(ErrorCode.CommandNotRecognized).toBe(0x05);
    expect(ErrorCode.InternalError).toBe(0x08);
  });

  it("io types", () => {
    expect(IoTypeId.Motor).toBe(0x0001);
    expect(IoTypeId.ColorDistanceSensor).toBe(0x0025);
    expect(IoTypeId.InternalMotorWithTacho).toBe(0x0027);
    expect(IoTypeId.InternalTilt).toBe(0x0028);
  });
});
