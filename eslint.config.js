import js from "@eslint/js";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";
import tseslint from "typescript-eslint";

const bluetoothMessage =
  "Use the BleTransport interface; navigator.bluetooth is only allowed in packages/transport/src/web.";

const nodeOnlyPackages = ["packages/lwp3/**", "packages/hub/**", "packages/runtime/**"];

export default tseslint.config(
  { ignores: ["**/dist/**", "**/node_modules/**", "**/coverage/**"] },
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    files: ["**/*.{ts,tsx}"],
    languageOptions: { globals: globals.node },
  },
  {
    // Boundary: all Bluetooth goes through BleTransport; only transport/web may touch the browser API.
    files: ["**/*.{ts,tsx}"],
    rules: {
      "no-restricted-properties": [
        "error",
        {
          object: "navigator",
          property: "bluetooth",
          message:
            "Use the BleTransport interface; navigator.bluetooth is only allowed in packages/transport/src/web.",
        },
      ],
      // Also catches window.navigator / globalThis.navigator and destructuring.
      "no-restricted-syntax": [
        "error",
        ...[
          "MemberExpression[property.name='bluetooth'][object.name='navigator']",
          "MemberExpression[property.name='bluetooth'][object.property.name='navigator']",
          "VariableDeclarator[init.name='navigator'] > ObjectPattern > Property[key.name='bluetooth']",
          "VariableDeclarator[init.property.name='navigator'] > ObjectPattern > Property[key.name='bluetooth']",
        ].map((selector) => ({ selector, message: bluetoothMessage })),
      ],
    },
  },
  {
    files: ["packages/transport/src/web/**/*.{ts,tsx}"],
    rules: { "no-restricted-properties": "off", "no-restricted-syntax": "off" },
  },
  {
    files: ["apps/web/**/*.{ts,tsx}"],
    languageOptions: { globals: globals.browser },
    plugins: { "react-hooks": reactHooks },
    rules: reactHooks.configs.recommended.rules,
  },
  {
    // Boundary: these packages must run in plain Node (no DOM, no React).
    files: nodeOnlyPackages
      .map((p) => `${p}/*.ts`)
      .concat(nodeOnlyPackages.map((p) => `${p}/**/*.ts`)),
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["react", "react/*", "react-dom", "react-dom/*"],
              message: "lwp3, hub and runtime must not depend on React or browser UI.",
            },
          ],
        },
      ],
    },
  },
);
