"use client";

import * as React from "react";
import useSWR, { mutate } from "swr";
import { ChevronDown } from "lucide-react";
import { api } from "@/lib/api";
import { bytesToGb, gbToBytes } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { StorageUsage } from "@/components/shared/storage-usage";
import { useBrandingStore, type LoginMode } from "@/stores/branding-store";
import type { InstanceSettings } from "@/types";

const LOGIN_MODE_LABELS: Record<LoginMode, string> = {
  magic_code: "Magic code",
  password: "Email & password",
};

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
  const [loginMode, setLoginMode] = React.useState<LoginMode>(defaultLoginMode);
  const [saving, setSaving] = React.useState(false);
  const [saved, setSaved] = React.useState(false);
  const [error, setError] = React.useState("");

  // Depend on storage_limit_bytes only — NOT the whole `data` object, whose volatile
  // storage_used_bytes changes on every SWR revalidation and would clobber an in-progress edit.
  React.useEffect(() => {
    if (data) setGb(data.storage_limit_bytes > 0 ? String(bytesToGb(data.storage_limit_bytes)) : "");
  }, [data?.storage_limit_bytes]);

  React.useEffect(() => {
    if (!brandingLoaded) fetchBranding();
  }, [brandingLoaded, fetchBranding]);

  React.useEffect(() => {
    setLoginMode(defaultLoginMode);
  }, [defaultLoginMode]);

  const handleSave = async () => {
    setSaving(true);
    setSaved(false);
    setError("");
    // Two endpoints, so each part reports its own failure; one failing doesn't
    // undo or hide the other.
    const errors: string[] = [];
    try {
      const value = gb.trim() === "" ? 0 : gbToBytes(Number(gb));
      await api.put("/instance/settings", { storage_limit_bytes: value });
      mutate("/instance/settings");
    } catch (err: unknown) {
      errors.push(`Storage limit: ${err instanceof Error ? err.message : "failed to save"}`);
    }
    if (loginMode !== defaultLoginMode) {
      try {
        await api.put("/instance/branding", { default_login_mode: loginMode });
        setDefaultLoginMode(loginMode);
      } catch (err: unknown) {
        errors.push(`Sign-in method: ${err instanceof Error ? err.message : "failed to save"}`);
      }
    }
    if (errors.length > 0) setError(errors.join(". "));
    else setSaved(true);
    setSaving(false);
  };

  return (
    <div className="space-y-8 max-w-md">
      <section className="space-y-4">
        <h2 className="text-sm font-semibold text-text-primary">Instance storage</h2>
        {data && (
          <StorageUsage used={data.storage_used_bytes} limit={data.storage_limit_bytes} variant="panel" />
        )}
        <div className="flex flex-col gap-1.5">
          <label htmlFor="storage-limit-gb" className="text-sm font-medium text-text-secondary">
            Storage limit (GB)
          </label>
          <Input
            id="storage-limit-gb"
            type="number"
            min={0}
            value={gb}
            onChange={(e) => setGb(e.target.value)}
            placeholder="0 = unlimited"
          />
          <p className="text-xs text-text-tertiary">Leave blank or 0 for unlimited.</p>
        </div>
      </section>

      <section className="space-y-4">
        <h2 className="text-sm font-semibold text-text-primary">Sign-in</h2>
        <div className="flex flex-col gap-1.5">
          <label htmlFor="default-login-mode" className="text-sm font-medium text-text-secondary">
            Default sign-in method
          </label>
          <div className="relative">
            <select
              id="default-login-mode"
              value={loginMode}
              onChange={(e) => setLoginMode(e.target.value as LoginMode)}
              disabled={!brandingLoaded}
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
          <p className="text-xs text-text-tertiary">
            What the sign-in page shows first. People can still switch to the other method.
          </p>
        </div>
      </section>

      <div className="space-y-2">
        {error && <p className="text-xs text-status-error">{error}</p>}
        {saved && <p className="text-xs text-status-success">Saved.</p>}
        {/* disabled until both load, so a click before the fetches resolve can't PUT 0 and wipe
            an existing cap, or save over the sign-in method with a stale default */}
        <Button size="sm" onClick={handleSave} loading={saving} disabled={!data || !brandingLoaded}>
          Save
        </Button>
      </div>
    </div>
  );
}
