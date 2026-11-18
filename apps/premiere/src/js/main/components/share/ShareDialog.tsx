/**
 * Share panel for an asset. Two panes on one rail: the link itself, and the
 * advanced settings that slide in over the preview.
 *
 * It reuses the asset's existing review link rather than minting a second one
 * every time the dialog opens.
 */
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useApp } from "../../state";
import { copyText } from "../../../lib/freeframe/clipboard";
import type {
  Asset,
  ShareLink,
  ShareOptions,
  SharePermission,
} from "../../../lib/freeframe/types";
import { openLinkInBrowser } from "../../../lib/utils/bolt";
import { Dropdown, MenuRadio } from "../Dropdown";
import { Toggle } from "../Toggle";
import { ScrubThumb } from "../ScrubThumb";
import {
  IconCheck,
  IconChevronDown,
  IconChevronLeft,
  IconClock,
  IconComment,
  IconCopy,
  IconDownload,
  IconDroplet,
  IconExternal,
  IconFilm,
  IconGlobe,
  IconKey,
  IconLink,
  IconPlus,
  IconRename,
  IconTrash,
} from "../Icons";

const VISIBILITY = [
  { key: "public" as const, label: "Public", hint: "Anyone with the link" },
  { key: "secure" as const, label: "Secure", hint: "Sign-in required" },
];

/** The panel offers view/comment as a switch; approve stays a web-side choice. */
const permissionFor = (allowComments: boolean): SharePermission =>
  allowComments ? "comment" : "view";

export const ShareDialog = ({
  asset,
  onClose,
  onRenamed,
}: {
  asset: Asset;
  onClose: () => void;
  onRenamed?: (name: string) => void;
}) => {
  const { api, settings } = useApp();
  const [share, setShare] = useState<ShareLink | null>(null);
  const [shares, setShares] = useState<ShareLink[]>([]);
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(asset.name);
  const [renaming, setRenaming] = useState(false);
  const [invite, setInvite] = useState("");
  const [notice, setNotice] = useState("");
  const [copied, setCopied] = useState(false);
  const [copiedShareId, setCopiedShareId] = useState<string | null>(null);
  const [removingShareId, setRemovingShareId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(true);
  const [advanced, setAdvanced] = useState(false);

  // Draft settings, applied only when the advanced pane is confirmed.
  const [draft, setDraft] = useState<ShareOptions>({
    permission: "comment",
    visibility: "public",
    allow_download: true,
    show_versions: true,
    show_watermark: false,
    expires_at: null,
    password: null,
  });
  const [usePassphrase, setUsePassphrase] = useState(false);

  // The rail is sized to whichever pane is showing, so the taller settings
  // list is never clipped and the preview never bleeds through behind it.
  const mainPaneRef = useRef<HTMLDivElement>(null);
  const advancedPaneRef = useRef<HTMLDivElement>(null);
  const [railHeight, setRailHeight] = useState(0);

  useLayoutEffect(() => {
    const node = advanced ? advancedPaneRef.current : mainPaneRef.current;
    if (!node) return;
    const measure = () => setRailHeight(node.offsetHeight);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [advanced, usePassphrase, share]);

  const webBase = (settings.webUrl || settings.serverUrl).replace(/\/+$/, "");
  const url = share ? `${webBase}/s/${share.short_code ?? share.token}` : "";
  const urlOf = (entry: ShareLink) => `${webBase}/s/${entry.short_code ?? entry.token}`;

  const setEditorShare = (link: ShareLink) => {
    setShare(link);
    setDraft({
      permission: link.permission,
      visibility: link.visibility,
      allow_download: link.allow_download,
      show_versions: link.show_versions,
      show_watermark: link.show_watermark ?? false,
      expires_at: link.expires_at ?? null,
      password: null,
    });
    setUsePassphrase(!!link.has_password);
  };

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const existing = await api.shares(asset.id);
        if (cancelled) return;
        setShares(existing);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setBusy(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [api, asset.id]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      // Escape backs out of the settings pane before closing the dialog.
      if (advanced) setAdvanced(false);
      else if (editing) setEditing(false);
      else onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [advanced, editing, onClose]);

  const flash = (message: string) => {
    setNotice(message);
    setTimeout(() => setNotice(""), 2500);
  };

  /**
   * The API has no PATCH for a link, so applying settings mints a fresh one.
   * The previous link keeps working — deliberately, since it may already be
   * out with reviewers.
   */
  const apply = async () => {
    setBusy(true);
    try {
      const next = await api.createShare(asset.id, {
        ...draft,
        password: usePassphrase ? draft.password || undefined : undefined,
        expires_at: draft.expires_at || undefined,
      });
      setEditorShare(next);
      setShares((current) => [next, ...current]);
      setAdvanced(false);
      flash("New link created with those settings.");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
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
      onRenamed?.(trimmed);
    } catch (e) {
      setName(asset.name);
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const onInvite = async () => {
    const email = invite.trim();
    if (!email) return;
    try {
      await api.shareWithUser(asset.id, email, share?.permission ?? "comment");
      setInvite("");
      flash(`Shared with ${email}.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const copy = () => {
    void copyText(url);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const copyListedShare = (entry: ShareLink) => {
    void copyText(urlOf(entry));
    setCopiedShareId(entry.id);
    setTimeout(() => setCopiedShareId(null), 2000);
  };

  const createNewLink = async () => {
    setBusy(true);
    setError("");
    try {
      const next = await api.createShare(asset.id);
      setShares((current) => [next, ...current]);
      setEditorShare(next);
      setAdvanced(false);
      setEditing(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const removeShare = async (entry: ShareLink) => {
    setRemovingShareId(entry.id);
    setError("");
    try {
      await api.revokeShare(entry.token);
      setShares((current) => current.filter((currentShare) => currentShare.id !== entry.id));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRemovingShareId(null);
    }
  };

  const summary = share
    ? `Anyone with the link can view${share.permission !== "view" ? ", comment" : ""}${
        share.allow_download ? " and download" : ""
      }.`
    : "…";

  if (!editing) {
    return (
      <div className="scrim" onClick={onClose}>
        <div
          className="share-dialog collection-share-dialog"
          onClick={(event) => event.stopPropagation()}
        >
          <div className="share-head">
            <h3>Share {asset.name}</h3>
            <button className="primary with-icon" onClick={createNewLink} disabled={busy}>
              <IconPlus width={14} height={14} />
              New link
            </button>
          </div>
          <p className="muted">Manage the links that share this video.</p>

          <div className="collection-share-list">
            {busy && <p className="muted">Loading links…</p>}
            {!busy && !shares.length && (
              <p className="muted">No links yet. Create one when you are ready to share this video.</p>
            )}
            {shares.map((entry) => {
              const entryUrl = urlOf(entry);
              return (
                <div className="collection-share-row" key={entry.id}>
                  <div className="link-box">
                    <input type="text" readOnly value={entryUrl} />
                    {copiedShareId === entry.id && (
                      <span className="copied">
                        Link copied! <IconCheck width={12} height={12} />
                      </span>
                    )}
                    <button className="icon-btn" onClick={() => copyListedShare(entry)} title="Copy link">
                      <IconLink width={15} height={15} />
                    </button>
                  </div>
                  <div className="collection-share-actions">
                    <button className="text-btn" onClick={() => openLinkInBrowser(entryUrl)} title="Open link">
                      <IconExternal width={14} height={14} />
                      Open
                    </button>
                    <button
                      className="text-btn danger"
                      onClick={() => removeShare(entry)}
                      disabled={removingShareId === entry.id}
                      title="Delete link"
                    >
                      <IconTrash width={14} height={14} />
                      {removingShareId === entry.id ? "Deleting…" : "Delete"}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>

          {error && <p className="error">{error}</p>}
          <div className="share-foot">
            <span className="spacer" />
            <button className="primary" onClick={onClose}>Done</button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="scrim" onClick={onClose}>
      <div className="share-dialog" onClick={(event) => event.stopPropagation()}>
        <div className="share-head">
          {renaming ? (
            <span className="share-rename">
              <input
                type="text"
                value={name}
                autoFocus
                onChange={(event) => setName(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") onRename();
                  if (event.key === "Escape") {
                    setName(asset.name);
                    setRenaming(false);
                  }
                }}
              />
              <button className="icon-btn" onClick={onRename} title="Save name">
                <IconCheck width={14} height={14} />
              </button>
            </span>
          ) : (
            <>
              <h3>{name}</h3>
              <button className="icon-btn" onClick={() => setRenaming(true)} title="Rename">
                <IconRename width={14} height={14} />
              </button>
            </>
          )}
        </div>

        <div className="link-box">
          <input type="text" readOnly value={busy && !share ? "Creating link…" : url} />
          {copied && (
            <span className="copied">
              Link copied!
              <IconCheck width={12} height={12} />
            </span>
          )}
          <button className="icon-btn" onClick={copy} disabled={!url} title="Copy link">
            <IconLink width={15} height={15} />
          </button>
          <Dropdown
            align="right"
            triggerClass="visibility-trigger"
            trigger={
              <>
                <IconGlobe width={14} height={14} />
                {VISIBILITY.find((entry) => entry.key === (share?.visibility ?? "public"))
                  ?.label}
                <IconChevronDown width={13} height={13} />
              </>
            }
          >
            {(close) =>
              VISIBILITY.map((entry) => (
                <MenuRadio
                  key={entry.key}
                  label={`${entry.label} — ${entry.hint}`}
                  checked={(share?.visibility ?? "public") === entry.key}
                  onSelect={() => {
                    setDraft((current) => ({ ...current, visibility: entry.key }));
                    close();
                  }}
                />
              ))
            }
          </Dropdown>
        </div>

        <div className="share-invite">
          <input
            type="email"
            placeholder="Add a name or email"
            value={invite}
            onChange={(event) => setInvite(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") onInvite();
            }}
          />
          {!!invite.trim() && (
            <button className="primary" onClick={onInvite}>
              Invite
            </button>
          )}
        </div>

        {/* Two panes on one rail: the preview slides out, settings slide in. */}
        <div className="share-rail" style={{ height: railHeight || undefined }}>
          <div className={`share-panes${advanced ? " advanced" : ""}`}>
            <div className="share-pane" ref={mainPaneRef}>
              <div className="share-preview">
                <ScrubThumb api={api} assetId={asset.id} thumbnailUrl={asset.thumbnail_url}>
                  {!asset.thumbnail_url && <IconFilm width={26} height={26} />}
                </ScrubThumb>
              </div>
              <button className="share-settings" onClick={() => setAdvanced(true)}>
                <span>
                  <strong>Settings</strong>
                  <em>{summary}</em>
                </span>
                <IconChevronDown
                  width={14}
                  height={14}
                  style={{ transform: "rotate(-90deg)" }}
                />
              </button>
            </div>

            <div className="share-pane" ref={advancedPaneRef}>
              <div className="share-setting">
                <IconComment width={15} height={15} />
                <Toggle
                  label="Allow comments"
                  checked={draft.permission !== "view"}
                  onChange={(value) =>
                    setDraft((c) => ({ ...c, permission: permissionFor(value) }))
                  }
                />
              </div>

              <div className="share-setting">
                <IconDownload width={15} height={15} />
                <Toggle
                  label="Allow downloads"
                  checked={draft.allow_download}
                  onChange={(value) => setDraft((c) => ({ ...c, allow_download: value }))}
                />
              </div>

              <div className="share-setting">
                <IconKey width={15} height={15} />
                <Toggle
                  label="Passphrase"
                  checked={usePassphrase}
                  onChange={(value) => {
                    setUsePassphrase(value);
                    if (!value) setDraft((c) => ({ ...c, password: null }));
                  }}
                />
              </div>
              {usePassphrase && (
                <input
                  className="share-passphrase"
                  type="text"
                  placeholder={
                    share?.has_password ? "Replace the passphrase" : "Set a passphrase"
                  }
                  value={draft.password ?? ""}
                  onChange={(event) =>
                    setDraft((c) => ({ ...c, password: event.target.value }))
                  }
                />
              )}

              <div className="share-setting">
                <IconClock width={15} height={15} />
                <span>Expiration date</span>
                <input
                  type="date"
                  value={draft.expires_at ? draft.expires_at.slice(0, 10) : ""}
                  onChange={(event) =>
                    setDraft((c) => ({
                      ...c,
                      expires_at: event.target.value
                        ? new Date(`${event.target.value}T23:59:59`).toISOString()
                        : null,
                    }))
                  }
                />
              </div>

              <div className="share-setting">
                <IconDroplet width={15} height={15} />
                <Toggle
                  label="Watermark"
                  checked={draft.show_watermark}
                  onChange={(value) => setDraft((c) => ({ ...c, show_watermark: value }))}
                />
              </div>
            </div>
          </div>
        </div>

        {notice && <p className="notice">{notice}</p>}
        {error && <p className="error">{error}</p>}

        <div className="share-foot">
          {advanced ? (
            <>
              <button onClick={() => setAdvanced(false)}>
                <IconChevronLeft width={14} height={14} />
                Back
              </button>
              <span className="spacer" />
              <button className="primary" onClick={apply} disabled={busy}>
                {busy ? "Working…" : "Create"}
              </button>
            </>
          ) : (
            <>
              <button
                className="text-btn"
                onClick={() =>
                  openLinkInBrowser(
                    `${webBase}/projects/${asset.project_id}/assets/${asset.id}`
                  )
                }
              >
                Open in browser
                <IconExternal width={12} height={12} />
              </button>
              <span className="spacer" />
              <button disabled={!url} onClick={copy}>
                <IconCopy width={14} height={14} />
                Copy Link
              </button>
              <button className="primary" onClick={onClose}>
                Done
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
};
