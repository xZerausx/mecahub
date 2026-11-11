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

- Hub property operation/property combinations: the doc table lists which operations each property supports, but node-poweredup enables updates on Battery Voltage. The encoder does not enforce the table.
- Primary MAC address byte order: the doc (3.5.5 note G) says big-endian; no other source confirmed it.
- Two-byte length field (messages over 127 bytes): checked against the doc only; pylgbst and node-poweredup emit one byte.
- Advertising name longer than 14 bytes or version fields with non-BCD digits: decode tolerates the first, rejects the second. Real hubs untested.
- pybricksdev was not cross-checked for any vector in the first LWP3 PR.
