import {
  GenDragoonClient,
  treeNode,
  type LockAssessment,
  type SecretStore,
  type SortOverrides,
  type TreeNode,
  type WorkspaceRecord,
} from "@gendragoon/core";
import { ThemeProvider, useTheme } from "./src/themeContext";
import { NavigationContainer, createNavigationContainerRef } from "@react-navigation/native";
import { createBottomTabNavigator } from "@react-navigation/bottom-tabs";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import { useEffect, useMemo, useRef, useState } from "react";
import { AccountsClient, type AccountRules } from "@gendragoon/core";
import { SignupScreen } from "./src/account/SignupScreen";
import { Linking } from "react-native";
import { StatusBar } from "expo-status-bar";
import { SafeAreaProvider } from "react-native-safe-area-context";
import {
  ConnectStorageScreen,
  DeleteAccountScreen,
  FileTree,
  LockScreen,
  PassphraseScreen,
  SettingsHome,
  SignInSession,
  SortScreen,
  WorkspacesScreen,
} from "./src/screens";
import { sessionTokenAfterAuthFailure } from "./src/account/session";
import { payToRestore } from "./src/billing";
import { byoServerFlowReady } from "./src/byoReady";
import { ENCRYPTED_WORKSPACE_ENABLED } from "./src/flags";
import { accountLockCoversApp, locksThisWorkspaceOnly, noteWorkspaceLock } from "./src/workspaceState";
import { createExpoSecureStore } from "./src/platform/secureStore";
import { ShotFrame, webShot } from "./src/shots";
import { TeamsTab } from "./src/teams";

type RootStack = {
  SignIn: undefined;
  Signup: undefined;
  Passphrase: undefined;
  Lock: undefined;
  Main: undefined;
};

const Stack = createNativeStackNavigator<RootStack>();
const Tabs = createBottomTabNavigator();
export const navigationRef = createNavigationContainerRef<RootStack>();

const PREVIEW_FILES = [
  "Pictures/vacation.jpg",
  "Videos/launch.mp4",
  "Documents/notes.pdf",
  "Apps/Grok Bot.app",
  "Apps/Gyazo.app",
  "Apps/sample.apk",
];

function previewWorkspaces(): WorkspaceRecord[] {
  return Array.from({ length: 11 }, (_, index) => ({
    id: index === 10 ? "overflow" : `ws-${index + 1}`,
    name: index === 10 ? "Overflow" : `Workspace ${index + 1}`,
    kind: "paid" as const,
    projectStatus: "active" as const,
    projectFeeStatus: "paid" as const,
  }));
}

function lockedAccess(): LockAssessment {
  return {
    locked: true,
    cap: 10,
    activeCount: 11,
    overCap: true,
    unpaidIds: ["overflow"],
    lapsedIds: [],
    readable: true,
    downloadsAllowed: true,
    uploadsBlocked: true,
    normalUseBlocked: true,
    highTier: false,
  };
}

function freshPreviewToken(): string {
  const authTime = Math.floor(Date.now() / 1000) - 30;
  const part = (value: unknown) => {
    const bytes = new TextEncoder().encode(JSON.stringify(value));
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/g, "");
  };
  return `${part({ alg: "none", typ: "JWT" })}.${part({ auth_time: authTime, sub: "preview-user" })}.sig`;
}

/**
 * Sign-up goes to Red-XAI Accounts (`/v1`, app `gendragoon`) when this build has
 * an issuer, otherwise to the Gendragoon backend's transitional `/v1/accounts`.
 */
function accountsFor(issuer: string, apiBase: string) {
  const base = issuer || apiBase;
  if (!base) return null;
  const make = (session: string | null) =>
    new AccountsClient(issuer ? { baseUrl: issuer, pathPrefix: "/v1", app: "gendragoon", getToken: async () => session } : { baseUrl: apiBase, getToken: async () => session });
  return { client: make(null), withSession: make };
}

export function MobileRoot(props: {
  secrets?: SecretStore;
  apiBase?: string;
  initialRoute?: keyof RootStack;
}) {
  const { colors } = useTheme();
  const secrets = useMemo(() => props.secrets ?? createExpoSecureStore(), [props.secrets]);
  const apiBase = props.apiBase ?? process.env.EXPO_PUBLIC_API_BASE ?? "";
  const [idToken, setIdToken] = useState(freshPreviewToken);
  const accounts = useMemo(() => accountsFor(process.env.EXPO_PUBLIC_REDXAI_ISSUER ?? "", apiBase), [apiBase]);
  const accountSession = useRef<string | null>(null);
  const [accountRules, setAccountRules] = useState<AccountRules | null>(null);
  useEffect(() => {
    void accounts?.client.rules().then(setAccountRules).catch(() => undefined);
  }, [accounts]);
  const [access, setAccess] = useState<LockAssessment>(lockedAccess);
  const [workspaces, setWorkspaces] = useState(previewWorkspaces);
  const [selected, setSelected] = useState<TreeNode | null>(null);
  const [overrides, setOverrides] = useState<SortOverrides>({});
  const [activeTransfers, setActiveTransfers] = useState(0);
  const [settingsPage, setSettingsPage] = useState<"home" | "sort" | "connect" | "delete">("home");
  const [tab, setTab] = useState<"Files" | "Backup" | "Workspaces" | "Teams" | "Settings">("Files");
  const [openWorkspaceId, setOpenWorkspaceId] = useState(workspaces[0]?.id ?? "");
  const nodes = PREVIEW_FILES.map((path) => treeNode({
    path,
    directory: path.endsWith(".app"),
  }));
  const client = useMemo(() => {
    if (!apiBase) {
      return {
        async deleteAccount() {
          return { jobId: "preview" };
        },
        async deletionStatus() {
          return { jobId: "preview", status: "done" as const };
        },
      };
    }
    return new GenDragoonClient({ baseUrl: apiBase, getToken: () => idToken });
  }, [apiBase, idToken]);
  useEffect(() => {
    if (__DEV__) return;
    void import("expo-updates").then(async (Updates) => {
      if (!Updates.isEnabled) return;
      const check = await Updates.checkForUpdateAsync();
      if (!check.isAvailable) return;
      await Updates.fetchUpdateAsync();
      await Updates.reloadAsync();
    }).catch(() => undefined);
  }, []);

  function payWorkspace(id: string) {
    void payToRestore({
      unpaidWorkspaceIds: [id],
      checkoutWorkspace: "checkoutProject" in client ? (workspaceId) => client.checkoutProject(workspaceId) : undefined,
      openUrl: (url) => Linking.openURL(url),
    }).catch(() => undefined);
  }
  function WorkspaceFiles(props: { mode: "upload" | "backup" }) {
    if (openWorkspaceId && locksThisWorkspaceOnly(access, openWorkspaceId)) {
      const open = workspaces.find((workspace) => workspace.id === openWorkspaceId);
      return (
        <LockScreen
          workspaceOnly
          workspaces={open ? [open] : []}
          lock={{ reason: "lapsed", overBy: 0, unpaidWorkspaceIds: [openWorkspaceId] }}
          onReview={() => setTab("Workspaces")}
          onPay={() => payWorkspace(openWorkspaceId)}
        />
      );
    }
    return (
      <FileTree
        mode={props.mode}
        nodes={nodes}
        locked={accountLockCoversApp(access)}
        selected={selected}
        onSelect={setSelected}
        onRefresh={() => undefined}
        onUpload={props.mode === "upload" ? () => setActiveTransfers((count) => count + 1) : undefined}
        onBackup={props.mode === "backup" ? () => setActiveTransfers((count) => count + 1) : undefined}
      />
    );
  }
  function Files() {
    return <WorkspaceFiles mode="upload" />;
  }
  function Backup() {
    return <WorkspaceFiles mode="backup" />;
  }
  function Spaces() {
    return (
      <WorkspacesScreen
        workspaces={workspaces}
        unpaidIds={access.unpaidIds}
        onOpen={(id) => {
          setOpenWorkspaceId(id);
          setTab("Files");
        }}
        onPay={payWorkspace}
        onDelete={async (id) => {
          if ("deleteWorkspace" in client && typeof client.deleteWorkspace === "function") {
            await client.deleteWorkspace(id);
          }
          const next = workspaces.filter((workspace) => workspace.id !== id);
          setWorkspaces(next);
          if (next.length <= access.cap) {
            setAccess({ ...access, locked: false, activeCount: next.length, overCap: false, unpaidIds: [], uploadsBlocked: false, normalUseBlocked: false });
          }
        }}
        onMerge={() => undefined}
      />
    );
  }
  function Teams() {
    return (
      <TeamsTab
        client={client instanceof GenDragoonClient ? client : null}
        personalWorkspaces={workspaces.map((w) => ({ id: w.id, name: w.name || w.id }))}
        openUrl={(url) => void Linking.openURL(url)}
      />
    );
  }
  function Settings() {
    if (settingsPage === "sort") return <SortScreen overrides={overrides} onChange={setOverrides} />;
    if (settingsPage === "connect") return <ConnectStorageScreen />;
    if (settingsPage === "delete") {
      return (
        <DeleteAccountScreen
          activeTransfers={activeTransfers}
          secrets={secrets}
          workspaceIds={workspaces.map((workspace) => workspace.id)}
          idToken={idToken}
          client={client}
          apiBase={apiBase}
          onReauth={() => {
            setIdToken((token) => sessionTokenAfterAuthFailure("reauth", token));
            if (navigationRef.isReady()) navigationRef.navigate("SignIn");
          }}
          onSignedOut={() => {
            setIdToken((token) => sessionTokenAfterAuthFailure("sign-out", token));
            if (navigationRef.isReady()) navigationRef.navigate("SignIn");
          }}
          onClearSession={() => {
            setIdToken((token) => sessionTokenAfterAuthFailure("sign-out", token));
          }}
          onDone={() => {
            if (navigationRef.isReady()) navigationRef.navigate("SignIn");
          }}
          onError={() => undefined}
        />
      );
    }
    return (
      <SettingsHome
        deleteDisabled={activeTransfers > 0}
        connectEnabled={byoServerFlowReady()}
        onSort={() => setSettingsPage("sort")}
        onConnect={() => setSettingsPage("connect")}
        onDelete={() => setSettingsPage("delete")}
        onSignOut={() => {
          if (navigationRef.isReady()) navigationRef.navigate("SignIn");
        }}
      />
    );
  }

  function Main() {
    return (
      <Tabs.Navigator
        key={tab}
        initialRouteName={tab}
        screenOptions={{
          headerStyle: { backgroundColor: colors.sidebar },
          headerTintColor: colors.text,
          tabBarStyle: { backgroundColor: colors.sidebar, minHeight: 56 },
          tabBarActiveTintColor: colors.purpleHot,
          tabBarInactiveTintColor: colors.muted,
        }}
      >
        <Tabs.Screen name="Files" component={Files} />
        <Tabs.Screen name="Backup" component={Backup} />
        <Tabs.Screen name="Workspaces" component={Spaces} />
        <Tabs.Screen name="Teams" component={Teams} />
        <Tabs.Screen name="Settings" component={Settings} />
      </Tabs.Navigator>
    );
  }

  return (
    <Stack.Navigator
      initialRouteName={props.initialRoute ?? (accountLockCoversApp(access) ? "Lock" : "SignIn")}
      screenOptions={{
        headerStyle: { backgroundColor: colors.bg },
        headerTintColor: colors.text,
        contentStyle: { backgroundColor: colors.bg },
      }}
    >
      <Stack.Screen name="SignIn" options={{ headerShown: false }}>
        {() => (
          <SignInSession
            secrets={secrets}
            sessionToken={idToken}
            nextToken={freshPreviewToken()}
            googleEnabled={Boolean(process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID)}
            onCreateAccount={accounts ? () => navigationRef.navigate("Signup") : undefined}
            onSwapped={(token) => {
              setIdToken(token);
              if (accountLockCoversApp(access)) {
                navigationRef.navigate("Lock");
              } else {
                navigationRef.navigate("Main");
              }
            }}
          />
        )}
      </Stack.Screen>
      {accounts ? (
        <Stack.Screen name="Signup" options={{ title: "Create account" }}>
          {() => (
            <SignupScreen
              api={accounts.client}
              rules={accountRules}
              onSubmit={async (fields) => {
                const created = await accounts.client.signup(fields);
                accountSession.current = created.session ?? null;
                return created;
              }}
              onConfirmTwoFactor={async (code) => { await accounts.withSession(accountSession.current).confirmTwoFactor(code); }}
              onResendPhoneCode={(phone) => accounts.withSession(accountSession.current).setupTwoFactor({ method: "phone", phone })}
              onDone={() => navigationRef.navigate("SignIn")}
            />
          )}
        </Stack.Screen>
      ) : null}
      {ENCRYPTED_WORKSPACE_ENABLED ? (
        <Stack.Screen name="Passphrase" options={{ title: "Passphrase" }}>
          {() => <PassphraseScreen onSubmit={() => navigationRef.navigate("Main")} />}
        </Stack.Screen>
      ) : null}
      <Stack.Screen name="Lock" options={{ headerShown: false, gestureEnabled: false }}>
        {() => (
          <LockScreen
            access={access}
            workspaces={workspaces}
            onReview={() => {
              setTab("Workspaces");
              navigationRef.navigate("Main");
            }}
            onPay={() => {
              void payToRestore({
                unpaidWorkspaceIds: access.unpaidIds,
                checkoutWorkspace: "checkoutProject" in client ? (id) => client.checkoutProject(id) : undefined,
                openUrl: (url) => Linking.openURL(url),
              }).catch(() => undefined);
            }}
          />
        )}
      </Stack.Screen>
      <Stack.Screen name="Main" options={{ headerShown: false }} component={Main} />
    </Stack.Navigator>
  );
}

function ThemeStatusBar() {
  const { scheme } = useTheme();
  return <StatusBar style={scheme === "dark" ? "light" : "dark"} />;
}

export function App() {
  const shot = webShot();
  return (
    <ThemeProvider>
    <SafeAreaProvider>
      <ThemeStatusBar />
      {shot ? <ShotFrame id={shot} /> : (
        <NavigationContainer ref={navigationRef}>
          <MobileRoot />
        </NavigationContainer>
      )}
    </SafeAreaProvider>
    </ThemeProvider>
  );
}

export function noteLock(error: unknown, access: LockAssessment): LockAssessment {
  return noteWorkspaceLock(error, access);
}
