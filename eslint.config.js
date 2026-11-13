import js from "@eslint/js";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";
import tseslint from "typescript-eslint";

const bluetoothMessage =
  "Use the BleTransport interface; navigator.bluetooth is only allowed in packages/transport/src/web.";

const nodeOnlyPackages = [
  "packages/lwp3/**",
  "packages/hub/**",
  "packages/runtime/**",
  "packages/simulator/**",
];

const reactImports = {
  group: ["react", "react/*", "react-dom", "react-dom/*"],
  message: "lwp3, hub, runtime and simulator must not depend on React or browser UI.",
};

// Test support subpaths (@mecahub/*/testing import vitest or node:fs) are for tests only.
const testingImports = {
  group: ["@mecahub/*/testing"],
  message: "@mecahub/*/testing is test support: import it only from test files.",
};
const testFiles = ["**/*.test.{ts,tsx}", "**/src/testing/**", "**/src/test-support/**"];

const nodeOnlyFiles = nodeOnlyPackages
  .map((p) => `${p}/*.ts`)
  .concat(nodeOnlyPackages.map((p) => `${p}/**/*.ts`));

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
    files: nodeOnlyFiles,
    rules: { "no-restricted-imports": ["error", { patterns: [reactImports] }] },
  },
  {
    // Test support subpaths stay out of production code. A flat-config rule is replaced, not
    // merged, so the node-only packages repeat the React pattern here.
    files: ["**/*.{ts,tsx}"],
    ignores: [...testFiles, ...nodeOnlyFiles],
    rules: { "no-restricted-imports": ["error", { patterns: [testingImports] }] },
  },
  {
    files: nodeOnlyFiles,
    ignores: testFiles,
    rules: {
      "no-restricted-imports": ["error", { patterns: [reactImports, testingImports] }],
    },
  },
);
