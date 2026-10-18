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
);
