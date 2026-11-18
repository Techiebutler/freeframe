/** First browse screen: every project the user can reach, as cards. */
import { useEffect, useMemo, useState } from "react";
import { useApp } from "../state";
import type { Project } from "../../lib/freeframe/types";
import { copyText } from "../../lib/freeframe/clipboard";
import { formatBytes, gradientFor, relativeTime } from "../../lib/freeframe/format";
import { Dropdown, MenuAction } from "./Dropdown";
import { AppearanceMenu, SortedByMenu, cardMinWidth } from "./BrowseControls";
import { PromptDialog } from "./PromptDialog";
import { ConfirmDialog, type ConfirmRequest } from "./ConfirmDialog";
import { openLinkInBrowser, selectFile } from "../../lib/utils/bolt";
import { fs, path } from "../../lib/cep/node";
import {
  IconClose,
  IconCopy,
  IconExternal,
  IconFolder,
  IconMore,
  IconPlus,
  IconRefresh,
  IconSearch,
  IconTrash,
  IconUpload,
} from "./Icons";

type SortKey = "name" | "date";

const SORTS: { key: SortKey; label: string }[] = [
  { key: "date", label: "Date" },
  { key: "name", label: "Name" },
];

const posterMimeForPath = (filePath: string) => {
  switch (path.extname(filePath).toLowerCase()) {
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".png":
      return "image/png";
    case ".webp":
      return "image/webp";
    case ".gif":
      return "image/gif";
    default:
      return "";
  }
};

export const ProjectGrid = ({ onOpen }: { onOpen: (project: Project) => void }) => {
  const { api, settings } = useApp();
  const [sort, setSort] = useState<SortKey>("date");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState("");
  const [creatingBusy, setCreatingBusy] = useState(false);
  const [confirming, setConfirming] = useState<ConfirmRequest | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = async (refresh = false) => {
    setLoading(true);
    setError("");
    try {
      setProjects(await api.projects(refresh));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, [api]);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const filtered = needle
      ? projects.filter((project) => project.name.toLowerCase().includes(needle))
      : projects.slice();
    return filtered.sort((a, b) =>
      sort === "name"
        ? a.name.localeCompare(b.name)
        : b.created_at.localeCompare(a.created_at)
    );
  }, [projects, query, sort]);

  const projectUrl = (project: Project) =>
    `${(settings.webUrl || settings.serverUrl).replace(/\/+$/, "")}/projects/${project.id}`;

  const onCreate = async (name: string) => {
    setCreatingBusy(true);
    setCreateError("");
    try {
      const project = await api.createProject(name);
      setCreating(false);
      await load(true);
      onOpen(project);
    } catch (e) {
      setCreateError(e instanceof Error ? e.message : String(e));
    } finally {
      setCreatingBusy(false);
    }
  };

  const onDelete = async (project: Project) => {
    try {
      await api.deleteProject(project.id);
      await load(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const onSetPoster = (project: Project) => {
    selectFile("", "Choose project cover image", async (filePath) => {
      const mimeType = posterMimeForPath(filePath);
      if (!mimeType) {
        setError("Choose a JPEG, PNG, WebP, or GIF image.");
        return;
      }

      try {
        const bytes = fs.readFileSync(filePath);
        const file = new Blob([new Uint8Array(bytes)], { type: mimeType });
        const updated = await api.uploadProjectPoster(project.id, file, path.basename(filePath));
        setProjects((current) =>
          current.map((entry) => (entry.id === project.id ? { ...entry, ...updated } : entry))
        );
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    });
  };

  const onRemovePoster = async (project: Project) => {
    try {
      await api.removeProjectPoster(project.id);
      setProjects((current) =>
        current.map((entry) => (entry.id === project.id ? { ...entry, poster_url: null } : entry))
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="browse">
      <ConfirmDialog request={confirming} onClose={() => setConfirming(null)} />
      {creating && (
        <PromptDialog
          title="New project"
          label="Project name"
          placeholder="Untitled project"
          confirmLabel="Create"
          busy={creatingBusy}
          error={createError}
          onConfirm={onCreate}
          onCancel={() => {
            setCreating(false);
            setCreateError("");
          }}
        />
      )}

      <div className="view-bar">
        {searching ? (
          <>
            <div className="field">
              <IconSearch />
              <input
                type="search"
                placeholder={"Search projects"}
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

      <div
        className="card-grid projects"
        style={{
          gridTemplateColumns: `repeat(auto-fill, minmax(min(100%, ${cardMinWidth(
            settings.cardSize
          )}px), 1fr))`,
        }}
      >
        {visible.map((project) => (
          <div
            key={project.id}
            className="card"
            role="button"
            tabIndex={0}
            onClick={() => onOpen(project)}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") onOpen(project);
            }}
          >
            <span
              className="poster"
              style={
                project.poster_url
                  ? { backgroundImage: `url(${project.poster_url})` }
                  : { backgroundImage: gradientFor(project.id) }
              }
            >
              <span className="poster-scrim" />
              <span className="poster-name">{project.name}</span>
            </span>
            <span className="card-foot">
              <span className="card-sub">
                {project.asset_count ?? 0} asset{project.asset_count === 1 ? "" : "s"}
                {project.storage_bytes ? ` · ${formatBytes(project.storage_bytes)}` : ""}
              </span>
              <span className="card-sub">Updated {relativeTime(project.created_at)}</span>
            </span>
            <span className="card-menu-slot">
              <Dropdown up triggerClass="card-menu" trigger={<IconMore width={15} height={15} />}>
                {(close) => (
                  <>
                    <MenuAction
                      icon={<IconFolder width={14} height={14} />}
                      label="Open project"
                      onSelect={() => {
                        close();
                        onOpen(project);
                      }}
                    />
                    <MenuAction
                      icon={<IconExternal width={14} height={14} />}
                      label="Open in browser"
                      onSelect={() => {
                        close();
                        openLinkInBrowser(projectUrl(project));
                      }}
                    />
                    <MenuAction
                      icon={<IconCopy width={14} height={14} />}
                      label="Copy link"
                      onSelect={() => {
                        close();
                        void copyText(projectUrl(project));
                      }}
                    />
                    <MenuAction
                      icon={<IconUpload width={14} height={14} />}
                      label="Set cover image"
                      onSelect={() => {
                        close();
                        onSetPoster(project);
                      }}
                    />
                    {project.poster_url && (
                      <MenuAction
                        icon={<IconClose width={14} height={14} />}
                        label="Remove cover image"
                        onSelect={() => {
                          close();
                          onRemovePoster(project);
                        }}
                      />
                    )}
                    <div className="menu-rule" />
                    <MenuAction
                      danger
                      icon={<IconTrash width={14} height={14} />}
                      label="Delete"
                      onSelect={() => {
                        close();
                        setConfirming({
                          title: "Delete project",
                          body: `"${project.name}" and its ${
                            project.asset_count ?? 0
                          } asset(s) move to the trash. You can restore them from the FreeFrame web app.`,
                          confirmLabel: "Delete",
                          danger: true,
                          onConfirm: () => onDelete(project),
                        });
                      }}
                    />
                  </>
                )}
              </Dropdown>
            </span>
          </div>
        ))}
        {/* Same poster + footer structure as a real card, so the tile matches
            their height exactly when the grid wraps. */}
        <button className="card new-card" onClick={() => setCreating(true)}>
          <span className="poster new-poster">
            <span className="new-plus">
              <IconPlus width={20} height={20} />
            </span>
          </span>
          <span className="card-foot">
            <span className="card-title">New Project</span>
          </span>
        </button>
      </div>
    </div>
  );
};
