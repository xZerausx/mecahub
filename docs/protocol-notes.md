# Protocol notes

Findings from the real hub vs. the official docs.

Nothing recorded yet. Add each discrepancy with: date, message/bytes, expected (docs), observed (hub), firmware version.

## Unverified on hardware (TODO(hw))

Everything here comes from the docs or from other libraries, not from a real Move Hub. When a capture contradicts it, the capture wins (see ADR 0002).

From planning:

- Move Hub feedback status 0x0A (completed + idle) in Port Output Command Feedback (0x82).
- Port-pair payloads in 0x82 (one message reporting several ports).
- `useProfile` handling in motor commands.
- Virtual port AB id is assigned dynamically (>= 0x10). Read it from the Attached Virtual I/O event (0x02, doc 3.8); never hardcode it.
- Attached I/O message sizes on old firmware.
- Little-endian assumption for multibyte fields other than versions (the doc only states it for 3.5.6).

Found in code (`rg "TODO\(hw\)" packages`):

- Two-byte length field (messages over 127 bytes): literal from doc 3.2 only; the reference libraries do not cover it (pylgbst and node-poweredup emit one byte).
- Version values with non-BCD digits or bit 31 set: decode is lenient (`bcd: false`, raw Int32 kept); real hub behaviour untested.
- Advertising name longer than 14 bytes: decode tolerates it. Real hubs untested.
- Hub Attached I/O (0x04): endianness of ioType and revisions is not stated in doc 3.8 (little-endian assumed; pylgbst hub.py:164, node-poweredup lpf2hub.ts:240 and pybricksdev messages.py:516 agree). Unknown ioType values are kept raw, never an error.
- Port Input Format Setup/Format (0x41/0x47): delta interval endianness not stated in doc 3.17/3.23 (LE assumed). Notify byte other than 0/1 is decoded as `bad-field` (pylgbst reads any byte).
- Port Value (Single) (0x45): value endianness not stated in doc 3.21 (LE assumed). Decode keeps `raw` because the size depends on the port mode; `readPortValue` needs the Value Format from Port Mode Information (0x44), not yet modelled.
- Port Value multi-port (several ports in one 0x45, doc 3.21): out of scope. Decode treats everything after the first port id as that port's `raw`, so a multi-port frame yields mixed bytes. Needs the modes of every port to split.
- Doc section numbers: the fetched doc lists Port Value (Single) as 3.21 and Port Input Format (Single) as 3.23 (the task brief said 3.20/3.21).
- The pylgbst vectors for 0x04/0x47/0x45 come from its mocked tests (test_hub.py:36-117), not hub captures.

Resolved by cross-checking (no longer TODO(hw)):

- Enable Updates on Battery Voltage is allowed by doc 3.5.1; also pybricksdev messages.py:173-219 (`_HUB_PROPERTY_OPS_MAP`, battery entry at 196-201) and node-poweredup lpf2hub.ts:189.
- Primary MAC address is in wire order, not reversed: doc 3.5.5 note G, pylgbst hub.py:289, node-poweredup utils.ts:32-34, pybricksdev bytecodes.py:134-135.
- Generic error layout: doc 3.9 (codes in 3.9.2), pylgbst messages.py:370-371, pybricksdev messages.py:573-604.
- pybricksdev was cross-checked for hub properties, generic error and the header (messages.py:71).
