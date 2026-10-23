"use client";

import * as React from "react";
import {
  Check,
  Copy,
  Link2,
  Loader2,
  Share2,
  Plus,
  Search,
} from "lucide-react";
import { cn, copyToClipboard } from "@/lib/utils";
import { withBasePath } from "@/lib/base-path";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { useShareLinks } from "@/hooks/use-share-links";
import { ShareCreateDialog } from "@/components/projects/share-create-dialog";
import type { ShareLinkListItem, AssetResponse } from "@/types";

// ─── Share Dialog (Dropdown) ─────────────────────────────────────────────────

type AddResult =
  | { token: string; kind: "added" | "already" }
  | { token: string; kind: "error"; message: string };

function shareUrl(token: string) {
  return `${window.location.origin}${withBasePath(`/share/${token}`)}`;
}

interface ShareDialogProps {
  assetId: string;
  assetName?: string;
  projectId?: string;
  asset?: AssetResponse | null;
}

export function ShareDialog({
  assetId,
  assetName,
  projectId,
  asset,
}: ShareDialogProps) {
  const [dropdownOpen, setDropdownOpen] = React.useState(false);
  const [search, setSearch] = React.useState("");
  const [addingToToken, setAddingToToken] = React.useState<string | null>(null);
  const [addResult, setAddResult] = React.useState<AddResult | null>(null);
  const [copied, setCopied] = React.useState<{ token: string; ok: boolean } | null>(null);
  const [createDialogOpen, setCreateDialogOpen] = React.useState(false);
  const dropdownRef = React.useRef<HTMLDivElement>(null);
  const sectionId = React.useId();

  const { shareLinks, isLoading, mutateShareLinks } = useShareLinks(projectId ?? "", assetId);

  // Stable references for ShareCreateDialog props
  const stableAssets = React.useMemo(
    () => (asset ? [asset as AssetResponse] : []),
    [asset],
  );
  const emptyFolders = React.useMemo(() => [] as never[], []);
  const stablePreselectedItem = React.useMemo(
    () =>
      asset
        ? { type: "asset" as const, id: asset.id, name: asset.name }
        : { type: "asset" as const, id: assetId, name: assetName || "Asset" },
    [asset, assetId, assetName],
  );

  // Close dropdown on outside click
  React.useEffect(() => {
    if (!dropdownOpen) return;
    function handleClick(e: MouseEvent) {
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(e.target as Node)
      ) {
        setDropdownOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [dropdownOpen]);

  // Close dropdown on Escape
  React.useEffect(() => {
    if (!dropdownOpen) return;
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") setDropdownOpen(false);
    }
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [dropdownOpen]);

  const filteredLinks = React.useMemo(() => {
    if (!search.trim()) return shareLinks;
    const q = search.toLowerCase();
    return shareLinks.filter(
      (l) =>
        l.title.toLowerCase().includes(q) ||
        l.target_name.toLowerCase().includes(q),
    );
  }, [shareLinks, search]);

  // Links that already show this asset, directly or through a folder or the
  // whole project, are for copying: adding to them would change nothing.
  const currentLinks = filteredLinks.filter((l) => l.contains_asset);
  const otherLinks = filteredLinks.filter((l) => !l.contains_asset);

  async function handleCopy(link: ShareLinkListItem) {
    const ok = await copyToClipboard(shareUrl(link.token));
    setCopied({ token: link.token, ok });
    setTimeout(() => setCopied(null), 2000);
  }

  async function handleAddToLink(link: ShareLinkListItem) {
    setAddingToToken(link.token);
    setAddResult(null);
    try {
      const res = await api.post<{ added?: boolean }>(
        `/share/${link.token}/add-asset/${assetId}`,
        {},
      );
      setAddResult({ token: link.token, kind: res.added ? "added" : "already" });
      mutateShareLinks();
      setTimeout(() => setAddResult(null), 2000);
    } catch (err) {
      setAddResult({
        token: link.token,
        kind: "error",
        message: err instanceof Error ? err.message : "Could not add to this link",
      });
    } finally {
      setAddingToToken(null);
    }
  }

  function addStatus(token: string) {
    if (addResult?.token !== token) return null;
    if (addResult.kind === "error") {
      return (
        <p role="alert" className="text-[10px] text-status-error">
          {addResult.message}
        </p>
      );
    }
    return (
      <p className="text-[10px] text-status-success">
        {addResult.kind === "added" ? "Added to this link" : "Already in this link"}
      </p>
    );
  }

  function handleNewShareLink() {
    setDropdownOpen(false);
    setCreateDialogOpen(true);
  }

  return (
    <>
      <div className="relative" ref={dropdownRef}>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => setDropdownOpen(!dropdownOpen)}
          className={cn(
            dropdownOpen && "bg-bg-hover",
          )}
        >
          <Share2 className="h-4 w-4" />
          Share
        </Button>

        {dropdownOpen && (
          <div
            className={cn(
              "absolute right-0 top-full mt-1.5 z-50 w-80",
              "rounded-xl border border-border bg-bg-elevated shadow-xl",
              "animate-in fade-in-0 zoom-in-95 duration-150",
            )}
          >
            {/* New Share Link button */}
            <div className="p-2">
              <button
                onClick={handleNewShareLink}
                className="flex w-full items-center justify-center gap-2 rounded-lg bg-accent px-4 py-2.5 text-sm font-medium text-white hover:bg-accent/90 transition-colors"
              >
                <Plus className="h-4 w-4" />
                New Share Link
              </button>
            </div>

            {/* Divider + existing links */}
            {projectId && (
              <div className="border-t border-border">
                {/* Search (only if more than 3 links) */}
                {shareLinks.length > 3 && (
                  <div className="px-2 pt-2">
                    <div className="relative">
                      <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-text-tertiary" />
                      <input
                        type="text"
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                        placeholder={`Search ${shareLinks.length} Share Links`}
                        className="flex h-8 w-full rounded-md border border-border bg-bg-secondary pl-8 pr-3 text-sm text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-accent"
                        autoFocus
                      />
                    </div>
                  </div>
                )}

                {/* Links list */}
                <div className="max-h-72 overflow-y-auto px-1 pb-1.5">
                  {isLoading ? (
                    <div className="flex items-center justify-center py-6">
                      <Loader2 className="h-4 w-4 animate-spin text-text-tertiary" />
                    </div>
                  ) : filteredLinks.length === 0 ? (
                    <p className="py-4 text-center text-xs text-text-tertiary">
                      {search ? "No matching share links" : "No share links yet"}
                    </p>
                  ) : (
                    <>
                      {currentLinks.length > 0 && (
                        <section aria-labelledby={`${sectionId}-current`}>
                          <p
                            id={`${sectionId}-current`}
                            className="px-2 pt-2.5 pb-1.5 text-xs font-medium text-text-tertiary"
                          >
                            Links to this asset
                          </p>
                          {currentLinks.map((link) => {
                            const copyState = copied?.token === link.token ? copied : null;
                            const name = link.title || link.target_name;
                            return (
                              <div
                                key={link.id}
                                className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2"
                              >
                                <div className="flex h-8 w-8 items-center justify-center rounded-md bg-bg-tertiary shrink-0">
                                  <Link2 className="h-4 w-4 text-text-tertiary" />
                                </div>
                                <div className="min-w-0 flex-1">
                                  <p className="text-sm text-text-primary truncate">
                                    {name}
                                  </p>
                                  {addStatus(link.token) ??
                                    ((!link.is_enabled || link.contains_asset === "indirect") && (
                                      <p className="text-[10px] text-text-tertiary truncate">
                                        {!link.is_enabled
                                          ? "Access disabled"
                                          : "Through a folder or the whole project"}
                                      </p>
                                    ))}
                                </div>
                                <button
                                  type="button"
                                  onClick={() => handleCopy(link)}
                                  aria-label={`Copy link ${name}`}
                                  className={cn(
                                    "flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-xs transition-colors",
                                    copyState?.ok
                                      ? "text-status-success"
                                      : copyState
                                        ? "text-status-error"
                                        : "text-text-secondary hover:bg-bg-hover hover:text-text-primary",
                                  )}
                                >
                                  {copyState?.ok ? (
                                    <Check className="h-3.5 w-3.5" />
                                  ) : (
                                    <Copy className="h-3.5 w-3.5" />
                                  )}
                                  {copyState ? (copyState.ok ? "Copied" : "Copy failed") : "Copy"}
                                </button>
                              </div>
                            );
                          })}
                        </section>
                      )}

                      {otherLinks.length > 0 && (
                        <section aria-labelledby={`${sectionId}-other`}>
                          <p
                            id={`${sectionId}-other`}
                            className="px-2 pt-2.5 pb-1.5 text-xs font-medium text-text-tertiary"
                          >
                            Add to another share link
                          </p>
                          {otherLinks.map((link) => {
                            const isAdding = addingToToken === link.token;
                            return (
                              <button
                                key={link.id}
                                onClick={() => handleAddToLink(link)}
                                disabled={isAdding}
                                className={cn(
                                  "flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors",
                                  "hover:bg-bg-hover disabled:opacity-70",
                                )}
                              >
                                <div className="flex h-8 w-8 items-center justify-center rounded-md bg-bg-tertiary shrink-0">
                                  {isAdding ? (
                                    <Loader2 className="h-4 w-4 animate-spin text-text-tertiary" />
                                  ) : (
                                    <Plus className="h-4 w-4 text-text-tertiary" />
                                  )}
                                </div>
                                <div className="min-w-0 flex-1">
                                  <p className="text-sm text-text-primary truncate">
                                    {link.title || link.target_name}
                                  </p>
                                  {addStatus(link.token)}
                                </div>
                              </button>
                            );
                          })}
                        </section>
                      )}
                    </>
                  )}
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* ShareCreateDialog for new link */}
      {projectId && (
        <ShareCreateDialog
          open={createDialogOpen}
          onOpenChange={setCreateDialogOpen}
          projectId={projectId}
          currentFolderId={asset?.folder_id ?? null}
          assets={stableAssets}
          folders={emptyFolders}
          preselectedItem={stablePreselectedItem}
          currentViewAvailable={false}
          onShareCreated={() => {
            mutateShareLinks();
          }}
        />
      )}
    </>
  );
}
