"use client";

import * as React from "react";
import * as Dialog from "@radix-ui/react-dialog";
import * as Tabs from "@radix-ui/react-tabs";
import * as Select from "@radix-ui/react-select";
import {
  X,
  Copy,
  Check,
  Trash2,
  Link2,
  Users,
  ChevronDown,
  Loader2,
  Share2,
  Plus,
  Search,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api";
import { useShareLinks } from "@/hooks/use-share-links";
import { ShareCreateDialog } from "@/components/projects/share-create-dialog";
import type { ShareLink, AssetShare, SharePermission, Team, ShareLinkListItem, AssetResponse } from "@/types";

// ─── Types ────────────────────────────────────────────────────────────────────

interface ShareLinkResponse {
  share_link: ShareLink & { url: string };
}

interface ShareLinksListResponse {
  share_links: (ShareLink & { url?: string })[];
}

interface AssetSharesResponse {
  shares: AssetShare[];
}

interface TeamsResponse {
  teams: Team[];
}

// ─── Permission select ────────────────────────────────────────────────────────

interface PermissionSelectProps {
  value: SharePermission;
  onChange: (value: SharePermission) => void;
  disabled?: boolean;
}

function PermissionSelect({
  value,
  onChange,
  disabled,
}: PermissionSelectProps) {
  return (
    <Select.Root
      value={value}
      onValueChange={(v) => onChange(v as SharePermission)}
      disabled={disabled}
    >
      <Select.Trigger
        className={cn(
          "flex h-9 items-center justify-between gap-2 rounded-md border border-border bg-bg-secondary px-3 text-sm text-text-primary",
          "focus:outline-none focus:border-border-focus",
          "data-[placeholder]:text-text-tertiary disabled:opacity-50 disabled:cursor-not-allowed",
        )}
      >
        <Select.Value />
        <Select.Icon>
          <ChevronDown className="h-4 w-4 text-text-tertiary" />
        </Select.Icon>
      </Select.Trigger>
      <Select.Portal>
        <Select.Content
          className="z-[200] min-w-[160px] overflow-hidden rounded-lg border border-border bg-bg-elevated shadow-xl"
          position="popper"
          sideOffset={4}
        >
          <Select.Viewport className="p-1">
            {(["view", "comment", "approve"] as SharePermission[]).map((p) => (
              <Select.Item
                key={p}
                value={p}
                className="relative flex cursor-pointer select-none items-center rounded px-3 py-2 text-sm text-text-primary outline-none hover:bg-bg-hover data-[highlighted]:bg-bg-hover capitalize"
              >
                <Select.ItemText>{p}</Select.ItemText>
              </Select.Item>
            ))}
          </Select.Viewport>
        </Select.Content>
      </Select.Portal>
    </Select.Root>
  );
}

// ─── Copy button ──────────────────────────────────────────────────────────────

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = React.useState(false);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Fallback
    }
  }

  return (
    <button
      onClick={handleCopy}
      className="inline-flex items-center gap-1.5 rounded px-2 py-1 text-xs text-text-secondary hover:bg-bg-hover hover:text-text-primary transition-colors"
      title="Copy to clipboard"
    >
      {copied ? (
        <Check className="h-3.5 w-3.5 text-status-success" />
      ) : (
        <Copy className="h-3.5 w-3.5" />
      )}
      {copied ? "Copied!" : "Copy"}
    </button>
  );
}

// ─── Link tab ─────────────────────────────────────────────────────────────────

interface LinkTabProps {
  assetId: string;
}

function LinkTab({ assetId }: LinkTabProps) {
  const [permission, setPermission] = React.useState<SharePermission>("view");
  const [password, setPassword] = React.useState("");
  const [expiresAt, setExpiresAt] = React.useState("");
  const [allowDownload, setAllowDownload] = React.useState(false);
  const [generating, setGenerating] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [generatedUrl, setGeneratedUrl] = React.useState<string | null>(null);

  const [links, setLinks] = React.useState<(ShareLink & { url?: string })[]>(
    [],
  );
  const [loadingLinks, setLoadingLinks] = React.useState(true);
  const [deletingId, setDeletingId] = React.useState<string | null>(null);

  // Load existing links
  React.useEffect(() => {
    if (!assetId) return;
    setLoadingLinks(true);
    api
      .get<ShareLinksListResponse>(`/assets/${assetId}/share`)
      .then((res) => setLinks(res.share_links))
      .catch(() => setLinks([]))
      .finally(() => setLoadingLinks(false));
  }, [assetId]);

  async function handleGenerate() {
    setGenerating(true);
    setError(null);
    setGeneratedUrl(null);
    try {
      const body: Record<string, unknown> = {
        permission,
        allow_download: allowDownload,
      };
      if (password.trim()) body.password = password.trim();
      if (expiresAt) body.expires_at = new Date(expiresAt).toISOString();

      const res = await api.post<ShareLinkResponse>(
        `/assets/${assetId}/share`,
        body,
      );
      const newLink = res.share_link;
      const url =
        newLink.url ?? `${window.location.origin}/share/${newLink.token}`;
      setGeneratedUrl(url);
      setLinks((prev) => [...prev, { ...newLink, url }]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to generate link");
    } finally {
      setGenerating(false);
    }
  }

  async function handleDelete(linkId: string) {
    setDeletingId(linkId);
    try {
      await api.delete(`/share/${linkId}`);
      setLinks((prev) => prev.filter((l) => l.id !== linkId));
    } catch {
      // silent
    } finally {
      setDeletingId(null);
    }
  }

  return (
    <div className="space-y-5">
      {/* Generator form */}
      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-medium text-text-secondary">
              Permission
            </label>
            <PermissionSelect value={permission} onChange={setPermission} />
          </div>
          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-medium text-text-secondary">
              Expiry (optional)
            </label>
            <input
              type="datetime-local"
              value={expiresAt}
              onChange={(e) => setExpiresAt(e.target.value)}
              className="flex h-9 rounded-md border border-border bg-bg-secondary px-3 text-sm text-text-primary focus:outline-none focus:border-border-focus"
            />
          </div>
        </div>

        <div className="flex flex-col gap-1.5">
          <label className="text-xs font-medium text-text-secondary">
            Password (optional)
          </label>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Leave blank for no password"
            className="flex h-9 w-full rounded-md border border-border bg-bg-secondary px-3 text-sm text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-border-focus"
          />
        </div>

        <label className="flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={allowDownload}
            onChange={(e) => setAllowDownload(e.target.checked)}
            className="rounded border-border"
          />
          <span className="text-sm text-text-secondary">Allow download</span>
        </label>

        {error && <p className="text-xs text-status-error">{error}</p>}

        <Button
          size="sm"
          onClick={handleGenerate}
          loading={generating}
          className="w-full"
        >
          <Link2 className="h-4 w-4" />
          Generate link
        </Button>
      </div>

      {/* Generated URL */}
      {generatedUrl && (
        <div className="flex items-center gap-2 rounded-md border border-border bg-bg-tertiary px-3 py-2">
          <span className="flex-1 truncate font-mono text-xs text-text-primary">
            {generatedUrl}
          </span>
          <CopyButton text={generatedUrl} />
        </div>
      )}

      {/* Existing links */}
      {(loadingLinks || links.length > 0) && (
        <div className="space-y-2">
          <p className="text-xs font-medium text-text-secondary">
            Existing links
          </p>
          {loadingLinks ? (
            <div className="flex items-center gap-2 py-2">
              <Loader2 className="h-4 w-4 animate-spin text-text-tertiary" />
              <span className="text-xs text-text-tertiary">Loading…</span>
            </div>
          ) : (
            <div className="space-y-2 max-h-48 overflow-y-auto">
              {links.map((link) => {
                const linkUrl =
                  link.url ??
                  `${typeof window !== "undefined" ? window.location.origin : ""}/share/${link.token}`;
                return (
                  <div
                    key={link.id}
                    className="flex items-center gap-2 rounded-md border border-border bg-bg-secondary px-3 py-2"
                  >
                    <div className="flex-1 min-w-0 space-y-0.5">
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-medium text-text-primary capitalize">
                          {link.permission}
                        </span>
                        {link.expires_at && (
                          <span className="text-2xs text-text-tertiary">
                            expires{" "}
                            {new Date(link.expires_at).toLocaleDateString()}
                          </span>
                        )}
                        {link.allow_download && (
                          <span className="text-2xs text-text-tertiary">
                            download
                          </span>
                        )}
                      </div>
                      <span className="font-mono text-2xs text-text-tertiary truncate block">
                        {linkUrl}
                      </span>
                    </div>
                    <CopyButton text={linkUrl} />
                    <button
                      onClick={() => handleDelete(link.id)}
                      disabled={deletingId === link.id}
                      className="text-text-tertiary hover:text-status-error transition-colors disabled:opacity-50"
                    >
                      {deletingId === link.id ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <Trash2 className="h-3.5 w-3.5" />
                      )}
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Direct tab ───────────────────────────────────────────────────────────────

interface DirectTabProps {
  assetId: string;
  orgId?: string;
}

function DirectTab({ assetId, orgId }: DirectTabProps) {
  const [userEmail, setUserEmail] = React.useState("");
  const [userPermission, setUserPermission] =
    React.useState<SharePermission>("view");
  const [sharingUser, setSharingUser] = React.useState(false);
  const [userError, setUserError] = React.useState<string | null>(null);
  const [userSuccess, setUserSuccess] = React.useState(false);

  const [selectedTeamId, setSelectedTeamId] = React.useState("");
  const [teamPermission, setTeamPermission] =
    React.useState<SharePermission>("view");
  const [sharingTeam, setSharingTeam] = React.useState(false);
  const [teamError, setTeamError] = React.useState<string | null>(null);
  const [teamSuccess, setTeamSuccess] = React.useState(false);

  const [teams, setTeams] = React.useState<Team[]>([]);
  const [loadingTeams, setLoadingTeams] = React.useState(false);

  const [shares, setShares] = React.useState<AssetShare[]>([]);
  const [loadingShares, setLoadingShares] = React.useState(true);

  // Load teams for selector
  React.useEffect(() => {
    if (!orgId) return;
    setLoadingTeams(true);
    api
      .get<TeamsResponse>(`/organizations/${orgId}/teams`)
      .then((res) => setTeams(res.teams))
      .catch(() => setTeams([]))
      .finally(() => setLoadingTeams(false));
  }, [orgId]);

  // Load current shares
  React.useEffect(() => {
    if (!assetId) return;
    setLoadingShares(true);
    api
      .get<AssetSharesResponse>(`/assets/${assetId}/shares`)
      .then((res) => setShares(res.shares))
      .catch(() => setShares([]))
      .finally(() => setLoadingShares(false));
  }, [assetId]);

  async function handleShareUser(e: React.FormEvent) {
    e.preventDefault();
    if (!userEmail.trim()) return;
    setSharingUser(true);
    setUserError(null);
    setUserSuccess(false);
    try {
      const res = await api.post<{ share: AssetShare }>(
        `/assets/${assetId}/share/user`,
        {
          email: userEmail.trim(),
          permission: userPermission,
        },
      );
      setShares((prev) => [...prev, res.share]);
      setUserEmail("");
      setUserSuccess(true);
      setTimeout(() => setUserSuccess(false), 3000);
    } catch (err) {
      setUserError(err instanceof Error ? err.message : "Failed to share");
    } finally {
      setSharingUser(false);
    }
  }

  async function handleShareTeam(e: React.FormEvent) {
    e.preventDefault();
    if (!selectedTeamId) return;
    setSharingTeam(true);
    setTeamError(null);
    setTeamSuccess(false);
    try {
      const res = await api.post<{ share: AssetShare }>(
        `/assets/${assetId}/share/team`,
        {
          team_id: selectedTeamId,
          permission: teamPermission,
        },
      );
      setShares((prev) => [...prev, res.share]);
      setSelectedTeamId("");
      setTeamSuccess(true);
      setTimeout(() => setTeamSuccess(false), 3000);
    } catch (err) {
      setTeamError(err instanceof Error ? err.message : "Failed to share");
    } finally {
      setSharingTeam(false);
    }
  }

  return (
    <div className="space-y-5">
      {/* Share with user */}
      <div className="space-y-2">
        <p className="text-xs font-medium text-text-secondary">
          Share with user
        </p>
        <form onSubmit={handleShareUser} className="flex items-end gap-2">
          <div className="flex-1">
            <input
              type="email"
              value={userEmail}
              onChange={(e) => setUserEmail(e.target.value)}
              placeholder="user@example.com"
              className="flex h-9 w-full rounded-md border border-border bg-bg-secondary px-3 text-sm text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-border-focus"
            />
          </div>
          <PermissionSelect
            value={userPermission}
            onChange={setUserPermission}
          />
          <Button
            type="submit"
            size="sm"
            loading={sharingUser}
            disabled={!userEmail.trim()}
          >
            Share
          </Button>
        </form>
        {userError && <p className="text-xs text-status-error">{userError}</p>}
        {userSuccess && (
          <p className="text-xs text-status-success">Shared successfully!</p>
        )}
      </div>

      {/* Share with team */}
      <div className="space-y-2">
        <p className="text-xs font-medium text-text-secondary">
          Share with team
        </p>
        <form onSubmit={handleShareTeam} className="flex items-end gap-2">
          <div className="flex-1">
            <select
              value={selectedTeamId}
              onChange={(e) => setSelectedTeamId(e.target.value)}
              disabled={loadingTeams}
              className="flex h-9 w-full rounded-md border border-border bg-bg-secondary px-3 text-sm text-text-primary focus:outline-none focus:border-border-focus disabled:opacity-50"
            >
              <option value="">Select a team…</option>
              {teams.map((team) => (
                <option key={team.id} value={team.id}>
                  {team.name}
                </option>
              ))}
            </select>
          </div>
          <PermissionSelect
            value={teamPermission}
            onChange={setTeamPermission}
          />
          <Button
            type="submit"
            size="sm"
            loading={sharingTeam}
            disabled={!selectedTeamId}
          >
            Share
          </Button>
        </form>
        {teamError && <p className="text-xs text-status-error">{teamError}</p>}
        {teamSuccess && (
          <p className="text-xs text-status-success">Shared with team!</p>
        )}
      </div>

      {/* Current shares list */}
      {(loadingShares || shares.length > 0) && (
        <div className="space-y-2">
          <p className="text-xs font-medium text-text-secondary">
            Current shares
          </p>
          {loadingShares ? (
            <div className="flex items-center gap-2 py-2">
              <Loader2 className="h-4 w-4 animate-spin text-text-tertiary" />
              <span className="text-xs text-text-tertiary">Loading…</span>
            </div>
          ) : (
            <div className="space-y-1.5 max-h-40 overflow-y-auto">
              {shares.map((share) => (
                <div
                  key={share.id}
                  className="flex items-center justify-between rounded-md border border-border bg-bg-secondary px-3 py-2 text-xs"
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <Users className="h-3.5 w-3.5 text-text-tertiary shrink-0" />
                    <span className="text-text-secondary truncate">
                      {share.shared_with_user_id
                        ? `User ${share.shared_with_user_id.slice(0, 8)}…`
                        : `Team ${share.shared_with_team_id?.slice(0, 8)}…`}
                    </span>
                  </div>
                  <span className="text-text-tertiary capitalize shrink-0 ml-2">
                    {share.permission}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Share Dialog (Dropdown) ─────────────────────────────────────────────────

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
  const [addedToToken, setAddedToToken] = React.useState<string | null>(null);
  const [createDialogOpen, setCreateDialogOpen] = React.useState(false);
  const dropdownRef = React.useRef<HTMLDivElement>(null);

  const { shareLinks, isLoading, mutateShareLinks } = useShareLinks(projectId ?? "");

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

  async function handleAddToLink(link: ShareLinkListItem) {
    setAddingToToken(link.token);
    try {
      await api.post(`/share/${link.token}/add-asset/${assetId}`, {});
      setAddedToToken(link.token);
      mutateShareLinks();
      setTimeout(() => {
        setAddedToToken(null);
        setDropdownOpen(false);
      }, 1500);
    } catch {
      // Could show error, but keeping simple
    } finally {
      setAddingToToken(null);
    }
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
                <p className="px-3 pt-2.5 pb-1.5 text-xs font-medium text-text-tertiary">
                  Add to Existing Share Links
                </p>

                {/* Search (only if more than 3 links) */}
                {shareLinks.length > 3 && (
                  <div className="px-2 pb-2">
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
                    filteredLinks.map((link) => {
                      const isAdding = addingToToken === link.token;
                      const isAdded = addedToToken === link.token;
                      return (
                        <button
                          key={link.id}
                          onClick={() => handleAddToLink(link)}
                          disabled={isAdding || isAdded}
                          className={cn(
                            "flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors",
                            isAdded
                              ? "bg-status-success/10"
                              : "hover:bg-bg-hover",
                            "disabled:opacity-70",
                          )}
                        >
                          <div className="flex h-8 w-8 items-center justify-center rounded-md bg-bg-tertiary shrink-0">
                            {isAdding ? (
                              <Loader2 className="h-4 w-4 animate-spin text-text-tertiary" />
                            ) : isAdded ? (
                              <Check className="h-4 w-4 text-status-success" />
                            ) : (
                              <Link2 className="h-4 w-4 text-text-tertiary" />
                            )}
                          </div>
                          <div className="min-w-0 flex-1">
                            <p className="text-sm text-text-primary truncate">
                              {link.title || link.target_name}
                            </p>
                            {isAdded && (
                              <p className="text-[10px] text-status-success">
                                Asset added!
                              </p>
                            )}
                          </div>
                        </button>
                      );
                    })
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
          onShareCreated={() => {
            mutateShareLinks();
          }}
        />
      )}
    </>
  );
}
