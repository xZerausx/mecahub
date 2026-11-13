/** Message type ids (doc 3.3). */
export const MessageType = {
  HubProperties: 0x01,
  HubActions: 0x02,
  HubAlerts: 0x03,
  HubAttachedIo: 0x04,
  GenericError: 0x05,
  HwNetworkCommands: 0x08,
  GoIntoBootMode: 0x10,
  LockMemory: 0x11,
  LockStatusRequest: 0x12,
  LockStatus: 0x13,
  PortInformationRequest: 0x21,
  PortModeInformationRequest: 0x22,
  PortInputFormatSetupSingle: 0x41,
  PortInputFormatSetupCombined: 0x42,
  PortInformation: 0x43,
  PortModeInformation: 0x44,
  PortValueSingle: 0x45,
  PortValueCombined: 0x46,
  PortInputFormatSingle: 0x47,
  PortInputFormatCombined: 0x48,
  VirtualPortSetup: 0x61,
  PortOutputCommand: 0x81,
  PortOutputCommandFeedback: 0x82,
} as const;
export type MessageType = (typeof MessageType)[keyof typeof MessageType];

/** Hub property ids (doc 3.5). */
export const HubPropertyId = {
  AdvertisingName: 0x01,
  Button: 0x02,
  FirmwareVersion: 0x03,
  HardwareVersion: 0x04,
  Rssi: 0x05,
  /** Doc name; the value is a percentage 0..100 (decoded as `batteryPercent`). */
  BatteryVoltage: 0x06,
  BatteryType: 0x07,
  ManufacturerName: 0x08,
  RadioFirmwareVersion: 0x09,
  ProtocolVersion: 0x0a,
  SystemTypeId: 0x0b,
  HardwareNetworkId: 0x0c,
  PrimaryMacAddress: 0x0d,
  SecondaryMacAddress: 0x0e,
  HardwareNetworkFamily: 0x0f,
} as const;
export type HubPropertyId = (typeof HubPropertyId)[keyof typeof HubPropertyId];

/** Hub property operations (doc 3.5). Update is upstream only. */
export const HubPropertyOperation = {
  Set: 0x01,
  EnableUpdates: 0x02,
  DisableUpdates: 0x03,
  Reset: 0x04,
  RequestUpdate: 0x05,
  Update: 0x06,
} as const;
export type HubPropertyOperation = (typeof HubPropertyOperation)[keyof typeof HubPropertyOperation];

/** Generic error codes (doc 3.9.2). */
export const ErrorCode = {
  Ack: 0x01,
  Mack: 0x02,
  BufferOverflow: 0x03,
  Timeout: 0x04,
  CommandNotRecognized: 0x05,
  InvalidUse: 0x06,
  Overcurrent: 0x07,
  InternalError: 0x08,
} as const;
export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

/** End state of a timed/positioned motor command (doc 3.27, EndState). */
export const EndState = { Float: 0, Hold: 126, Brake: 127 } as const;
export type EndState = (typeof EndState)[keyof typeof EndState];

/** I/O device type ids (doc 3.8.4; the doc says the list may not be current). */
export const IoTypeId = {
  Motor: 0x0001,
  SystemTrainMotor: 0x0002,
  Button: 0x0005,
  LedLight: 0x0008,
  Voltage: 0x0014,
  Current: 0x0015,
  PiezoTone: 0x0016,
  RgbLight: 0x0017,
  ExternalTiltSensor: 0x0022,
  MotionSensor: 0x0023,
  /** The doc calls 0x0025 "Vision Sensor" (color + distance). */
  ColorDistanceSensor: 0x0025,
  ExternalMotorWithTacho: 0x0026,
  InternalMotorWithTacho: 0x0027,
  InternalTilt: 0x0028,
} as const;
export type IoTypeId = (typeof IoTypeId)[keyof typeof IoTypeId];

/**
 * Color ids of the LWP3 color table ('derivado del layout': pylgbst peripherals.py:22-33 and
 * node-poweredup consts.ts:138-151 agree on all twelve values): what the color & distance sensor reports in mode 0 and what the
 * hub LED takes in its index mode (names after the refs). `None` (255) is "no color": the sensor sees
 * nothing, and for the LED it means off like `Black`.
 */
export const ColorId = {
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
} as const;
export type ColorId = (typeof ColorId)[keyof typeof ColorId];

const COLOR_IDS: readonly number[] = Object.values(ColorId);
/** Whether `value` is an id of the color table (a sensor may report ones the refs do not list). */
export const isColorId = (value: number): value is ColorId => COLOR_IDS.includes(value);
