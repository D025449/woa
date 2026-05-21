import js from "@eslint/js";
import globals from "globals";

const baseRules = {
  "no-undef": "error",
  "no-unreachable": "error",
  "no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
  "no-redeclare": "error",
  "no-constant-binary-expression": "error",
  "no-useless-assignment": "off"
};

export default [
  {
    ignores: [
      "node_modules/**",
      "uploads/**"
    ]
  },
  js.configs.recommended,
  {
    files: ["src/public/**/*.js"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: {
        ...globals.browser,
        ...globals.es2024,
        echarts: "readonly",
        bootstrap: "readonly",
        L: "readonly",
        maplibregl: "readonly",
        Tabulator: "readonly"
      }
    },
    rules: baseRules
  },
  {
    files: [
      "src/**/*.js",
      "!src/public/**/*.js",
      "!src/shared/**/*.js"
    ],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: {
        ...globals.node,
        ...globals.es2024
      }
    },
    rules: baseRules
  },
  {
    files: ["src/shared/**/*.js"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: {
        ...globals.browser,
        ...globals.node,
        ...globals.es2024,
        echarts: "readonly"
      }
    },
    rules: baseRules
  }
];
