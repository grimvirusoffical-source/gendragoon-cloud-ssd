import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/release/**",
      "**/coverage/**",
      "**/*.d.ts",
      "apps/desktop/electron-builder.cjs",
      "apps/desktop/scripts/**",
      "apps/mobile/scripts/**",
      "packages/core/test/fixtures/**",
      "apps/mobile/android/**",
      "apps/mobile/ios/**",
      "apps/mobile/.expo/**",
      "apps/mobile/dist/**",
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { "argsIgnorePattern": "^_", "varsIgnorePattern": "^_" },
      ],
    },
  },
  {
    files: [
      "apps/mobile/babel.config.js",
      "apps/mobile/jest.config.js",
      "apps/mobile/metro.config.js",
    ],
    languageOptions: {
      sourceType: "commonjs",
      globals: {
        module: "readonly",
        require: "readonly",
        __dirname: "readonly",
        exports: "readonly",
      },
    },
    rules: {
      "@typescript-eslint/no-require-imports": "off",
    },
  },
  {
    // SDK contract tooling: plain Node CommonJS scripts.
    files: ["sdk/**/*.cjs"],
    languageOptions: {
      sourceType: "commonjs",
      globals: {
        module: "readonly",
        require: "readonly",
        exports: "readonly",
        __dirname: "readonly",
        __filename: "readonly",
        process: "readonly",
        console: "readonly",
        Buffer: "readonly",
        fetch: "readonly",
        structuredClone: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        setInterval: "readonly",
        clearInterval: "readonly",
        URL: "readonly",
      },
    },
    rules: {
      "@typescript-eslint/no-require-imports": "off",
    },
  },
);
