"use client";

import * as React from "react";
import useSWR, { mutate } from "swr";
import { Check, ChevronDown } from "lucide-react";
import { api } from "@/lib/api";
import { bytesToGb, gbToBytes } from "@/lib/utils";
import { Input } from "@/components/ui/input";
import { StorageUsage } from "@/components/shared/storage-usage";
import { useBrandingStore, type LoginMode } from "@/stores/branding-store";
import type { InstanceSettings } from "@/types";

const LOGIN_MODE_LABELS: Record<LoginMode, string> = {
  magic_code: "Magic code",
  password: "Email & password",
};

/** A "Saved" flag that clears itself after 2s; a second save restarts the clock. */
function useSavedFlash(): [boolean, () => void] {
  const [saved, setSaved] = React.useState(false);
  const timer = React.useRef<ReturnType<typeof setTimeout>>();
  React.useEffect(() => () => clearTimeout(timer.current), []);
  const flash = React.useCallback(() => {
    clearTimeout(timer.current);
    setSaved(true);
    timer.current = setTimeout(() => setSaved(false), 2000);
  }, []);
  return [saved, flash];
}

function SavedMark() {
  return (
    <span className="inline-flex items-center gap-1 text-xs text-status-success">
      <Check className="h-3.5 w-3.5" />
      Saved
    </span>
  );
}

function formatGb(bytes: number): string {
  return String(bytesToGb(bytes));
}

export function InstanceSettingsTab() {
  const { data } = useSWR<InstanceSettings>(
    "/instance/settings",
    () => api.get<InstanceSettings>("/instance/settings"),
  );
  // The default sign-in method lives on the branding row, not in instance
  // settings: the signed-out login page already receives branding (server-rendered
  // and from the public endpoint), while /instance/settings needs a session.
  const {
    defaultLoginMode,
    setDefaultLoginMode,
    loaded: brandingLoaded,
    fetchBranding,
  } = useBrandingStore();

  const [gb, setGb] = React.useState<string>("");
  const [limitSaving, setLimitSaving] = React.useState(false);
  // Guards a second blur arriving while the first save is still in flight.
  const limitInFlight = React.useRef(false);
  const [limitError, setLimitError] = React.useState("");
  const [limitSaved, flashLimitSaved] = useSavedFlash();

  // The mode being saved. The select shows it while the PUT is in flight, since
  // the store only changes once the save succeeds and would otherwise snap the
  // select back to the old value.
  const [pendingMode, setPendingMode] = React.useState<LoginMode | null>(null);
  const [modeError, setModeError] = React.useState("");
  const [modeSaved, flashModeSaved] = useSavedFlash();

  // Depend on storage_limit_bytes only — NOT the whole `data` object, whose volatile
  // storage_used_bytes changes on every SWR revalidation and would clobber an in-progress edit.
  React.useEffect(() => {
    if (data) setGb(formatGb(data.storage_limit_bytes));
  }, [data?.storage_limit_bytes]);

  React.useEffect(() => {
    if (!brandingLoaded) fetchBranding();
  }, [brandingLoaded, fetchBranding]);

  const handleModeChange = async (mode: LoginMode) => {
    setPendingMode(mode);
    setModeError("");
    try {
      // Only this key: the branding PUT is a partial update.
      await api.put("/instance/branding", { default_login_mode: mode });
      setDefaultLoginMode(mode);
      flashModeSaved();
    } catch (err: unknown) {
      setModeError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setPendingMode(null);
    }
  };

  // Runs on blur only (Enter blurs), never per keystroke: each PUT applies at
  // once, so saving while typing "100" would briefly set a 1 GB cap.
  const commitLimit = async (input: HTMLInputElement) => {
    if (!data || limitInFlight.current) return;
    const saved = data.storage_limit_bytes;
    // A type=number input reports unparseable text such as "1e" as "".
    if (input.validity.badInput) {
      setLimitError("Enter a number of GB, or 0 for unlimited.");
      return;
    }
    const raw = gb.trim();
    // Blank is not "unlimited": clearing the field to retype and clicking away
    // would otherwise remove the cap. Put the saved value back instead.
    if (raw === "") {
      setGb(formatGb(saved));
      setLimitError("");
      return;
    }
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) {
      setLimitError("Enter a number of GB, or 0 for unlimited.");
      return;
    }
    const bytes = gbToBytes(n);
    if (n > 0 && bytes === 0) {
      setLimitError("That's too small to be a limit. Enter 0 for unlimited.");
      return;
    }
    setLimitError("");
    if (bytes === saved) return;

    limitInFlight.current = true;
    setLimitSaving(true);
    try {
      const updated = await api.put<InstanceSettings>("/instance/settings", {
        storage_limit_bytes: bytes,
      });
      mutate("/instance/settings", updated, { revalidate: false });
      flashLimitSaved();
    } catch (err: unknown) {
      setLimitError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      limitInFlight.current = false;
      setLimitSaving(false);
    }
  };

  return (
    <div className="space-y-8 max-w-md">
      <section className="space-y-4">
        <h2 className="text-sm font-semibold text-text-primary">Instance storage</h2>
        {data && (
          <StorageUsage used={data.storage_used_bytes} limit={data.storage_limit_bytes} variant="panel" />
        )}
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between">
            <label htmlFor="storage-limit-gb" className="text-sm font-medium text-text-secondary">
              Storage limit (GB)
            </label>
            {limitSaved && <SavedMark />}
          </div>
          {/* disabled until settings load, so a blur before the fetch resolves can't
              save over an existing cap */}
          <Input
            id="storage-limit-gb"
            type="number"
            min={0}
            value={gb}
            onChange={(e) => setGb(e.target.value)}
            onBlur={(e) => commitLimit(e.currentTarget)}
            onKeyDown={(e) => {
              if (e.key === "Enter") e.currentTarget.blur();
            }}
            disabled={!data || limitSaving}
          />
          {limitError ? (
            <p className="text-xs text-status-error">{limitError}</p>
          ) : (
            <p className="text-xs text-text-tertiary">Enter 0 for unlimited.</p>
          )}
        </div>
      </section>

      <section className="space-y-4">
        <h2 className="text-sm font-semibold text-text-primary">Sign-in</h2>
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between">
            <label htmlFor="default-login-mode" className="text-sm font-medium text-text-secondary">
              Default sign-in method
            </label>
            {modeSaved && <SavedMark />}
          </div>
          <div className="relative">
            {/* disabled while saving, so two quick changes can't land out of order */}
            <select
              id="default-login-mode"
              value={pendingMode ?? defaultLoginMode}
              onChange={(e) => handleModeChange(e.target.value as LoginMode)}
              disabled={!brandingLoaded || pendingMode !== null}
              className="w-full appearance-none cursor-pointer rounded-md border border-border bg-bg-secondary py-1.5 pl-3 pr-8 text-sm text-text-primary transition-colors hover:border-border-focus focus:outline-none focus:border-border-focus focus:ring-1 focus:ring-border-focus disabled:cursor-not-allowed disabled:opacity-50"
            >
              {(Object.keys(LOGIN_MODE_LABELS) as LoginMode[]).map((mode) => (
                <option key={mode} value={mode}>
                  {LOGIN_MODE_LABELS[mode]}
                </option>
              ))}
            </select>
            <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-text-tertiary" />
          </div>
          {modeError ? (
            <p className="text-xs text-status-error">{modeError}</p>
          ) : (
            <p className="text-xs text-text-tertiary">
              What the sign-in page shows first. People can still switch to the other method.
            </p>
          )}
        </div>
      </section>
    </div>
  );
}
