# Captured fixtures

Logs captured from a real hub with the dev connect page (see "Testing with a real hub" in the
root README). Every vector here has origin `capturado`: if it contradicts a derived vector, the
derived one is fixed.

Name files `<yyyy-mm-dd>-<what>.txt`, for example `2026-11-12-connect-battery.txt`.

## Format

Paste the output of **Copy log** as is:

```
# mecahub hub probe log
# origin: capturado (real hub, Web Bluetooth)
# date: 2026-11-12T10:00:00.000Z
# hub name: Move Hub
+0ms tx 05 00 01 06 02
# enableUpdates batteryPercent
+120ms rx 06 00 01 06 06 55
```

- `# ...` lines are comments (header and notes about the line above).
- `+<n>ms <dir> <hex>`: milliseconds since connecting, `tx` (sent to the hub) or `rx` (received),
  then the frame bytes in hex.

Load a file in tests with `loadCapture` from `packages/lwp3/src/test-support/fixtures.ts` (test-only; returns `{ at, dir, bytes }[]`). See `src/capture-2026-11-13.test.ts` for an example.
