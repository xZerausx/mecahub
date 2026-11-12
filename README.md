# mecahub

mecahub is a free, open-source block-programming app for the Move Hub of set 17101. It talks to the hub's original firmware using the LEGO Wireless Protocol 3.0 over Bluetooth Low Energy, so nothing needs to be flashed onto the hub. It is designed for kids 7 and up.

Why: the official app will be removed from the app stores on 1 January 2027. mecahub keeps these sets usable after that date.

Compatible with the LEGO® BOOST Move Hub (set 17101).

LEGO and BOOST are trademarks of the LEGO Group, which does not sponsor, authorize or endorse this project.

## Status

Early development (phase 0). Not usable yet.

## Privacy

No accounts, no analytics, no data collection. The app makes no network requests other than loading the PWA itself.

## Supported browsers

The first release is a PWA that uses Web Bluetooth:

- Supported: Chrome and Edge on Android, Windows, macOS, Linux and ChromeOS.
- Not supported: Safari and any browser on iOS (they lack Web Bluetooth). iOS will be supported once the native app exists (planned via Capacitor, along with Android).

## Running it

Prerequisites: Node 24 (see `.nvmrc`) and pnpm.

```sh
pnpm install
pnpm dev        # start the web app
pnpm test       # run unit tests
pnpm lint       # run ESLint
pnpm typecheck  # run TypeScript checks
```

## Testing with a real hub

There is a dev-only page (not part of the production build) that connects to the Move Hub and shows its name and battery.

1. Run `pnpm dev` and open <http://localhost:5173/dev/connect.html> in Chrome or Edge.
2. On Linux, enable `chrome://flags/#enable-experimental-web-platform-features` and restart Chrome. You also need BlueZ 5.41 or newer (`bluetoothctl --version`). Chromium installed as a snap reportedly cannot use Web Bluetooth: use the .deb or Flatpak build instead.
3. Press the hub's green button so it advertises, press **Connect** and pick it in the list.
4. Press **Copy log** and paste the result into an issue, or save it as `packages/lwp3/fixtures/<yyyy-mm-dd>-<what>.txt` (format in that folder's README). These become the first `capturado` vectors.

## Repository layout

```
apps/
  web/          PWA (Vite + React)
  mobile/       Native wrapper (Capacitor), planned
packages/
  lwp3/         LEGO Wireless Protocol 3.0 message encoding/decoding
  hub/          Hub and device abstractions
  transport/    BLE transport interface and implementations
  runtime/      Program execution engine
  blocks/       Block definitions (Blockly)
  simulator/    Virtual hub for development and tests
content/
  activities/   Learning activities (CC BY-SA 4.0)
  i18n/         Interface text (CC BY-SA 4.0)
docs/           Decisions and protocol notes
```

## Protocol reference

LEGO Wireless Protocol 3.0: https://lego.github.io/lego-ble-wireless-protocol-docs/

## Contributing

Contributions are welcome under the Developer Certificate of Origin (DCO); there is no CLA. Sign off every commit:

```sh
git commit -s
```

## License

- Code: Apache-2.0 (see `LICENSE` and `NOTICE`).
- Content under `content/` (activities, graphics, i18n text): CC BY-SA 4.0 (see `content/LICENSE`).
- Sounds: own work or CC0.

## En español

mecahub es una aplicación libre de programación por bloques para el Move Hub del set 17101, que usa el firmware original del hub mediante Bluetooth de bajo consumo. Existe porque la aplicación oficial dejará de estar disponible en las tiendas el 1 de enero de 2027. Está en desarrollo temprano y todavía no se puede usar. No tiene cuentas, analíticas ni recolección de datos.
