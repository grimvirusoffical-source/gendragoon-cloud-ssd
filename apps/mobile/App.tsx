import {
  GenDragoonClient,
  accountFromAssessment,
  applyApiFailure,
  treeNode,
  type LockAssessment,
  type SecretStore,
  type SortOverrides,
  type TreeNode,
  type WorkspaceRecord,
} from "@gendragoon/core";
import { colors } from "@gendragoon/ui/theme";
import { NavigationContainer, createNavigationContainerRef } from "@react-navigation/native";
import { createBottomTabNavigator } from "@react-navigation/bottom-tabs";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import { useEffect, useMemo, useState } from "react";
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
import { byoServerFlowReady } from "./src/byoReady";
import { ENCRYPTED_WORKSPACE_ENABLED } from "./src/flags";
import { createExpoSecureStore } from "./src/platform/secureStore";

type RootStack = {
  SignIn: undefined;
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

export function MobileRoot(props: {
  secrets?: SecretStore;
  apiBase?: string;
  initialRoute?: keyof RootStack;
}) {
  const secrets = useMemo(() => props.secrets ?? createExpoSecureStore(), [props.secrets]);
  const apiBase = props.apiBase ?? process.env.EXPO_PUBLIC_API_BASE ?? "";
  const [idToken, setIdToken] = useState(freshPreviewToken);
  const [access, setAccess] = useState<LockAssessment>(lockedAccess);
  const [workspaces, setWorkspaces] = useState(previewWorkspaces);
  const [selected, setSelected] = useState<TreeNode | null>(null);
  const [overrides, setOverrides] = useState<SortOverrides>({});
  const [activeTransfers, setActiveTransfers] = useState(0);
  const [settingsPage, setSettingsPage] = useState<"home" | "sort" | "connect" | "delete">("home");
  const [tab, setTab] = useState<"Files" | "Backup" | "Workspaces" | "Settings">("Files");
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
  const account = accountFromAssessment(access);

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

  function Files() {
    return (
      <FileTree
        mode="upload"
        nodes={nodes}
        locked={account.phase === "delete_or_merge"}
        selected={selected}
        onSelect={setSelected}
        onRefresh={() => undefined}
        onUpload={() => setActiveTransfers((count) => count + 1)}
      />
    );
  }
  function Backup() {
    return (
      <FileTree
        mode="backup"
        nodes={nodes}
        locked={account.phase === "delete_or_merge"}
        selected={selected}
        onSelect={setSelected}
        onRefresh={() => undefined}
        onBackup={() => setActiveTransfers((count) => count + 1)}
      />
    );
  }
  function Spaces() {
    return (
      <WorkspacesScreen
        workspaces={workspaces}
        unpaidIds={access.unpaidIds}
        monthlyCents={500}
        onDelete={(id) => {
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
          onReauth={() => {
            setIdToken((token) => sessionTokenAfterAuthFailure("reauth", token));
            if (navigationRef.isReady()) navigationRef.navigate("SignIn");
          }}
          onSignedOut={() => {
            setIdToken((token) => sessionTokenAfterAuthFailure("sign-out", token));
            if (navigationRef.isReady()) navigationRef.navigate("SignIn");
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
        <Tabs.Screen name="Settings" component={Settings} />
      </Tabs.Navigator>
    );
  }

  return (
    <Stack.Navigator
      initialRouteName={props.initialRoute ?? (account.phase === "delete_or_merge" ? "Lock" : "SignIn")}
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
            onSwapped={(token) => {
              setIdToken(token);
              if (accountFromAssessment(access).phase === "delete_or_merge") {
                navigationRef.navigate("Lock");
              } else {
                navigationRef.navigate("Main");
              }
            }}
          />
        )}
      </Stack.Screen>
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
          />
        )}
      </Stack.Screen>
      <Stack.Screen name="Main" options={{ headerShown: false }} component={Main} />
    </Stack.Navigator>
  );
}

export function App() {
  return (
    <SafeAreaProvider>
      <StatusBar style="light" />
      <NavigationContainer ref={navigationRef}>
        <MobileRoot />
      </NavigationContainer>
    </SafeAreaProvider>
  );
}

export function noteLock(error: unknown, access: LockAssessment): LockAssessment {
  const next = applyApiFailure(accountFromAssessment(access), error);
  if (next.phase !== "delete_or_merge") return access;
  return { ...access, locked: true, uploadsBlocked: true, normalUseBlocked: true };
}
