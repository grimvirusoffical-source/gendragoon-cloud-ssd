/** Avery: `session-uid` is a test-only element and must not render outside test builds. */
import { MemorySecretStore } from "@gendragoon/core";
import { render } from "@testing-library/react-native";
import { isTestBuild } from "../src/flags";
import { SignInSession } from "../src/screens";

function idToken(sub: string): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none" })}.${encode({ sub, auth_time: Math.floor(Date.now() / 1000) - 30 })}.sig`;
}

function ui() {
  return (
    <SignInSession secrets={new MemorySecretStore()} sessionToken={idToken("user-1")} nextToken={idToken("user-1")} googleEnabled={false} onSwapped={() => undefined} />
  );
}

describe("session-uid is test-only", () => {
  const before = process.env.NODE_ENV;
  afterEach(() => {
    (process.env as Record<string, string | undefined>).NODE_ENV = before;
  });

  it("renders under Jest (NODE_ENV=test)", async () => {
    expect(isTestBuild()).toBe(true);
    const s = await render(ui());
    expect(s.getByTestId("session-uid").props.children).toBe("user-1");
  });

  it.each(["production", "development"] as const)("is absent when NODE_ENV=%s", async (env) => {
    process.env.NODE_ENV = env;
    expect(isTestBuild()).toBe(false);
    const s = await render(ui());
    expect(s.queryByTestId("session-uid")).toBeNull();
    expect(s.queryByText("user-1")).toBeNull();
    expect(s.getByTestId("sign-in")).toBeTruthy();
  });
});
