"use strict";

const globals = {
  AbortController: "readonly",
  Buffer: "readonly",
  URL: "readonly",
  URLSearchParams: "readonly",
  clearInterval: "readonly",
  clearTimeout: "readonly",
  console: "readonly",
  module: "readonly",
  process: "readonly",
  require: "readonly",
  setInterval: "readonly",
  setTimeout: "readonly",
  __dirname: "readonly"
};

module.exports = [
  {
    ignores: ["coverage/**", "node_modules/**"]
  },
  {
    files: ["**/*.js"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "commonjs",
      globals
    },
    rules: {
      "array-callback-return": "error",
      "eqeqeq": ["error", "always"],
      "no-eval": "error",
      "no-new-func": "error",
      "no-unused-vars": ["error", { "argsIgnorePattern": "^_" }],
      "no-use-before-define": ["error", { "functions": false }],
      "prefer-const": "error",
      "quotes": ["error", "double", { "avoidEscape": true }],
      "semi": ["error", "always"]
    }
  }
];
