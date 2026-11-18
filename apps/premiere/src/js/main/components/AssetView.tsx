/**
 * Review screen: the asset playing back, its comments, the marker sync, and the
 * link between the asset and the sequence that is open in Premiere.
 *
 * Wide panels put the comments beside the video; narrow ones stack them (see
 * the `.review` media query in main.scss).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useApp } from "../state";
import type { Asset, AssetVersion, Comment } from "../../lib/freeframe/types";
import { copyText } from "../../lib/freeframe/clipboard";
import { buildCommentNumbers } from "../../lib/freeframe/comment-numbers";
import {
  uploadCommentAttachment,
  validateCommentAttachment,
} from "../../lib/freeframe/comment-attachments";
import {
  commentAuthorName,
  commentTreeContains,
  EMPTY_REVIEW_FILTERS,
  filterAndSortComments,
  insertReplyIntoThread,
  markerSignatureFor,
  resolveSequenceLink,
  timestampedComments,
  type ReviewFilters,
  type ReviewSortKey,
} from "../../lib/freeframe/review";
import { shortDate } from "../../lib/freeframe/format";
import {
  clearLink,
  clearMarkers,
  getSegmentLinks,
  inPremiere,
  removeSegmentLink,
  setLink,
  setPlayheadSeconds,
  type AssetLink,
  type SegmentLink,
} from "../../lib/freeframe/host";
import { useMarkerSync } from "../hooks/useMarkerSync";
import { useReviewComments } from "../hooks/useReviewComments";
import { openLinkInBrowser } from "../../lib/utils/bolt";
import { Player, type PlayerHandle } from "./player/Player";
import { Dropdown, MenuAction, MenuCheck, MenuRadio } from "./Dropdown";
import { CommentComposer } from "./comments/CommentComposer";
import { CommentItem } from "./comments/CommentItem";
import { ConfirmDialog, type ConfirmRequest } from "./ConfirmDialog";
import { ShareDialog } from "./share/ShareDialog";
import {
  IconAnnotation,
  IconAttachment,
  IconCheck,
  IconCheckCircle,
  IconChevronDown,
  IconChevronLeft,
  IconChevronUp,
  IconCircle,
  IconCopy,
  IconDownload,
  IconExternal,
  IconFilm,
  IconFilter,
  IconLink,
  IconMarker,
  IconPlus,
  IconRename,
  IconSearch,
  IconShare,
  IconSort,
  IconTrash,
} from "./Icons";

const MIN_REVIEW_MAIN_WIDTH = 360;
const MIN_REVIEW_SIDE_WIDTH = 240;
const REVIEW_SPLIT_CHROME_WIDTH = 18;

type SortKey = ReviewSortKey;

const SORTS: { key: SortKey; label: string }[] = [
  { key: "oldest", label: "Oldest" },
  { key: "timecode", label: "Timecode (Default)" },
  { key: "newest", label: "Newest" },
  { key: "commenter", label: "Commenter" },
  { key: "completed", label: "Completed" },
];

type Filters = ReviewFilters;
const NO_FILTERS = EMPTY_REVIEW_FILTERS;
const authorOf = commentAuthorName;

export const AssetView = ({
  asset,
  onBack,
  onExport,
  link,
  onLinkChange,
}: {
  asset: Asset;
  onBack: () => void;
  onExport: () => void;
  link: AssetLink | null;
  onLinkChange: (link: AssetLink | null) => void;
}) => {
  const { api, settings, updateSettings, user, host, refreshHost } = useApp();
  const [name, setName] = useState(asset.name);
  const [renaming, setRenaming] = useState(false);
  const [confirming, setConfirming] = useState<ConfirmRequest | null>(null);
  const [sharing, setSharing] = useState(false);
  const [versions, setVersions] = useState<AssetVersion[]>([]);
  const [versionId, setVersionId] = useState(asset.latest_version?.id ?? "");
  const [segmentLinks, setSegmentLinks] = useState<SegmentLink[]>([]);
  const [error, setError] = useState("");
  const { comments, setComments, refreshComments: loadComments } = useReviewComments({
    api,
    assetId: asset.id,
    versionId,
    onError: setError,
  });
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState("");
  const [attachment, setAttachment] = useState<File | null>(null);
  const [timecodeAttached, setTimecodeAttached] = useState(true);
  const [selectedTimeRange, setSelectedTimeRange] = useState<{
    start: number;
    end: number;
  } | null>(null);
  const [visibility, setVisibility] = useState<"public" | "internal">("public");
  const [replyTo, setReplyTo] = useState<string | null>(null);
  const [replyDraft, setReplyDraft] = useState("");
  const [replyAttachment, setReplyAttachment] = useState<File | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [videoTime, setVideoTime] = useState(0);
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<SortKey>("timecode");
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  // Read state is local: the API tracks notifications, not per-comment reads.
  const readIds = useMemo(
    () => new Set(settings.readComments ?? []),
    [settings.readComments]
  );
  const [justRead, setJustRead] = useState<Set<string>>(new Set());
  const listRef = useRef<HTMLUListElement>(null);
  const playerRef = useRef<PlayerHandle>(null);
  const reviewRef = useRef<HTMLDivElement>(null);
  const [wide, setWide] = useState(false);
  const [sideWidth, setSideWidth] = useState(settings.sideWidth);

  /**
   * Side-by-side is driven by the panel's own width rather than a media query,
   * so the splitter and the layout switch agree on the same measurement.
   */
  useEffect(() => {
    const node = reviewRef.current;
    if (!node || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      const width = entry.contentRect.width;
      const isWide = width >= 640;
      setWide(isWide);
      if (isWide) {
        const maxSideWidth = Math.max(
          MIN_REVIEW_SIDE_WIDTH,
          width - MIN_REVIEW_MAIN_WIDTH - REVIEW_SPLIT_CHROME_WIDTH
        );
        // Shrinking the panel must clamp the existing splitter choice too;
        // previously that only happened after the user dragged it again.
        setSideWidth((current) => Math.min(current, maxSideWidth));
      }
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const onSplitterDown = (event: React.MouseEvent) => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = sideWidth;
    const total = reviewRef.current?.clientWidth ?? 0;
    const onMove = (move: MouseEvent) => {
      // Dragging left widens the thread, so the delta is inverted.
      const next = startWidth - (move.clientX - startX);
      const maxSideWidth = Math.max(
        MIN_REVIEW_SIDE_WIDTH,
        total - MIN_REVIEW_MAIN_WIDTH - REVIEW_SPLIT_CHROME_WIDTH
      );
      setSideWidth(Math.max(MIN_REVIEW_SIDE_WIDTH, Math.min(next, maxSideWidth)));
    };
    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      setSideWidth((width) => {
        updateSettings({ sideWidth: width });
        return width;
      });
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  };

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
  }, [asset.id, host.ok, host.sequenceId, versionId]);

  const { sequenceLink, segmentLink, isLinked, offsetSeconds: offset } = useMemo(
    () => resolveSequenceLink({ assetId: asset.id, versionId, link, segmentLinks }),
    [asset.id, versionId, link, segmentLinks]
  );
  // Segment comments are relative to the exported In/Out clip. The Premiere
  // marker must include that clip's real timeline start.
  // A direct sequence link may be recreated after an In/Out export. Keep the
  // segment's real timeline start authoritative, otherwise relinking would
  // replace it with the direct link's default offset (zero).
  const isVideo = asset.asset_type === "video";
  const hasTimecode = isVideo || asset.asset_type === "audio";
  const markersOn = settings.markersVisible;
  const annotationsOn = settings.annotationsVisible;

  /** The drawing replayed over the video: the selected comment's, if any. */
  const activeAnnotation = useMemo(() => {
    if (!annotationsOn || !activeId) return null;
    const found = comments.find((comment) => comment.id === activeId);
    return found?.annotation?.drawing_data ?? null;
  }, [annotationsOn, activeId, comments]);

  /** Where a new comment lands: the player is the reference when it's there. */
  const composerTime = isVideo
    ? videoTime
    : Math.max(0, (host.playheadSeconds ?? 0) - offset);

  const timed = useMemo(() => timestampedComments(comments), [comments]);

  const people = useMemo(() => {
    const names = new Set<string>();
    comments.forEach((comment) => names.add(authorOf(comment)));
    return [...names].sort();
  }, [comments]);

  const filtersOn =
    filters.annotations ||
    filters.attachments ||
    filters.completed ||
    filters.incomplete ||
    !!filters.person;

  const visible = useMemo(
    () =>
      filterAndSortComments({
        comments,
        filters,
        query,
        sort,
        hideResolved: settings.hideResolved,
      }),
    [comments, query, sort, filters, settings.hideResolved]
  );

  const openCount = comments.filter((c) => !c.resolved).length;

  /** Stable root-thread numbers, independent of visible sorting or filtering. */
  const indexOf = useMemo(() => buildCommentNumbers(comments), [comments]);

  useEffect(() => {
    setName(asset.name);
  }, [asset.id, asset.name]);

  useEffect(() => {
    (async () => {
      try {
        const list = await api.versions(asset.id);
        setVersions(list);
        setVersionId((current) => current || list[list.length - 1]?.id || "");
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    })();
  }, [api, asset.id]);

  // -- navigation -------------------------------------------------------------

  /** Selecting a comment moves both playheads: the panel's and Premiere's. */
  const markRead = useCallback(
    (id: string) => {
      setJustRead((current) => new Set(current).add(id));
      if (readIds.has(id)) return;
      // Cap the log: it only exists to grey out what has already been seen.
      const next = [...(settings.readComments ?? []), id].slice(-800);
      updateSettings({ readComments: next });
    },
    [readIds, settings.readComments, updateSettings]
  );

  const jumpTo = useCallback(
    async (comment: Comment) => {
      setActiveId(comment.id);
      markRead(comment.id);
      if (comment.timecode_start === null || comment.timecode_start === undefined) return;
      const at = comment.timecode_start as number;
      playerRef.current?.seek(at);
      if (inPremiere()) await setPlayheadSeconds(at + offset);
    },
    [offset, markRead]
  );

  const step = async (direction: 1 | -1) => {
    if (!timed.length) return;
    const index = timed.findIndex((c) => c.id === activeId);
    const next =
      index === -1
        ? direction === 1
          ? 0
          : timed.length - 1
        : Math.min(timed.length - 1, Math.max(0, index + direction));
    await jumpTo(timed[next]);
    listRef.current
      ?.querySelector(`[data-comment="${timed[next].id}"]`)
      ?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  };

  // -- markers ----------------------------------------------------------------

  const { pushMarkers } = useMarkerSync({
    offsetSeconds: offset,
    fps: host.fps,
    includeResolved: !settings.hideResolved,
    refreshHost,
    onError: setError,
  });

  /**
   * While markers are shown, keep them matching the thread — but only when the
   * set of comments actually changed, so the poll doesn't hit ExtendScript on
   * every tick.
   */
  // Marker sync follows the same filtered thread the reviewer sees. This also
  // changes whenever search, status, author, attachment, or annotation filters
  // change the visible comment set.
  const markerSignature = markerSignatureFor(visible);
  // Read the latest list from a ref: `visible` gets a new identity on every
  // comment poll, which re-sent every marker to ExtendScript each time.
  const visibleRef = useRef(visible);
  visibleRef.current = visible;

  useEffect(() => {
    // Marker visibility is global to the extension, but the active sequence
    // only belongs to this asset when it has an explicit sequence/segment link.
    // Without this guard, posting on an unrelated asset could write markers
    // into whichever Premiere sequence happens to be open.
    if (!isLinked || !markersOn || !host.ok) return;
    pushMarkers(visibleRef.current);
    // `markerSignature` includes the current comment filters as well as the
    // comment content, so markers disappear and return with the list.
  }, [markerSignature, isLinked, markersOn, host.sequenceId, offset]);

  /**
   * In/Out exports are already linked when their upload completes, without a
   * manual "Link asset" click. As soon as that asset has comments, enable the
   * same marker sync that the manual-link flow performs.
   */
  useEffect(() => {
    if (!segmentLink || !host.ok || markersOn || !comments.length) return;
    pushMarkers(visibleRef.current).then((result) => {
      if (result) updateSettings({ markersVisible: true });
    });
  }, [segmentLink?.id, markerSignature, host.ok, host.sequenceId, offset]);

  const toggleMarkers = async () => {
    if (!host.ok) {
      setError("Open a sequence in Premiere first.");
      return;
    }
    setBusy(true);
    try {
      if (markersOn) {
        const result = await clearMarkers();
        if (!result.ok) {
          setError(`Could not remove markers: ${result.error}`);
          return;
        }
        updateSettings({ markersVisible: false });
      } else {
        const result = await pushMarkers(visible);
        if (!result) return;
        updateSettings({ markersVisible: true });
        // Comments outside the sequence silently have nowhere to go, so that
        // one case is still worth saying out loud.
        if (result?.skipped) {
          setError(
            `${result.skipped} comment(s) fall outside the sequence and got no marker.`
          );
        }
      }
      await refreshHost();
    } finally {
      setBusy(false);
    }
  };

  // -- asset actions ----------------------------------------------------------

  const askToLink = () => {
    if (!host.ok) {
      setError("Open a sequence in Premiere first.");
      return;
    }
    setConfirming({
      title: "Link asset to active sequence",
      body: `Linking connects "${host.sequenceName}" to ${name}, so markers and new versions from this sequence go to that asset in FreeFrame.`,
      confirmLabel: "Link asset",
      onConfirm: onLink,
    });
  };

  const onLink = async () => {
    if (!host.ok) return;
    const next: AssetLink = {
      assetId: asset.id,
      assetName: name,
      projectId: asset.project_id,
      projectName: host.projectName ?? "",
      versionId,
      offsetSeconds: offset,
    };
    const result = await setLink(next);
    if (!result.ok) {
      // XMP can be unavailable (no project item, read-only project); the local
      // copy still keeps the panel useful for this session.
      setError("Linked locally — Premiere would not store it in the project.");
    }
    onLinkChange(next);

    const markerResult = await pushMarkers(visible);
    if (markerResult) {
      updateSettings({ markersVisible: true });
      if (markerResult.skipped) {
        setError(
          `${markerResult.skipped} comment(s) fall outside the sequence and got no marker.`
        );
      }
    }
  };

  const askToUnlink = () => {
    setConfirming({
      title: "Unlink asset from active sequence",
      body: `Unlinking disconnects "${name}" from ${host.sequenceName ?? "this sequence"} and removes its FreeFrame markers from the timeline.`,
      confirmLabel: "Unlink asset",
      danger: true,
      onConfirm: onUnlink,
    });
  };

  const onUnlink = async () => {
    let errorMessage: string | null = null;
    try {
      // Only FreeFrame-owned markers are removed; hand-made Premiere markers
      // are left untouched by the host-side clearMarkers implementation.
      const markerResult = await clearMarkers();
      if (!markerResult.ok) {
        errorMessage = `Could not remove markers: ${markerResult.error}`;
      }
    } catch (error) {
      errorMessage = `Could not remove markers: ${String(error)}`;
    }

    if (segmentLink) {
      try {
        const result = await removeSegmentLink(segmentLink.id);
        if (!result.ok) {
          errorMessage ??= `Could not unlink segment: ${result.error}`;
        } else {
          setSegmentLinks((links) => links.filter((link) => link.id !== segmentLink.id));
        }
      } catch (error) {
        errorMessage ??= `Could not unlink segment: ${String(error)}`;
      }
    }
    if (sequenceLink) {
      try {
        const result = await clearLink();
        if (!result.ok) {
          errorMessage ??= `Could not unlink asset: ${result.error}`;
        }
      } catch (error) {
        errorMessage ??= `Could not unlink asset: ${String(error)}`;
      }
      onLinkChange(null);
    }

    updateSettings({ markersVisible: false });
    try {
      await refreshHost();
    } catch (error) {
      errorMessage ??= `Could not refresh Premiere: ${String(error)}`;
    }
    if (errorMessage) setError(errorMessage);
  };

  const assetUrl = (commentId?: string) => {
    const base = (settings.webUrl || settings.serverUrl).replace(/\/+$/, "");
    const suffix = commentId ? `?commentId=${commentId}` : "";
    return `${base}/projects/${asset.project_id}/assets/${asset.id}${suffix}`;
  };

  const onDownload = async () => {
    try {
      openLinkInBrowser(await api.downloadUrl(asset.id));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const onRename = async () => {
    const trimmed = name.trim();
    setRenaming(false);
    if (!trimmed || trimmed === asset.name) {
      setName(asset.name);
      return;
    }
    try {
      await api.renameAsset(asset.id, trimmed);
      asset.name = trimmed;
    } catch (e) {
      setName(asset.name);
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const onDelete = async () => {
    try {
      await api.deleteAsset(asset.id);
      if (isLinked) await onUnlink();
      onBack();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  // -- comment actions --------------------------------------------------------

  const onPost = async () => {
    if (!draft.trim() || !versionId) return;
    setBusy(true);
    try {
      const comment = await api.createComment(asset.id, {
        version_id: versionId,
        body: draft.trim(),
        timecode_start: timecodeAttached
          ? selectedTimeRange?.start ?? composerTime
          : null,
        timecode_end:
          timecodeAttached &&
          selectedTimeRange &&
          selectedTimeRange.end - selectedTimeRange.start > 0.05
            ? selectedTimeRange.end
            : undefined,
        visibility,
      });
      if (attachment) await uploadCommentAttachment(api, comment.id, attachment);
      setDraft("");
      setAttachment(null);
      setSelectedTimeRange(null);
      const list = await loadComments();
      // A newly exported In/Out asset is linked through its segment metadata,
      // rather than the manual link menu. Push the first new note immediately
      // so the marker appears without requiring a relink.
      if (isLinked && host.ok && list) {
        const result = await pushMarkers(visible);
        if (result) updateSettings({ markersVisible: true });
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const onReply = async (commentId: string) => {
    if (!replyDraft.trim() || !versionId) return;
    try {
      const reply = await api.reply(asset.id, commentId, versionId, replyDraft.trim());
      if (replyAttachment) await uploadCommentAttachment(api, reply.id, replyAttachment);
      setComments((current) => insertReplyIntoThread(current, commentId, reply));
      setReplyDraft("");
      setReplyAttachment(null);
      setReplyTo(null);
      const refreshed = await loadComments();
      // Some API deployments briefly return a root-only list after reply
      // creation. Preserve the new reply until the nested tree catches up.
      if (refreshed && !commentTreeContains(refreshed, reply.id)) {
        setComments(insertReplyIntoThread(refreshed, commentId, reply));
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  /** Toggling a reaction is optimistic too; the poll reconciles the counts. */
  const onReact = async (comment: Comment, emoji: string) => {
    setComments((current) =>
      current.map((c) => {
        if (c.id !== comment.id) return c;
        const reactions = [...(c.reactions ?? [])];
        const index = reactions.findIndex((r) => r.emoji === emoji);
        if (index === -1) {
          reactions.push({ emoji, count: 1, reacted: true });
        } else {
          const hit = reactions[index];
          const count = hit.count + (hit.reacted ? -1 : 1);
          if (count <= 0) reactions.splice(index, 1);
          else reactions[index] = { ...hit, count, reacted: !hit.reacted };
        }
        return { ...c, reactions };
      })
    );
    try {
      await api.react(comment.id, emoji);
      await loadComments();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      await loadComments();
    }
  };

  /** Optimistic so the checkbox feels instant; the poll reconciles it. */
  const onToggleDone = async (comment: Comment) => {
    setComments((current) =>
      current.map((c) => (c.id === comment.id ? { ...c, resolved: !c.resolved } : c))
    );
    try {
      await api.resolve(comment.id);
      await loadComments();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      await loadComments();
    }
  };

  const onDeleteComment = async (comment: Comment) => {
    try {
      await api.deleteComment(comment.id);
      if (activeId === comment.id) setActiveId(null);
      await loadComments();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const onDeleteAttachment = async (commentId: string, attachmentId: string) => {
    try {
      await api.deleteCommentAttachment(commentId, attachmentId);
      await loadComments();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="asset-view">
      <ConfirmDialog request={confirming} onClose={() => setConfirming(null)} />
      {sharing && (
        <ShareDialog
          asset={asset}
          onClose={() => setSharing(false)}
          onRenamed={(next) => setName(next)}
        />
      )}

      <nav className="navbar">
        <button className="icon-btn" onClick={onBack} title="Back">
          <IconChevronLeft width={15} height={15} />
        </button>
        {renaming ? (
          <input
            className="rename"
            value={name}
            autoFocus
            onChange={(e) => setName(e.target.value)}
            onBlur={onRename}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === " ") {
                e.preventDefault();
                const input = e.currentTarget;
                const start = input.selectionStart ?? input.value.length;
                const end = input.selectionEnd ?? start;
                setName((current) => `${current.slice(0, start)} ${current.slice(end)}`);
                requestAnimationFrame(() => input.setSelectionRange(start + 1, start + 1));
                return;
              }
              if (e.key === "Enter") onRename();
              if (e.key === "Escape") {
                setName(asset.name);
                setRenaming(false);
              }
            }}
          />
        ) : (
          <Dropdown
            triggerClass="name-btn"
            align="left"
            trigger={
              <>
                <span className="name-text">{name}</span>
                <IconChevronDown width={12} height={12} />
              </>
            }
          >
            {(close) => (
              <>
                <MenuAction
                  icon={<IconLink width={14} height={14} />}
                  label={isLinked ? "Unlink from sequence" : "Link to Premiere Sequence"}
                  sub={host.ok ? host.sequenceName : "no sequence open"}
                  onSelect={() => {
                    close();
                    if (isLinked) askToUnlink();
                    else askToLink();
                  }}
                />
                <div className="menu-rule" />
                <MenuAction
                  icon={<IconDownload width={14} height={14} />}
                  label="Download"
                  onSelect={() => {
                    close();
                    onDownload();
                  }}
                />
                <MenuAction
                  icon={<IconCopy width={14} height={14} />}
                  label="Copy Asset URL"
                  onSelect={() => {
                    close();
                    void copyText(assetUrl());
                  }}
                />
                <MenuAction
                  icon={<IconExternal width={14} height={14} />}
                  label="Open in browser"
                  onSelect={() => {
                    close();
                    openLinkInBrowser(assetUrl());
                  }}
                />
                <div className="menu-rule" />
                <MenuAction
                  icon={<IconRename width={14} height={14} />}
                  label="Rename"
                  onSelect={() => {
                    close();
                    setRenaming(true);
                  }}
                />
                <MenuAction
                  danger
                  icon={<IconTrash width={14} height={14} />}
                  label="Delete"
                  onSelect={() => {
                    close();
                    setConfirming({
                      title: "Delete asset",
                      body: `"${name}" moves to the project trash. You can restore it from the FreeFrame web app.`,
                      confirmLabel: "Delete",
                      danger: true,
                      onConfirm: onDelete,
                    });
                  }}
                />
              </>
            )}
          </Dropdown>
        )}
        <Dropdown
          align="left"
          triggerClass="version-trigger"
          title="Versions"
          trigger={
            <>
              v{versions.find((v) => v.id === versionId)?.version_number ?? 1}
              <IconChevronDown width={12} height={12} />
            </>
          }
        >
          {(close) => (
            <div className="version-list">
              {[...versions].reverse().map((version) => {
                const isLatest = version.id === asset.latest_version?.id;
                return (
                  <button
                    key={version.id}
                    className={`version-row${version.id === versionId ? " on" : ""}`}
                    onClick={() => {
                      setVersionId(version.id);
                      close();
                    }}
                  >
                    <em className="badge version">v{version.version_number}</em>
                    <span className="version-thumb">
                      {/* Only the newest version has a thumbnail URL in the
                          API; older ones fall back to the film glyph. */}
                      {isLatest && asset.thumbnail_url ? (
                        <img src={asset.thumbnail_url} alt="" />
                      ) : (
                        <IconFilm width={14} height={14} />
                      )}
                    </span>
                    <span className="version-meta">
                      <strong>{name}</strong>
                      <span>{shortDate(version.created_at)}</span>
                    </span>
                    {version.id === versionId && (
                      <IconCheck width={13} height={13} className="version-check" />
                    )}
                  </button>
                );
              })}
            </div>
          )}
        </Dropdown>

        <span className="spacer" />

        <button className="chip with-icon" onClick={() => setSharing(true)}>
          <IconShare width={13} height={13} />
          Share
        </button>
        <button
          className="primary icon-btn"
          onClick={onExport}
          title="Export the active sequence"
        >
          <IconPlus width={15} height={15} />
        </button>
      </nav>

      <div className={`review${wide ? " wide" : ""}`} ref={reviewRef}>
        <div className="review-main">
          {isVideo && versionId && (
            <Player
              ref={playerRef}
              api={api}
              assetId={asset.id}
              versionId={versionId}
              comments={comments}
              fps={host.fps}
              annotation={activeAnnotation}
              selectedTimeRange={selectedTimeRange}
              onSelectedTimeRangeChange={setSelectedTimeRange}
              onTimeUpdate={setVideoTime}
              onSelectComment={jumpTo}
            />
          )}

        </div>

        {wide && (
          <div className="splitter" onMouseDown={onSplitterDown} title="Drag to resize" />
        )}

        <div
          className="review-side"
          style={wide ? { flex: `0 0 ${sideWidth}px` } : undefined}
        >
          <div className="side-head">
            {searching ? (
              <>
                <div className="field">
                  <IconSearch />
                  <input
                    type="search"
                    placeholder="Search comments…"
                    value={query}
                    autoFocus
                    onChange={(e) => setQuery(e.target.value)}
                  />
                </div>
                <button
                  className="text-btn"
                  onClick={() => {
                    setSearching(false);
                    setQuery("");
                  }}
                >
                  Cancel
                </button>
              </>
            ) : (
              <>
                <span className="side-title">
                  All comments <em>{openCount}</em>
                </span>
                <button
                  className={`icon-btn${markersOn ? " accented" : ""}`}
                  onClick={toggleMarkers}
                  disabled={busy || !host.ok}
                  title={
                    markersOn
                      ? "Hide FreeFrame markers on the timeline"
                      : "Show comments as markers on the timeline"
                  }
                >
                  <IconMarker />
                </button>
                <button
                  className={`icon-btn${annotationsOn ? " accented" : ""}`}
                  onClick={() =>
                    updateSettings({ annotationsVisible: !annotationsOn })
                  }
                  title={
                    annotationsOn
                      ? "Hide annotations over the video"
                      : "Show annotations over the video"
                  }
                >
                  <IconAnnotation />
                </button>
                <Dropdown trigger={<IconFilter />} title="Filter by…" active={filtersOn}>
                  {() => (
                    <>
                      <MenuCheck
                        label="Annotations"
                        icon={<IconAnnotation width={13} height={13} />}
                        checked={filters.annotations}
                        onChange={(value) =>
                          setFilters({ ...filters, annotations: value })
                        }
                      />
                      <MenuCheck
                        label="Attachments"
                        icon={<IconAttachment width={13} height={13} />}
                        checked={filters.attachments}
                        onChange={(value) =>
                          setFilters({ ...filters, attachments: value })
                        }
                      />
                      <MenuCheck
                        label="Completed"
                        icon={<IconCheckCircle width={13} height={13} />}
                        checked={filters.completed}
                        onChange={(value) =>
                          setFilters({ ...filters, completed: value, incomplete: false })
                        }
                      />
                      <MenuCheck
                        label="Incomplete"
                        icon={<IconCircle width={13} height={13} />}
                        checked={filters.incomplete}
                        onChange={(value) =>
                          setFilters({ ...filters, incomplete: value, completed: false })
                        }
                      />
                      {people.length > 1 && (
                        <>
                          <div className="menu-sep">Person</div>
                          {people.map((person) => (
                            <MenuRadio
                              key={person}
                              label={person}
                              checked={filters.person === person}
                              onSelect={() =>
                                setFilters({
                                  ...filters,
                                  person: filters.person === person ? "" : person,
                                })
                              }
                            />
                          ))}
                        </>
                      )}
                      <button className="menu-foot" onClick={() => setFilters(NO_FILTERS)}>
                        Clear Filters
                      </button>
                    </>
                  )}
                </Dropdown>
                <Dropdown trigger={<IconSort />} title="Sort thread by…">
                  {(close) =>
                    SORTS.map((option) => (
                      <MenuRadio
                        key={option.key}
                        label={option.label}
                        checked={sort === option.key}
                        onSelect={() => {
                          setSort(option.key);
                          close();
                        }}
                      />
                    ))
                  }
                </Dropdown>
                <button
                  className="icon-btn"
                  onClick={() => setSearching(true)}
                  title="Search comments"
                >
                  <IconSearch />
                </button>
                <span className="stepper">
                  <button
                    className="icon-btn"
                    onClick={() => step(-1)}
                    disabled={!timed.length}
                    title="Previous comment"
                  >
                    <IconChevronUp width={14} height={14} />
                  </button>
                  <button
                    className="icon-btn"
                    onClick={() => step(1)}
                    disabled={!timed.length}
                    title="Next comment"
                  >
                    <IconChevronDown width={14} height={14} />
                  </button>
                </span>
              </>
            )}
          </div>

          {error && <p className="error">{error}</p>}

          <ul className="comments" ref={listRef}>
            {visible.map((comment) => (
              <CommentItem
                key={comment.id}
                comment={comment}
                active={comment.id === activeId}
                isRead={readIds.has(comment.id)}
                user={user}
                index={indexOf.get(comment.id)}
                justRead={justRead.has(comment.id)}
                onToggleDone={() => onToggleDone(comment)}
                fps={host.fps}
                onDeleteAttachment={(attachmentId) => onDeleteAttachment(comment.id, attachmentId)}
                onDeleteReplyAttachment={onDeleteAttachment}
                onReact={(emoji) => onReact(comment, emoji)}
                onReply={() => setReplyTo(replyTo === comment.id ? null : comment.id)}
                onOpen={() => openLinkInBrowser(assetUrl(comment.id))}
                onDelete={() => setConfirming({ title: "Delete comment", body: "This comment will be removed from the review.", confirmLabel: "Delete", danger: true, onConfirm: () => onDeleteComment(comment) })}
                replyTo={replyTo}
                replyDraft={replyDraft}
                replyAttachment={replyAttachment}
                onReplyDraftChange={setReplyDraft}
                onReplyAttachmentChange={(file) => {
                  if (!file) return setReplyAttachment(null);
                  const validationError = validateCommentAttachment(file);
                  if (validationError) return setError(validationError);
                  setError(""); setReplyAttachment(file);
                }}
                onReplySubmit={() => onReply(comment.id)}
                onSelect={() => jumpTo(comment)}
              />
            ))}
            {!visible.length && (
              <li className="muted empty">
                {comments.length ? "No comments match." : "No comments on this version."}
              </li>
            )}
          </ul>

          <CommentComposer
            draft={draft}
            attachment={attachment}
            busy={busy}
            fps={host.fps}
            hasTimecode={hasTimecode}
            timecodeAttached={timecodeAttached}
            composerTime={composerTime}
            selectedTimeRange={selectedTimeRange}
            visibility={visibility}
            onDraftChange={setDraft}
            onAttachmentChange={(file) => {
              if (!file) {
                setAttachment(null);
                return;
              }
              const validationError = validateCommentAttachment(file);
              if (validationError) {
                setError(validationError);
                return;
              }
              setError("");
              setAttachment(file);
            }}
            onTimecodeAttachedChange={setTimecodeAttached}
            onSelectedTimeRangeChange={setSelectedTimeRange}
            onVisibilityChange={setVisibility}
            onPost={onPost}
          />
        </div>
      </div>
    </div>
  );
};
