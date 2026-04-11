"use client";

import * as React from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import useSWR from "swr";
import Link from "next/link";
import * as Dialog from "@radix-ui/react-dialog";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import {
  Upload,
  X,
  FolderOpen,
  Link as LinkIcon,
  Download,
  Share2,
  Plus,
  Trash2,
  ChevronDown,
  MessageSquare,
  FolderPlus,
  Folder as FolderIcon,
  FileText,
  MoreHorizontal,
  MinusCircle,
  ExternalLink,
  Users,
} from "lucide-react";
import { cn, formatRelativeTime, formatBytes } from "@/lib/utils";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Avatar } from "@/components/shared/avatar";
import { AssetGrid } from "@/components/projects/asset-grid";
import { CommentPanel } from "@/components/review/comment-panel";
import { UploadZone } from "@/components/upload/upload-zone";
import { useUploadStore } from "@/stores/upload-store";
import { useAuthStore } from "@/stores/auth-store";
import { useViewStore } from "@/stores/view-store";
import { useBreadcrumbStore } from "@/stores/breadcrumb-store";
import { useComments } from "@/hooks/use-comments";
import { useFolders, useTrash } from "@/hooks/use-folders";
import { useShareLinks } from "@/hooks/use-share-links";
import { FolderTree } from "@/components/projects/folder-tree";
import { ShareLinksTable } from "@/components/projects/share-links-table";
import {
  ShareLinkContent,
  ShareLinkSettingsPanel,
} from "@/components/projects/share-link-detail";
import { NameDialog } from "@/components/projects/name-dialog";
import { ShareCreateDialog } from "@/components/projects/share-create-dialog";
import { ProjectMembersDialog } from "@/components/projects/project-members-dialog";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { usePageTitle } from "@/hooks/use-page-title";
import type {
  Project,
  AssetResponse,
  ProjectMember,
  User,
  Folder,
  ShareLink,
} from "@/types";

export default function ProjectDetailPage() {
  const params = useParams();
  const router = useRouter();
  const searchParams = useSearchParams();
  const projectId = params.id as string;

  const [uploadOpen, setUploadOpen] = React.useState(false);
  const [assetName, setAssetName] = React.useState("");
  const [pendingFiles, setPendingFiles] = React.useState<File[]>([]);
  const [selectedAsset, setSelectedAsset] =
    React.useState<AssetResponse | null>(null);
  const [shareLinksExpanded, setShareLinksExpanded] = React.useState(true);
  const [rightTab, setRightTab] = React.useState<"comments" | "fields">(
    "comments",
  );
  const { rightPanelOpen } = useViewStore();

  const [currentFolderId, setCurrentFolderId] = React.useState<string | null>(
    searchParams.get("folder") || null,
  );
  const [showTrash, setShowTrash] = React.useState(false);
  const [showShareLinks, setShowShareLinks] = React.useState(false);
  const [selectedShareLink, setSelectedShareLink] = React.useState<
    string | null
  >(null);
  const [folderDialogOpen, setFolderDialogOpen] = React.useState(false);
  const [folderDialogParentId, setFolderDialogParentId] = React.useState<
    string | null
  >(null);
  const [shareDialogOpen, setShareDialogOpen] = React.useState(false);
  const [shareDialogPreselect, setShareDialogPreselect] = React.useState<{
    type: "folder" | "asset";
    id: string;
    name: string;
  } | null>(null);
  const [shareDialogPreselectedItems, setShareDialogPreselectedItems] = React.useState<
    { type: "folder" | "asset"; id: string; name: string }[]
  >([]);
  const [shareDialogResult, setShareDialogResult] = React.useState<{
    token: string;
    title: string;
    itemType: "asset" | "folder";
    thumbnailUrl: string | null;
    assetId?: string | null;
    folderId?: string | null;
    projectId?: string | null;
  } | null>(null);
  const [shareMode, setShareMode] = React.useState(false);
  const [membersDialogOpen, setMembersDialogOpen] = React.useState(false);
  const [pendingBulkDelete, setPendingBulkDelete] = React.useState<{
    assetIds: string[];
    folderIds: string[];
  } | null>(null);
  const [assetToRename, setAssetToRename] = React.useState<AssetResponse | null>(null);
  const [assetToDelete, setAssetToDelete] = React.useState<AssetResponse | null>(null);

  const { files: uploadFiles, startUpload } = useUploadStore();
  const { user } = useAuthStore();

  const {
    tree,
    mutateTree,
    createFolder,
    renameFolder,
    moveFolder,
    deleteFolder,
    moveAsset,
    bulkMove,
    restoreAsset,
    restoreFolder,
  } = useFolders(projectId);

  const { trash, mutateTrash } = useTrash(projectId);
  const {
    shareLinks,
    toggleEnabled,
    deleteShareLink,
    createFolderShare,
    mutateShareLinks,
  } = useShareLinks(projectId);

  // Comments for the selected asset
  const selectedVersionId = selectedAsset?.latest_version?.id || null;
  const {
    comments,
    resolveComment,
    deleteComment,
    addReaction,
    removeReaction,
  } = useComments(selectedAsset?.id || null, selectedVersionId);

  const { data: project, isLoading: loadingProject } = useSWR<Project>(
    `/projects/${projectId}`,
    () => api.get<Project>(`/projects/${projectId}`),
  );

  // Register project name for header breadcrumb + page title
  usePageTitle(project?.name ?? null);
  const setLabel = useBreadcrumbStore((s) => s.setLabel);
  const setExtraCrumbs = useBreadcrumbStore((s) => s.setExtraCrumbs);
  React.useEffect(() => {
    if (project?.name) setLabel(projectId, project.name);
  }, [project?.name, projectId, setLabel]);

  // Push folder path as extra breadcrumb crumbs when navigating folders
  React.useEffect(() => {
    if (!currentFolderId || !tree) {
      setExtraCrumbs([]);
      return;
    }
    // Walk the tree to collect path nodes (id + name) to currentFolderId
    function findPath(
      nodes: typeof tree,
      targetId: string,
      trail: { id: string; name: string }[],
    ): { id: string; name: string }[] | null {
      for (const node of nodes) {
        const newTrail = [...trail, { id: node.id, name: node.name }]
        if (node.id === targetId) return newTrail
        const found = findPath(node.children, targetId, newTrail)
        if (found) return found
      }
      return null
    }
    const path = findPath(tree, currentFolderId, []) ?? []
    setExtraCrumbs(
      path.map((f) => ({ label: f.name, href: `/projects/${projectId}?folder=${f.id}` }))
    );
  }, [currentFolderId, tree, projectId, setExtraCrumbs]);

  const folderParam = currentFolderId
    ? `folder_id=${currentFolderId}`
    : "folder_id=root";
  const {
    data: assets,
    isLoading: loadingAssets,
    mutate: mutateAssets,
  } = useSWR<AssetResponse[]>(
    showTrash ? null : `/projects/${projectId}/assets?${folderParam}`,
    (key: string) => api.get<AssetResponse[]>(key),
  );

  // Subfolders for current view
  const { data: subfolders, mutate: mutateSubfolders } = useSWR<Folder[]>(
    showTrash
      ? null
      : `/projects/${projectId}/folders?parent_id=${currentFolderId ?? "root"}`,
    (key: string) => api.get<Folder[]>(key),
  );

  const thumbnails = React.useMemo(() => {
    if (!assets) return {};
    const map: Record<string, string> = {};
    for (const a of assets) {
      if (a.thumbnail_url) map[a.id] = a.thumbnail_url;
    }
    return map;
  }, [assets]);

  const versionCounts = React.useMemo(() => {
    if (!assets) return {};
    const map: Record<string, number> = {};
    for (const a of assets) {
      if (a.latest_version) map[a.id] = a.latest_version.version_number;
    }
    return map;
  }, [assets]);

  const fileSizes = React.useMemo(() => {
    if (!assets) return {};
    const map: Record<string, number> = {};
    for (const a of assets) {
      if (a.latest_version?.files?.length) {
        map[a.id] = a.latest_version.files.reduce(
          (sum, f) => sum + (f.file_size_bytes || 0),
          0,
        );
      }
    }
    return map;
  }, [assets]);

  // Fetch user info for asset authors
  const authorIds = React.useMemo(() => {
    if (!assets) return [];
    return Array.from(new Set(assets.map((a) => a.created_by)));
  }, [assets]);

  const { data: authorUsers } = useSWR<User[]>(
    authorIds.length > 0 ? `/users?ids=${authorIds.join(",")}` : null,
    () => api.get<User[]>(`/users?ids=${authorIds.join(",")}`),
  );

  const authorNames = React.useMemo(() => {
    const map: Record<string, string> = {};
    if (authorUsers) {
      for (const u of authorUsers) map[u.id] = u.name;
    }
    // Fallback: current user
    if (user) map[user.id] = user.name;
    return map;
  }, [authorUsers, user]);

  const { data: members } = useSWR<ProjectMember[]>(
    `/projects/${projectId}/members`,
    () => api.get<ProjectMember[]>(`/projects/${projectId}/members`),
  );

  const assigneeIds = React.useMemo(() => {
    if (!assets) return [];
    const ids = assets.map((a) => a.assignee_id).filter(Boolean) as string[];
    return Array.from(new Set(ids));
  }, [assets]);

  const { data: assigneeUsers } = useSWR<User[]>(
    assigneeIds.length > 0 ? `/users?ids=${assigneeIds.join(",")}` : null,
    () => api.get<User[]>(`/users?ids=${assigneeIds.join(",")}`),
  );

  const assigneesMap: Record<string, User> = React.useMemo(() => {
    if (!assigneeUsers) return {};
    return Object.fromEntries(assigneeUsers.map((u) => [u.id, u]));
  }, [assigneeUsers]);

  // ─── Role-based permissions ───────────────────────────────────────────────
  const currentMember = members?.find((m) => m.user_id === user?.id);
  const currentRole = currentMember?.role ?? "viewer";
  // owner → Full Access, editor → Edit & Share, reviewer → Comment Only, viewer → View Only
  const canUpload = currentRole === "owner" || currentRole === "editor";
  const canCreateFolder = currentRole === "owner" || currentRole === "editor";
  const canShare = currentRole === "owner" || currentRole === "editor";
  const canManageMembers = currentRole === "owner";
  const canSeeShareLinks = currentRole === "owner" || currentRole === "editor";
  const canComment = currentRole !== "viewer";

  function openShareDialog(assetIds: string[], folderIds: string[]) {
    if (folderIds.length === 1 && assetIds.length === 0) {
      const folder = subfolders?.find((f) => f.id === folderIds[0]);
      setShareDialogPreselect({
        type: "folder",
        id: folderIds[0],
        name: folder?.name || "Shared Folder",
      });
      setShareDialogPreselectedItems([]);
    } else if (assetIds.length === 1 && folderIds.length === 0) {
      const asset = assets?.find((a) => a.id === assetIds[0]);
      setShareDialogPreselect({
        type: "asset",
        id: assetIds[0],
        name: asset?.name || "Shared Asset",
      });
      setShareDialogPreselectedItems([]);
    } else if (assetIds.length > 0 || folderIds.length > 0) {
      // Multiple items — build preselectedItems array
      setShareDialogPreselect(null);
      const items: { type: "folder" | "asset"; id: string; name: string }[] = [];
      for (const id of assetIds) {
        const asset = assets?.find((a) => a.id === id);
        if (asset) items.push({ type: "asset", id, name: asset.name });
      }
      for (const id of folderIds) {
        const folder = subfolders?.find((f) => f.id === id);
        if (folder) items.push({ type: "folder", id, name: folder.name });
      }
      setShareDialogPreselectedItems(items);
    } else {
      setShareDialogPreselect(null);
      setShareDialogPreselectedItems([]);
    }
    setShareDialogResult(null);
    setShareDialogOpen(true);
  }

  React.useEffect(() => {
    const anyComplete = uploadFiles.some(
      (f) => f.projectId === projectId && f.status === "complete",
    );
    if (anyComplete) {
      mutateAssets();
      mutateSubfolders();
    }
  }, [uploadFiles, mutateAssets, mutateSubfolders, projectId]);

  const handleFilesSelected = (files: File[]) => {
    setPendingFiles(files);
    if (files.length > 0) setAssetName(files[0].name.replace(/\.[^/.]+$/, ""));
  };

  const handleStartUpload = () => {
    pendingFiles.forEach((file) => {
      const name =
        pendingFiles.length === 1 ? assetName || file.name : file.name;
      // Note: startUpload does not yet accept folderId — assets will upload to root.
      // Upload store needs to be updated in a future task to support folder placement.
      startUpload(file, projectId, name, project?.name, currentFolderId);
    });
    setPendingFiles([]);
    setAssetName("");
    setUploadOpen(false);
  };

  const handleSelectFolder = React.useCallback(
    (folderId: string | null) => {
      setCurrentFolderId(folderId);
      setShowTrash(false);
      setShowShareLinks(false);
      setSelectedShareLink(null);
      const url = folderId
        ? `/projects/${projectId}?folder=${folderId}`
        : `/projects/${projectId}`;
      window.history.replaceState(null, "", url);
    },
    [projectId],
  );

  return (
    <div className="flex h-full flex-col lg:flex-row overflow-hidden">
      {/* ─── Left Sidebar (Frame.io style) ──────────────────────────────── */}
      <div className="hidden lg:flex w-72 flex-col border-r border-border bg-bg-secondary shrink-0">
        {/* Assets section */}
        <div className="p-3 space-y-0.5">
          <div className="flex items-center justify-between px-2 mb-1">
            <span className="text-2xs font-semibold text-text-tertiary uppercase tracking-wider">
              Assets
            </span>
            {canCreateFolder && (
              <button
                className="text-text-tertiary hover:text-text-primary transition-colors"
                onClick={() => {
                  setFolderDialogParentId(currentFolderId);
                  setFolderDialogOpen(true);
                }}
                title="New folder"
              >
                <Plus className="h-3.5 w-3.5" />
              </button>
            )}
          </div>

          {/* Project folder tree */}
          <FolderTree
            tree={tree}
            projectName={project?.name || "Project"}
            currentFolderId={currentFolderId}
            showTrash={showTrash}
            onSelectFolder={handleSelectFolder}
            onShowTrash={() => {
              setShowTrash(true);
              setCurrentFolderId(null);
              setShowShareLinks(false);
              setSelectedShareLink(null);
            }}
            onCreateFolder={async (_name, parentId) => {
              setFolderDialogParentId(parentId);
              setFolderDialogOpen(true);
            }}
            onRenameFolder={async (id, name) => {
              await renameFolder(id, name);
              mutateSubfolders();
            }}
            onDeleteFolder={async (id) => {
              await deleteFolder(id);
              if (currentFolderId === id) handleSelectFolder(null);
              mutateAssets();
              mutateSubfolders();
            }}
            onDropItems={async (targetFolderId, assetIds, folderIds) => {
              await bulkMove(assetIds, folderIds, targetFolderId);
              mutateAssets();
              mutateSubfolders();
            }}
          />
        </div>

        {/* Share Links section — only visible to owner/editor */}
        {canSeeShareLinks && <div className="px-3 py-2 border-t border-border">
          <div className="w-full flex items-center justify-between px-2 mb-1">
            <span
              className="text-2xs font-semibold text-text-tertiary uppercase tracking-wider cursor-pointer"
              onClick={() => setShareLinksExpanded(!shareLinksExpanded)}
            >
              Share Links
            </span>
            <div className="flex items-center gap-1">
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  setShowShareLinks(false);
                  setShowTrash(false);
                  openShareDialog([], []);
                }}
                className="text-text-tertiary hover:text-text-primary transition-colors"
                title="Create share link"
              >
                <Plus className="h-3.5 w-3.5" />
              </button>
              <button
                onClick={() => setShareLinksExpanded(!shareLinksExpanded)}
                className="text-text-tertiary hover:text-text-primary transition-colors"
              >
                <ChevronDown
                  className={cn(
                    "h-3 w-3 transition-transform",
                    !shareLinksExpanded && "-rotate-90",
                  )}
                />
              </button>
            </div>
          </div>

          {shareLinksExpanded && (
            <div className="space-y-0.5">
              <button
                onClick={() => {
                  setShowShareLinks(true);
                  setSelectedShareLink(null);
                  setShowTrash(false);
                  setCurrentFolderId(null);
                }}
                className={cn(
                  "w-full flex items-center gap-2 px-2 py-1.5 rounded text-sm transition-colors",
                  showShareLinks && !selectedShareLink
                    ? "bg-bg-hover text-text-primary"
                    : "text-text-secondary hover:bg-bg-hover hover:text-text-primary",
                )}
              >
                <LinkIcon className="h-4 w-4" />
                <span>All Share Links ({shareLinks.length})</span>
              </button>
              {shareLinks.map((link) => (
                <div
                  key={link.token}
                  className={cn(
                    "group w-full flex items-center gap-2 px-2 py-1.5 rounded text-sm transition-colors cursor-pointer",
                    selectedShareLink === link.token
                      ? "bg-bg-hover text-text-primary"
                      : "text-text-secondary hover:bg-bg-hover hover:text-text-primary",
                  )}
                  onClick={() => {
                    setShowShareLinks(true);
                    setSelectedShareLink(link.token);
                    setShowTrash(false);
                    setCurrentFolderId(null);
                  }}
                >
                  {link.share_type === "folder" ? (
                    <FolderIcon className="h-4 w-4 shrink-0" />
                  ) : (
                    <FileText className="h-4 w-4 shrink-0" />
                  )}
                  <span className="truncate flex-1">
                    {link.title || link.target_name}
                  </span>
                  <DropdownMenu.Root>
                    <DropdownMenu.Trigger asChild>
                      <button
                        className="h-5 w-5 flex items-center justify-center rounded text-text-tertiary hover:text-text-primary opacity-0 group-hover:opacity-100 transition-opacity shrink-0"
                        onClick={(e) => {
                          e.stopPropagation();
                        }}
                      >
                        <MoreHorizontal className="h-3.5 w-3.5" />
                      </button>
                    </DropdownMenu.Trigger>
                    <DropdownMenu.Portal>
                      <DropdownMenu.Content
                        className="z-50 min-w-[180px] rounded-xl border border-border bg-bg-secondary p-1 shadow-xl"
                        sideOffset={4}
                        align="end"
                      >
                        <DropdownMenu.Item
                          className="flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm text-text-secondary hover:bg-bg-hover hover:text-text-primary cursor-pointer outline-none transition-colors"
                          onSelect={() =>
                            window.open(
                              `${window.location.origin}/share/${link.token}`,
                              "_blank",
                            )
                          }
                        >
                          <ExternalLink className="h-4 w-4 text-text-tertiary" />
                          Open Share
                        </DropdownMenu.Item>
                        <DropdownMenu.Item
                          className="flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm text-text-secondary hover:bg-bg-hover hover:text-text-primary cursor-pointer outline-none transition-colors"
                          onSelect={() =>
                            navigator.clipboard.writeText(
                              `${window.location.origin}/share/${link.token}`,
                            )
                          }
                        >
                          <LinkIcon className="h-4 w-4 text-text-tertiary" />
                          Copy Link
                        </DropdownMenu.Item>
                        <DropdownMenu.Separator className="my-1 h-px bg-border" />
                        <DropdownMenu.Item
                          className="flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm text-text-secondary hover:bg-bg-hover hover:text-text-primary cursor-pointer outline-none transition-colors"
                          onSelect={() =>
                            toggleEnabled(link.token, !link.is_enabled)
                          }
                        >
                          <MinusCircle className="h-4 w-4 text-text-tertiary" />
                          {link.is_enabled ? "Disable Access" : "Enable Access"}
                        </DropdownMenu.Item>
                        <DropdownMenu.Item
                          className="flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm text-status-error hover:bg-status-error/10 cursor-pointer outline-none transition-colors"
                          onSelect={async () => {
                            await deleteShareLink(link.token);
                            if (selectedShareLink === link.token)
                              setSelectedShareLink(null);
                          }}
                        >
                          <Trash2 className="h-4 w-4" />
                          Delete
                        </DropdownMenu.Item>
                      </DropdownMenu.Content>
                    </DropdownMenu.Portal>
                  </DropdownMenu.Root>
                </div>
              ))}
            </div>
          )}
        </div>}

        {/* Spacer */}
        <div className="flex-1" />

        {/* Storage indicator — matches global sidebar bottom section (p-2 + space-y-1) */}
        {(() => {
          const used = project?.storage_bytes ?? 0;
          const limit = 10 * 1024 * 1024 * 1024; // 10 GB default limit
          const pct = limit > 0 ? Math.min((used / limit) * 100, 100) : 0;
          const isCritical = pct >= 90;
          const isWarning = pct >= 80;
          return (
            <div className="border-t border-border shrink-0 p-2 space-y-1">
              <div className="flex flex-col gap-1 px-2.5 py-1.5">
                <div className="flex items-center justify-between">
                  <span className="text-[11px] font-medium text-text-secondary">Storage</span>
                  <span className={cn(
                    "text-[10px] tabular-nums",
                    isCritical ? "text-status-error font-medium" : isWarning ? "text-amber-400 font-medium" : "text-text-tertiary",
                  )}>
                    {formatBytes(used)} / {formatBytes(limit)}
                  </span>
                </div>
                <div className="h-1 w-full rounded-full bg-bg-hover overflow-hidden">
                  <div
                    className={cn(
                      "h-full rounded-full transition-all duration-300",
                      isCritical ? "bg-status-error" : isWarning ? "bg-amber-400" : "bg-accent",
                    )}
                    style={{ width: `${Math.max(pct, 1)}%` }}
                  />
                </div>
              </div>
              <div className="h-5" />
            </div>
          );
        })()}
      </div>

      {/* ─── Main Content ───────────────────────────────────────────────── */}
      <div
        className="flex-1 flex flex-col min-w-0 bg-bg-primary h-full overflow-y-auto"
        onClick={() => setSelectedAsset(null)}
      >
        <div className="px-5 pt-3 pb-6 space-y-3">
          {/* Asset grid, Share links, or Trash view */}
          {showShareLinks && !selectedShareLink ? (
            <ShareLinksTable
              shareLinks={shareLinks}
              onSelectLink={(token) => setSelectedShareLink(token)}
              onToggleEnabled={(token, enabled) =>
                toggleEnabled(token, enabled)
              }
              onViewActivity={(token) => setSelectedShareLink(token)}
              frontendUrl={
                typeof window !== "undefined" ? window.location.origin : ""
              }
            />
          ) : showShareLinks && selectedShareLink ? (
            <ShareLinkContent
              token={selectedShareLink}
              projectId={projectId}
              onBack={() => setSelectedShareLink(null)}
              frontendUrl={
                typeof window !== "undefined" ? window.location.origin : ""
              }
              onUpdate={mutateShareLinks}
            />
          ) : showTrash ? (
            <div className="flex-1 overflow-y-auto">
              <h2 className="text-sm font-medium text-text-primary mb-3">
                Recently Deleted
              </h2>
              {trash.folders.length === 0 && trash.assets.length === 0 ? (
                <p className="text-xs text-text-tertiary">No deleted items</p>
              ) : (
                <div className="space-y-1">
                  {trash.folders.map((item) => (
                    <div
                      key={item.id}
                      className="flex items-center justify-between px-3 py-2 rounded-lg hover:bg-white/5"
                    >
                      <div className="flex items-center gap-2 min-w-0">
                        <FolderIcon className="h-4 w-4 text-text-tertiary shrink-0" />
                        <span className="text-sm text-text-primary truncate">
                          {item.name}
                        </span>
                        <span className="text-xs text-text-tertiary">
                          Folder
                        </span>
                      </div>
                      <button
                        className="text-xs text-accent hover:underline shrink-0"
                        onClick={async () => {
                          await restoreFolder(item.id);
                          mutateTrash();
                          mutateAssets();
                          mutateSubfolders();
                        }}
                      >
                        Restore
                      </button>
                    </div>
                  ))}
                  {trash.assets.map((item) => (
                    <div
                      key={item.id}
                      className="flex items-center justify-between px-3 py-2 rounded-lg hover:bg-white/5"
                    >
                      <div className="flex items-center gap-2 min-w-0">
                        <span className="text-sm text-text-primary truncate">
                          {item.name}
                        </span>
                        <span className="text-xs text-text-tertiary capitalize">
                          {item.type}
                        </span>
                      </div>
                      <button
                        className="text-xs text-accent hover:underline shrink-0"
                        onClick={async () => {
                          await restoreAsset(item.id);
                          mutateTrash();
                          mutateAssets();
                          mutateSubfolders();
                        }}
                      >
                        Restore
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ) : (
            <AssetGrid
              assets={assets ?? []}
              folders={subfolders ?? []}
              currentFolderId={currentFolderId}
              projectId={projectId}
              projectName={project?.name ?? 'Project'}
              folderTree={tree ?? []}
              isLoading={loadingAssets}
              assignees={assigneesMap}
              thumbnails={thumbnails}
              versionCounts={versionCounts}
              authorNames={authorNames}
              fileSizes={fileSizes}
              selectedAssetId={selectedAsset?.id}
              onUpload={() => setUploadOpen(true)}
              onAssetSelect={(asset, e) => {
                e?.stopPropagation();
                setSelectedAsset(asset as AssetResponse);
              }}
              onAssetOpen={(asset) =>
                router.push(`/projects/${projectId}/assets/${asset.id}`)
              }
              onFolderOpen={(folder) => handleSelectFolder(folder.id)}
              onFolderRename={async (id, name) => {
                await renameFolder(id, name);
                mutateSubfolders();
              }}
              onFolderDelete={async (id) => {
                await deleteFolder(id);
                mutateAssets();
                mutateSubfolders();
              }}
              onFolderShare={async (folderId, folderName) => {
                setShareDialogPreselect({
                  type: "folder",
                  id: folderId,
                  name: folderName,
                });
                setShareDialogOpen(true);
              }}
              onDropToFolder={async (targetFolderId, assetIds, folderIds) => {
                await bulkMove(assetIds, folderIds, targetFolderId);
                mutateAssets();
                mutateSubfolders();
              }}
              shareMode={false}
              onShareModeChange={setShareMode}
              onCreateShareLink={openShareDialog}
              onAssetShare={(asset) => {
                // Open dialog in configure phase — creation happens when user clicks "Create"
                setShareDialogPreselect({
                  type: "asset",
                  id: asset.id,
                  name: asset.name,
                });
                setShareDialogResult(null);
                setShareDialogOpen(true);
              }}
              onAssetDownload={async (asset) => {
                try {
                  const data = await api.get<{ url: string }>(
                    `/assets/${asset.id}/stream?download=true`,
                  );
                  if (data?.url) {
                    const iframe = document.createElement("iframe");
                    iframe.style.display = "none";
                    iframe.src = data.url;
                    document.body.appendChild(iframe);
                    setTimeout(() => iframe.remove(), 30000);
                  }
                } catch {}
              }}
              onAssetRename={(asset) => setAssetToRename(asset as AssetResponse)}
              onAssetDelete={(asset) => setAssetToDelete(asset as AssetResponse)}
              onBulkMove={async (assetIds, folderIds, targetFolderId) => {
                await bulkMove(assetIds, folderIds, targetFolderId);
                mutateAssets();
                mutateSubfolders();
                mutateTree();
              }}
              onBulkDelete={(assetIds, folderIds) => {
                setPendingBulkDelete({ assetIds, folderIds });
              }}
              onBulkDownload={async (assetIds, folderIds) => {
                function triggerDownload(url: string) {
                  const iframe = document.createElement("iframe");
                  iframe.style.display = "none";
                  iframe.src = url;
                  document.body.appendChild(iframe);
                  setTimeout(() => iframe.remove(), 30000);
                }

                async function downloadAsset(id: string) {
                  try {
                    const data = await api.get<{ url: string }>(
                      `/assets/${id}/stream?download=true`,
                    );
                    if (data?.url) {
                      triggerDownload(data.url);
                      await new Promise((r) => setTimeout(r, 300));
                    }
                  } catch {}
                }

                // Download selected assets
                for (const id of assetIds) {
                  await downloadAsset(id);
                }

                // Download assets from selected folders
                for (const folderId of folderIds) {
                  try {
                    const folderAssets = await api.get<AssetResponse[]>(
                      `/projects/${projectId}/assets?folder_id=${folderId}&skip=0&limit=100`,
                    );
                    for (const fa of folderAssets) {
                      await downloadAsset(fa.id);
                    }
                  } catch {}
                }
              }}
              actions={
                <>
                  {canManageMembers && (
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => setMembersDialogOpen(true)}
                    >
                      <Users className="h-4 w-4" />
                    </Button>
                  )}
                  {canShare && (
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => openShareDialog([], [])}
                    >
                      <Share2 className="h-4 w-4" />
                      Share
                    </Button>
                  )}
                  {canCreateFolder && (
                    <button
                      className="flex items-center gap-1.5 h-8 px-3 rounded-lg border border-border text-text-secondary hover:text-text-primary hover:bg-bg-hover text-[13px] transition-colors"
                      onClick={() => {
                        setFolderDialogParentId(currentFolderId);
                        setFolderDialogOpen(true);
                      }}
                    >
                      <FolderPlus className="h-4 w-4" />
                      New Folder
                    </button>
                  )}
                  {canUpload && (
                    <Button size="sm" onClick={() => setUploadOpen(true)}>
                      <Upload className="h-4 w-4" />
                      Upload
                    </Button>
                  )}
                </>
              }
            />
          )}

          {/* Upload dialog */}
          <Dialog.Root open={uploadOpen} onOpenChange={setUploadOpen}>
            <Dialog.Portal>
              <Dialog.Overlay className="fixed inset-0 z-40 bg-black/50 backdrop-blur-sm data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0" />
              <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-full max-w-lg -translate-x-1/2 -translate-y-1/2 rounded-xl border border-border bg-bg-secondary p-6 shadow-xl data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95">
                <Dialog.Close className="absolute right-4 top-4 text-text-tertiary hover:text-text-primary transition-colors">
                  <X className="h-4 w-4" />
                </Dialog.Close>
                <Dialog.Title className="text-base font-semibold text-text-primary">
                  Upload asset
                </Dialog.Title>
                <Dialog.Description className="mt-1 text-sm text-text-secondary">
                  Add new media to this project.
                </Dialog.Description>
                <div className="mt-4 space-y-4">
                  {pendingFiles.length === 0 ? (
                    <UploadZone onFilesSelected={handleFilesSelected} />
                  ) : (
                    <>
                      <div className="rounded-lg border border-border bg-bg-tertiary">
                        <div className="px-3 py-2 text-xs font-medium text-text-tertiary border-b border-border">
                          {pendingFiles.length} file{pendingFiles.length !== 1 ? "s" : ""} selected
                        </div>
                        <div className="max-h-40 overflow-y-auto divide-y divide-border">
                          {pendingFiles.map((f, i) => (
                            <div key={i} className="flex items-center justify-between px-3 py-1.5">
                              <span className="text-sm text-text-primary truncate mr-2">{f.name}</span>
                              <span className="text-xs text-text-tertiary shrink-0">
                                {f.size < 1024 * 1024
                                  ? `${(f.size / 1024).toFixed(0)} KB`
                                  : `${(f.size / (1024 * 1024)).toFixed(1)} MB`}
                              </span>
                            </div>
                          ))}
                        </div>
                      </div>
                      {pendingFiles.length === 1 && (
                        <Input
                          label="Asset name"
                          value={assetName}
                          onChange={(e) => setAssetName(e.target.value)}
                          placeholder="e.g. Hero Video Final"
                        />
                      )}
                      <div className="flex justify-end gap-2">
                        <Button
                          type="button"
                          variant="secondary"
                          size="sm"
                          onClick={() => setPendingFiles([])}
                        >
                          Change files
                        </Button>
                        <Button size="sm" onClick={handleStartUpload}>
                          Start upload
                        </Button>
                      </div>
                    </>
                  )}
                </div>
              </Dialog.Content>
            </Dialog.Portal>
          </Dialog.Root>
        </div>
      </div>

      {/* ─── Right Panel (Comments + Fields tabs, or Share Link Settings) ─ */}
      {rightPanelOpen && (
        <div className="hidden xl:flex w-[360px] flex-col border-l border-border bg-bg-secondary shrink-0">
          {showShareLinks && selectedShareLink ? (
            <ShareLinkSettingsPanel token={selectedShareLink} />
          ) : (
            <>
              {/* Tabs */}
              <div className="flex items-center border-b border-border">
                <button
                  onClick={() => setRightTab("comments")}
                  className={cn(
                    "flex-1 flex items-center justify-center gap-1.5 py-2.5 text-sm font-medium transition-colors border-b-2",
                    rightTab === "comments"
                      ? "border-accent text-text-primary"
                      : "border-transparent text-text-tertiary hover:text-text-secondary",
                  )}
                >
                  <MessageSquare className="h-4 w-4" />
                  Comments
                </button>
                <button
                  onClick={() => setRightTab("fields")}
                  className={cn(
                    "flex-1 flex items-center justify-center gap-1.5 py-2.5 text-sm font-medium transition-colors border-b-2",
                    rightTab === "fields"
                      ? "border-accent text-text-primary"
                      : "border-transparent text-text-tertiary hover:text-text-secondary",
                  )}
                >
                  Fields
                </button>
                {selectedAsset && (
                  <button
                    onClick={() => setSelectedAsset(null)}
                    className="px-3 text-text-tertiary hover:text-text-primary transition-colors"
                  >
                    <X className="h-4 w-4" />
                  </button>
                )}
              </div>

              {selectedAsset ? (
                rightTab === "comments" ? (
                  /* Comments tab — real comments */
                  <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
                    {comments.length > 0 ? (
                      <CommentPanel
                        comments={comments as any}
                        currentUserId={user?.id}
                        onResolve={resolveComment}
                        onDelete={deleteComment}
                        onAddReaction={addReaction}
                        onRemoveReaction={removeReaction}
                        onReply={() => {}}
                        onSubmitReply={async () => {}}
                      />
                    ) : (
                      <div className="flex-1 flex items-center justify-center p-6 text-center">
                        <div>
                          <div className="mx-auto mb-3 h-12 w-12 rounded-full bg-bg-tertiary flex items-center justify-center">
                            <MessageSquare className="h-6 w-6 text-text-tertiary/50" />
                          </div>
                          <p className="text-sm text-text-secondary">
                            No comments yet
                          </p>
                          <p className="text-xs text-text-tertiary mt-1">
                            Double-click the asset to open the viewer and leave
                            comments.
                          </p>
                        </div>
                      </div>
                    )}
                    {/* Quick link to open in viewer */}
                    <div className="border-t border-border p-3 shrink-0">
                      <Link
                        href={`/projects/${projectId}/assets/${selectedAsset.id}`}
                      >
                        <div className="rounded-lg border border-border bg-bg-tertiary px-3 py-2 text-sm text-text-tertiary cursor-pointer hover:border-border-focus transition-colors text-center">
                          Open in viewer to comment
                        </div>
                      </Link>
                    </div>
                  </div>
                ) : (
                  /* Fields tab */
                  <div className="flex-1 overflow-y-auto p-4 space-y-4">
                    {/* Thumbnail preview */}
                    <div className="aspect-video bg-bg-tertiary rounded-lg overflow-hidden border border-border flex items-center justify-center">
                      {selectedAsset.thumbnail_url ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={selectedAsset.thumbnail_url}
                          alt={selectedAsset.name}
                          className="h-full w-full object-cover"
                        />
                      ) : (
                        <span className="text-xs text-text-tertiary uppercase font-bold">
                          {selectedAsset.asset_type}
                        </span>
                      )}
                    </div>

                    <h4 className="text-sm font-semibold text-text-primary break-words">
                      {selectedAsset.name}
                    </h4>

                    <div className="space-y-3">
                      <div className="flex items-center justify-between">
                        <span className="text-xs text-text-tertiary">Type</span>
                        <span className="text-xs text-text-primary capitalize">
                          {selectedAsset.asset_type.replace("_", " ")}
                        </span>
                      </div>
                      <div className="flex items-center justify-between">
                        <span className="text-xs text-text-tertiary">
                          Uploaded
                        </span>
                        <span className="text-xs text-text-primary">
                          {formatRelativeTime(selectedAsset.created_at)}
                        </span>
                      </div>
                      {authorNames[selectedAsset.created_by] && (
                        <div className="flex items-center justify-between">
                          <span className="text-xs text-text-tertiary">
                            Uploaded by
                          </span>
                          <span className="text-xs text-text-primary">
                            {authorNames[selectedAsset.created_by]}
                          </span>
                        </div>
                      )}
                      {fileSizes[selectedAsset.id] != null && (
                        <div className="flex items-center justify-between">
                          <span className="text-xs text-text-tertiary">
                            File size
                          </span>
                          <span className="text-xs text-text-primary">
                            {formatBytes(fileSizes[selectedAsset.id])}
                          </span>
                        </div>
                      )}
                      {selectedAsset.latest_version && (
                        <div className="flex items-center justify-between">
                          <span className="text-xs text-text-tertiary">
                            Version
                          </span>
                          <span className="text-xs text-text-primary">
                            v{selectedAsset.latest_version.version_number}
                          </span>
                        </div>
                      )}
                      {selectedAsset.assignee_id &&
                        assigneesMap[selectedAsset.assignee_id] && (
                          <div className="flex items-center justify-between">
                            <span className="text-xs text-text-tertiary">
                              Assignee
                            </span>
                            <div className="flex items-center gap-1.5">
                              <Avatar size="sm" className="h-5 w-5" />
                              <span className="text-xs text-text-primary">
                                {assigneesMap[selectedAsset.assignee_id].name}
                              </span>
                            </div>
                          </div>
                        )}
                    </div>

                    <div className="pt-3 border-t border-border grid grid-cols-2 gap-2">
                      <Button asChild className="w-full col-span-2" size="sm">
                        <Link
                          href={`/projects/${projectId}/assets/${selectedAsset.id}`}
                        >
                          Open in Player
                        </Link>
                      </Button>
                      <Button
                        variant="secondary"
                        size="sm"
                        className="gap-1"
                        onClick={() => {
                          setShareDialogPreselect({
                            type: "asset",
                            id: selectedAsset.id,
                            name: selectedAsset.name,
                          });
                          setShareDialogOpen(true);
                        }}
                      >
                        <LinkIcon className="h-3.5 w-3.5" /> Share
                      </Button>
                      <Button
                        variant="secondary"
                        size="sm"
                        className="gap-1"
                        onClick={async () => {
                          try {
                            const res = await api.get<{ url: string }>(
                              `/assets/${selectedAsset.id}/stream?download=true`,
                            );
                            if (res.url) {
                              const iframe = document.createElement("iframe");
                              iframe.style.display = "none";
                              iframe.src = res.url;
                              document.body.appendChild(iframe);
                              setTimeout(() => iframe.remove(), 30000);
                            }
                          } catch {
                            // Silent fail
                          }
                        }}
                      >
                        <Download className="h-3.5 w-3.5" /> Download
                      </Button>
                    </div>
                  </div>
                )
              ) : (
                /* No asset selected */
                <div className="flex-1 flex items-center justify-center p-6 text-center">
                  <div>
                    <div className="mx-auto mb-3 h-16 w-16 rounded-full bg-bg-tertiary flex items-center justify-center">
                      <MessageSquare className="h-8 w-8 text-text-tertiary/50" />
                    </div>
                    <p className="text-sm text-text-secondary">
                      Select an asset to view comments
                    </p>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      )}

      {/* Create folder dialog */}
      <NameDialog
        open={folderDialogOpen}
        onOpenChange={setFolderDialogOpen}
        title="New Folder"
        placeholder="Folder name"
        submitLabel="Create"
        onSubmit={async (name) => {
          await createFolder(name, folderDialogParentId);
          mutateAssets();
          mutateSubfolders();
        }}
      />

      {/* Share create dialog */}
      <ShareCreateDialog
        open={shareDialogOpen}
        onOpenChange={(open) => {
          setShareDialogOpen(open);
          if (!open) {
            setShareDialogPreselect(null);
            setShareDialogPreselectedItems([]);
            setShareDialogResult(null);
          }
        }}
        projectId={projectId}
        currentFolderId={currentFolderId}
        assets={assets ?? []}
        folders={subfolders ?? []}
        preselectedItem={shareDialogPreselect}
        preselectedItems={shareDialogPreselectedItems}
        initialResult={shareDialogResult}
        onShareCreated={() => mutateShareLinks()}
        onAdvancedSettings={(token) => {
          setShowShareLinks(true);
          setSelectedShareLink(token);
          setShowTrash(false);
        }}
      />

      {/* Project members dialog */}
      <ProjectMembersDialog
        open={membersDialogOpen}
        onOpenChange={setMembersDialogOpen}
        projectId={projectId}
        projectName={project?.name ?? ""}
      />

      {/* Bulk delete confirmation */}
      <ConfirmDialog
        open={pendingBulkDelete !== null}
        onOpenChange={(open) => {
          if (!open) setPendingBulkDelete(null);
        }}
        title={`Delete ${(pendingBulkDelete?.assetIds.length ?? 0) + (pendingBulkDelete?.folderIds.length ?? 0)} item${(pendingBulkDelete?.assetIds.length ?? 0) + (pendingBulkDelete?.folderIds.length ?? 0) !== 1 ? "s" : ""}?`}
        description="This will move the selected items to the trash. You can restore them later from Recently Deleted."
        confirmLabel="Delete"
        variant="danger"
        onConfirm={async () => {
          if (!pendingBulkDelete) return;
          for (const id of pendingBulkDelete.folderIds) await deleteFolder(id);
          for (const id of pendingBulkDelete.assetIds)
            await api.delete(`/assets/${id}`);
          mutateAssets();
          mutateSubfolders();
          mutateTree();
          setPendingBulkDelete(null);
        }}
      />

      {/* Rename asset dialog */}
      <NameDialog
        open={assetToRename !== null}
        onOpenChange={(open) => { if (!open) setAssetToRename(null); }}
        title="Rename asset"
        defaultValue={assetToRename?.name ?? ""}
        placeholder="Asset name..."
        submitLabel="Rename"
        onSubmit={async (name) => {
          if (!assetToRename) return;
          try {
            await api.patch(`/assets/${assetToRename.id}`, { name });
            mutateAssets();
          } catch {}
          setAssetToRename(null);
        }}
      />

      {/* Delete asset confirmation */}
      <ConfirmDialog
        open={assetToDelete !== null}
        onOpenChange={(open) => { if (!open) setAssetToDelete(null); }}
        title={`Delete "${assetToDelete?.name}"?`}
        description="This will move the asset to the trash. You can restore it later from Recently Deleted."
        confirmLabel="Delete"
        variant="danger"
        onConfirm={async () => {
          if (!assetToDelete) return;
          try {
            await api.delete(`/assets/${assetToDelete.id}`);
            mutateAssets();
            if (selectedAsset?.id === assetToDelete.id) setSelectedAsset(null);
          } catch {}
          setAssetToDelete(null);
        }}
      />
    </div>
  );
}
