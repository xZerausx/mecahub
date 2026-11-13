import { describe, expect, it } from "vitest";
import {
  ColorId,
  ErrorCode,
  HubPropertyId,
  HubPropertyOperation,
  IoTypeId,
  MessageType,
  isColorId,
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

  it("color ids", () => {
    // derivado del layout: pylgbst peripherals.py:22-33 and node-poweredup consts.ts:138-151 agree
    // on all twelve values (the doc's color table is not in the repo).
    expect(ColorId).toEqual({
      Black: 0,
      Pink: 1,
      Purple: 2,
      Blue: 3,
      LightBlue: 4,
      Cyan: 5,
      Green: 6,
      Yellow: 7,
      Orange: 8,
      Red: 9,
      White: 10,
      None: 255,
    });
  });

  it("isColorId tells table ids from other bytes", () => {
    expect(isColorId(0)).toBe(true);
    expect(isColorId(255)).toBe(true);
    expect(isColorId(11)).toBe(false);
    expect(isColorId(42)).toBe(false);
  });
});
