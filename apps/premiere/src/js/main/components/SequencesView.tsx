/**
 * Export status and history — the asset that belongs to the sequence you're
 * cutting, plus everything this machine has sent up. The export options
 * themselves live in the modal.
 */
import { useEffect, useMemo, useState } from "react";
import { useApp } from "../state";
import type { Asset } from "../../lib/freeframe/types";
import { copyText } from "../../lib/freeframe/clipboard";
import { relativeTime } from "../../lib/freeframe/format";
import { getSegmentLinks, type AssetLink, type SegmentLink } from "../../lib/freeframe/host";
import { openLinkInBrowser } from "../../lib/utils/bolt";
import { ApiError } from "../../lib/freeframe/api";
import { Dropdown, MenuAction } from "./Dropdown";
import {
  IconClose,
  IconComment,
  IconCopy,
  IconExternal,
  IconFilm,
  IconMarker,
  IconMore,
  IconPlus,
  IconUpload,
} from "./Icons";

const PHASE_LABEL: Record<string, string> = {
  queued: "Queued",
  rendering: "Encoding",
  uploading: "Uploading",
  done: "Uploaded",
  failed: "Failed",
  cancelled: "Cancelled",
};

/** `Today` / `Yesterday` / a date, for the history section headers. */
const dayLabel = (iso: string): string => {
  const date = new Date(iso);
  const today = new Date();
  const days = Math.floor(
    (new Date(today.toDateString()).getTime() - new Date(date.toDateString()).getTime()) /
      86400000
  );
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
};

export const SequencesView = ({
  link,
  onExport,
  onOpenAsset,
}: {
  link: AssetLink | null;
  onExport: () => void;
  onOpenAsset: (asset: Asset) => void;
}) => {
  const { api, settings, updateSettings, host, exportJobs, cancelExport } = useApp();
  const [thumbs, setThumbs] = useState<Record<string, Asset>>({});
  const [commentCounts, setCommentCounts] = useState<Record<string, number>>({});
  const [thumbTick, setThumbTick] = useState(0);
  const [gone, setGone] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [segmentLinks, setSegmentLinks] = useState<SegmentLink[]>([]);

  useEffect(() => {
    if (!host.ok) {
      setSegmentLinks([]);
      return;
    }
    let cancelled = false;
    getSegmentLinks()
      .then((links) => {
        if (!cancelled) setSegmentLinks(links);
      })
      .catch(() => {
        if (!cancelled) setSegmentLinks([]);
      });
    return () => {
      cancelled = true;
    };
  }, [host.ok, host.sequenceId]);

  const history = useMemo(
    () => (settings.exportHistory ?? []).filter((entry) => !gone.includes(entry.assetId)),
    [settings.exportHistory, gone]
  );

  // Prune the stored history once the dead rows have been identified.
  useEffect(() => {
    if (!gone.length) return;
    const stored = settings.exportHistory ?? [];
    const kept = stored.filter((entry) => !gone.includes(entry.assetId));
    if (kept.length !== stored.length) updateSettings({ exportHistory: kept });
  }, [gone, settings.exportHistory, updateSettings]);
  const active = exportJobs.filter(
    (job) => job.phase !== "done" && job.phase !== "cancelled"
  );

  /** The asset that belongs to the open sequence, if it has been exported. */
  const current = useMemo(() => {
    // An In/Out export has no single direct sequence link. Its association is
    // stored in the segment list, so include those assets in the current card.
    const linkedAssetIds = [link?.assetId, ...segmentLinks.map((segment) => segment.assetId)].filter(
      (id): id is string => !!id
    );
    const linked = history.find((entry) => linkedAssetIds.includes(entry.assetId));
    if (linked) return linked;
    const byName = host.sequenceName
      ? history.find((entry) => entry.sequenceName === host.sequenceName)
      : undefined;
    if (byName) return byName;
    // The export history is a per-machine log. A sequence linked by hand, by a
    // teammate, or exported on another computer still has a link — show it.
    const fallback = link ?? segmentLinks[0];
    if (!fallback) return null;
    return {
      assetId: fallback.assetId,
      name: fallback.assetName,
      projectId: fallback.projectId,
      projectName: fallback.projectName,
      sequenceName: host.sequenceName ?? "",
      uploadedAt: "",
    };
  }, [link, segmentLinks, history, host.sequenceName]);

  // Thumbnails and comment counts aren't in the history, so fetch what's shown.
  useEffect(() => {
    let cancelled = false;
    const ids = [
      ...new Set([
        ...(current ? [current.assetId] : []),
        ...history.slice(0, 20).map((entry) => entry.assetId),
      ]),
    ];
    ids.forEach(async (id) => {
      // Refetch while the thumbnail is still missing: it appears only when the
      // server finishes transcoding, after this row was first drawn.
      let asset = thumbs[id];
      try {
        if (!asset?.thumbnail_url) {
          asset = await api.asset(id);
          if (!cancelled) {
            setThumbs((current) => {
              const previous = current[id];
              // Avoid rerendering in a loop while a transcode still has no
              // thumbnail; the existing poll will try again shortly.
              if (
                previous?.thumbnail_url === asset!.thumbnail_url &&
                previous?.latest_version?.id === asset!.latest_version?.id
              ) {
                return current;
              }
              return { ...current, [id]: asset! };
            });
          }
        }
      } catch (e) {
        // The history is a local log, so it outlived assets deleted anywhere
        // else. A 404 means this row can never resolve again — drop it.
        if (!cancelled && e instanceof ApiError && (e.status === 404 || e.status === 403)) {
          setGone((current) => (current.includes(id) ? current : [...current, id]));
        }
        return;
      }

      const versionId = asset?.latest_version?.id;
      if (!versionId || commentCounts[id] !== undefined) return;
      try {
        const comments = await api.comments(id, versionId);
        if (cancelled) return;
        // Replies count too, matching the total shown in the review thread.
        const total = comments.reduce(
          (sum, comment) => sum + 1 + (comment.replies?.length ?? 0),
          0
        );
        setCommentCounts((current) => ({ ...current, [id]: total }));
      } catch {
        // The badge is supplemental; keep the asset usable if its count fails.
      }
    });
    return () => {
      cancelled = true;
    };
  }, [api, history, current, thumbTick, thumbs, commentCounts]);

  // Poll gently while any visible row is still waiting on its thumbnail.
  useEffect(() => {
    const pending = history
      .slice(0, 20)
      .some((entry) => !thumbs[entry.assetId]?.thumbnail_url);
    if (!pending) return;
    const timer = setTimeout(() => setThumbTick((tick) => tick + 1), 5000);
    return () => clearTimeout(timer);
  }, [history, thumbs]);

  const assetUrl = (projectId: string, assetId: string) =>
    `${(settings.webUrl || settings.serverUrl).replace(/\/+$/, "")}/projects/${projectId}/assets/${assetId}`;

  const open = async (assetId: string) => {
    try {
      onOpenAsset(await api.asset(assetId));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const Row = ({
    assetId,
    name,
    projectName,
    projectId,
    sequenceName,
  }: {
    assetId: string;
    name: string;
    projectName: string;
    projectId: string;
    sequenceName?: string;
  }) => {
    const asset = thumbs[assetId];
    const version = asset?.latest_version?.version_number;
    return (
      <div className="seq-row" onClick={() => open(assetId)}>
        <span className="seq-thumb">
          {asset?.thumbnail_url ? (
            <img src={asset.thumbnail_url} alt="" />
          ) : (
            <IconFilm width={18} height={18} />
          )}
          {!!commentCounts[assetId] && (
            <em className="seq-comment-count">
              <IconComment width={11} height={11} />
              {commentCounts[assetId]}
            </em>
          )}
        </span>
        <span className="seq-meta">
          <span className="seq-title">
            <strong>{name}</strong>
            {!!version && version > 1 && <em className="seq-version">v{version}</em>}
          </span>
          <span className="seq-sub">
            <IconFilm width={11} height={11} />
            {projectName}
          </span>
          {sequenceName && (
            <span className="seq-sub">
              <IconMarker width={11} height={11} />
              {sequenceName}
            </span>
          )}
        </span>
        <Dropdown triggerClass="icon-btn" trigger={<IconMore width={15} height={15} />}>
          {(close) => (
            <>
              <MenuAction
                icon={<IconFilm width={14} height={14} />}
                label="Open in review"
                onSelect={() => {
                  close();
                  open(assetId);
                }}
              />
              <MenuAction
                icon={<IconExternal width={14} height={14} />}
                label="Open in browser"
                onSelect={() => {
                  close();
                  openLinkInBrowser(assetUrl(projectId, assetId));
                }}
              />
              <MenuAction
                icon={<IconCopy width={14} height={14} />}
                label="Copy Asset URL"
                onSelect={() => {
                  close();
                  void copyText(assetUrl(projectId, assetId));
                }}
              />
            </>
          )}
        </Dropdown>
      </div>
    );
  };

  const grouped = useMemo(() => {
    const groups: { label: string; entries: typeof history }[] = [];
    history.forEach((entry) => {
      const label = dayLabel(entry.uploadedAt);
      const last = groups[groups.length - 1];
      if (last && last.label === label) last.entries.push(entry);
      else groups.push({ label, entries: [entry] });
    });
    return groups;
  }, [history]);

  const currentAsset = current ? thumbs[current.assetId] : undefined;

  return (
    <div className="sequences">
      <div className="seq-head">
        <h2>Current Sequence Asset</h2>
        <button className="primary icon-btn" onClick={onExport} title="Export sequence">
          <IconPlus width={15} height={15} />
        </button>
      </div>

      {error && <p className="error">{error}</p>}

      {/* One surface: the row and its status strip light up together. */}
      <div
        className={`seq-card${!active.length && current ? " clickable" : ""}${
          currentAsset?.thumbnail_url ? " has-thumbnail" : ""
        }`}
        onClick={() => !active.length && current && open(current.assetId)}
      >
        {currentAsset?.thumbnail_url && (
          <span
            className="seq-backdrop"
            aria-hidden="true"
            style={{ backgroundImage: `url("${currentAsset.thumbnail_url}")` }}
          />
        )}
        {active.length > 0 ? (
          active.map((job) => (
            <div key={job.id}>
              <div className="seq-row static">
                <span className="seq-thumb spinner" />
                <span className="seq-meta">
                  <strong>{job.name}</strong>
                  <span className="seq-sub">{job.projectName}</span>
                  <span className="seq-sub">
                    <span className="render-dot" />
                    {job.sequenceName}
                  </span>
                </span>
              </div>
              <div className={`seq-status${job.phase === "failed" ? " failed" : ""}`}>
                <span className="seq-bar" style={{ width: `${job.progress}%` }} />
                <span className="seq-status-text">
                  <IconUpload width={12} height={12} />
                  {PHASE_LABEL[job.phase]}
                  {job.phase === "rendering" || job.phase === "uploading"
                    ? ` ${job.progress}%`
                    : ""}
                  {job.error ? ` — ${job.error}` : ""}
                  <button
                    className="text-btn"
                    onClick={() => cancelExport(job.id)}
                    title={
                      job.phase === "uploading"
                        ? "Stop the upload"
                        : "Remove this job. A render already queued in Media Encoder continues there."
                    }
                  >
                    <IconClose width={12} height={12} />
                    Cancel
                  </button>
                </span>
              </div>
            </div>
          ))
        ) : current ? (
          <>
            <Row
              assetId={current.assetId}
              name={current.name}
              projectId={current.projectId}
              projectName={current.projectName}
              sequenceName={current.sequenceName}
            />
            <div className="seq-status">
              <span className="seq-status-text">
                {current.uploadedAt ? `Uploaded ${relativeTime(current.uploadedAt)}` : "Linked to this sequence"}
              </span>
            </div>
          </>
        ) : (
          <div className="seq-empty">
            {host.ok
              ? "Current sequence not yet exported"
              : "No sequence open in Premiere"}
          </div>
        )}
      </div>

      <h2>All Sequence Assets</h2>

      {!grouped.length && <p className="muted empty">No linked sequence assets</p>}

      {grouped.map((group) => (
        <div key={group.label} className="seq-group">
          <span className="seq-day">{group.label}</span>
          {group.entries.map((entry) => (
            <Row
              key={`${entry.assetId}-${entry.uploadedAt}`}
              assetId={entry.assetId}
              name={entry.name}
              projectId={entry.projectId}
              projectName={entry.projectName}
            />
          ))}
        </div>
      ))}
    </div>
  );
};
