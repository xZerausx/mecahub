# 0001. Monorepo structure

Status: accepted

## Context

mecahub talks to the Move Hub over BLE (LWP3), runs on web (Web Bluetooth) and later mobile (Capacitor), and must be testable without hardware.

## Decision

pnpm workspaces with `packages/*` (libraries), `apps/*` (deliverables) and `content/` (activities, i18n).

Package boundaries:

- `lwp3`: pure encode/decode of protocol messages. Node-only, no DOM, no React.
- `transport`: `BleTransport` interface plus implementations (web, mock). The only place that touches Bluetooth APIs.
- `hub`: hub state and commands on top of lwp3 + transport. Node-only.
- `runtime`: executes programs. Node-only.
- `blocks`: Blockly blocks and compilation to IR.
- `simulator`: fake hub for tests and development without hardware.
- `apps/web`: React UI. `apps/mobile`: Capacitor shell (phase 4).

Enforced by tsconfig (`lib` without DOM), Vitest `node` environment and an ESLint `no-restricted-imports` rule for react.

## Programs run as IR through an interpreter

Blocks compile to a small intermediate representation executed by `runtime`, instead of generating and eval-ing JavaScript. Reasons: the original firmware cannot run user code, so the host must drive the hub; an interpreter can be stepped, paused and stopped at any instruction (STOP < 200 ms), is deterministic for tests, safe for kids' content, and needs no `eval` (CSP-friendly).

## Consequences

Boundaries are checked mechanically. The IR must be designed and versioned deliberately.
