/** Panel-wide state: settings, the API client, the signed-in user, the host. */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { FreeFrameApi } from "../lib/freeframe/api";
import type { Me } from "../lib/freeframe/types";
import {
  loadSettings,
  saveSettings,
  type Settings,
} from "../lib/freeframe/settings";
import { getHostInfo, watchHost, type HostInfo } from "../lib/freeframe/host";
import {
  useExportJobs,
  type ExportHistoryEntry,
  type ExportJob,
  type ExportRequest,
} from "../lib/freeframe/exports";

type AuthStatus = "loading" | "unauthenticated" | "ready";

interface AppState {
  settings: Settings;
  updateSettings: (patch: Partial<Settings>) => void;
  api: FreeFrameApi;
  user: Me | null;
  status: AuthStatus;
  authError: string;
  login: (email: string, password: string) => Promise<void>;
  /** Adopts a session handed over by the web app's /link page. */
  adoptSession: (tokens: { accessToken: string; refreshToken: string }) => Promise<void>;
  logout: () => void;
  host: HostInfo;
  refreshHost: () => Promise<void>;
  /** Renders in flight, newest first. Survives the export dialog closing. */
  exportJobs: ExportJob[];
  startExport: (request: ExportRequest) => Promise<void>;
  cancelExport: (id: string) => void;
}

const AppContext = createContext<AppState | null>(null);

export const useApp = (): AppState => {
  const state = useContext(AppContext);
  if (!state) throw new Error("useApp must be used inside <AppProvider>");
  return state;
};

export const AppProvider = ({ children }: { children: ReactNode }) => {
  const [settings, setSettings] = useState<Settings>(() => loadSettings());
  const [user, setUser] = useState<Me | null>(null);
  const [status, setStatus] = useState<AuthStatus>("loading");
  const [authError, setAuthError] = useState("");
  const [host, setHost] = useState<HostInfo>({ ok: false });

  // Settings are the source of truth; keep the ref in step so the API client's
  // token callbacks always write onto the latest values.
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  const updateSettings = useCallback((patch: Partial<Settings>) => {
    setSettings((previous) => {
      const next = { ...previous, ...patch };
      saveSettings(next);
      return next;
    });
  }, []);

  const api = useMemo(
    () =>
      new FreeFrameApi({
        baseUrl: settingsRef.current.serverUrl,
        accessToken: settingsRef.current.accessToken,
        refreshToken: settingsRef.current.refreshToken,
        onTokens: ({ accessToken, refreshToken }) =>
          updateSettings({ accessToken, refreshToken }),
        onLogout: () => {
          setUser(null);
          setStatus("unauthenticated");
        },
      }),
    [updateSettings]
  );

  // The client outlives edits to the server URL, so push those through.
  useEffect(() => {
    api.baseUrl = settings.serverUrl.replace(/\/+$/, "");
  }, [api, settings.serverUrl]);

  // Restore the session on launch.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!settingsRef.current.serverUrl || !settingsRef.current.accessToken) {
        setStatus("unauthenticated");
        return;
      }
      try {
        const me = await api.me();
        if (cancelled) return;
        setUser(me);
        setStatus("ready");
      } catch (e) {
        if (cancelled) return;
        setStatus("unauthenticated");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [api]);

  useEffect(() => watchHost(setHost), []);

  const login = useCallback(
    async (email: string, password: string) => {
      setAuthError("");
      try {
        await api.login(email, password);
        const me = await api.me();
        setUser(me);
        setStatus("ready");
      } catch (e) {
        setAuthError(e instanceof Error ? e.message : String(e));
        throw e;
      }
    },
    [api]
  );

  const adoptSession = useCallback(
    async ({ accessToken, refreshToken }: { accessToken: string; refreshToken: string }) => {
      setAuthError("");
      api.accessToken = accessToken;
      api.refreshToken = refreshToken;
      updateSettings({ accessToken, refreshToken });
      const me = await api.me();
      setUser(me);
      setStatus("ready");
    },
    [api, updateSettings]
  );

  const logout = useCallback(() => {
    api.logout();
    setUser(null);
    setStatus("unauthenticated");
  }, [api]);

  const refreshHost = useCallback(async () => setHost(await getHostInfo()), []);

  const rememberExport = useCallback(
    (entry: ExportHistoryEntry) => {
      const history = [
        entry,
        // One row per asset: a new version replaces the older entry.
        ...settingsRef.current.exportHistory.filter((old) => old.assetId !== entry.assetId),
      ].slice(0, 50);
      updateSettings({ exportHistory: history });
    },
    [updateSettings]
  );

  const { jobs, startExport, cancelExport } = useExportJobs(api, rememberExport);

  // Memoised so consumers re-render only when something in it changed.
  const value: AppState = useMemo(
    () => ({
      settings,
      updateSettings,
      api,
      user,
      status,
      authError,
      login,
      adoptSession,
      logout,
      host,
      refreshHost,
      exportJobs: jobs,
      startExport,
      cancelExport,
    }),
    [
      settings,
      updateSettings,
      api,
      user,
      status,
      authError,
      login,
      adoptSession,
      logout,
      host,
      refreshHost,
      jobs,
      startExport,
      cancelExport,
    ]
  );

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
};
