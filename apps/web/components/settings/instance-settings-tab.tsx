"use client";

import * as React from "react";
import useSWR, { mutate } from "swr";
import { api } from "@/lib/api";
import { bytesToGb, gbToBytes } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { StorageUsage } from "@/components/shared/storage-usage";
import type { InstanceSettings } from "@/types";

export function InstanceSettingsTab() {
  const { data } = useSWR<InstanceSettings>(
    "/instance/settings",
    () => api.get<InstanceSettings>("/instance/settings"),
  );

  const [gb, setGb] = React.useState<string>("");
  const [saving, setSaving] = React.useState(false);
  const [saved, setSaved] = React.useState(false);
  const [error, setError] = React.useState("");

  // Depend on storage_limit_bytes only — NOT the whole `data` object, whose volatile
  // storage_used_bytes changes on every SWR revalidation and would clobber an in-progress edit.
  React.useEffect(() => {
    if (data) setGb(data.storage_limit_bytes > 0 ? String(bytesToGb(data.storage_limit_bytes)) : "");
  }, [data?.storage_limit_bytes]);

  const handleSave = async () => {
    setSaving(true);
    setSaved(false);
    setError("");
    try {
      const value = gb.trim() === "" ? 0 : gbToBytes(Number(gb));
      await api.put("/instance/settings", { storage_limit_bytes: value });
      mutate("/instance/settings");
      setSaved(true);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="space-y-4 max-w-md">
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
      {error && <p className="text-xs text-status-error">{error}</p>}
      {saved && <p className="text-xs text-status-success">Saved.</p>}
      {/* disabled until settings load, so a click before the fetch resolves can't PUT 0 and wipe an existing cap */}
      <Button size="sm" onClick={handleSave} loading={saving} disabled={!data}>Save</Button>
    </section>
  );
}
