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

type PartSizeMode = "auto" | "fixed";

const PART_SIZE_MODE_LABELS: Record<PartSizeMode, string> = {
  auto: "Automatic",
  fixed: "Fixed",
};

type OriginalDownloads = "transcode" | "original";

const ORIGINAL_DOWNLOADS_LABELS: Record<OriginalDownloads, string> = {
  transcode: "Transcode only",
  original: "Original or transcode",
};

/**
 * How hard review streams are compressed: the names and the order the slider
 * shows them in. The CRF offset each step means lives in COMPRESSION_LEVELS in
 * packages/transcoder/base.py and is never copied here; the server resolves the
 * offset it will use into a step and sends it as `compression_level_effective`,
 * so there is one scale. Level 3 is what the transcoder always did, so the
 * default position changes nothing.
 */
const COMPRESSION_LEVELS = [1, 2, 3, 4, 5] as const;
const COMPRESSION_LABELS: Record<number, string> = {
  1: "Highest quality",
  2: "Higher quality",
  3: "Balanced",
  4: "Smaller files",
  5: "Smallest files",
};
const DEFAULT_COMPRESSION_LEVEL = 3;
// How long after the last step of a drag the save goes out. Long enough that
// one sweep across the track is one PUT, short enough to feel immediate when
// the thumb is released. A release (pointerup, keyup, blur) flushes it, so this
// only ever runs for a gesture that is still going.
const COMPRESSION_SAVE_DELAY_MS = 250;

const MB = 1024 * 1024;
// The bounds the API enforces: 5 MB is the smallest part S3, R2 and B2 accept.
const MIN_PART_MB = 5;
const MAX_PART_MB = 512;
// What choosing Fixed starts from: the size every upload used before Automatic.
const DEFAULT_FIXED_PART_BYTES = 10 * MB;

/** A "Saved" flag that clears itself after 2s; a second save restarts the clock. */
function useSavedFlash(): [boolean, () => void] {
  const [saved, setSaved] = React.useState(false);
  const timer = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
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

  // Part size: 0 is Automatic, anything else the fixed size. Admin-only on the
  // API, and this tab is only shown to admins.
  const partSizeBytes = data?.upload_part_size_bytes ?? 0;
  const [pendingPartMode, setPendingPartMode] = React.useState<PartSizeMode | null>(null);
  const partMode: PartSizeMode = pendingPartMode ?? (partSizeBytes ? "fixed" : "auto");
  const [partError, setPartError] = React.useState("");
  const [partSaved, flashPartSaved] = useSavedFlash();
  const [partMb, setPartMb] = React.useState<string>("");
  const [partSaving, setPartSaving] = React.useState(false);
  // Same guard as the storage limit: a second blur while the first save runs.
  const partInFlight = React.useRef(false);

  // Depend on storage_limit_bytes only — NOT the whole `data` object, whose volatile
  // storage_used_bytes changes on every SWR revalidation and would clobber an in-progress edit.
  React.useEffect(() => {
    if (data) setGb(formatGb(data.storage_limit_bytes));
  }, [data?.storage_limit_bytes]);

  // Same rule as the storage limit: follow the saved value only, so a
  // revalidation can't clobber a size being typed.
  React.useEffect(() => {
    if (partSizeBytes) setPartMb(String(partSizeBytes / MB));
  }, [partSizeBytes]);

  React.useEffect(() => {
    if (!brandingLoaded) fetchBranding();
  }, [brandingLoaded, fetchBranding]);

  // What people outside a project can download. Off by default; members always
  // get the choice. Shown in the select while its PUT is in flight.
  const [pendingOriginals, setPendingOriginals] = React.useState<OriginalDownloads | null>(null);
  const [originalsError, setOriginalsError] = React.useState("");
  const [originalsSaved, flashOriginalsSaved] = useSavedFlash();
  const originals: OriginalDownloads =
    pendingOriginals ?? (data?.allow_original_downloads ? "original" : "transcode");

  const handleOriginalsChange = async (value: OriginalDownloads) => {
    if (value === originals) return;
    setPendingOriginals(value);
    setOriginalsError("");
    try {
      const updated = await api.put<InstanceSettings>("/instance/settings", {
        allow_original_downloads: value === "original",
      });
      mutate("/instance/settings", updated, { revalidate: false });
      flashOriginalsSaved();
    } catch (err: unknown) {
      setOriginalsError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setPendingOriginals(null);
    }
  };

  const savePartSize = async (bytes: number) => {
    const updated = await api.put<InstanceSettings>("/instance/settings", {
      upload_part_size_bytes: bytes,
    });
    mutate("/instance/settings", updated, { revalidate: false });
    flashPartSaved();
  };

  // Compression. The slider is driven by a local draft while the admin is
  // moving it, and the save is debounced and flushed on release, because the
  // obvious shape does not work: disabling the input on the first change event
  // aborts the pointer gesture mid-drag (one drag then moves exactly one step)
  // and drops keyboard focus to BODY, swallowing every arrow key after the
  // first. So the input is never disabled while data is loaded, and responses
  // that arrive out of order are discarded by sequence number instead.
  const [draftCompression, setDraftCompression] = React.useState<number | null>(null);
  const [compressionError, setCompressionError] = React.useState("");
  const [compressionSaved, flashCompressionSaved] = useSavedFlash();
  // The step the pending save is for, as a ref: the flush handlers run inside
  // the same gesture and must see the newest step, not the render's closure.
  const compressionTarget = React.useRef<number | null>(null);
  const compressionTimer = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // The level the newest PUT was sent for: undefined until one has gone out,
  // and null once "Use server default" has cleared the level. What "nothing to
  // save" is decided against, because the SWR value only changes when a PUT
  // answers -- see commitCompression.
  const compressionSent = React.useRef<number | null | undefined>(undefined);
  // Bumped per save. An answer whose number is no longer the current one is a
  // save that a later one has already superseded, so its result is dropped.
  const compressionSeq = React.useRef(0);
  // Focus goes back here when "Use server default" unmounts itself.
  const compressionInput = React.useRef<HTMLInputElement | null>(null);
  React.useEffect(() => () => clearTimeout(compressionTimer.current), []);

  // Which step the instance is on. The stored level when there is one;
  // otherwise the step the server resolved its effective CRF offset to. Both
  // come from the API, so the offsets live in exactly one place
  // (COMPRESSION_LEVELS in packages/transcoder/base.py).
  const effectiveCompression = data?.compression_level ?? data?.compression_level_effective;
  // The level the instance is actually on, or null when it is on none: an
  // environment offset no step names leaves the thumb in the middle without
  // the instance being on the middle step, so the two cannot share a value.
  const storedCompression = effectiveCompression ?? null;
  const savedCompression = effectiveCompression ?? DEFAULT_COMPRESSION_LEVEL;
  const compression = draftCompression ?? savedCompression;
  // An offset the environment sets that no step names (-5, say). The slider has
  // nowhere honest to stand, so it says what is actually in force rather than
  // showing "Balanced" while the encoder runs at -5. Only ever true for an
  // admin, who is the only one the API sends these fields to.
  const compressionIsCustom =
    draftCompression === null &&
    data?.compression_crf_offset !== undefined &&
    effectiveCompression === undefined;
  // There is something to clear only once a level is stored: without one the
  // instance already follows the environment.
  const canResetCompression = data?.compression_level != null;

  const saveCompression = React.useCallback(
    async (level: number | null) => {
      const seq = ++compressionSeq.current;
      compressionSent.current = level;
      setCompressionError("");
      try {
        const updated = await api.put<InstanceSettings>("/instance/settings", {
          compression_level: level,
        });
        if (seq !== compressionSeq.current) return false;
        mutate("/instance/settings", updated, { revalidate: false });
        // Only once the gesture has ended. A drag that pauses longer than the
        // debounce has its save sent mid-drag, and clearing the draft then
        // snaps the thumb back under the finger.
        if (compressionTarget.current === null) setDraftCompression(null);
        flashCompressionSaved();
        return true;
      } catch (err: unknown) {
        if (seq !== compressionSeq.current) return false;
        setCompressionError(err instanceof Error ? err.message : "Failed to save");
        // Nothing was stored, so the next attempt at this level has to go out
        // again rather than read as "already sent".
        compressionSent.current = undefined;
        // Back to the saved level, as the selects on this tab do: the thumb
        // must not sit on a step the instance is not on.
        setDraftCompression(null);
        return false;
      }
    },
    [flashCompressionSaved],
  );

  // Takes whatever step the gesture has arrived at and saves it, or drops the
  // draft when it is the step the instance is already on. One place, so the
  // debounce and the release path cannot drift apart.
  const commitCompression = React.useCallback(
    (stored: number | null) => {
      const target = compressionTarget.current;
      compressionTarget.current = null;
      // Against the last level actually sent, not against the value from the
      // API: that one only changes when a PUT answers, so for the length of a
      // round trip it is stale. Saved 3, drag to 5 and release, drag back to 3
      // and release before the answer: 3 equalled the stale 3, nothing went
      // out, and the instance ended on 5 although the admin let go on 3.
      // `stored` is null where no level is stored at all, where every step the
      // admin releases on is a change -- which is how "Custom (env)" can be
      // left for Balanced in one gesture.
      const base = compressionSent.current === undefined ? stored : compressionSent.current;
      if (target !== null && target !== base) void saveCompression(target);
      else setDraftCompression(null);
    },
    [saveCompression],
  );

  const handleCompressionChange = (level: number) => {
    setDraftCompression(level);
    setCompressionError("");
    compressionTarget.current = level;
    clearTimeout(compressionTimer.current);
    compressionTimer.current = setTimeout(() => {
      compressionTimer.current = undefined;
      commitCompression(storedCompression);
    }, COMPRESSION_SAVE_DELAY_MS);
  };

  // Release ends the gesture, so the save need not wait out the debounce.
  const flushCompression = () => {
    if (compressionTimer.current === undefined) return;
    clearTimeout(compressionTimer.current);
    compressionTimer.current = undefined;
    commitCompression(storedCompression);
  };

  // Clearing the level puts the instance back on TRANSCODER_CRF_OFFSET, which
  // is what "no level" means and the only way back without psql on the
  // production database. An explicit null in the body, not an omitted key.
  const resetCompression = async () => {
    clearTimeout(compressionTimer.current);
    compressionTimer.current = undefined;
    compressionTarget.current = null;
    setDraftCompression(null);
    // The button unmounts itself the moment the level is cleared, which drops
    // keyboard focus to the document. Move it to the control it belongs to.
    if (await saveCompression(null)) compressionInput.current?.focus();
  };

  const handlePartModeChange = async (mode: PartSizeMode) => {
    if (mode === partMode) return;
    setPendingPartMode(mode);
    setPartError("");
    try {
      await savePartSize(mode === "auto" ? 0 : DEFAULT_FIXED_PART_BYTES);
      if (mode === "fixed") setPartMb(String(DEFAULT_FIXED_PART_BYTES / MB));
    } catch (err: unknown) {
      setPartError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setPendingPartMode(null);
    }
  };

  // Blur only, like the storage limit: every PUT applies at once, so saving
  // per keystroke would cut uploads into 1 MB parts on the way to typing 128.
  const commitPartSize = async (input: HTMLInputElement) => {
    if (!data || partInFlight.current) return;
    const saved = partSizeBytes;
    const outOfRange = `Enter a whole number of MB from ${MIN_PART_MB} to ${MAX_PART_MB}.`;
    if (input.validity.badInput) {
      setPartError(outOfRange);
      return;
    }
    const raw = partMb.trim();
    // Blank is not Automatic -- that is the select's job. Put the saved value back.
    if (raw === "") {
      setPartMb(String(saved / MB));
      setPartError("");
      return;
    }
    const n = Number(raw);
    if (!Number.isInteger(n) || n < MIN_PART_MB || n > MAX_PART_MB) {
      setPartError(outOfRange);
      return;
    }
    setPartError("");
    const bytes = n * MB;
    if (bytes === saved) return;

    partInFlight.current = true;
    setPartSaving(true);
    try {
      await savePartSize(bytes);
    } catch (err: unknown) {
      setPartError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      partInFlight.current = false;
      setPartSaving(false);
    }
  };

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
        <h2 className="text-sm font-semibold text-text-primary">Uploads</h2>
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between">
            <label htmlFor="upload-part-size-mode" className="text-sm font-medium text-text-secondary">
              Upload part size
            </label>
            {partSaved && <SavedMark />}
          </div>
          <div className="relative">
            {/* disabled while saving, so two quick changes can't land out of order */}
            <select
              id="upload-part-size-mode"
              value={partMode}
              onChange={(e) => handlePartModeChange(e.target.value as PartSizeMode)}
              disabled={!data || pendingPartMode !== null || partSaving}
              className="w-full appearance-none cursor-pointer rounded-md border border-border bg-bg-secondary py-1.5 pl-3 pr-8 text-sm text-text-primary transition-colors hover:border-border-focus focus:outline-none focus:border-border-focus focus:ring-1 focus:ring-border-focus disabled:cursor-not-allowed disabled:opacity-50"
            >
              {(Object.keys(PART_SIZE_MODE_LABELS) as PartSizeMode[]).map((mode) => (
                <option key={mode} value={mode}>
                  {PART_SIZE_MODE_LABELS[mode]}
                </option>
              ))}
            </select>
            <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-text-tertiary" />
          </div>
          {partMode === "auto" &&
            (partError ? (
              <p className="text-xs text-status-error">{partError}</p>
            ) : (
              <p className="text-xs text-text-tertiary">
                Sized from each file: 10 MB parts, larger for big files so they finish quickly.
              </p>
            ))}
        </div>
        {partMode === "fixed" && (
          <div className="flex flex-col gap-1.5">
            <label htmlFor="upload-part-size-mb" className="text-sm font-medium text-text-secondary">
              Part size (MB)
            </label>
            <Input
              id="upload-part-size-mb"
              type="number"
              min={MIN_PART_MB}
              max={MAX_PART_MB}
              value={partMb}
              onChange={(e) => setPartMb(e.target.value)}
              onBlur={(e) => commitPartSize(e.currentTarget)}
              onKeyDown={(e) => {
                if (e.key === "Enter") e.currentTarget.blur();
              }}
              disabled={!data || pendingPartMode !== null || partSaving}
            />
            {partError ? (
              <p className="text-xs text-status-error">{partError}</p>
            ) : (
              <p className="text-xs text-text-tertiary">
                Between {MIN_PART_MB} and {MAX_PART_MB} MB. Files that would need more than 10,000
                parts are refused.
              </p>
            )}
          </div>
        )}
      </section>

      <section className="space-y-4">
        <h2 className="text-sm font-semibold text-text-primary">Review streams</h2>
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between">
            {/* Value in the label, which is where this app puts a slider's
                readout. The label row carries the Saved mark like every other
                control in this tab. */}
            <label htmlFor="compression-level" className="text-sm font-medium text-text-secondary">
              Compression: {compressionIsCustom ? "Custom (env)" : COMPRESSION_LABELS[compression]}
            </label>
            {compressionSaved && <SavedMark />}
          </div>
          <input
            id="compression-level"
            ref={compressionInput}
            type="range"
            min={COMPRESSION_LEVELS[0]}
            max={COMPRESSION_LEVELS[COMPRESSION_LEVELS.length - 1]}
            step={1}
            value={compression}
            /* The step name, not the number: a screen reader otherwise reads
               "2", "3", "4" while dragging, and the name only lives in the
               label, which is not re-announced on a value change. */
            aria-valuetext={
              compressionIsCustom ? "Custom (env)" : COMPRESSION_LABELS[compression]
            }
            onChange={(e) => handleCompressionChange(Number(e.target.value))}
            /* Released, so there is nothing left to interrupt: save now rather
               than waiting out the debounce. onBlur covers tabbing away
               mid-gesture. */
            onPointerUp={flushCompression}
            onKeyUp={flushCompression}
            onBlur={flushCompression}
            /* Never disabled once the settings have loaded. Disabling it on the
               first change event -- the obvious way to serialise the saves --
               makes the browser abort the pointer drag and move focus to BODY,
               so a drag advanced one step and the second arrow key was lost.
               Out-of-order answers are handled in saveCompression instead. */
            disabled={!data}
            className="w-full accent-accent disabled:cursor-not-allowed disabled:opacity-50"
          />
          {compressionError ? (
            <p className="text-xs text-status-error">{compressionError}</p>
          ) : (
            <p className="text-xs text-text-tertiary">
              How hard video review streams are compressed, from highest quality to
              smallest files. Less compression means a cleaner picture in dark and
              graded shots, and larger files. Applies to versions uploaded from now
              on; videos already transcoded keep the streams they have.
            </p>
          )}
          {compressionIsCustom && (
            <p className="text-xs text-text-tertiary">
              Currently set by TRANSCODER_CRF_OFFSET ({data?.compression_crf_offset}), which
              is not one of the steps. Moving the slider overrides it.
            </p>
          )}
          {canResetCompression && (
            /* Plain text button, as the inline actions elsewhere in the app are
               (share review screen, folder share viewer): a full Button under
               the slider would outweigh the control it belongs to. Tokens only,
               and the focus ring is the one the selects on this tab use. */
            <button
              type="button"
              onClick={() => void resetCompression()}
              className="mt-0.5 self-start rounded text-xs font-medium text-text-secondary transition-colors hover:text-text-primary focus:outline-none focus-visible:ring-1 focus-visible:ring-border-focus"
            >
              Use server default
            </button>
          )}
        </div>
      </section>

      <section className="space-y-4">
        <h2 className="text-sm font-semibold text-text-primary">Downloads</h2>
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between">
            <label htmlFor="original-downloads" className="text-sm font-medium text-text-secondary">
              Outside a project
            </label>
            {originalsSaved && <SavedMark />}
          </div>
          <div className="relative">
            {/* disabled while saving, so two quick changes can't land out of order */}
            <select
              id="original-downloads"
              value={originals}
              onChange={(e) => handleOriginalsChange(e.target.value as OriginalDownloads)}
              disabled={!data || pendingOriginals !== null}
              className="w-full appearance-none cursor-pointer rounded-md border border-border bg-bg-secondary py-1.5 pl-3 pr-8 text-sm text-text-primary transition-colors hover:border-border-focus focus:outline-none focus:border-border-focus focus:ring-1 focus:ring-border-focus disabled:cursor-not-allowed disabled:opacity-50"
            >
              {(Object.keys(ORIGINAL_DOWNLOADS_LABELS) as OriginalDownloads[]).map((value) => (
                <option key={value} value={value}>
                  {ORIGINAL_DOWNLOADS_LABELS[value]}
                </option>
              ))}
            </select>
            <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-text-tertiary" />
          </div>
          {originalsError ? (
            <p className="text-xs text-status-error">{originalsError}</p>
          ) : (
            <p className="text-xs text-text-tertiary">
              What share-link visitors, visitors to a public project and people an asset is
              shared with directly can download. Project members can always download the
              original.
            </p>
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
