import { act, fireEvent, render } from "@testing-library/react-native";
import { DELETION_SUPPORT_ENDPOINT_ENABLED } from "../src/flags";

const mockDeleteProps: { apiBase?: string }[] = [];

jest.mock("../src/screens", () => {
  const actual = jest.requireActual("../src/screens");
  const { Text } = jest.requireActual("react-native");
  return {
    ...actual,
    DeleteAccountScreen: (props: { apiBase?: string }) => {
      mockDeleteProps.push(props);
      return <Text testID="delete-account-stub">delete</Text>;
    },
  };
});

jest.mock("react-native-safe-area-context", () => {
  const actual = jest.requireActual("react-native-safe-area-context");
  const frame = { x: 0, y: 0, width: 390, height: 844 };
  const insets = { top: 0, left: 0, right: 0, bottom: 0 };
  return {
    ...actual,
    SafeAreaProvider: ({ children }: { children: unknown }) => (
      <actual.SafeAreaProvider initialMetrics={{ frame, insets }}>{children}</actual.SafeAreaProvider>
    ),
  };
});

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { MobileRoot } = require("../App") as typeof import("../App");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { NavigationContainer } = require("@react-navigation/native") as typeof import("@react-navigation/native");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { SafeAreaProvider } = require("react-native-safe-area-context") as typeof import("react-native-safe-area-context");

const memory = new Map<string, string>();
const secrets = {
  async get(key: string) { return memory.get(key) ?? null; },
  async set(key: string, value: string) { memory.set(key, value); },
  async delete(key: string) { memory.delete(key); },
};

async function openDeleteAccount(apiBase: string | undefined) {
  mockDeleteProps.length = 0;
  const screen = await render(
    <SafeAreaProvider>
      <NavigationContainer>
        <MobileRoot secrets={secrets as never} apiBase={apiBase} initialRoute="Main" />
      </NavigationContainer>
    </SafeAreaProvider>,
  );
  await act(async () => {
    fireEvent.press(screen.getAllByText("Settings").at(-1)!);
  });
  await act(async () => {
    fireEvent.press(await screen.findByTestId("delete-account"));
  });
  await screen.findByTestId("delete-account-stub");
  return screen;
}

describe("MobileRoot wires apiBase into DeleteAccountScreen", () => {
  it("keeps the deletion support endpoint flag off", () => {
    expect(DELETION_SUPPORT_ENDPOINT_ENABLED).toBe(false);
  });

  it("passes the app's apiBase to the delete account screen", async () => {
    const screen = await openDeleteAccount("https://api.gendragoon.test");
    expect(mockDeleteProps.at(-1)?.apiBase).toBe("https://api.gendragoon.test");
    screen.unmount();
  });

  it("passes EXPO_PUBLIC_API_BASE when no prop is given, the same config the client uses", async () => {
    const before = process.env.EXPO_PUBLIC_API_BASE;
    process.env.EXPO_PUBLIC_API_BASE = "https://env.gendragoon.test";
    try {
      const screen = await openDeleteAccount(undefined);
      expect(mockDeleteProps.at(-1)?.apiBase).toBe("https://env.gendragoon.test");
      screen.unmount();
    } finally {
      if (before === undefined) delete process.env.EXPO_PUBLIC_API_BASE;
      else process.env.EXPO_PUBLIC_API_BASE = before;
    }
  });
});
