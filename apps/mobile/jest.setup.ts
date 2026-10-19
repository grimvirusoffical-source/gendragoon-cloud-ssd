jest.mock("expo-haptics", () => ({
  impactAsync: jest.fn(async () => undefined),
  ImpactFeedbackStyle: { Medium: "medium" },
}));

jest.mock("expo-updates", () => ({
  isEnabled: false,
  checkForUpdateAsync: jest.fn(async () => ({ isAvailable: false })),
  fetchUpdateAsync: jest.fn(async () => undefined),
  reloadAsync: jest.fn(async () => undefined),
}));

const mockMemory = new Map<string, string>();

jest.mock("expo-secure-store", () => ({
  getItemAsync: jest.fn(async (key: string) => mockMemory.get(key) ?? null),
  setItemAsync: jest.fn(async (key: string, value: string) => {
    mockMemory.set(key, value);
  }),
  deleteItemAsync: jest.fn(async (key: string) => {
    mockMemory.delete(key);
  }),
  AFTER_FIRST_UNLOCK: "AFTER_FIRST_UNLOCK",
}));
