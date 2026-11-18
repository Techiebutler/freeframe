/**
 * Renders the active sequence through Media Encoder and uploads the result to
 * FreeFrame — as a new version of the linked asset, or as a new asset.
 */
import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { useApp } from "../state";
import {
  getInOut,
  getSegmentLinks,
  type AssetLink,
  type SegmentLink,
} from "../../lib/freeframe/host";
import { findPresets, type Preset } from "../../lib/freeframe/presets";
import { Dropdown, MenuRadio } from "./Dropdown";
import { Toggle } from "./Toggle";
import { LocationPicker, type UploadLocation } from "./LocationPicker";
import { IconChevronDown, IconClose, IconRefresh, IconRename, IconSearch } from "./Icons";
import type { Asset } from "../../lib/freeframe/types";

/** `encodeSequence` work-area codes. */
const RANGES = [
  { value: 0, label: "Entire Sequence" },
  { value: 1, label: "In/Out Points" },
];

type StackTarget = AssetLink | SegmentLink;

const isSegmentLink = (target: StackTarget): target is SegmentLink =>
  typeof (target as SegmentLink).id === "string" &&
  typeof (target as SegmentLink).inPoint === "number" &&
  typeof (target as SegmentLink).outPoint === "number";

const linkFromAsset = (asset: Asset, projectName = ""): AssetLink => ({
  assetId: asset.id,
  assetName: asset.name,
  projectId: asset.project_id,
  projectName,
});

export const ExportView = ({
  link,
  defaultLocation = null,
  reviewAsset = null,
  onClose,
}: {
  link: AssetLink | null;
  /** The folder the user was browsing when they opened the dialog. */
  defaultLocation?: UploadLocation | null;
  /** The asset open in Review — offered as a version-stack target even if it was uploaded on the web. */
  reviewAsset?: Asset | null;
  onClose: () => void;
}) => {
  const { api, settings, updateSettings, host, startExport } = useApp();
  const [name, setName] = useState("");
  const [location, setLocation] = useState<UploadLocation | null>(defaultLocation);
  const [pickingLocation, setPickingLocation] = useState(false);
  const [pickingAsset, setPickingAsset] = useState(false);
  // An asset chosen by hand from FreeFrame (e.g. one uploaded on the website,
  // which has no Premiere link to discover it by).
  const [pickedTarget, setPickedTarget] = useState<AssetLink | null>(null);
  // Persisted: the range is a habit, not a per-export decision.
  const range = settings.exportRange;
  const [presets, setPresets] = useState<Preset[]>([]);
  const [presetPath, setPresetPath] = useState(settings.presetPath);
  const [markersAsComments, setMarkersAsComments] = useState(false);
  const [keepLocalCopy, setKeepLocalCopy] = useState(false);
  const [versionStack, setVersionStack] = useState(false);
  const [segmentLinks, setSegmentLinks] = useState<SegmentLink[]>([]);
  const [stackTarget, setStackTarget] = useState<StackTarget | null>(null);
  const [stackTargets, setStackTargets] = useState<StackTarget[]>([]);
  const [nextVersion, setNextVersion] = useState(0);
  // The link can outlive its asset — deleted here, on the web, or by someone
  // else. Until the version count comes back we don't know which.
  const [linkedAssetGone, setLinkedAssetGone] = useState(false);
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => setName(host.sequenceName ?? ""), [host.sequenceName]);
  useEffect(() => {
    if (!host.ok) return;
    getSegmentLinks().then(setSegmentLinks).catch(() => setSegmentLinks([]));
  }, [host.ok]);

  // Metadata in a Premiere project can outlive an asset being moved or deleted
  // on FreeFrame. Validate each timeline link before offering it as a V1.
  const linkedTargets = useMemo(() => {
    const candidates: StackTarget[] = [
      ...(pickedTarget ? [pickedTarget] : []),
      ...(link ? [link] : []),
      ...(reviewAsset ? [linkFromAsset(reviewAsset, defaultLocation?.projectName)] : []),
      ...segmentLinks,
    ];
    const seen = new Set<string>();
    return candidates.filter((candidate) => {
      const key = isSegmentLink(candidate) ? candidate.id : `sequence-${candidate.assetId}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }, [link, segmentLinks, reviewAsset, pickedTarget, defaultLocation?.projectName]);

  useEffect(() => {
    let cancelled = false;
    Promise.all(
      linkedTargets.map(async (candidate) => {
        try {
          const asset = await api.asset(candidate.assetId);
          if (asset.project_id !== candidate.projectId) return null;
          return { ...candidate, assetName: asset.name, projectId: asset.project_id };
        } catch {
          return null;
        }
      })
    ).then((targets) => {
      if (!cancelled) setStackTargets(targets.filter((target): target is StackTarget => !!target));
    });
    return () => {
      cancelled = true;
    };
  }, [api, linkedTargets]);

  useEffect(() => {
    if (!stackTarget) return;
    const stillAvailable = stackTargets.some((candidate) => {
      const candidateId = isSegmentLink(candidate) ? candidate.id : candidate.assetId;
      const selectedId = isSegmentLink(stackTarget) ? stackTarget.id : stackTarget.assetId;
      return candidateId === selectedId;
    });
    if (!stillAvailable) setStackTarget(null);
  }, [stackTarget, stackTargets]);

  // Show which version the render will land on, the way the web viewer does.
  useEffect(() => {
    setNextVersion(0);
    setLinkedAssetGone(false);
    if (!stackTarget) return;
    let cancelled = false;
    api
      .versions(stackTarget.assetId)
      .then((list) => !cancelled && setNextVersion(list.length + 1))
      .catch(() => {
        if (cancelled) return;
        // Nothing to stack onto: fall back to creating a separate asset.
        setLinkedAssetGone(true);
        setVersionStack(false);
      });
    return () => {
      cancelled = true;
    };
  }, [api, stackTarget]);

  // Presets come off disk; rescanning is cheap and only happens on demand.
  const loadPresets = () => {
    const found = findPresets();
    setPresets(found);
    if (!presetPath && found.length) {
      setPresetPath(found[0].file);
      updateSettings({ presetPath: found[0].file });
    }
  };
  useEffect(loadPresets, []);

  // Default the destination to the linked asset's project — and re-pin it
  // whenever stacking is switched on, since the version has to go there.
  useEffect(() => {
    if (!stackTarget) return;
    if (location && !versionStack) return;
    if (versionStack && location?.projectId === stackTarget.projectId) return;
    setLocation({
      projectId: stackTarget.projectId,
      projectName: stackTarget.projectName || "Linked project",
      folderId: null,
      folderName: "Assets",
    });
  }, [stackTarget, location, versionStack]);

  const grouped = useMemo(() => {
    const groups: Record<string, Preset[]> = {};
    presets.forEach((preset) => {
      (groups[preset.group] ||= []).push(preset);
    });
    return groups;
  }, [presets]);

  const presetName = presets.find((p) => p.file === presetPath)?.name || "None chosen";

  const onExport = async () => {
    if (submitting) return;
    setError("");
    if (!host.ok) {
      setError("Open a sequence in Premiere first.");
      return;
    }
    if (!presetPath) {
      setError("Choose an export preset.");
      return;
    }
    if (!location) {
      setError("Choose an upload location.");
      return;
    }
    if (versionStack && !stackTarget) {
      setError("Choose which timeline asset receives this new version.");
      return;
    }
    setSubmitting(true);
    try {
      const inOut = range === 1 ? await getInOut() : null;
      if (range === 1 && (!inOut || inOut.outPoint <= inOut.inPoint)) {
        setError("Set valid In and Out points before exporting this video.");
        return;
      }
      const selectedSegment = stackTarget && isSegmentLink(stackTarget) ? stackTarget : null;
      const segmentId = selectedSegment?.id ?? `segment-${Date.now()}-${Math.round(Math.random() * 100000)}`;
      // Hand the job to the provider and get out of the way: the render outlives
      // this dialog, and its progress shows on the Sequences tab.
      await startExport({
        name:
          versionStack && stackTarget
            ? stackTarget.assetName
            : name || host.sequenceName || "Sequence",
        projectId: location.projectId,
        projectName: location.projectName,
        folderId: location.folderId,
        assetId: versionStack ? stackTarget?.assetId : undefined,
        presetPath,
        range,
        markersAsComments,
        keepLocalCopy,
        exportDir: settings.exportDir,
        sequenceName: host.sequenceName ?? "",
        renderMode: settings.renderMode,
        segment: inOut ? { id: segmentId, ...inOut } : undefined,
      });
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSubmitting(false);
    }
  };

  const busy = submitting;

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [busy, onClose]);

  const modal = (
    <div className="scrim" onClick={() => !busy && onClose()}>
      <div className="export-view" onClick={(event) => event.stopPropagation()}>
      {pickingAsset && (
        <LocationPicker
          mode="asset"
          onCancel={() => setPickingAsset(false)}
          onSelect={() => setPickingAsset(false)}
          onSelectAsset={(asset, projectName) => {
            const next = linkFromAsset(asset, projectName);
            setPickedTarget(next);
            setStackTarget(next);
            setPickingAsset(false);
            setError("");
          }}
        />
      )}
      {pickingLocation && (
        <LocationPicker
          onCancel={() => setPickingLocation(false)}
          onSelect={(next) => {
            setLocation(next);
            setPickingLocation(false);
            setError("");
          }}
        />
      )}

      <div className="export-head">
        <h2>Export to FreeFrame</h2>
        <button className="icon-btn" onClick={onClose} disabled={busy} title="Close">
          <IconClose width={15} height={15} />
        </button>
      </div>

      <div className="export-scroll">
      <Toggle
        label="Add to Version Stack"
        hint={
          linkedAssetGone
            ? "The selected asset is no longer on the server, so this export creates a new asset."
            : "Choose the asset this render (entire sequence or In/Out) should update as a new version."
        }
        checked={versionStack}
        onChange={(checked) => {
          setVersionStack(checked);
          if (!checked) setStackTarget(null);
        }}
        disabled={linkedAssetGone}
      />

      {versionStack && (
        <div className="form-row">
          <span className="form-label">Version Asset</span>
          <Dropdown
            align="right"
            triggerClass="form-control"
            trigger={
              <>
                <span className="control-value">
                  {stackTarget ? stackTarget.assetName : "Choose a timeline asset"}
                </span>
                <IconChevronDown width={14} height={14} />
              </>
            }
          >
            {(close) => (
              <>
                {stackTargets.map((target) => {
                  const segment = isSegmentLink(target) ? target : null;
                  const targetId = segment?.id ?? target.assetId;
                  const selectedId = stackTarget
                    ? (isSegmentLink(stackTarget) ? stackTarget.id : stackTarget.assetId)
                    : null;
                  return (
                    <MenuRadio
                      key={targetId}
                      label={
                        segment
                          ? `${target.assetName} (${segment.inPoint.toFixed(1)}s – ${segment.outPoint.toFixed(1)}s)`
                          : `${target.assetName} (sequence link)`
                      }
                      checked={selectedId === targetId}
                      onSelect={() => {
                        setStackTarget(target);
                        close();
                      }}
                    />
                  );
                })}
                {!stackTargets.length && (
                  <div className="menu-field">No current timeline assets were found in FreeFrame.</div>
                )}
                <button
                  className="menu-foot"
                  onClick={() => {
                    close();
                    setPickingAsset(true);
                  }}
                >
                  <IconSearch width={13} height={13} />
                  Choose another FreeFrame asset…
                </button>
              </>
            )}
          </Dropdown>
        </div>
      )}

      <div className="form-row">
        <span className="form-label">Name</span>
        <span className="name-field">
          <input
            type="text"
            value={versionStack ? stackTarget?.assetName ?? "" : name}
            placeholder={versionStack ? "Choose a Version Asset first" : host.sequenceName ?? "Sequence"}
            disabled={versionStack}
            onChange={(e) => setName(e.target.value)}
          />
          {versionStack && !!nextVersion && (
            <em className="version-badge" title="Uploads as this version of the asset">
              v{nextVersion}
            </em>
          )}
        </span>
      </div>

      <div className="form-row">
        <span className="form-label">Upload Location</span>
        <button
          className="form-control"
          disabled={versionStack && !!stackTarget}
          title={
            versionStack && !!stackTarget
              ? "A new version always lands on the asset's own project."
              : undefined
          }
          onClick={() => setPickingLocation(true)}
        >
          <span className="control-value">
            {location
              ? `${location.projectName} / ${location.folderName}`
              : "Select a FreeFrame location"}
          </span>
          {!(versionStack && stackTarget) && <IconRename width={14} height={14} />}
        </button>
      </div>

      <div className="form-row">
        <span className="form-label">Range</span>
        <Dropdown
          align="right"
          triggerClass="form-control"
          trigger={
            <>
              <span className="control-value">
                {RANGES.find((entry) => entry.value === range)?.label}
              </span>
              <IconChevronDown width={14} height={14} />
            </>
          }
        >
          {(close) =>
            RANGES.map((entry) => (
              <MenuRadio
                key={entry.value}
                label={entry.label}
                checked={range === entry.value}
                onSelect={() => {
                  updateSettings({ exportRange: entry.value });
                  close();
                }}
              />
            ))
          }
        </Dropdown>
      </div>

      <div className="form-row">
        <span className="form-label">Render with</span>
        <Dropdown
          align="right"
          triggerClass="form-control"
          trigger={
            <>
              <span className="control-value">
                {settings.renderMode === "premiere" ? "Premiere (in-app)" : "Media Encoder"}
              </span>
              <IconChevronDown width={14} height={14} />
            </>
          }
        >
          {(close) => (
            <>
              <MenuRadio
                label="Media Encoder"
                checked={settings.renderMode === "ame"}
                onSelect={() => {
                  updateSettings({ renderMode: "ame" });
                  close();
                }}
              />
              <MenuRadio
                label="Premiere (in-app)"
                checked={settings.renderMode === "premiere"}
                onSelect={() => {
                  updateSettings({ renderMode: "premiere" });
                  close();
                }}
              />
              <div className="menu-field">
                In-app skips Media Encoder, but Premiere is busy until the
                render finishes and reports no progress here.
              </div>
            </>
          )}
        </Dropdown>
      </div>

      <div className="form-row">
        <span className="form-label">Preset</span>
        <Dropdown
          align="right"
          triggerClass="form-control"
          trigger={
            <>
              <span className="control-value">{presetName}</span>
              <IconChevronDown width={14} height={14} />
            </>
          }
        >
          {(close) => (
            <>
              {Object.entries(grouped).map(([group, entries]) => (
                <div key={group}>
                  <div className="menu-sep">{group}</div>
                  {entries.map((preset) => (
                    <MenuRadio
                      key={preset.file}
                      label={preset.name}
                      checked={presetPath === preset.file}
                      onSelect={() => {
                        setPresetPath(preset.file);
                        updateSettings({ presetPath: preset.file });
                        close();
                      }}
                    />
                  ))}
                </div>
              ))}
              {!presets.length && (
                <div className="menu-field">No .epr presets found on this machine.</div>
              )}
              <button className="menu-foot" onClick={loadPresets}>
                <IconRefresh width={13} height={13} />
                Rescan presets
              </button>
            </>
          )}
        </Dropdown>
      </div>

      <Toggle
        label="Upload Markers as Comments"
        checked={markersAsComments}
        onChange={setMarkersAsComments}
      />
      <Toggle
        label="Save a Local Copy"
        hint={`Off: the render is deleted after it uploads. On: it stays in ${
          settings.exportDir || "the project folder"
        }.`}
        checked={keepLocalCopy}
        onChange={setKeepLocalCopy}
      />
      <p className="export-meta">
        {[
          host.ok ? host.sequenceName : "No sequence open",
          host.fps ? `${host.fps.toFixed(2)} fps` : null,
          presets.length ? `${presets.length} presets found` : null,
        ]
          .filter(Boolean)
          .join("  |  ")}
      </p>

      {error && <p className="error">{error}</p>}
      </div>

      <div className="dialog-actions export-actions">
        <button onClick={onClose} disabled={busy}>
          Cancel
        </button>
        <button className="primary" onClick={onExport} disabled={busy || !host.ok}>
          {busy ? "Working…" : "Export"}
        </button>
      </div>
      </div>
    </div>
  );

  // CEP's Chromium can stop repainting a fixed, scrollable dialog when it is
  // composed below the Review layout. Keeping the export modal at the document
  // root avoids that clipped compositing layer and keeps it stable while the
  // panel is resized or scrolled.
  return typeof document === "undefined" ? modal : createPortal(modal, document.body);
};
