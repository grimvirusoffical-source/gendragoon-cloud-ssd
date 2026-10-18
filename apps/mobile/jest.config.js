/* global process */
// Pin the zone so local-time formatting (Payment due date) is tested as a New York user sees it.
process.env.TZ = "America/New_York";

module.exports = {
  preset: "jest-expo",
  setupFiles: ["<rootDir>/jest.setup.ts"],
  testMatch: ["<rootDir>/test/**/*.test.ts", "<rootDir>/test/**/*.test.tsx"],
  moduleNameMapper: {
    "^@gendragoon/ui/theme$": "<rootDir>/../../packages/ui/src/theme.ts",
    "^(\\.{1,2}/.*)\\.js$": "$1",
  },
  transformIgnorePatterns: [
    "/node_modules/(?!(.pnpm|react-native|@react-native|@react-native-community|expo|@expo|@expo-google-fonts|react-navigation|@react-navigation|@sentry/react-native|native-base|standard-navigation|@gendragoon|@noble|libsodium-wrappers-sumo))",
    "/node_modules/react-native-reanimated/plugin/",
    "/node_modules/@react-native/babel-preset/",
  ],
};
