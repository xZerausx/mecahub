# Plan del proyecto (resumen)

Plan completo: https://claude.ai/artifact/CbuBwz8qYrFGXEnoWjtMxu (11/11/2026)

## Decisiones clave
- Nombre: **mecahub** (repo en cuenta personal de GitHub). Descartados por marcas: maxhub/maxihub (MAXHUB de CVTE, Clase 9), entre otros. Org "MecaHub" en GitHub ya está tomada.
- Hub con firmware ORIGINAL de LEGO, vía LEGO Wireless Protocol 3.0 (BLE, servicio 00001623-1212-efde-1623-785feabcd123, característica 1624). La app ejecuta el programa y manda comandos en vivo.
- Stack: TypeScript estricto, pnpm monorepo, Vite + React, Blockly, Vitest, Playwright. PWA primero (Web Bluetooth: Chrome/Edge), Capacitor + @capacitor-community/bluetooth-le después (Android/iOS).
- Paquetes: lwp3, transport (BleTransport: web, capacitor, simulador), hub, runtime (intérprete de IR JSON con STOP < 200 ms), blocks, simulator.
- Dos niveles de bloques: Íconos (7-9 años) y Avanzado.
- Licencias: código Apache-2.0, contenido CC BY-SA 4.0. Sin "LEGO"/"BOOST" en el nombre; sin material de la app oficial; sin datos ni cuentas.

## Hoja de ruta
Fechas orientativas: se avanza fase por fase según el tiempo disponible, sin calendario fijo.
- Fase 0 Base: 12-18 nov 2026
- Fase 1 Hablar con el hub: 14-25 nov
- Fase 2 Bloques que se ejecutan: 26 nov - 9 dic
- Fase 3 Beta pública (PWA en GitHub Pages): 10-29 dic
- Retiro app oficial: 1 ene 2027
- Fase 4 Tiendas (F-Droid, Google Play, App Store): 4 ene - 26 feb 2027
- Fase 5 Crecer: actividades propias, exportar a Python de Pybricks, otros hubs
