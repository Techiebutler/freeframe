"use client";

import * as React from "react";
import * as Dialog from "@radix-ui/react-dialog";
import useSWR from "swr";
import {
  Copy,
  Check,
  ExternalLink,
  Lock,
  Calendar,
  Paintbrush,
  Eye,
  EyeOff,
  ChevronDown,
  ChevronRight,
  MessageSquare,
  Droplets,
  Globe,
  Image as ImageIcon,
  Pencil,
  SlidersHorizontal,
  X,
} from "lucide-react";
import { cn, copyToClipboard, dateInputValue, endOfDayISO } from "@/lib/utils";
import { withBasePath } from "@/lib/base-path";
import { api } from "@/lib/api";
import { ShareLinkActivityPanel } from "@/components/projects/share-link-activity";
import { FolderShareViewer } from "@/components/share/folder-share-viewer";
import {
  ShareAppearanceFields,
  DEFAULT_SHARE_APPEARANCE,
} from "@/components/projects/share-appearance-fields";
import { ToggleRow } from "@/components/ui/setting-controls";
import { resolveShareLogoUrl } from "@/lib/project-branding";
import type { Project, ProjectBranding, ShareBranding, ShareLink, ShareLinkAppearance } from "@/types";
import {
  SHARE_PASSWORD_TOO_LONG,
  sharePasswordTooLong,
} from "@/lib/share-password";

// ─── Shared hook for share link data + mutations ────────────────────────────

function useShareLinkData(token: string) {
  const { data: shareLink, mutate } = useSWR<ShareLink>(
    `/share/${token}/details`,
    (key: string) => api.get<ShareLink>(key),
  );

  const updateTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );

  const debouncedUpdate = React.useCallback(
    (updates: Record<string, unknown>) => {
      if (updateTimerRef.current) clearTimeout(updateTimerRef.current);
      updateTimerRef.current = setTimeout(async () => {
        try {
          await api.patch(`/share/${token}`, updates);
          mutate();
        } catch {
          // Silent fail — could add toast
        }
      }, 300);
    },
    [token, mutate],
  );

  // Drop a change still waiting in the debounce, so it is never sent.
  const cancelPendingUpdate = React.useCallback(() => {
    if (updateTimerRef.current) clearTimeout(updateTimerRef.current);
    updateTimerRef.current = null;
  }, []);

  const immediateUpdate = React.useCallback(
    async (updates: Record<string, unknown>) => {
      try {
        await api.patch(`/share/${token}`, updates);
        mutate();
      } catch {
        // Silent fail
      }
    },
    [token, mutate],
  );

  // A link without a stored appearance renders on the API's defaults, so the
  // panel shows (and patches from) those same values. The header banner fields
  // are optional and left out: the API fills them in (no banner, centred,
  // unzoomed) and every reader falls back to the same values.
  const appearance: ShareLinkAppearance = shareLink?.appearance || DEFAULT_SHARE_APPEARANCE;

  const updateAppearance = React.useCallback(
    (patch: Partial<ShareLinkAppearance>) => {
      const updated = { ...appearance, ...patch };
      immediateUpdate({ appearance: updated });
    },
    [appearance, immediateUpdate],
  );

  return {
    shareLink,
    mutate,
    debouncedUpdate,
    cancelPendingUpdate,
    immediateUpdate,
    appearance,
    updateAppearance,
  };
}

// ─── Collapsible Section ─────────────────────────────────────────────────────

function Section({
  title,
  icon,
  defaultOpen = true,
  open: controlledOpen,
  onOpenChange,
  id,
  children,
}: {
  title: string;
  icon: React.ReactNode;
  defaultOpen?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  id?: string;
  children: React.ReactNode;
}) {
  const [open, setOpen] = React.useState(defaultOpen);
  const isOpen = controlledOpen ?? open;
  const toggle = () => {
    const next = !isOpen;
    if (controlledOpen === undefined) setOpen(next);
    onOpenChange?.(next);
  };

  return (
    <div id={id} className="border-b border-border">
      <button
        onClick={toggle}
        className="flex w-full items-center gap-2 px-4 py-3 text-xs font-semibold uppercase tracking-wider text-text-secondary hover:text-text-primary transition-colors"
      >
        {icon}
        <span className="flex-1 text-left">{title}</span>
        {isOpen ? (
          <ChevronDown className="h-3.5 w-3.5" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5" />
        )}
      </button>
      {isOpen && <div className="px-4 pb-4 space-y-3">{children}</div>}
    </div>
  );
}

// ─── Share User Search (autocomplete) ───────────────────────────────────────

interface UserSuggestion {
  id: string;
  name: string;
  email: string;
  avatar_url?: string | null;
}

interface InvitedUser {
  id: string;
  name: string;
  email: string;
  permission: string;
}

function ShareUserSearch({ shareLink }: { shareLink: ShareLink }) {
  const [query, setQuery] = React.useState("");
  const [suggestions, setSuggestions] = React.useState<UserSuggestion[]>([]);
  const [showSuggestions, setShowSuggestions] = React.useState(false);
  const [sending, setSending] = React.useState(false);
  const [sent, setSent] = React.useState<string | null>(null);
  const [invitedUsers, setInvitedUsers] = React.useState<InvitedUser[]>([]);
  const debounceRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const containerRef = React.useRef<HTMLDivElement>(null);

  // Fetch already-invited users from direct shares
  React.useEffect(() => {
    async function fetchInvited() {
      try {
        const targetId = shareLink.folder_id || shareLink.asset_id;
        if (!targetId) return;
        const type = shareLink.folder_id ? "folders" : "assets";
        const shares = await api.get<
          Array<{
            id: string;
            shared_with_user_id: string | null;
            permission: string;
          }>
        >(`/${type}/${targetId}/direct-shares`);
        if (shares && shares.length > 0) {
          const userIds = shares
            .filter((s) => s.shared_with_user_id)
            .map((s) => s.shared_with_user_id)
            .join(",");
          if (userIds) {
            const users = await api.get<
              Array<{ id: string; name: string; email: string }>
            >(`/users?ids=${userIds}`);
            setInvitedUsers(
              users.map((u) => ({
                id: u.id,
                name: u.name,
                email: u.email,
                permission:
                  shares.find((s) => s.shared_with_user_id === u.id)
                    ?.permission || "view",
              })),
            );
          }
        }
      } catch {
        // Endpoint may not exist yet — silently fail
      }
    }
    fetchInvited();
  }, [shareLink.asset_id, shareLink.folder_id]);

  function searchUsers(q: string) {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (!q.trim()) {
      setSuggestions([]);
      setShowSuggestions(false);
      return;
    }
    debounceRef.current = setTimeout(async () => {
      try {
        const results = await api.get<UserSuggestion[]>(
          `/users/search?q=${encodeURIComponent(q.trim())}`,
        );
        setSuggestions(results);
        setShowSuggestions(results.length > 0);
      } catch {
        setSuggestions([]);
      }
    }, 250);
  }

  async function inviteUser(user: UserSuggestion) {
    setSending(true);
    try {
      const body = {
        permission: shareLink.permission || "view",
        user_id: user.id,
        share_token: shareLink.token,
      };
      if (shareLink.folder_id) {
        await api.post(`/folders/${shareLink.folder_id}/share/user`, body);
      } else if (shareLink.asset_id) {
        await api.post(`/assets/${shareLink.asset_id}/share/user`, body);
      } else if ((shareLink as any).project_id) {
        await api.post(
          `/projects/${(shareLink as any).project_id}/share/user`,
          body,
        );
      }
      setSent(user.name || user.email);
      setQuery("");
      setSuggestions([]);
      setShowSuggestions(false);
      setInvitedUsers((prev) => [
        ...prev.filter((u) => u.id !== user.id),
        {
          id: user.id,
          name: user.name,
          email: user.email,
          permission: shareLink.permission || "view",
        },
      ]);
      setTimeout(() => setSent(null), 3000);
    } catch {
      // Could show error
    } finally {
      setSending(false);
    }
  }

  async function inviteByEmail(email: string) {
    setSending(true);
    try {
      const body = {
        permission: shareLink.permission || "view",
        email,
        share_token: shareLink.token,
      };
      if (shareLink.folder_id) {
        await api.post(`/folders/${shareLink.folder_id}/share/user`, body);
      } else if (shareLink.asset_id) {
        await api.post(`/assets/${shareLink.asset_id}/share/user`, body);
      } else if ((shareLink as any).project_id) {
        await api.post(
          `/projects/${(shareLink as any).project_id}/share/user`,
          body,
        );
      }
      setSent(email);
      setQuery("");
      setSuggestions([]);
      setShowSuggestions(false);
      setTimeout(() => setSent(null), 3000);
    } catch {
      // Could show error
    } finally {
      setSending(false);
    }
  }

  // Close suggestions on outside click
  React.useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (
        containerRef.current &&
        !containerRef.current.contains(e.target as Node)
      ) {
        setShowSuggestions(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  return (
    <div className="mt-2 relative" ref={containerRef}>
      <input
        type="text"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          searchUsers(e.target.value);
        }}
        onFocus={() => {
          if (suggestions.length > 0) setShowSuggestions(true);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && query.includes("@") && !showSuggestions) {
            inviteByEmail(query.trim());
          }
        }}
        placeholder="Send to name or email"
        disabled={sending}
        className="w-full rounded-md border border-border bg-bg-tertiary px-3 py-2 text-sm text-text-primary placeholder:text-text-tertiary outline-none focus:border-accent/50"
      />

      {/* Suggestions dropdown — rendered inline to avoid overflow clipping */}
      {showSuggestions && suggestions.length > 0 && (
        <div className="mt-1 rounded-lg border border-border bg-bg-tertiary shadow-xl">
          {suggestions.map((user) => (
            <button
              key={user.id}
              onClick={() => inviteUser(user)}
              className="w-full flex items-center gap-3 px-3 py-2.5 text-left hover:bg-bg-hover transition-colors first:rounded-t-lg last:rounded-b-lg"
            >
              <div className="h-7 w-7 rounded-full bg-accent/20 flex items-center justify-center shrink-0">
                <span className="text-xs font-medium text-accent">
                  {(user.name || user.email).charAt(0).toUpperCase()}
                </span>
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-sm text-text-primary truncate">
                  {user.name}
                </p>
                <p className="text-2xs text-text-tertiary truncate">
                  {user.email}
                </p>
              </div>
            </button>
          ))}
        </div>
      )}

      {/* Success message */}
      {sent && <p className="text-2xs text-green-400 mt-1">Invited {sent}</p>}
      {!sent && !invitedUsers.length && (
        <p className="text-2xs text-text-tertiary mt-1">
          Type to search users or enter email
        </p>
      )}

      {/* Invited users list */}
      {invitedUsers.length > 0 && (
        <div className="mt-2 space-y-1">
          {invitedUsers.map((user) => (
            <div
              key={user.id}
              className="flex items-center gap-2 rounded-md bg-bg-tertiary px-2.5 py-1.5"
            >
              <div className="h-6 w-6 rounded-full bg-accent/20 flex items-center justify-center shrink-0">
                <span className="text-2xs font-medium text-accent">
                  {(user.name || user.email).charAt(0).toUpperCase()}
                </span>
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-xs text-text-primary truncate">
                  {user.name}
                </p>
              </div>
              <span className="text-2xs text-text-tertiary capitalize shrink-0">
                {user.permission}
              </span>
              <button
                onClick={async () => {
                  try {
                    const targetId = shareLink.folder_id || shareLink.asset_id;
                    const type = shareLink.folder_id ? "folders" : "assets";
                    // Find the share ID for this user
                    const shares = await api.get<
                      Array<{ id: string; shared_with_user_id: string }>
                    >(`/${type}/${targetId}/direct-shares`);
                    const share = shares.find(
                      (s) => s.shared_with_user_id === user.id,
                    );
                    if (share && shareLink.folder_id) {
                      await api.delete(
                        `/folders/${shareLink.folder_id}/shares/${share.id}`,
                      );
                    }
                    // For assets, we'd need a similar delete endpoint — for now just remove from UI
                    setInvitedUsers((prev) =>
                      prev.filter((u) => u.id !== user.id),
                    );
                  } catch {
                    setInvitedUsers((prev) =>
                      prev.filter((u) => u.id !== user.id),
                    );
                  }
                }}
                className="text-text-tertiary hover:text-red-400 transition-colors shrink-0"
                title="Remove access"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Copy Button (small, inline) ────────────────────────────────────────────

function CopyButton({ text, className }: { text: string; className?: string }) {
  const [copied, setCopied] = React.useState(false);

  async function handleCopy() {
    if (!(await copyToClipboard(text))) return;
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <button
      onClick={handleCopy}
      className={cn(
        "inline-flex items-center gap-1.5 rounded px-2 py-1 text-xs text-text-secondary hover:bg-bg-hover hover:text-text-primary transition-colors",
        className,
      )}
      title="Copy to clipboard"
    >
      {copied ? (
        <>
          <Check className="h-3.5 w-3.5 text-green-400" />
          <span>Copied!</span>
        </>
      ) : (
        <>
          <Copy className="h-3.5 w-3.5" />
          <span>Copy</span>
        </>
      )}
    </button>
  );
}

// ─── Copy Link Button (larger, for main content area) ────────────────────────

function CopyLinkButton({ text }: { text: string }) {
  const [copied, setCopied] = React.useState(false);

  async function handleCopy() {
    if (!(await copyToClipboard(text))) return;
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <button
      onClick={handleCopy}
      className={cn(
        "inline-flex items-center gap-2 rounded-lg border px-4 py-2 text-sm font-medium transition-colors",
        copied
          ? "border-green-500/30 text-green-400"
          : "border-border text-text-primary hover:bg-bg-tertiary hover:text-text-primary",
      )}
    >
      {copied ? (
        <>
          <Check className="h-4 w-4" />
          Copied!
        </>
      ) : (
        <>
          <Copy className="h-4 w-4" />
          Copy Link
        </>
      )}
    </button>
  );
}

// ─── Header banner editor ───────────────────────────────────────────────────

type BannerDraft = {
  key: string | null;
  url: string | null;
  positionX: number;
  positionY: number;
  zoom: number;
};

function HeaderBannerDialog({
  open,
  onOpenChange,
  token,
  appearance,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  token: string;
  appearance: ShareLinkAppearance;
  onSaved: () => Promise<unknown>;
}) {
  const [draft, setDraft] = React.useState<BannerDraft>({
    key: null,
    url: null,
    positionX: 50,
    positionY: 50,
    zoom: 1,
  });
  const [uploading, setUploading] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const inputRef = React.useRef<HTMLInputElement>(null);
  const objectUrlRef = React.useRef<string | null>(null);

  React.useEffect(() => {
    if (!open) return;
    setError(null);
    setDraft({
      key: appearance.header_banner_key ?? null,
      url: appearance.header_banner_url ?? null,
      positionX: appearance.header_banner_position_x ?? 50,
      positionY: appearance.header_banner_position_y ?? 50,
      zoom: appearance.header_banner_zoom ?? 1,
    });
  }, [open, appearance]);

  React.useEffect(() => () => {
    if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
  }, []);

  const updateDraft = (patch: Partial<BannerDraft>) =>
    setDraft((current) => ({ ...current, ...patch }));

  const uploadImage = async (file: File) => {
    const supportedTypes = ["image/jpeg", "image/png", "image/webp"];
    if (!supportedTypes.includes(file.type)) {
      setError("Use uma imagem JPG, PNG ou WebP.");
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      setError("A imagem do banner deve ter no máximo 10 MB.");
      return;
    }

    setUploading(true);
    setError(null);
    try {
      const upload = await api.post<{ upload_url: string; key: string }>(
        `/share/${token}/header-banner-upload`,
        { content_type: file.type },
      );
      const result = await fetch(upload.upload_url, {
        method: "PUT",
        headers: { "Content-Type": file.type },
        body: file,
      });
      if (!result.ok) throw new Error("Upload failed");
      if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
      objectUrlRef.current = URL.createObjectURL(file);
      updateDraft({ key: upload.key, url: objectUrlRef.current });
    } catch {
      setError("Não foi possível enviar a imagem. Tente novamente.");
    } finally {
      setUploading(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await api.patch(`/share/${token}`, {
        appearance: {
          ...appearance,
          header_banner_key: draft.key,
          header_banner_position_x: draft.positionX,
          header_banner_position_y: draft.positionY,
          header_banner_zoom: draft.zoom,
        },
      });
      await onSaved();
      onOpenChange(false);
    } catch {
      setError("Não foi possível salvar o cabeçalho. Tente novamente.");
    } finally {
      setSaving(false);
    }
  };

  const close = (nextOpen: boolean) => {
    if (!saving && !uploading) onOpenChange(nextOpen);
  };

  const percent = Math.round(draft.zoom * 100);

  return (
    <Dialog.Root open={open} onOpenChange={close}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[calc(100%-2rem)] max-w-4xl -translate-x-1/2 -translate-y-1/2 overflow-hidden rounded-2xl border border-border bg-bg-secondary shadow-2xl focus:outline-none">
          <div className="flex items-start justify-between border-b border-border px-6 py-5">
            <div>
              <Dialog.Title className="text-lg font-semibold text-text-primary">Editar cabeçalho</Dialog.Title>
              <Dialog.Description className="mt-1 text-sm text-text-tertiary">Escolha a imagem e ajuste o enquadramento que aparece no topo do link.</Dialog.Description>
            </div>
            <Dialog.Close className="rounded-md p-1.5 text-text-tertiary hover:bg-bg-hover hover:text-text-primary transition-colors" aria-label="Fechar editor">
              <X className="h-5 w-5" />
            </Dialog.Close>
          </div>

          <div className="grid gap-6 p-6 lg:grid-cols-[minmax(0,1fr)_248px]">
            <div className="space-y-3">
              <div className="overflow-hidden rounded-xl border border-border bg-bg-primary shadow-inner">
                <div className="relative aspect-[16/5] overflow-hidden bg-gradient-to-br from-bg-tertiary to-bg-primary">
                  {draft.url ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={draft.url} alt="Prévia do banner" className="absolute inset-0 h-full w-full object-cover" style={{ objectPosition: `${draft.positionX}% ${draft.positionY}%`, transform: `scale(${draft.zoom})`, transformOrigin: `${draft.positionX}% ${draft.positionY}%` }} />
                  ) : (
                    <div className="flex h-full flex-col items-center justify-center gap-2 text-text-tertiary">
                      <ImageIcon className="h-8 w-8" />
                      <span className="text-sm">Nenhuma imagem selecionada</span>
                    </div>
                  )}
                  <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-bg-primary via-bg-primary/60 to-black/5" />
                  <div className="absolute bottom-4 left-5">
                    <p className="text-sm font-semibold text-white">Prévia do cabeçalho</p>
                    <p className="mt-0.5 text-xs text-white/65">O degradê mantém a leitura sobre a imagem.</p>
                  </div>
                </div>
              </div>
              <p className="text-xs text-text-tertiary">Use uma imagem horizontal para obter o melhor resultado.</p>
            </div>

            <div className="space-y-5 rounded-xl border border-border bg-bg-tertiary/40 p-4">
              <input ref={inputRef} type="file" accept="image/jpeg,image/png,image/webp" className="hidden" onChange={(event) => { const file = event.target.files?.[0]; if (file) void uploadImage(file); }} />
              <button onClick={() => inputRef.current?.click()} disabled={uploading} className="flex w-full items-center justify-center gap-2 rounded-lg bg-accent px-3 py-2.5 text-sm font-medium text-text-inverse hover:bg-accent/90 disabled:cursor-not-allowed disabled:opacity-60 transition-colors">
                <ImageIcon className="h-4 w-4" />
                {uploading ? "Enviando…" : draft.url ? "Trocar imagem" : "Escolher imagem"}
              </button>

              <div className="space-y-4">
                <p className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-text-secondary"><SlidersHorizontal className="h-3.5 w-3.5" /> Enquadramento</p>
                {([
                  ["Posição horizontal", "positionX", draft.positionX, "%"],
                  ["Posição vertical", "positionY", draft.positionY, "%"],
                  ["Zoom", "zoom", percent, "%"],
                ] as const).map(([label, field, value, suffix]) => (
                  <label key={field} className="block space-y-1.5">
                    <span className="flex justify-between text-xs text-text-secondary"><span>{label}</span><span className="text-text-primary">{value}{suffix}</span></span>
                    <input type="range" min={field === "zoom" ? 100 : 0} max={field === "zoom" ? 200 : 100} step={field === "zoom" ? 1 : 1} value={value} onChange={(event) => updateDraft({ [field]: field === "zoom" ? Number(event.target.value) / 100 : Number(event.target.value) })} className="h-1.5 w-full cursor-pointer appearance-none rounded-full bg-bg-hover accent-accent" />
                  </label>
                ))}
              </div>

              <div className="flex gap-2 pt-1">
                <button onClick={() => updateDraft({ positionX: 50, positionY: 50, zoom: 1 })} className="flex-1 rounded-md border border-border px-2 py-2 text-xs font-medium text-text-secondary hover:bg-bg-hover hover:text-text-primary transition-colors">Centralizar</button>
                <button onClick={() => updateDraft({ key: null, url: null, positionX: 50, positionY: 50, zoom: 1 })} disabled={!draft.key} className="rounded-md border border-border px-2.5 py-2 text-xs font-medium text-text-secondary hover:bg-red-500/10 hover:text-red-400 disabled:cursor-not-allowed disabled:opacity-40 transition-colors" title="Remover imagem"><X className="h-4 w-4" /></button>
              </div>
              {error && <p className="text-xs text-red-400">{error}</p>}
            </div>
          </div>

          <div className="flex justify-end gap-3 border-t border-border px-6 py-4">
            <button onClick={() => close(false)} disabled={saving || uploading} className="rounded-lg px-4 py-2 text-sm font-medium text-text-secondary hover:bg-bg-hover hover:text-text-primary disabled:opacity-50 transition-colors">Cancelar</button>
            <button onClick={() => void save()} disabled={saving || uploading} className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-text-inverse hover:bg-accent/90 disabled:cursor-not-allowed disabled:opacity-60 transition-colors">{saving ? "Salvando…" : "Salvar alterações"}</button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

// ─── Props ───────────────────────────────────────────────────────────────────

interface ShareLinkContentProps {
  token: string;
  projectId: string;
  onBack: () => void;
  frontendUrl: string;
  onUpdate?: () => void;
}

interface ShareLinkSettingsPanelProps {
  token: string;
}

// ─── ShareLinkContent (LEFT/MAIN panel) ─────────────────────────────────────

/**
 * The link's page, embedded and editable: the real share page component
 * (FolderShareViewer) rendered in the link's appearance, with the title and
 * description editable in place. The settings panel mutates the same SWR key,
 * so a saved setting re-renders the preview at once. `onBack` and
 * `frontendUrl` stay on the props for callers; the open/copy actions live in
 * the settings panel's footer.
 */
export function ShareLinkContent({
  token,
  projectId,
  onUpdate,
}: ShareLinkContentProps) {
  const { shareLink, immediateUpdate, appearance } = useShareLinkData(token);

  // The page takes the project's branding (logo, colour, footer) for every
  // link type, so the preview reads it from the same place the API does.
  const [projectBranding, setProjectBranding] = React.useState<ProjectBranding | null>(null);
  const { data: project } = useSWR<Project>(`/projects/${projectId}`, (key: string) =>
    api.get<Project>(key),
  );

  React.useEffect(() => {
    let cancelled = false;
    api
      .get<ProjectBranding>(`/projects/${projectId}/branding`)
      .then((b) => !cancelled && setProjectBranding(b ?? null))
      .catch(() => !cancelled && setProjectBranding(null));
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  // The branding the share API sends: the resolved project logo (the cover
  // when the project uses it as its logo), the project colour and the footer.
  const previewBranding: ShareBranding | null = projectBranding
    ? {
        logo_url: resolveShareLogoUrl({
          useCoverAsLogo: projectBranding.use_cover_as_logo ?? false,
          coverUrl: project?.poster_url,
          logoUrl: projectBranding.logo_url,
        }),
        primary_color: projectBranding.primary_color ?? null,
        custom_footer: projectBranding.custom_footer ?? null,
      }
    : null;

  if (!shareLink) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="flex items-center gap-2 text-text-tertiary">
          <div className="h-4 w-4 animate-spin rounded-full border-2 border-zinc-500 border-t-transparent" />
          <span className="text-sm">Loading...</span>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 min-w-0 overflow-hidden bg-bg-primary">
      <FolderShareViewer
        embedded
        editableHeader
        token={token}
        folderName={shareLink.title || "Shared Link"}
        title={shareLink.title || "Shared Link"}
        description={shareLink.description}
        permission={shareLink.permission}
        allowDownload={shareLink.allow_download}
        showVersions={shareLink.show_versions}
        appearance={appearance}
        branding={previewBranding}
        onTitleCommit={(title) => {
          void immediateUpdate({ title }).then(() => onUpdate?.());
        }}
        onDescriptionCommit={(description) => {
          void immediateUpdate({ description }).then(() => onUpdate?.());
        }}
      />
    </div>
  );
}

// ─── ShareLinkSettingsPanel (RIGHT panel) ───────────────────────────────────

export function ShareLinkSettingsPanel({ token }: ShareLinkSettingsPanelProps) {
  const {
    shareLink,
    mutate,
    debouncedUpdate,
    cancelPendingUpdate,
    immediateUpdate,
    appearance,
    updateAppearance,
  } = useShareLinkData(token);

  const [rightTab, setRightTab] = React.useState<"settings" | "activity">(
    "settings",
  );
  const [localPassword, setLocalPassword] = React.useState("");
  const [passwordEnabled, setPasswordEnabled] = React.useState(false);
  const [showPassword, setShowPassword] = React.useState(false);
  // The typed password is over the API's limit, so it is not being saved.
  const [passwordTooLong, setPasswordTooLong] = React.useState(false);
  const [appearanceOpen, setAppearanceOpen] = React.useState(false);
  const [bannerDialogOpen, setBannerDialogOpen] = React.useState(false);
  const [customSlug, setCustomSlug] = React.useState("");
  const [customSlugError, setCustomSlugError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (shareLink) {
      setPasswordEnabled(shareLink.has_password ?? false);
      setLocalPassword(shareLink.password_value || "");
      setCustomSlug(shareLink.custom_slug || "");
    }
  }, [shareLink]);

  React.useEffect(() => {
    const openHeaderEditor = () => {
      setRightTab("settings");
      setAppearanceOpen(true);
      setBannerDialogOpen(true);
    };
    window.addEventListener("freeframe:open-share-banner-editor", openHeaderEditor);
    return () => window.removeEventListener("freeframe:open-share-banner-editor", openHeaderEditor);
  }, []);

  const shareUrl =
    typeof window !== "undefined"
      ? `${window.location.origin}${withBasePath(`/s/${shareLink?.custom_slug ?? shareLink?.short_code ?? token}`)}`
      : withBasePath(`/s/${shareLink?.custom_slug ?? shareLink?.short_code ?? token}`);

  async function saveCustomSlug() {
    if (!shareLink) return;
    try {
      const updated = await api.patch<ShareLink>(`/share/${token}`, {
        custom_slug: customSlug.trim() || null,
      });
      setCustomSlug(updated.custom_slug || "");
      setCustomSlugError(null);
      await mutate(updated, false);
    } catch (error) {
      setCustomSlugError(error instanceof Error ? error.message : "Could not save the custom link name.");
    }
  }

  // The link has a password but the API did not send it back: it shows the
  // password only to the people who manage the link, and not at all once the
  // key it was stored under has changed. The box then starts empty, and typing
  // replaces the password.
  const passwordHidden =
    !!shareLink?.has_password && !shareLink?.password_value;

  if (!shareLink) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="flex items-center gap-2 text-text-tertiary">
          <div className="h-4 w-4 animate-spin rounded-full border-2 border-zinc-500 border-t-transparent" />
          <span className="text-sm">Loading...</span>
        </div>
      </div>
    );
  }

  return (
    <>
      <HeaderBannerDialog
        open={bannerDialogOpen}
        onOpenChange={setBannerDialogOpen}
        token={token}
        appearance={appearance}
        onSaved={async () => { await mutate(); }}
      />
      {/* Tabs */}
      <div className="flex items-center border-b border-border">
        {(["settings", "activity"] as const).map((tab) => (
          <button
            key={tab}
            onClick={() => setRightTab(tab)}
            className={cn(
              "flex-1 flex items-center justify-center gap-1.5 py-2.5 text-sm font-medium capitalize transition-colors border-b-2",
              rightTab === tab
                ? "border-accent text-text-primary"
                : "border-transparent text-text-tertiary hover:text-text-secondary",
            )}
          >
            {tab}
          </button>
        ))}
      </div>

      {/* Tab content */}
      <div className="flex-1 overflow-y-auto">
        {rightTab === "settings" ? (
          <div>
            {/* Link Visibility */}
            <Section
              title="Link Visibility"
              icon={<Globe className="h-3.5 w-3.5" />}
            >
              <ToggleRow
                label="Enabled"
                description={
                  shareLink.visibility === "secure"
                    ? "Only invited users can access"
                    : "Anyone with the link can access"
                }
                checked={shareLink.is_enabled}
                onCheckedChange={(checked) =>
                  immediateUpdate({ is_enabled: checked })
                }
              />
              {/* URL + Visibility dropdown */}
              <div className="flex items-center gap-2 rounded-md bg-bg-tertiary px-3 py-2 mt-2">
                <span className="flex-1 truncate font-mono text-xs text-text-secondary">
                  {shareUrl}
                </span>
                <CopyButton text={shareUrl} />
                <select
                  value={shareLink.visibility || "public"}
                  onChange={(e) =>
                    immediateUpdate({ visibility: e.target.value })
                  }
                  className="rounded-full border border-border bg-bg-tertiary px-2.5 py-1 text-2xs font-medium text-text-primary outline-none cursor-pointer [color-scheme:auto]"
                >
                  <option value="public">🌐 Public</option>
                  <option value="secure">🔒 Secure</option>
                </select>
              </div>
              <div className="mt-2 space-y-1.5">
                <label htmlFor="custom-share-link" className="block text-2xs font-medium text-text-secondary">
                  Custom link
                </label>
                <div className="flex items-center rounded-md border border-border bg-bg-tertiary focus-within:border-accent/60">
                  <span className="shrink-0 select-none border-r border-border px-2.5 py-2 font-mono text-2xs text-text-tertiary">/s/</span>
                  <input
                    id="custom-share-link"
                    value={customSlug}
                    onChange={(event) => {
                      setCustomSlug(event.target.value);
                      setCustomSlugError(null);
                    }}
                    onBlur={saveCustomSlug}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") event.currentTarget.blur();
                      if (event.key === "Escape") {
                        setCustomSlug(shareLink.custom_slug || "");
                        setCustomSlugError(null);
                        event.currentTarget.blur();
                      }
                    }}
                    placeholder="review-client"
                    maxLength={120}
                    className="min-w-0 flex-1 bg-transparent px-2.5 py-2 font-mono text-xs text-text-primary outline-none placeholder:text-text-tertiary"
                  />
                </div>
                <p className={cn("text-2xs", customSlugError ? "text-status-error" : "text-text-tertiary")}>
                  {customSlugError || "Optional. Names are normalized to lowercase URL-safe text."}
                </p>
              </div>
              {shareLink.visibility === "secure" && (
                <p className="text-2xs text-text-tertiary mt-1">
                  Only project members and people you invite can view this link.
                </p>
              )}
              {/* Send to name or email */}
              <ShareUserSearch shareLink={shareLink} />
            </Section>

            {/* Permissions */}
            <Section
              title="Permissions"
              icon={<MessageSquare className="h-3.5 w-3.5" />}
            >
              <ToggleRow
                label="Comments"
                description="Allow viewers to leave comments"
                checked={
                  shareLink.permission === "comment" ||
                  shareLink.permission === "approve"
                }
                onCheckedChange={(checked) =>
                  immediateUpdate({ permission: checked ? "comment" : "view" })
                }
              />
              <ToggleRow
                label="Downloads"
                description="Allow viewers to download files"
                checked={shareLink.allow_download}
                onCheckedChange={(checked) =>
                  immediateUpdate({ allow_download: checked })
                }
              />
              <ToggleRow
                label="Show all versions"
                description="Display version history"
                checked={shareLink.show_versions}
                onCheckedChange={(checked) =>
                  immediateUpdate({ show_versions: checked })
                }
              />
            </Section>

            {/* Security */}
            <Section title="Security" icon={<Lock className="h-3.5 w-3.5" />}>
              <ToggleRow
                label="Passphrase"
                description={
                  passwordEnabled
                    ? "Password required to access"
                    : "Require a password to access"
                }
                checked={passwordEnabled}
                onCheckedChange={(checked) => {
                  setPasswordEnabled(checked);
                  if (!checked) {
                    cancelPendingUpdate();
                    setLocalPassword("");
                    setShowPassword(false);
                    setPasswordTooLong(false);
                    immediateUpdate({ password: null });
                  }
                }}
              />
              {passwordEnabled && passwordHidden && (
                <p className="text-xs text-text-tertiary">Password set</p>
              )}
              {passwordEnabled && (
                <div className="relative">
                  <input
                    type={showPassword ? "text" : "password"}
                    value={localPassword}
                    // Keeps the browser from filling in a saved password,
                    // which would save it over the link's.
                    autoComplete="new-password"
                    onChange={(e) => {
                      setLocalPassword(e.target.value);
                      const next = e.target.value.trim();
                      // Over the limit the API refuses the save, and this
                      // panel would not show that, so it is never sent and
                      // the message below says why.
                      const tooLong = sharePasswordTooLong(next);
                      setPasswordTooLong(tooLong);
                      // An empty box is not "remove the password": the
                      // toggle above does that. Typing is only ever a new one.
                      if (next && !tooLong) debouncedUpdate({ password: next });
                      else cancelPendingUpdate();
                    }}
                    aria-invalid={passwordTooLong || undefined}
                    placeholder={
                      passwordHidden
                        ? "Type a new passphrase to replace it"
                        : "Enter passphrase"
                    }
                    className="w-full rounded-md border border-border bg-bg-tertiary px-3 py-2 pr-12 text-sm text-text-primary placeholder:text-text-tertiary outline-none focus:border-accent/50"
                  />
                  <button
                    onClick={() => setShowPassword(!showPassword)}
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-text-tertiary hover:text-text-primary transition-colors"
                    title={showPassword ? "Hide password" : "Show password"}
                  >
                    {showPassword ? (
                      <EyeOff className="h-4 w-4" />
                    ) : (
                      <Eye className="h-4 w-4" />
                    )}
                  </button>
                </div>
              )}
              {passwordEnabled && passwordTooLong && (
                <p role="alert" className="text-xs text-status-error">
                  {SHARE_PASSWORD_TOO_LONG}
                </p>
              )}

              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-sm text-text-primary">Expiration</p>
                  <p className="text-xs text-text-tertiary mt-0.5">
                    {shareLink.expires_at
                      ? `Expires ${new Date(shareLink.expires_at).toLocaleDateString()}`
                      : "Not set"}
                  </p>
                </div>
                <div className="flex items-center gap-1.5">
                  <Calendar className="h-3.5 w-3.5 text-text-tertiary" />
                  <input
                    type="date"
                    value={dateInputValue(shareLink.expires_at)}
                    onChange={(e) => {
                      const val = e.target.value;
                      immediateUpdate({
                        expires_at: val ? endOfDayISO(val) : null,
                      });
                    }}
                    className="w-[130px] rounded border border-border bg-bg-tertiary px-2 py-1 text-xs text-text-primary outline-none focus:border-accent/50 [color-scheme:auto]"
                  />
                </div>
              </div>

              <ToggleRow
                label="Watermark"
                description="Overlay watermark on content"
                checked={shareLink.show_watermark}
                onCheckedChange={(checked) =>
                  immediateUpdate({ show_watermark: checked })
                }
              />
            </Section>

            {/* Appearance — the same block the create dialog shows, minus the
                current-view copy: editing a saved link, there is no folder view
                on screen to copy from. An asset link gets only theme and accent. */}
            <Section
              title="Appearance"
              icon={<Paintbrush className="h-3.5 w-3.5" />}
              open={appearanceOpen}
              onOpenChange={setAppearanceOpen}
            >
              {/* Header banner */}
              <div className="rounded-lg border border-border bg-bg-tertiary/40 p-3">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <p className="text-sm text-text-primary">Header banner</p>
                    <p className="text-xs text-text-tertiary">Imagem, zoom e enquadramento do topo</p>
                  </div>
                  <button
                    onClick={() => setBannerDialogOpen(true)}
                    className="inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-xs font-medium text-text-primary hover:bg-bg-hover transition-colors"
                  >
                    <Pencil className="h-3.5 w-3.5" />
                    {appearance.header_banner_key ? "Editar" : "Configurar"}
                  </button>
                </div>
                {appearance.header_banner_url && (
                  <div className="relative mt-3 overflow-hidden rounded-md border border-border aspect-[16/5] bg-bg-tertiary">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={appearance.header_banner_url} alt="Prévia do banner" className="h-full w-full object-cover" style={{ objectPosition: `${appearance.header_banner_position_x}% ${appearance.header_banner_position_y}%`, transform: `scale(${appearance.header_banner_zoom})`, transformOrigin: `${appearance.header_banner_position_x}% ${appearance.header_banner_position_y}%` }} />
                    <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-bg-primary/80 to-transparent" />
                  </div>
                )}
              </div>

              <ShareAppearanceFields
                appearance={appearance}
                kind={shareLink.asset_id ? "asset" : "collection"}
                onChange={updateAppearance}
              />
            </Section>
          </div>
        ) : (
          <ShareLinkActivityPanel token={token} />
        )}
      </div>

      {/* Bottom action buttons */}
      <div className="border-t border-border p-3 shrink-0 flex items-center gap-2">
        <button
          onClick={() => window.open(shareUrl, "_blank")}
          className="flex-1 inline-flex items-center justify-center gap-2 rounded-lg bg-accent px-3 py-2 text-sm font-medium text-text-inverse hover:bg-accent/90 transition-colors"
        >
          <ExternalLink className="h-4 w-4" />
          Open Share Link
        </button>
        <CopyLinkButton text={shareUrl} />
      </div>
    </>
  );
}

// ─── Legacy default export (kept for backward compat, now delegates) ────────

export function ShareLinkDetail({
  token,
  projectId,
  onBack,
  frontendUrl,
}: ShareLinkContentProps) {
  return (
    <ShareLinkContent
      token={token}
      projectId={projectId}
      onBack={onBack}
      frontendUrl={frontendUrl}
    />
  );
}
