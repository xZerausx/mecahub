import js from "@eslint/js";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";
import tseslint from "typescript-eslint";

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
