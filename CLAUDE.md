# Project

mecahub: free (Apache-2.0) block-programming app for the Move Hub of set 17101,
using the original firmware via LEGO Wireless Protocol 3.0 (BLE). Audience: kids 7+.

# Stack

Strict TypeScript, pnpm workspaces, Vite, React, Blockly, Vitest, Playwright, Capacitor.

# Rules

- packages/lwp3, hub and runtime: no browser APIs and no React. Must run in Node.
- All Bluetooth access goes through the BleTransport interface. Never use navigator.bluetooth directly outside transport/web.
- Every new LWP3 message: test with bytes from https://lego.github.io/lego-ble-wireless-protocol-docs/
- STOP must halt all motors in < 200 ms, always. Mandatory test.
- No telemetry, no accounts, no network requests except loading the PWA.
- UI strings only via i18n (content/i18n). No hardcoded strings.
- Do not use "LEGO" or "BOOST" in code names, packages or UI except the compatibility statement.
- Strict TDD: write the failing test first, then the code.

# Commands

pnpm test | pnpm lint | pnpm typecheck | pnpm dev (web) | pnpm sim (simulator)
