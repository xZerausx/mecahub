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

## Simulator

A dev-only page with a simulated Move Hub (battery, button, tilt, color and distance sensors, motors with live readouts, link faults) and an app connected to it, so you can try the app and the STOP path without hardware. It also shows how long STOP takes to halt the motors.

Run `pnpm sim` (starts the web dev server and opens <http://localhost:5173/dev/simulator.html>). Like the connect page, it is not part of the production build.

## Lab page

A dev-only page for hardware sessions (not part of the production build): connect a real hub (or the simulator), drive its motors, LED and readings, run the measurement tools, and export everything the hub said.

Run `pnpm lab` (or `pnpm dev` and open <http://localhost:5173/dev/lab.html> in Chrome or Edge). Without Web Bluetooth the page falls back to the simulator; simulator results are labelled `simulado` in the export and must never be saved as fixtures. The big **STOP** button (and the Escape key) is always there: it shows how long every STOP write took.

### Hardware-session checklist

The lab sends STOP by itself after every connect or reconnect. Steps 1 and 2 first, then any order. Lift the robot (wheels free) before anything that spins a motor.

| Step                    | What to do on the page                                                                           | Answers (`TODO(hw)` in [docs/protocol-notes.md](docs/protocol-notes.md))                                          |
| ----------------------- | ------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| 1. Connect time         | Press Connect, pick the hub, read **Timings**. Repeat 2 or 3 times.                              | Connect time (chooser, Bluetooth, ports announced)                                                                |
| 2. Write latency        | **Measure write latency** (20 battery requests, one by one).                                     | Write latency L: min / median / p95 / max of the write and of request-to-reply; sizes the STOP budget (n + 1) x L |
| 3. Motor speed          | Tick the safety box, **Measure motor speed** on A (and B, C, D).                                 | `maxDegPerSec` of the simulator: degrees per second at 100 % and 50 % (no load vs. wheels on the floor differ)    |
| 4. Double write         | **Test the double write**.                                                                       | Whether one GATT write may hold two messages (a single-write STOP would remove the (n + 1) factor)                |
| 5. Feedback             | **Capture feedback**.                                                                            | Whether the hub sends status 0x0A (completed + idle) in 0x82, and which flags in what order                       |
| 6. Link loss            | Tick the safety box, **Spin motor A and cut the connection**, watch, answer, let it reconnect.   | Whether the hub stops its motors by itself when the link drops (the lab always sends STOP after reconnecting)     |
| 7. Tilt                 | Tilt the hub forward, back, left, right and read **Readings**. Note the signs of x and y.        | Tilt sign (the refs disagree on x)                                                                                |
| 8. Colors               | Show colored bricks to the sensor and read **Color** (and the Diagnostics list for unknown ids). | Color ids of the table, what the sensor reports at rest                                                           |
| 9. LED and button       | Pick LED colors; press the hub button; read the capture for the 0x41 setup and its reply.        | Whether the LED port setup (0x41) is needed (the lab sends it like the refs do)                                   |
| 10. enableUpdates reply | In the capture, look at what follows the battery Enable Updates (`05 00 01 06 02`) right away.   | Whether Enable Updates is answered with an immediate Update                                                       |

Then press **Copy capture text** (frames plus a `# result:` line per measurement) and paste it into `packages/lwp3/fixtures/<yyyy-mm-dd>-<what>.txt` (format in that folder's README), and **Download JSON results** for the numbers. Diagnostics lists the errors the hub sent that no request owns (`unattributed-error`) and the values the app could not read (`unknown-value`): include them in the report.

How each tool measures, and its limits:

- **Write latency**: waits for a quiet period first, pauses the lab's battery subscription while it runs, and drains after a lost reply so a late reply cannot be matched to the next sample. The clock is `performance.now` on the page; the write time includes the transport's write queue, the reply time also the hub's processing and the notification path. It does not tell write-with-response from without (the transport picks).
- **Motor speed** (asks for the same "robot lifted, wheels free" confirmation as the link-loss test): runs the motor for 1 s and uses the position reports. `degPerSec` is the speed between the first reported change and the last report taken while the command ran (ramp-up and brake tail left out), so read it as a lower bound; the "maximum" assumes speed is linear in the percentage.
- **Double write**: first sends each message alone (`control`), then both in one write, and waits 1 s for the replies; a very late reply looks like "none".
- **Link loss**: the link is cut with a clean GATT disconnect, which is not the same as a hub that went out of range. You answer by looking at the motor; on the simulator the answer is derived from its state.
- **Feedback**: keeps the flags byte of each 0x82 for the port (the full frames are in the capture).

Behaviours marked `supuesto` in the code (sensor value layouts, motor timing, what the hub does when the link dies) are our own assumptions and have not been verified on real hardware: see [docs/protocol-notes.md](docs/protocol-notes.md).

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
