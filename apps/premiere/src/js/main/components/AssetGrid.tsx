/** Second browse screen: folders and assets of one project, as cards. */
import { useCallback, useEffect, useMemo, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent } from "react";
import { useApp } from "../state";
import type { Asset, FolderNode, Project } from "../../lib/freeframe/types";
import { copyText } from "../../lib/freeframe/clipboard";
import type { UploadLocation } from "./LocationPicker";
import { formatDuration, shortDate } from "../../lib/freeframe/format";
import { Dropdown, MenuAction } from "./Dropdown";
import { AppearanceMenu, SortedByMenu, cardMinWidth } from "./BrowseControls";
import { openLinkInBrowser } from "../../lib/utils/bolt";
import { useProjectEvents } from "../../lib/freeframe/events";
import {
  clearLink,
  clearMarkers,
  getSegmentLinks,
  type AssetLink,
  type SegmentLink,
} from "../../lib/freeframe/host";
import { ConfirmDialog, type ConfirmRequest } from "./ConfirmDialog";
import { PromptDialog } from "./PromptDialog";
import { MoveAssetDialog } from "./MoveAssetDialog";
import { CollectionShareDialog } from "./share/CollectionShareDialog";
import { ShareDialog } from "./share/ShareDialog";
import { ScrubThumb } from "./ScrubThumb";
import {
  IconCheck,
  IconCloudUpload,
  IconClose,
  IconComment,
  IconCopy,
  IconDownload,
  IconShare,
  IconRename,
  IconExternal,
  IconFilm,
  IconMarker,
  IconMore,
  IconTrash,
  IconFolder,
  IconFolderFilled,
  IconHome,
  IconPlus,
  IconRefresh,
  IconSearch,
} from "./Icons";

/** Comment counts aren't on the asset list, so fetch a bounded few by hand. */
const COUNT_LIMIT = 24;
const COUNT_CONCURRENCY = 4;

type SortKey = "name" | "newest" | "oldest" | "duration";

const SORTS: { key: SortKey; label: string }[] = [
  { key: "name", label: "Name" },
  { key: "newest", label: "Date" },
  { key: "oldest", label: "Oldest" },
  { key: "duration", label: "Duration" },
];

interface Crumb {
  id: string | null;
  name: string;
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

/** "3 items · 2 folders", or "Empty". */
const folderSummary = (folder: FolderNode) => {
  const parts = [
    folder.item_count ? plural(folder.item_count, "item") : "",
    folder.children?.length ? plural(folder.children.length, "folder") : "",
  ].filter(Boolean);
  return parts.length ? parts.join(" · ") : "Empty";
};

const findNode = (nodes: FolderNode[], id: string): FolderNode | null => {
  for (const node of nodes) {
    if (node.id === id) return node;
    const hit = node.children ? findNode(node.children, id) : null;
    if (hit) return hit;
  }
  return null;
};

const durationOf = (asset: Asset) =>
  asset.latest_version?.files?.[0]?.duration_seconds ?? 0;

export const AssetGrid = ({
  project,
  onBack,
  onOpenAsset,
  onExport,
  link,
  onLinkChange,
}: {
  project: Project;
  onBack: () => void;
  onOpenAsset: (asset: Asset) => void;
  /** Opens the export dialog; passes the folder being browsed as the default destination. */
  onExport: (location?: UploadLocation) => void;
  /** The asset bound to the sequence open in Premiere, if it is in this grid. */
  link: AssetLink | null;
  onLinkChange: (link: AssetLink | null) => void;
}) => {
  const { api, settings, host, updateSettings, refreshHost } = useApp();
  const [tree, setTree] = useState<FolderNode[]>([]);
  const [crumbs, setCrumbs] = useState<Crumb[]>([{ id: null, name: "Assets" }]);
  const [assets, setAssets] = useState<Asset[]>([]);
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [sort, setSort] = useState<SortKey>("name");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [confirming, setConfirming] = useState<ConfirmRequest | null>(null);
  const [sharing, setSharing] = useState<Asset | null>(null);
  const [sharingCollection, setSharingCollection] = useState(false);
  const [renamingId, setRenamingId] = useState("");
  const [draftName, setDraftName] = useState("");
  const [segmentLinks, setSegmentLinks] = useState<SegmentLink[]>([]);
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [folderBusy, setFolderBusy] = useState(false);
  const [folderError, setFolderError] = useState("");
  const [movingAssets, setMovingAssets] = useState<Asset[]>([]);
  // Multi-select: Ctrl/Cmd-click toggles, Shift-click selects a range, and the
  // hover checkbox starts a selection without a modifier key.
  const [selected, setSelected] = useState<string[]>([]);
  const [anchorId, setAnchorId] = useState<string | null>(null);
  const [moveBusy, setMoveBusy] = useState(false);
  const [moveError, setMoveError] = useState("");

  const folderId = crumbs[crumbs.length - 1].id;

  // A selection belongs to one folder listing.
  useEffect(() => {
    setSelected([]);
    setAnchorId(null);
  }, [folderId]);
  const exportHere = () =>
    onExport({
      projectId: project.id,
      projectName: project.name,
      folderId,
      folderName: crumbs[crumbs.length - 1].name,
    });

  const load = useCallback(async (refresh = false) => {
    setLoading(true);
    setError("");
    try {
      const [folders, items] = await Promise.all([
        api.folderTree(project.id, refresh),
        api.assets(project.id, folderId ?? "root", refresh),
      ]);
      setTree(folders);
      setAssets(items);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [api, project.id, folderId]);

  useEffect(() => {
    load();
  }, [load]);

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

  // The thumbnail only exists once transcoding ends, which is well after the
  // upload returns — so listen for it instead of guessing at a delay.
  useProjectEvents(api, project.id, () => load(true));

  /**
   * Refresh when an export lands in this project. The second pass catches the
   * thumbnail, which only exists once the server finishes transcoding.
   */
  const latestExport = settings.exportHistory?.[0];
  useEffect(() => {
    if (!latestExport || latestExport.projectId !== project.id) return;
    load(true);
    const timer = setTimeout(() => load(true), 8000);
    return () => clearTimeout(timer);
  }, [latestExport?.uploadedAt, latestExport?.projectId, project.id, load]);

  /**
   * Comment counts for the badge. The API has no aggregate endpoint, so this
   * walks the newest versions a few at a time and gives up past COUNT_LIMIT
   * rather than firing a request per asset in a large folder.
   */
  useEffect(() => {
    let cancelled = false;
    const targets = assets
      .filter((asset) => asset.latest_version?.id)
      .slice(0, COUNT_LIMIT);
    if (!targets.length) return;

    (async () => {
      let cursor = 0;
      const worker = async () => {
        while (!cancelled && cursor < targets.length) {
          const asset = targets[cursor++];
          try {
            const list = await api.comments(asset.id, asset.latest_version!.id);
            if (cancelled) return;
            // Replies count too — the badge mirrors the thread total.
            const total = list.reduce(
              (sum, comment) => sum + 1 + (comment.replies?.length ?? 0),
              0
            );
            setCounts((current) => ({ ...current, [asset.id]: total }));
          } catch (e) {
            // A count is decoration; a failure just leaves the badge off.
          }
        }
      };
      await Promise.all(
        Array.from({ length: Math.min(COUNT_CONCURRENCY, targets.length) }, worker)
      );
    })();

    return () => {
      cancelled = true;
    };
  }, [api, assets]);

  const childFolders = useMemo(() => {
    if (!folderId) return tree;
    return findNode(tree, folderId)?.children ?? [];
  }, [tree, folderId]);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const filtered = needle
      ? assets.filter((asset) => asset.name.toLowerCase().includes(needle))
      : assets.slice();
    return filtered.sort((a, b) => {
      switch (sort) {
        case "newest":
          return b.created_at.localeCompare(a.created_at);
        case "oldest":
          return a.created_at.localeCompare(b.created_at);
        case "duration":
          return durationOf(b) - durationOf(a);
        default:
          return a.name.localeCompare(b.name);
      }
    });
  }, [assets, query, sort]);

  const assetUrl = (asset: Asset) =>
    `${(settings.webUrl || settings.serverUrl).replace(/\/+$/, "")}/projects/${
      asset.project_id
    }/assets/${asset.id}`;

  const onDownload = async (asset: Asset) => {
    try {
      openLinkInBrowser(await api.downloadUrl(asset.id));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const onRename = async (asset: Asset) => {
    const trimmed = draftName.trim();
    setRenamingId("");
    if (!trimmed || trimmed === asset.name) return;
    try {
      await api.renameAsset(asset.id, trimmed);
      await load(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const onCreateFolder = async (name: string) => {
    setFolderBusy(true);
    setFolderError("");
    try {
      await api.createFolder(project.id, name, folderId);
      setCreatingFolder(false);
      await load(true);
    } catch (e) {
      setFolderError(e instanceof Error ? e.message : String(e));
    } finally {
      setFolderBusy(false);
    }
  };

  const onMoveAsset = async (targetFolderId: string | null) => {
    const toMove = movingAssets.filter((asset) => asset.folder_id !== targetFolderId);
    if (!toMove.length) return;
    setMoveBusy(true);
    setMoveError("");
    try {
      for (const asset of toMove) {
        await api.moveAsset(asset.id, targetFolderId);
      }
      setMovingAssets([]);
      setSelected([]);
      await load(true);
    } catch (e) {
      setMoveError(e instanceof Error ? e.message : String(e));
    } finally {
      setMoveBusy(false);
    }
  };

  const onDelete = async (asset: Asset, reload = true) => {
    try {
      await api.deleteAsset(asset.id);
      if (link?.assetId === asset.id) {
        // The active sequence only contains FreeFrame markers for its linked
        // asset. Keep hand-made Premiere markers intact, then invalidate the
        // sequence link so the deleted asset cannot re-populate them.
        try {
          await clearMarkers();
        } finally {
          await clearLink();
          updateSettings({ markersVisible: false });
          onLinkChange(null);
          await refreshHost();
        }
      }
      if (reload) await load(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const selectedAssets = useMemo(
    () => visible.filter((asset) => selected.includes(asset.id)),
    [visible, selected]
  );

  const toggleSelected = (asset: Asset) => {
    setSelected((current) =>
      current.includes(asset.id) ? current.filter((id) => id !== asset.id) : [...current, asset.id]
    );
    setAnchorId(asset.id);
  };

  const onCardClick = (asset: Asset, event: ReactMouseEvent | ReactKeyboardEvent) => {
    if (event.shiftKey && anchorId) {
      const ids = visible.map((entry) => entry.id);
      const from = ids.indexOf(anchorId);
      const to = ids.indexOf(asset.id);
      if (from !== -1 && to !== -1) {
        const range = ids.slice(Math.min(from, to), Math.max(from, to) + 1);
        setSelected((current) => [...new Set([...current, ...range])]);
        return;
      }
    }
    if (event.ctrlKey || event.metaKey || selected.length > 0) {
      toggleSelected(asset);
      return;
    }
    onOpenAsset(asset);
  };

  useEffect(() => {
    if (!selected.length) return;
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea")) return;
      if (event.key === "Escape") setSelected([]);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [selected.length]);

  const deleteSelected = () => {
    const targets = selectedAssets;
    if (!targets.length) return;
    const plural = targets.length === 1 ? "" : "s";
    setConfirming({
      title: `Delete ${targets.length} asset${plural}`,
      body: `${targets.length} asset${plural} will move to the project trash. You can restore them from the FreeFrame web app.`,
      confirmLabel: "Delete",
      danger: true,
      onConfirm: async () => {
        for (const asset of targets) await onDelete(asset, false);
        setSelected([]);
        await load(true);
      },
    });
  };

  return (
    <div className="browse">
      <ConfirmDialog request={confirming} onClose={() => setConfirming(null)} />
      {creatingFolder && (
        <PromptDialog
          title="New folder"
          label="Folder name"
          placeholder="Untitled folder"
          confirmLabel="Create folder"
          busy={folderBusy}
          error={folderError}
          onConfirm={onCreateFolder}
          onCancel={() => {
            if (!folderBusy) {
              setCreatingFolder(false);
              setFolderError("");
            }
          }}
        />
      )}
      {movingAssets.length > 0 && (
        <MoveAssetDialog
          assetName={
            movingAssets.length === 1 ? movingAssets[0].name : `${movingAssets.length} assets`
          }
          count={movingAssets.length}
          tree={tree}
          currentFolderId={movingAssets[0].folder_id}
          busy={moveBusy}
          error={moveError}
          onMove={onMoveAsset}
          onClose={() => {
            if (!moveBusy) {
              setMovingAssets([]);
              setMoveError("");
            }
          }}
        />
      )}
      {sharing && (
        <ShareDialog
          asset={sharing}
          onClose={() => setSharing(null)}
          onRenamed={() => load(true)}
        />
      )}
      {sharingCollection && (
        <CollectionShareDialog
          projectId={project.id}
          folderId={folderId}
          name={crumbs[crumbs.length - 1].name}
          onClose={() => setSharingCollection(false)}
        />
      )}

      <nav className="navbar">
        <button className="icon-btn" onClick={onBack} title="All projects">
          <IconHome width={15} height={15} />
        </button>
        <div className="crumbs">
          {crumbs.map((crumb, index) => (
            <span key={crumb.id ?? "root"} className="crumb-slot">
              <span className="sep">/</span>
              <button
                className="crumb"
                disabled={index === crumbs.length - 1}
                onClick={() => setCrumbs(crumbs.slice(0, index + 1))}
              >
                {index === 0 ? project.name : crumb.name}
              </button>
            </span>
          ))}
        </div>
        <span className="spacer" />
        <button
          className="chip with-icon"
          onClick={() => setSharingCollection(true)}
          title={folderId ? "Share this folder" : "Share this project"}
        >
          <IconShare width={13} height={13} />
          Share
        </button>
        <button
          className="primary icon-btn"
          onClick={() => setCreatingFolder(true)}
          title={`Create folder${folderId ? " in this folder" : ""}`}
        >
          <IconFolder width={15} height={15} />
        </button>
        <button
          className="primary icon-btn"
          onClick={exportHere}
          title="Export the active sequence here"
        >
          <IconPlus width={15} height={15} />
        </button>
      </nav>

      <div className="view-bar">
        {selected.length > 0 ? (
          <div className="selection-bar">
            <strong>{selected.length} selected</strong>
            <span className="spacer" />
            <button
              className="chip"
              onClick={() => setSelected(visible.map((asset) => asset.id))}
              disabled={selected.length === visible.length}
            >
              Select all
            </button>
            <button
              className="chip with-icon"
              onClick={() => {
                setMoveError("");
                setMovingAssets(selectedAssets);
              }}
            >
              <IconFolder width={13} height={13} />
              Move
            </button>
            <button className="chip with-icon danger" onClick={deleteSelected}>
              <IconTrash width={13} height={13} />
              Delete
            </button>
            <button className="icon-btn" title="Clear selection (Esc)" onClick={() => setSelected([])}>
              <IconClose width={15} height={15} />
            </button>
          </div>
        ) : searching ? (
          <>
            <div className="field">
              <IconSearch />
              <input
                type="search"
                placeholder={`Search in ${project.name}`}
                value={query}
                autoFocus
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") {
                    setQuery("");
                    setSearching(false);
                  }
                }}
              />
            </div>
            <button
              className="icon-btn"
              title="Close search"
              onClick={() => {
                setQuery("");
                setSearching(false);
              }}
            >
              <IconClose width={15} height={15} />
            </button>
          </>
        ) : (
          <>
            <AppearanceMenu />
            <span className="bar-sep" />
            <SortedByMenu options={SORTS} value={sort} onChange={setSort} />
            <span className="spacer" />
            <button
              className="icon-btn"
              onClick={() => setSearching(true)}
              title="Search"
            >
              <IconSearch />
            </button>
            <button className="icon-btn" onClick={() => load(true)} title="Refresh">
              <IconRefresh />
            </button>
          </>
        )}
      </div>

      {error && <p className="error">{error}</p>}
      {loading && <p className="muted">Loading…</p>}

      {childFolders.length > 0 && (
        <div className="folder-grid">
          {childFolders.map((folder) => (
            <button
              key={folder.id}
              className="folder-tile"
              title={folder.name}
              onClick={() => setCrumbs([...crumbs, { id: folder.id, name: folder.name }])}
            >
              <span className="folder-tile-icon">
                <IconFolderFilled width={20} height={20} />
              </span>
              <span className="folder-tile-meta">
                <span className="folder-tile-name">{folder.name}</span>
                <span className="folder-tile-sub">{folderSummary(folder)}</span>
              </span>
            </button>
          ))}
        </div>
      )}

      <div
        className="card-grid assets"
        style={{
          gridTemplateColumns: `repeat(auto-fill, minmax(min(100%, ${cardMinWidth(
            settings.cardSize
          )}px), 1fr))`,
        }}
      >
        {visible.map((asset) => {
          const duration = durationOf(asset);
          const version = asset.latest_version?.version_number ?? 1;
          const isSelected = selected.includes(asset.id);
          const isSequenceLinked =
            link?.assetId === asset.id || segmentLinks.some((segment) => segment.assetId === asset.id);
          return (
            <div
              key={asset.id}
              className={`card${isSelected ? " selected" : ""}${selected.length ? " selecting" : ""}`}
              role="button"
              tabIndex={0}
              aria-pressed={selected.length ? isSelected : undefined}
              onClick={(event) => onCardClick(asset, event)}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") onCardClick(asset, event);
              }}
            >
              <span
                className="card-check"
                role="checkbox"
                aria-checked={isSelected}
                title={isSelected ? "Deselect" : "Select"}
                onClick={(event) => {
                  event.stopPropagation();
                  if (event.shiftKey) onCardClick(asset, event);
                  else toggleSelected(asset);
                }}
              >
                {isSelected && <IconCheck width={11} height={11} />}
              </span>
              <span className="poster asset-poster">
                <ScrubThumb
                  api={api}
                  assetId={asset.id}
                  versionId={asset.latest_version?.id}
                  thumbnailUrl={asset.thumbnail_url}
                >
                  {!asset.thumbnail_url && (
                    <span className="poster-fallback">
                      <IconFilm width={22} height={22} />
                    </span>
                  )}
                  {!!counts[asset.id] && (
                    <em className="badge count">
                      <IconComment width={11} height={11} />
                      {counts[asset.id]}
                    </em>
                  )}
                  {duration > 0 && (
                    <em className="badge time">{formatDuration(duration)}</em>
                  )}
                  <span className="badge-row">
                    {version > 1 && <em className="badge version">v{version}</em>}
                    {isSequenceLinked && (
                      <em
                        className="badge linked"
                        title="Linked to the sequence open in Premiere"
                      >
                        <IconMarker width={12} height={12} />
                      </em>
                    )}
                  </span>
                </ScrubThumb>
              </span>
              <span className="card-foot">
                {renamingId === asset.id ? (
                  <input
                    className="card-rename"
                    value={draftName}
                    autoFocus
                    onClick={(event) => event.stopPropagation()}
                    onChange={(event) => setDraftName(event.target.value)}
                    onBlur={() => onRename(asset)}
                    onKeyDown={(event) => {
                      // The parent card treats Space as "open". Keep the
                      // keystroke inside the text field so Premiere never
                      // receives it as its play/pause shortcut either.
                      event.stopPropagation();
                      if (event.key === " ") {
                        event.preventDefault();
                        const input = event.currentTarget;
                        const start = input.selectionStart ?? input.value.length;
                        const end = input.selectionEnd ?? start;
                        setDraftName((current) =>
                          `${current.slice(0, start)} ${current.slice(end)}`
                        );
                        requestAnimationFrame(() => input.setSelectionRange(start + 1, start + 1));
                        return;
                      }
                      if (event.key === "Enter") onRename(asset);
                      if (event.key === "Escape") setRenamingId("");
                    }}
                  />
                ) : (
                  <span className="card-title">{asset.name}</span>
                )}
                <span className="card-sub">
                  v{version} ·{" "}
                  {shortDate(asset.updated_at || asset.created_at)}
                </span>
              </span>
              <span className="card-menu-slot">
                <Dropdown
                  up
                  triggerClass="card-menu"
                  trigger={<IconMore width={15} height={15} />}
                >
                  {(close) => (
                    <>
                      <MenuAction
                        icon={<IconShare width={14} height={14} />}
                        label="Create Share Link"
                        onSelect={() => {
                          close();
                          setSharing(asset);
                        }}
                      />
                      <div className="menu-rule" />
                      <MenuAction
                        icon={<IconDownload width={14} height={14} />}
                        label="Download"
                        onSelect={() => {
                          close();
                          onDownload(asset);
                        }}
                      />
                      <MenuAction
                        icon={<IconCopy width={14} height={14} />}
                        label="Copy Asset URL"
                        onSelect={() => {
                          close();
                          void copyText(assetUrl(asset));
                        }}
                      />
                      <MenuAction
                        icon={<IconExternal width={14} height={14} />}
                        label="Open in browser"
                        onSelect={() => {
                          close();
                          openLinkInBrowser(assetUrl(asset));
                        }}
                      />
                      <div className="menu-rule" />
                      <MenuAction
                        icon={<IconRename width={14} height={14} />}
                        label="Rename"
                        onSelect={() => {
                          close();
                          setDraftName(asset.name);
                          setRenamingId(asset.id);
                        }}
                      />
                      <MenuAction
                        icon={<IconFolder width={14} height={14} />}
                        label="Move to folder"
                        onSelect={() => {
                          close();
                          setMoveError("");
                          setMovingAssets(
                            isSelected && selectedAssets.length > 1 ? selectedAssets : [asset]
                          );
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
                            body: `"${asset.name}" moves to the project trash. You can restore it from the FreeFrame web app.`,
                            confirmLabel: "Delete",
                            danger: true,
                            onConfirm: () => onDelete(asset),
                          });
                        }}
                      />
                    </>
                  )}
                </Dropdown>
              </span>
            </div>
          );
        })}
      </div>

      {!loading && !visible.length && !childFolders.length && (
        <div className="dropzone">
          <span className="dropzone-icon">
            <IconCloudUpload width={44} height={44} />
          </span>
          <p>
            {query.trim()
              ? "Nothing matches that search."
              : "Export your sequence to begin."}
          </p>
          {!query.trim() && (
            <button className="primary" onClick={exportHere} disabled={!host.ok}>
              {host.ok ? `Export ${host.sequenceName}` : "Open a sequence in Premiere"}
            </button>
          )}
        </div>
      )}
    </div>
  );
};
