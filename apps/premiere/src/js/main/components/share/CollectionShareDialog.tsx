import { useCallback, useEffect, useState } from "react";
import { useApp } from "../../state";
import type { ShareLink, ShareOptions } from "../../../lib/freeframe/types";
import { copyText } from "../../../lib/freeframe/clipboard";
import { openLinkInBrowser } from "../../../lib/utils/bolt";
import { Dropdown, MenuRadio } from "../Dropdown";
import { Toggle } from "../Toggle";
import {
  IconCheck,
  IconChevronDown,
  IconChevronLeft,
  IconClock,
  IconComment,
  IconDownload,
  IconDroplet,
  IconExternal,
  IconGlobe,
  IconKey,
  IconLink,
  IconPlus,
  IconTrash,
} from "../Icons";

const VISIBILITY = [
  { key: "public" as const, label: "Public" },
  { key: "secure" as const, label: "Secure" },
];

/** Lists and manages the public links for the folder currently open in Assets. */
export const CollectionShareDialog = ({
  projectId,
  folderId,
  name,
  onClose,
}: {
  projectId: string;
  folderId: string | null;
  name: string;
  onClose: () => void;
}) => {
  const { api, settings } = useApp();
  const [shares, setShares] = useState<ShareLink[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [creatingForm, setCreatingForm] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState<string | null>(null);
  const [draftName, setDraftName] = useState(name);
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
  const webBase = (settings.webUrl || settings.serverUrl).replace(/\/+$/, "");
  const target = folderId ? "folder" : "project";

  const urlOf = (share: ShareLink) => `${webBase}/s/${share.short_code ?? share.token}`;

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      setShares(folderId ? await api.folderShares(folderId) : await api.projectShares(projectId));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, [api, folderId, projectId]);

  useEffect(() => {
    load();
  }, [load]);

  const copy = (share: ShareLink) => {
    void copyText(urlOf(share));
    setCopied(share.id);
    setTimeout(() => setCopied(null), 2000);
  };

  const beginCreate = () => {
    setDraftName(name);
    setDraft({
      permission: "comment",
      visibility: "public",
      allow_download: true,
      show_versions: true,
      show_watermark: false,
      expires_at: null,
      password: null,
    });
    setUsePassphrase(false);
    setCreatingForm(true);
  };

  const create = async () => {
    setCreating(true);
    setError("");
    try {
      const share = folderId
        ? await api.createFolderShare(folderId, {
            ...draft,
            title: draftName.trim() || name,
            password: usePassphrase ? draft.password || undefined : undefined,
            expires_at: draft.expires_at || undefined,
          })
        : await api.createProjectShare(projectId, {
            ...draft,
            title: draftName.trim() || name,
            password: usePassphrase ? draft.password || undefined : undefined,
            expires_at: draft.expires_at || undefined,
          });
      setShares((current) => [share, ...current]);
      setCreatingForm(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setCreating(false);
    }
  };

  const remove = async (share: ShareLink) => {
    setRemoving(share.id);
    setError("");
    try {
      await api.revokeShare(share.token);
      setShares((current) => current.filter((entry) => entry.id !== share.id));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setRemoving(null);
    }
  };

  return (
    <div className="scrim" onClick={onClose}>
      <div className="share-dialog collection-share-dialog" onClick={(event) => event.stopPropagation()}>
        <div className="share-head">
          <h3>Share {name}</h3>
          {!creatingForm && <button className="primary with-icon" onClick={beginCreate}>
            <IconPlus width={14} height={14} />
            New link
          </button>}
        </div>
        <p className="muted">
          {folderId
            ? "Everyone with a link can review the assets in this folder."
            : "Everyone with a link can review the assets in this project."}
        </p>

        {creatingForm ? (
          <div className="collection-share-form">
            <label>
              Link name
              <input value={draftName} onChange={(event) => setDraftName(event.target.value)} />
            </label>
            <div className="share-setting">
              <IconGlobe width={15} height={15} />
              <span>Visibility</span>
              <Dropdown
                align="right"
                triggerClass="visibility-trigger"
                trigger={<><IconGlobe width={14} height={14} />{VISIBILITY.find((entry) => entry.key === draft.visibility)?.label}<IconChevronDown width={13} height={13} /></>}
              >
                {(close) => VISIBILITY.map((entry) => (
                  <MenuRadio key={entry.key} label={entry.label} checked={draft.visibility === entry.key} onSelect={() => { setDraft((current) => ({ ...current, visibility: entry.key })); close(); }} />
                ))}
              </Dropdown>
            </div>
            <div className="share-setting collection-share-toggle">
              <IconComment width={15} height={15} />
              <Toggle label="Allow comments" checked={draft.permission !== "view"} onChange={(value) => setDraft((current) => ({ ...current, permission: value ? "comment" : "view" }))} />
            </div>
            <div className="share-setting collection-share-toggle">
              <IconDownload width={15} height={15} />
              <Toggle label="Allow downloads" checked={draft.allow_download} onChange={(value) => setDraft((current) => ({ ...current, allow_download: value }))} />
            </div>
            <div className="share-setting collection-share-toggle">
              <IconKey width={15} height={15} />
              <Toggle label="Passphrase" checked={usePassphrase} onChange={(value) => { setUsePassphrase(value); if (!value) setDraft((current) => ({ ...current, password: null })); }} />
            </div>
            {usePassphrase && <input className="share-passphrase" type="text" placeholder="Set a passphrase" value={draft.password ?? ""} onChange={(event) => setDraft((current) => ({ ...current, password: event.target.value }))} />}
            <div className="share-setting">
              <IconClock width={15} height={15} />
              <span>Expiration date</span>
              <input type="date" value={draft.expires_at ? draft.expires_at.slice(0, 10) : ""} onChange={(event) => setDraft((current) => ({ ...current, expires_at: event.target.value ? new Date(`${event.target.value}T23:59:59`).toISOString() : null }))} />
            </div>
            <div className="share-setting collection-share-toggle">
              <IconDroplet width={15} height={15} />
              <Toggle label="Watermark" checked={draft.show_watermark} onChange={(value) => setDraft((current) => ({ ...current, show_watermark: value }))} />
            </div>
          </div>
        ) : <div className="collection-share-list">
          {loading && <p className="muted">Loading links…</p>}
          {!loading && !shares.length && (
            <p className="muted">No links yet. Create one when you are ready to share this {target}.</p>
          )}
          {shares.map((share) => {
            const url = urlOf(share);
            return (
              <div className="collection-share-row" key={share.id}>
                <div className="link-box">
                  <input type="text" readOnly value={url} />
                  {copied === share.id && (
                    <span className="copied">
                      Link copied! <IconCheck width={12} height={12} />
                    </span>
                  )}
                  <button className="icon-btn" onClick={() => copy(share)} title="Copy link">
                    <IconLink width={15} height={15} />
                  </button>
                </div>
                <div className="collection-share-actions">
                  <button className="text-btn" onClick={() => openLinkInBrowser(url)} title="Open link">
                    <IconExternal width={14} height={14} />
                    Open
                  </button>
                  <button
                    className="text-btn danger"
                    onClick={() => remove(share)}
                    disabled={removing === share.id}
                    title="Delete link"
                  >
                    <IconTrash width={14} height={14} />
                    {removing === share.id ? "Deleting…" : "Delete"}
                  </button>
                </div>
              </div>
            );
          })}
        </div>}

        {error && <p className="error">{error}</p>}
        <div className="share-foot">
          {creatingForm ? <>
            <button onClick={() => setCreatingForm(false)} disabled={creating}><IconChevronLeft width={14} height={14} />Back</button>
            <span className="spacer" />
            <button className="primary" onClick={create} disabled={creating}>{creating ? "Creating…" : "Create"}</button>
          </> : <><span className="spacer" /><button className="primary" onClick={onClose}>Done</button></>}
        </div>
      </div>
    </div>
  );
};
