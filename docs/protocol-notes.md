# Protocol notes

Findings from the real hub vs. the official docs.

Nothing recorded yet. Add each discrepancy with: date, message/bytes, expected (docs), observed (hub), firmware version.

## Unverified on hardware (TODO(hw))

Everything here comes from the docs or from other libraries, not from a real Move Hub. When a capture contradicts it, the capture wins (see ADR 0002).

From planning:

- Move Hub feedback status 0x0A (completed + idle) in Port Output Command Feedback (0x82). No ref has a captured 0x0A vector; the bit meanings (0x02 completed, 0x08 idle) are from doc 3.32.
- Whether the Move Hub actually sends several (port, flags) pairs in one 0x82 (the format is confirmed, see below; real behaviour is not).
- `useProfile` handling in motor commands on the Move Hub (the bits are confirmed by node-poweredup, the hub's reaction is not).
- Virtual port AB id is assigned dynamically (>= 0x10). Read it from the Attached Virtual I/O event (0x02, doc 3.8); never hardcode it. The 0x10 in the StartSpeed2 test vector is a test value only.
- Attached I/O message sizes on old firmware.
- Little-endian assumption for multibyte fields other than versions (the doc only states it for 3.5.6).

Found in code (`rg "TODO\(hw\)" packages`):

- Two-byte length field (messages over 127 bytes): literal from doc 3.2 only; the reference libraries do not cover it (pylgbst and node-poweredup emit one byte).
- Version values with non-BCD digits or bit 31 set: decode is lenient (`bcd: false`, raw Int32 kept); real hub behaviour untested.
- Advertising name longer than 14 bytes: decode tolerates it. Real hubs untested.
- Hub Attached I/O (0x04): endianness of ioType and revisions is not stated in doc 3.8 (little-endian assumed; pylgbst hub.py:164, node-poweredup lpf2hub.ts:240 and pybricksdev messages.py:516 agree). Unknown ioType values are kept raw, never an error.
- Port Input Format Setup/Format (0x41/0x47): delta interval endianness not stated in doc 3.17/3.23 (LE assumed). Non-zero notify treated as enabled, matching pylgbst/pybricksdev; TODO(hw) confirm hub only sends 0/1.
- Port Value (Single) (0x45): value endianness not stated in doc 3.21 (LE assumed). Decode keeps `raw` because the size depends on the port mode; `readPortValue` needs the Value Format from Port Mode Information (0x44), not yet modelled.
- Port Value multi-port (several ports in one 0x45, doc 3.21): out of scope. Decode treats everything after the first port id as that port's `raw`, so a multi-port frame yields mixed bytes. Needs the modes of every port to split.
- Doc section numbers: the fetched doc lists Port Value (Single) as 3.21 and Port Input Format (Single) as 3.23 (the task brief said 3.20/3.21).
- The pylgbst vectors for 0x04/0x47/0x45 come from its mocked tests (test_hub.py:36-117), not hub captures.

- Port Output Command (0x81, doc 3.26/3.27) and Feedback (0x82, doc 3.32): `time` is Int16 (0..MAX_INT16) and `degrees` Int32 (1..MAX_INT32) in the doc. Encoder follows the doc. Decoder is lenient: node-poweredup writes time with `writeUInt16LE` (tachomotor.ts:115) and degrees with `writeUInt32LE` (tachomotor.ts:149), and pylgbst uses `<H`/`<I` (peripherals.py:463, 508), so the decoder reads time as u16 (0..65535) and degrees as u32, accepting 0 for both. Bytes are identical within the doc's ranges. TODO(hw): whether the hub accepts time above 32767 or degrees 0.
- 0x81 speed rule (doc 3.27): StartSpeed (0x07/0x08) takes -100..100 and 126 (HOLD; the doc says "0 implies 126"), but not 127. StartSpeedForTime (0x09) and StartSpeedForDegrees (0x0B) take -100..100 only. FLOAT and BRAKE cannot be requested through speed commands: "the user has to use either StartPower(0 or 127)". The encoder enforces this; the decoder accepts 126 and 127 in every speed field so the simulator tolerates apps that send them (node-poweredup `mapSpeed` keeps 127, utils.ts:16).
- 0x81 StartPower (0x01) and StartPower2 (0x02, synchronized virtual port only), doc 3.27: Int8 -100..100 (negative counter-clockwise), 0 = FLOAT, 127 = BRAKE. Modelled as `startPower`/`startPower2`. The STOP command is startup immediate, completion none, `startPower` 127: `07 00 81 <port> 10 01 7F`. pybricksdev bytecodes.py:1035-1036 names START_POWER/START_POWER_2; pylgbst defines them at peripherals.py:363-364 and passes 127 through `_speed_abs` (:380-384), but its `stop()` (:414) uses a timed command with time 0, and node-poweredup `stop()` writes direct mode 0x51 power 0 (basicmotor.ts:54). The decoder rejects power outside -100..100 and 127 as bad-field.
- 0x81 `GotoAbsolutePosition` speed is 1..100 in the doc (other speeds: -100..100, 126 hold, 127 brake). pylgbst sends virtual-port commands as the single-port id + 1 (peripherals.py:388-390) instead of using the Speed1/Speed2 form of 0x07; node-poweredup (tachomotor.ts:118) and pybricksdev (bytecodes.py:1040) use 0x08 like the doc.
- 0x81 sub-commands not modelled (0x05/0x06 acc/dec time, 0x0A/0x0C/0x0E synchronized variants, 0x14 preset encoder, 0x50 WriteDirect): decoded as `{sub: "unknown", subCommand, payload}`, not as an error, so the simulator can ignore or log them. `WriteDirectModeData` (0x51) keeps mode + raw data; RGB example literal in doc 6.1.
- Doc 6.2.3 (Calibrate example) lists the passcode "Calib-Sensor" with a last byte 0x77 where "r" (0x72) is expected; looks like a doc typo. Not used by the codec.
- 0x82 flags: decoded booleans for bits 0x01..0x10; the raw byte is kept and bits above 0x10 are not an error.

Resolved by cross-checking (no longer TODO(hw)):

- Enable Updates on Battery Voltage is allowed by doc 3.5.1; also pybricksdev messages.py:173-219 (`_HUB_PROPERTY_OPS_MAP`, battery entry at 196-201) and node-poweredup lpf2hub.ts:189.
- Primary MAC address is in wire order, not reversed: doc 3.5.5 note G, pylgbst hub.py:289, node-poweredup utils.ts:32-34, pybricksdev bytecodes.py:134-135.
- Generic error layout: doc 3.9 (codes in 3.9.2), pylgbst messages.py:370-371, pybricksdev messages.py:573-604.
- Startup/completion byte: startup in the high nibble (0 buffer, 1 immediate), completion in the low nibble (0 none, 1 feedback): doc 3.26, pybricksdev bytecodes.py:1053-1061, node-poweredup portoutputcommand.ts:22-26.
- `useProfile` bits (0x01 acceleration, 0x02 deceleration): node-poweredup tachomotor.ts:154-163.
- 0x82 carries one or more (port, flags) pairs, length 3 + 2n: doc 3.32, pybricksdev messages.py:1508-1527, node-poweredup lpf2hub.ts:350-358. Flag bits: pybricksdev bytecodes.py:1063-1068, pylgbst messages.py:801-808.
- pybricksdev was cross-checked for hub properties, generic error and the header (messages.py:71).
