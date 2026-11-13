# @mecahub/hub

The Move Hub (set 17101) as an object model over LWP3: connection, ports, motors and STOP.
Node-only code: no browser APIs, no React. All Bluetooth goes through `BleTransport`
(`@mecahub/transport`); tests run it against `@mecahub/simulator`.

## Layers

| Piece          | Job                                                                                                                                                                             |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `HubSession`   | Owns the transport. Notification -> `splitFrames` -> `decode` -> typed `SessionEvent`. Decode errors are events, never exceptions. Correlates the request/response pairs below. |
| `PortRegistry` | What is plugged where, from Hub Attached I/O (0x04). Knows the virtual AB port id (dynamic, 0x10 in the capture) and when the connect burst is over.                            |
| `TachoMotor`   | One motor port (A, B, or an external motor on C/D): `run`, `runFor`, `rotate`, `goto`, `brake`, `float`, `onPosition`, `onSpeed`.                                               |
| `MotorPair`    | The virtual AB port: `run(speedA, speedB)`, `brake`, `float`.                                                                                                                   |
| `MoveHub`      | Facade: `connect`, `disconnect`, `motors.a/b/ab`, `portC`, `portD`, `onAttach`/`onDetach`, `stopAll`.                                                                           |

Commands that finish (`runFor`, `rotate`, `goto`) return a promise settled by the hub's Port Output
Command Feedback (0x82): `"completed"`, or `"discarded"` when another command replaced it (an
outcome, not an error). They reject on a generic error (0x05), on a timeout, or when the link is lost.
Mode layouts for `onPosition`/`onSpeed` come from the lwp3 mode table (`io-modes.ts`). A port reports
one input mode at a time: while `onPosition` has listeners, `onSpeed` rejects `mode-conflict` (and the
other way round). Disposing a motor, or replacing it on an attach, turns the hub's reporting off while
the link is up. TODO: a combined mode (Port Input Format Setup Combined, 0x42) could serve both.

A generic error (0x05) has no port, so it rejects a request only when exactly one of its type is
pending and nothing of that type was written after it; otherwise it surfaces as an
`unattributed-error` session event. A refused command (busy/full, 0x10) rejects `busy`.

## How STOP works

`moveHub.stopAll()` must halt every motor in under 200 ms (mandatory tests: `STOP:` in
`src/move-hub.test.ts`, run at 10 and 30 ms write latency).

1. One `StartPower2` 127/127 (brake) on the virtual AB port, or `StartPower` 127 on A and B when the
   hub announced no virtual port. Then `StartPower` 127 for every other attached motor.
2. Every frame is written with priority `urgent`: it jumps the write queue and cancels the queued
   normal writes, so ten pending commands do not delay it.
3. It never waits for feedback. `discardPendingOutputs()` then settles the waiters of ALL ports (not
   only the stopped ones) as `"discarded"`, immediately after the STOP frames were handed to the
   transport, so nothing hangs. A late report the hub still sends for them is swallowed (one per
   settled command whose write reached the hub, for 1 s; a completion only before the next
   command's own in-progress report) and never settles a later command.
4. It is idempotent and needs no port discovery: while the hub is still announcing ports, or when no
   A/B motor and no virtual port is known, A and B are stopped anyway.
5. It never rejects: it resolves `{ ok, errors }` after trying every frame and, when `ok` is false,
   calls the `onStopFailed` listeners. Firing it without `await` is safe.

Urgent writes are serialized, so n frames take about (n + 1) x the write latency (measured against
the simulator: 3 x L for AB + C, 90 ms at L = 30). Past the transport's urgent deadline (150 ms) a
stalled link is torn down. Whether the real hub brakes on these frames, how fast, and whether it
stops by itself on link loss are open: see `TODO(hw)` in [docs/protocol-notes.md](../../docs/protocol-notes.md).
