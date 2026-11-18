"use client";

import * as React from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import {
  CheckCircle2,
  Clock,
  ChevronDown,
  ChevronRight,
  MessageSquare,
  Smile,
  MoreHorizontal,
  Pencil,
  Link2,
  Trash2,
  Globe,
  ListFilter,
  ArrowUpDown,
  Search,
  X,
  Paperclip,
  Circle,
  Mail,
  AtSign,
  Hash,
  User,
  Check,
  Send,
  Lock,
  Download,
} from "lucide-react";
import { cn, copyToClipboard, formatTime, formatRelativeTime } from "@/lib/utils";
import { buildCommentNumbers } from "@/lib/comment-numbers";
import type { Asset } from "@/types";
import { useReviewStore } from "@/stores/review-store";
import type { CommentWithReplies } from "@/hooks/use-comments";
import {
  exportComments,
  FpsRequiredError,
  type ExportFormat,
} from "@/lib/export-comments";
import { FpsPromptDialog } from "@/components/review/fps-prompt-dialog";
import { Avatar } from "@/components/shared/avatar";
import { CommentThreadConnector } from "@/components/comments/comment-thread-connector";
import { CommentAttachment } from "@/components/review/comment-attachment";
import { submitCommentWithAttachment, validateCommentAttachment } from "@/lib/comment-attachments";

// ─── Props ────────────────────────────────────────────────────────────────────

interface CommentPanelProps {
  comments: CommentWithReplies[];
  isLoading?: boolean;
  currentUserId?: string;
  newCommentIds?: readonly string[];
  /** Grants deletion without granting edit rights (for project administrators). */
  canDeleteComment?: (comment: CommentWithReplies) => boolean;
  canManageComment?: (comment: CommentWithReplies) => boolean;
  /** Saves an edit. Without it the panel PATCHes the comment itself. */
  onUpdate?: (commentId: string, body: string) => Promise<void>;
  onResolve: (commentId: string) => Promise<void>;
  onDelete: (commentId: string) => Promise<void>;
  onAddReaction: (commentId: string, emoji: string) => Promise<void>;
  onRemoveReaction: (commentId: string, emoji: string) => Promise<void>;
  onReply: (parentId: string) => void;
  onSubmitReply?: (parentId: string, body: string) => Promise<{ id: string } | void>;
  onAttachmentsUploaded?: () => void;
  onDeleteAttachment?: (commentId: string, attachmentId: string) => Promise<void>;
  disableAttachments?: boolean;
  /** Compare mode: route comment-timecode clicks to a pane-scoped transport instead of the global store. */
  onSeekToTimecode?: (time: number, pause?: boolean) => void;
  /** Compare mode: route annotation display to a pane-scoped overlay instead of the global store. */
  onShowAnnotation?: (drawingData: Record<string, unknown> | null) => void;
  /** Compare mode: export this pane's version instead of the store's currentVersion. */
  exportVersionId?: string;
  /**
   * Export this asset instead of the review store's `currentAsset`.
   *
   * Required wherever the panel is rendered outside the review screen. The
   * store is written by `review-provider.tsx` and nothing clears it -- there is
   * no unmount cleanup and the back arrow is a client-side navigation -- so on
   * the project page it still holds whichever asset was opened last. Reading it
   * there does not fail, it exports the wrong asset's comments under the wrong
   * name, which is worse than doing nothing.
   */
  exportAsset?: Asset | null;
  /**
   * Whether to offer the comment export control. Defaults to true.
   *
   * `exportComments` authenticates with `Bearer ${getAccessToken()}` and nothing
   * else, so on a share link, where the viewer is a guest with no token, the
   * request can only 401. Set this false wherever the panel is rendered for
   * someone who cannot authenticate, so the control is absent rather than
   * present and guaranteed to fail.
   */
  canExport?: boolean;
  /**
   * Whether the viewer may delete other people's comments. Defaults to false.
   *
   * Mirrors `delete_comment`, which lets a project owner delete any comment on
   * the project, guests' included. Delete only: editing stays with the author.
   */
  canModerate?: boolean;
  className?: string;
}

// ─── Emoji picker ────────────────────────────────────────────────────────────

const QUICK_EMOJIS = ["👍", "❤️", "😂", "😮", "😢", "🔥"];

const REPLY_EMOJIS = [
  "👍",
  "👎",
  "❤️",
  "🔥",
  "👀",
  "🎉",
  "😂",
  "😮",
  "😢",
  "💯",
  "✅",
  "❌",
  "⭐",
  "💡",
  "🤔",
  "👏",
];

// ─── Avatar colors ───────────────────────────────────────────────────────────

const AVATAR_COLORS = [
  "bg-orange-500",
  "bg-blue-500",
  "bg-emerald-500",
  "bg-purple-500",
  "bg-rose-500",
  "bg-amber-500",
  "bg-cyan-500",
  "bg-pink-500",
];

function getAvatarColor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
}

// ─── useClickOutside ─────────────────────────────────────────────────────────

function useClickOutside(
  ref: React.RefObject<HTMLElement | null>,
  handler: () => void,
  active: boolean,
) {
  React.useEffect(() => {
    if (!active) return;
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) handler();
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [active, ref, handler]);
}

// ─── Dropdown wrapper ────────────────────────────────────────────────────────

function Dropdown({
  open,
  onClose,
  children,
  className,
  align = "left",
}: {
  open: boolean;
  onClose: () => void;
  children: React.ReactNode;
  className?: string;
  align?: "left" | "right";
}) {
  const ref = React.useRef<HTMLDivElement>(null);
  useClickOutside(ref, onClose, open);

  if (!open) return null;

  return (
    <div
      ref={ref}
      onClick={(event) => event.stopPropagation()}
      className={cn(
        "absolute top-full mt-1 z-50 rounded-xl border border-border bg-bg-elevated shadow-2xl py-1.5 animate-in fade-in zoom-in-95 duration-100",
        align === "right" ? "right-0" : "left-0",
        className,
      )}
    >
      {children}
    </div>
  );
}

// ─── Context menu ────────────────────────────────────────────────────────────

function CommentMenu({
  open,
  onOpenChange,
  canEdit,
  canDelete,
  commentId,
  assetId,
  onEdit,
  onDelete,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  canEdit: boolean;
  canDelete: boolean;
  commentId: string;
  assetId?: string;
  onEdit: () => void;
  onDelete: (commentId: string) => Promise<void>;
}) {
  if (!canEdit && !canDelete) return null;

  return (
    <DropdownMenu.Root open={open} onOpenChange={onOpenChange}>
      <DropdownMenu.Trigger asChild>
        <button
        onClick={(event) => {
          event.stopPropagation();
        }}
        aria-label="Comment actions"
        aria-expanded={open}
        aria-haspopup="menu"
        className="mobile-touch-target h-7 w-7 flex items-center justify-center rounded-full text-text-tertiary hover:text-text-secondary hover:bg-bg-tertiary transition-colors"
      >
        <MoreHorizontal className="h-4 w-4" />
      </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="end"
          sideOffset={4}
          collisionPadding={8}
          onClick={(event) => event.stopPropagation()}
          className="z-[1000] w-44 rounded-xl border border-border bg-bg-elevated shadow-2xl py-1.5 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95"
        >
        {canEdit && (
          <DropdownMenu.Item
            className="flex w-full cursor-pointer items-center gap-2.5 px-3 py-2 text-[13px] text-text-secondary outline-none data-[highlighted]:bg-bg-tertiary"
            onSelect={() => onEdit()}
          >
            <Pencil className="h-3.5 w-3.5" />
            Edit
          </DropdownMenu.Item>
        )}
        <DropdownMenu.Item
          className="flex w-full cursor-pointer items-center gap-2.5 px-3 py-2 text-[13px] text-text-secondary outline-none data-[highlighted]:bg-bg-tertiary"
          onSelect={() => {
            let url: URL
            if (assetId && window.location.pathname.match(/\/projects\/[^/]+$/)) {
              url = new URL(`${window.location.pathname}/assets/${assetId}`, window.location.origin)
            } else {
              url = new URL(window.location.href)
            }
            url.searchParams.set('commentId', commentId)
            void copyToClipboard(url.toString())
          }}
        >
          <Link2 className="h-3.5 w-3.5" />
          Copy Link
        </DropdownMenu.Item>
        {canDelete && (
          <DropdownMenu.Item
            className="flex w-full cursor-pointer items-center gap-2.5 px-3 py-2 text-[13px] text-red-400 outline-none data-[highlighted]:bg-bg-tertiary"
            onSelect={() => {
              onDelete(commentId);
            }}
          >
            <Trash2 className="h-3.5 w-3.5" />
            Delete
          </DropdownMenu.Item>
        )}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

// ─── Inline reply input (Frame.io style) ─────────────────────────────────────

function InlineReplyInput({
  parentId,
  onSubmit,
  onCancel,
  onAttachmentsUploaded,
  disableAttachments = false,
}: {
  parentId: string;
  onSubmit: (parentId: string, body: string) => Promise<{ id: string } | void>;
  onCancel: () => void;
  onAttachmentsUploaded?: () => void;
  disableAttachments?: boolean;
}) {
  const [body, setBody] = React.useState("");
  const [submitting, setSubmitting] = React.useState(false);
  const [emojiOpen, setEmojiOpen] = React.useState(false);
  const inputRef = React.useRef<HTMLInputElement>(null);
  const emojiRef = React.useRef<HTMLDivElement>(null);
  const attachmentInputRef = React.useRef<HTMLInputElement>(null);
  const [attachment, setAttachment] = React.useState<File | null>(null);
  const [attachmentCommentId, setAttachmentCommentId] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Close emoji picker on outside click
  React.useEffect(() => {
    if (!emojiOpen) return;
    function handleClick(e: MouseEvent) {
      if (emojiRef.current && !emojiRef.current.contains(e.target as Node)) {
        setEmojiOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [emojiOpen]);

  async function handleSubmit() {
    const trimmed = body.trim();
    if (!trimmed || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const commentId = await submitCommentWithAttachment(
        attachmentCommentId,
        attachment,
        () => onSubmit(parentId, trimmed),
        onAttachmentsUploaded,
      );
      if (attachment && commentId) setAttachmentCommentId(commentId);
      setBody("");
      setAttachment(null);
      setAttachmentCommentId(null);
      onCancel();
    } catch (err) {
      // Keep the typed reply and say why. An Error with an empty message is a
      // deliberate quiet abort (e.g. the guest dismissed the name prompt).
      const message = err instanceof Error ? err.message : "Couldn't send the reply";
      setError(message || null);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="mt-2 border-t border-border pt-3 pb-1">
      <input
        ref={inputRef}
        type="text"
        className="w-full rounded-lg border border-border bg-bg-tertiary px-3 py-2 text-[16px] [@media(hover:hover)]:text-[13px] text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-accent/50 focus:ring-1 focus:ring-accent/20"
        placeholder="Leave your reply here..."
        value={body}
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            handleSubmit();
          }
          if (e.key === "Escape") onCancel();
        }}
      />
      {error && (
        <p role="alert" className="mt-1.5 text-[12px] text-status-error">
          {error}
        </p>
      )}
      {!disableAttachments && attachment && (
        <div className="mt-2 flex w-fit items-center gap-1.5 rounded-md bg-bg-tertiary px-2 py-1 text-xs text-text-secondary">
          <Paperclip className="h-3.5 w-3.5" />
          <span className="max-w-48 truncate">{attachment.name}</span>
          <button type="button" onClick={() => setAttachment(null)} className="text-text-tertiary hover:text-text-primary" title="Remove attachment"><X className="h-3.5 w-3.5" /></button>
        </div>
      )}
      <div className="flex items-center justify-between mt-2">
        <div className="flex items-center gap-1">
          {!disableAttachments && <input ref={attachmentInputRef} type="file" className="hidden" onChange={(event) => {
            const file = event.target.files?.[0]; event.target.value = '';
            if (!file) return;
            const validationError = validateCommentAttachment(file);
            if (validationError) { setError(validationError); return; }
            setError(null); setAttachment(file);
          }} />}
          {!disableAttachments && <button type="button" onClick={() => attachmentInputRef.current?.click()} title="Attach file" className="mobile-touch-target h-7 w-7 flex items-center justify-center rounded-md text-text-tertiary hover:bg-bg-tertiary hover:text-text-secondary transition-colors">
            <Paperclip className="h-4 w-4" />
          </button>}
          <div className="relative" ref={emojiRef}>
            <button
              onClick={() => setEmojiOpen((p) => !p)}
              className="mobile-touch-target h-7 w-7 flex items-center justify-center rounded-md text-text-tertiary hover:bg-bg-tertiary hover:text-text-secondary transition-colors"
              title="Add emoji"
            >
              <Smile className="h-4 w-4" />
            </button>
            {emojiOpen && (
              <div className="absolute bottom-full left-1/2 -translate-x-1/2 slide-in-from-left-1/2 mb-2 z-50 rounded-lg border border-border bg-bg-elevated shadow-2xl p-1.5 animate-in fade-in zoom-in-95 duration-100 w-[200px]">
                <div className="grid grid-cols-8 gap-px">
                  {REPLY_EMOJIS.map((e) => (
                    <button
                      key={e}
                      className="h-6 w-6 rounded flex items-center justify-center text-sm hover:bg-bg-hover transition-colors"
                      onClick={() => {
                        setBody((prev) => prev + e);
                        setEmojiOpen(false);
                        inputRef.current?.focus();
                      }}
                    >
                      {e}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={onCancel}
            className="px-3 py-1 text-[12px] font-medium text-text-secondary hover:text-text-primary rounded-md border border-border hover:bg-bg-tertiary transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            disabled={!body.trim() || submitting}
            className="mobile-touch-target h-7 w-7 flex items-center justify-center rounded-full bg-accent text-text-inverse hover:bg-accent/90 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
          >
            <Send className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Single comment item ──────────────────────────────────────────────────────

interface CommentItemProps {
  comment: CommentWithReplies;
  commentNumber?: number;
  depth?: number;
  currentUserId?: string;
  newCommentIds?: readonly string[];
  canDeleteComment?: (comment: CommentWithReplies) => boolean;
  canManageComment?: (comment: CommentWithReplies) => boolean;
  canModerate?: boolean;
  onUpdate?: (commentId: string, body: string) => Promise<void>;
  replyingTo?: string | null;
  isFocused?: boolean;
  onResolve: (commentId: string) => Promise<void>;
  onDelete: (commentId: string) => Promise<void>;
  onAddReaction: (commentId: string, emoji: string) => Promise<void>;
  onRemoveReaction: (commentId: string, emoji: string) => Promise<void>;
  onReply: (parentId: string) => void;
  onCancelReply: () => void;
  onSubmitReply?: (parentId: string, body: string) => Promise<{ id: string } | void>;
  onAttachmentsUploaded?: () => void;
  onDeleteAttachment?: (commentId: string, attachmentId: string) => Promise<void>;
  disableAttachments?: boolean;
  onSeekToTimecode?: (time: number, pause?: boolean) => void;
  onShowAnnotation?: (drawingData: Record<string, unknown> | null) => void;
}

function CommentItem({
  comment,
  commentNumber,
  depth = 0,
  currentUserId,
  newCommentIds,
  canDeleteComment,
  canManageComment,
  canModerate,
  onUpdate,
  replyingTo,
  isFocused,
  onResolve,
  onDelete,
  onAddReaction,
  onRemoveReaction,
  onReply,
  onCancelReply,
  onSubmitReply,
  onAttachmentsUploaded,
  onDeleteAttachment,
  disableAttachments,
  onSeekToTimecode,
  onShowAnnotation,
}: CommentItemProps) {
  const storeSeekTo = useReviewStore((s) => s.seekTo);
  const seekTo = onSeekToTimecode ?? storeSeekTo;
  const setActiveAnnotation = useReviewStore((s) => s.setActiveAnnotation);
  const showAnnotation = onShowAnnotation ?? setActiveAnnotation;
  const setFocusedCommentId = useReviewStore((s) => s.setFocusedCommentId);
  const itemRef = React.useRef<HTMLDivElement>(null);
  const [showEmojiPicker, setShowEmojiPicker] = React.useState(false);
  const [menuOpen, setMenuOpen] = React.useState(false);
  const [resolving, setResolving] = React.useState(false);
  const [editing, setEditing] = React.useState(false);
  const [editBody, setEditBody] = React.useState(comment.body);
  const [saving, setSaving] = React.useState(false);
  const [actionError, setActionError] = React.useState<string | null>(null);

  // Scroll into view when focused from progress bar marker click
  React.useEffect(() => {
    if (isFocused && itemRef.current) {
      itemRef.current.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }, [isFocused]);

  const authorName =
    comment.author?.name ?? comment.guest_author?.name ?? "Unknown";
  const isOwn = !!(currentUserId && comment.author_id === currentUserId);
  const isNew = newCommentIds?.includes(comment.id) ?? false;
  const canEdit = canManageComment?.(comment) ?? isOwn;
  // A moderator (project owner) may delete anyone's comment, guests' included,
  // but editing stays with the author.
  const canDelete =
    canDeleteComment?.(comment) ?? canManageComment?.(comment) ?? (isOwn || !!canModerate);
  const avatarColor = getAvatarColor(authorName);
  const isReplyingHere = replyingTo === comment.id;
  const hasReplies = (comment.replies?.length ?? 0) > 0;

  // Group reactions by emoji
  const reactionGroups = React.useMemo(() => {
    const groups: Record<
      string,
      { emoji: string; count: number; userReacted: boolean }
    > = {};
    for (const r of comment.reactions ?? []) {
      if (!groups[r.emoji]) {
        groups[r.emoji] = { emoji: r.emoji, count: 0, userReacted: false };
      }
      groups[r.emoji].count++;
      if (r.user_id === currentUserId) groups[r.emoji].userReacted = true;
    }
    return Object.values(groups);
  }, [comment.reactions, currentUserId]);

  async function handleResolve() {
    setResolving(true);
    try {
      await onResolve(comment.id);
    } finally {
      setResolving(false);
    }
  }

  async function handleReactionClick(emoji: string, userReacted: boolean) {
    if (userReacted) await onRemoveReaction(comment.id, emoji);
    else await onAddReaction(comment.id, emoji);
  }

  async function handleQuickEmoji(emoji: string) {
    setShowEmojiPicker(false);
    const existing = reactionGroups.find((r) => r.emoji === emoji);
    if (existing?.userReacted) await onRemoveReaction(comment.id, emoji);
    else await onAddReaction(comment.id, emoji);
  }

  async function handleUpdate() {
    setSaving(true);
    setActionError(null);
    try {
      const nextBody = editBody.trim();
      if (onUpdate) {
        await onUpdate(comment.id, nextBody);
      } else {
        const { api } = await import("@/lib/api");
        await api.patch(`/comments/${comment.id}`, { body: nextBody });
        comment.body = nextBody;
      }
      setEditing(false);
    } catch {
      setActionError('Could not save this comment. Please try again.');
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    setActionError(null);
    try {
      await onDelete(comment.id);
    } catch {
      setActionError('Could not delete this comment. Please try again.');
    }
  }

  return (
    <CommentThreadConnector active={depth === 0 && hasReplies} className={menuOpen ? "z-20" : undefined}>
      <div
        ref={itemRef}
        className={cn(
          "group/comment relative transition-colors cursor-pointer",
          depth > 0
            ? ""
            : cn(
                "rounded-lg border px-3",
                isFocused
                  ? "border-accent/50 bg-white/[0.04]"
                  : "border-white/[0.06] hover:border-white/15 hover:bg-white/[0.02]",
              ),
        )}
        onClick={() => {
        setFocusedCommentId(comment.id);
        if (
          comment.timecode_start !== null &&
          comment.timecode_start !== undefined
        ) {
          seekTo(comment.timecode_start, true);
        }
        showAnnotation(
          comment.annotation ? comment.annotation.drawing_data : null,
        );
      }}
    >
      {isNew && (
        <span
          className="absolute left-1.5 top-1.5 h-2 w-2 rounded-full bg-blue-500"
          title="New comment"
        />
      )}
      <div className="relative z-[1] flex gap-2.5 py-3">
        {/* Profile picture, else initials on the author's colour. The wrapper
            carries the thread-connector anchor, which Avatar does not forward. */}
        <div data-comment-thread-avatar className="h-8 w-8 shrink-0 mt-0.5 rounded-full">
          <Avatar
            src={comment.author?.avatar_url}
            name={authorName}
            color={comment.author?.avatar_color}
            className={cn("text-[11px] font-bold text-text-inverse", avatarColor)}
          />
        </div>

        <div className="flex-1 min-w-0">
          {/* Header row */}
          <div className="flex items-center gap-2">
            <span className="text-[13px] font-semibold text-text-primary leading-none">
              {authorName}
            </span>
            <span className="text-[11px] text-text-tertiary leading-none">
              {formatRelativeTime(comment.created_at)}
            </span>
            <div className="ml-auto flex items-center gap-1.5">
              {commentNumber !== undefined && depth === 0 && (
                <span className="text-[11px] text-text-tertiary font-mono">
                  #{commentNumber}
                </span>
              )}
              {comment.visibility === "internal" ? (
                <Lock className="h-3.5 w-3.5 text-amber-400" />
              ) : (
                <Globe className="h-3.5 w-3.5 text-text-tertiary" />
              )}
            </div>
          </div>

          {/* Timecode badge + annotation indicator */}
          <div className="flex items-center gap-1.5 mt-1.5 flex-wrap">
            {comment.timecode_start !== null &&
              comment.timecode_start !== undefined && (
                <button
                  className="inline-flex items-center gap-1 rounded-md bg-amber-500/20 px-1.5 py-0.5 text-[11px] font-mono text-amber-400 hover:bg-amber-500/25 transition-colors"
                  onClick={() => {
                    seekTo(comment.timecode_start!, true);
                    setFocusedCommentId(comment.id);
                    if (comment.annotation) {
                      showAnnotation(comment.annotation.drawing_data);
                    }
                  }}
                  title="Jump to timecode"
                >
                  <Clock className="h-2.5 w-2.5" />
                  {formatTime(comment.timecode_start)}
                  {comment.timecode_end !== null &&
                    comment.timecode_end !== undefined && (
                      <> — {formatTime(comment.timecode_end)}</>
                    )}
                </button>
              )}
            {comment.annotation && (
              <button
                className="inline-flex items-center justify-center h-5 w-5 rounded text-purple-400/70 hover:text-purple-400 hover:bg-purple-500/15 transition-colors"
                onClick={() => {
                  showAnnotation(comment.annotation!.drawing_data);
                  setFocusedCommentId(comment.id);
                  if (
                    comment.timecode_start !== null &&
                    comment.timecode_start !== undefined
                  ) {
                    seekTo(comment.timecode_start, true);
                  }
                }}
                title="Show annotation"
              >
                <Pencil className="h-3 w-3" />
              </button>
            )}
          </div>

          {/* Body */}
          {editing ? (
            <div className="mt-1">
              <textarea
                value={editBody}
                onChange={(e) => setEditBody(e.target.value)}
                autoFocus
                rows={2}
                className="w-full rounded-md border border-border bg-bg-tertiary px-2 py-1.5 text-[16px] [@media(hover:hover)]:text-[13px] text-text-primary placeholder:text-text-tertiary outline-none focus:border-accent/50 resize-none"
              />
              <div className="flex items-center gap-1.5 mt-1">
                <button
                  disabled={saving || !editBody.trim()}
                  onClick={() => void handleUpdate()}
                  className="rounded-md bg-accent px-2.5 py-1 text-xs font-medium text-white hover:bg-accent/90 disabled:opacity-50 transition-colors"
                >
                  {saving ? 'Saving...' : 'Save'}
                </button>
                <button
                  onClick={() => { setEditing(false); setEditBody(comment.body); }}
                  className="rounded-md px-2.5 py-1 text-xs text-text-tertiary hover:text-text-primary transition-colors"
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <p className="mt-1 text-[13px] text-text-secondary leading-relaxed break-words">
              {comment.body}
            </p>
          )}
          {actionError && <p className="mt-1 text-xs text-status-error">{actionError}</p>}

          {(comment.attachments?.length ?? 0) > 0 && (
            <div className="mt-2 grid gap-2">
              {comment.attachments!.map((attachment) => (
                <CommentAttachment
                  key={attachment.id}
                  attachment={attachment}
                  isOwn={isOwn}
                  onDelete={onDeleteAttachment ? (attachmentId) => onDeleteAttachment(comment.id, attachmentId) : undefined}
                />
              ))}
            </div>
          )}

          {/* Reactions row */}
          {reactionGroups.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1">
              {reactionGroups.map((r) => (
                <button
                  key={r.emoji}
                  className={cn(
                    "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs transition-colors",
                    r.userReacted
                      ? "border-accent/40 bg-accent/10 text-accent"
                      : "border-border bg-bg-tertiary text-text-secondary hover:border-white/20",
                  )}
                  onClick={() => handleReactionClick(r.emoji, r.userReacted)}
                >
                  {r.emoji}
                  <span className="text-[10px]">{r.count}</span>
                </button>
              ))}
            </div>
          )}

          {/* Action row: Reply text + hover icons */}
          <div className="mt-1.5 flex items-center gap-2">
            {/* No submit handler means nowhere to send a reply (a view-only
                share link), so don't offer one. */}
            {onSubmitReply && (
              <button
                className="text-[13px] font-medium text-text-tertiary hover:text-text-secondary transition-colors"
                onClick={() => onReply(comment.id)}
              >
                Reply
              </button>
            )}

            <div className="ml-auto flex items-center gap-0.5">
              {/* Emoji — hover only */}
              <div className="relative opacity-0 group-hover/comment:opacity-100 transition-opacity">
                <button
                  className="h-7 w-7 flex items-center justify-center rounded-full text-text-tertiary hover:text-text-secondary hover:bg-bg-tertiary transition-colors"
                  onClick={() => setShowEmojiPicker((p) => !p)}
                  title="Add reaction"
                >
                  <Smile className="h-4 w-4" />
                </button>
                {showEmojiPicker && (
                  <div className="absolute bottom-full right-0 mb-1 z-50 flex gap-0.5 rounded-xl border border-border bg-bg-elevated p-1.5 shadow-2xl animate-in fade-in zoom-in-95 duration-100">
                    {QUICK_EMOJIS.map((e) => (
                      <button
                        key={e}
                        className="h-8 w-8 rounded-lg text-base hover:bg-bg-hover transition-colors"
                        onClick={() => handleQuickEmoji(e)}
                      >
                        {e}
                      </button>
                    ))}
                  </div>
                )}
              </div>

              {/* Context menu — hover only */}
              <div className={cn(
                "transition-opacity",
                menuOpen ? "opacity-100" : "opacity-0 group-hover/comment:opacity-100",
              )}>
                <CommentMenu
                  open={menuOpen}
                  onOpenChange={setMenuOpen}
                  canEdit={canEdit}
                  canDelete={canDelete}
                  commentId={comment.id}
                  assetId={comment.asset_id}
                  onEdit={() => { setEditing(true); setEditBody(comment.body); }}
                  onDelete={handleDelete}
                />
              </div>

              {/* Resolve — green filled when resolved (clickable to unresolve), outline on hover when unresolved */}
              {comment.resolved ? (
                <button
                  className="h-6 w-6 flex items-center justify-center rounded-full bg-emerald-500 text-text-inverse hover:bg-emerald-600 transition-colors disabled:opacity-50"
                  onClick={handleResolve}
                  disabled={resolving}
                  title="Unresolve"
                >
                  <Check className="h-3 w-3" strokeWidth={3} />
                </button>
              ) : (
                <button
                  className="h-6 w-6 flex items-center justify-center rounded-full text-text-tertiary hover:text-emerald-400 hover:bg-bg-tertiary transition-colors disabled:opacity-50 opacity-0 group-hover/comment:opacity-100"
                  onClick={handleResolve}
                  disabled={resolving}
                  title="Resolve"
                >
                  <CheckCircle2 className="h-4 w-4" />
                </button>
              )}
            </div>
          </div>

          {/* Inline reply input */}
          {isReplyingHere && onSubmitReply && (
            <InlineReplyInput
              parentId={comment.id}
              onSubmit={onSubmitReply}
              onCancel={onCancelReply}
              onAttachmentsUploaded={onAttachmentsUploaded}
              disableAttachments={disableAttachments}
            />
          )}
        </div>
      </div>

      {/* Replies */}
      {hasReplies && (
        <div className="relative mt-0.5">
          {comment.replies.map((reply) => (
            <CommentItem
              key={reply.id}
              comment={reply}
              depth={depth + 1}
              currentUserId={currentUserId}
              newCommentIds={newCommentIds}
              canDeleteComment={canDeleteComment}
              canManageComment={canManageComment}
              canModerate={canModerate}
              onUpdate={onUpdate}
              replyingTo={replyingTo}
              onResolve={onResolve}
              onDelete={onDelete}
              onAddReaction={onAddReaction}
              onRemoveReaction={onRemoveReaction}
              onReply={onReply}
              onCancelReply={onCancelReply}
              onSubmitReply={onSubmitReply}
              onAttachmentsUploaded={onAttachmentsUploaded}
              onDeleteAttachment={onDeleteAttachment}
              disableAttachments={disableAttachments}
              onSeekToTimecode={onSeekToTimecode}
              onShowAnnotation={onShowAnnotation}
            />
          ))}
        </div>
      )}
      </div>
    </CommentThreadConnector>
  );
}

// ─── Types ───────────────────────────────────────────────────────────────────

type CommentVisibility = "all" | "public" | "internal";
type SortMode = "timecode" | "oldest" | "newest" | "commenter" | "completed";

interface FilterState {
  annotations: boolean;
  attachments: boolean;
  completed: boolean;
  incomplete: boolean;
  unread: boolean;
  mentionsReactions: boolean;
}

const EMPTY_FILTERS: FilterState = {
  annotations: false,
  attachments: false,
  completed: false,
  incomplete: false,
  unread: false,
  mentionsReactions: false,
};

// ─── Comment panel ────────────────────────────────────────────────────────────

export function CommentPanel({
  comments,
  isLoading,
  currentUserId,
  newCommentIds,
  canDeleteComment,
  canManageComment,
  onUpdate,
  onResolve,
  onDelete,
  onAddReaction,
  onRemoveReaction,
  onReply,
  onSubmitReply,
  onAttachmentsUploaded,
  onDeleteAttachment,
  disableAttachments,
  onSeekToTimecode,
  onShowAnnotation,
  exportVersionId,
  exportAsset,
  canExport = true,
  canModerate = false,
  className,
}: CommentPanelProps) {
  const focusedCommentId = useReviewStore((s) => s.focusedCommentId);
  const setFocusedCommentId = useReviewStore((s) => s.setFocusedCommentId);
  const setActiveAnnotation = useReviewStore((s) => s.setActiveAnnotation);
  const storeAsset = useReviewStore((s) => s.currentAsset);
  // The prop wins where it is given. `undefined` means "not told", so the store
  // is used; an explicit `null` means "told, and there is nothing selected",
  // which must not silently fall through to whatever the store still holds.
  const currentAsset = exportAsset !== undefined ? exportAsset : storeAsset;
  const currentVersion = useReviewStore((s) => s.currentVersion);

  // Toolbar state
  const [visibility, setVisibility] = React.useState<CommentVisibility>("all");
  const [visOpen, setVisOpen] = React.useState(false);
  const [filterOpen, setFilterOpen] = React.useState(false);
  const [sortOpen, setSortOpen] = React.useState(false);
  const [searchOpen, setSearchOpen] = React.useState(false);
  const [searchQuery, setSearchQuery] = React.useState("");
  const [sortMode, setSortMode] = React.useState<SortMode>("timecode");
  const [filters, setFilters] = React.useState<FilterState>(EMPTY_FILTERS);
  const [replyingTo, setReplyingTo] = React.useState<string | null>(null);
  const [exportOpen, setExportOpen] = React.useState(false);
  const [exportError, setExportError] = React.useState<string | null>(null);
  const [fpsPromptFormat, setFpsPromptFormat] =
    React.useState<ExportFormat | null>(null);

  // The refusal is about one asset and one version, so it has to go when
  // either of them changes. Nothing here remounts on its own: the version
  // switcher is a sibling of this panel with no `key`, so a message about v2
  // would otherwise sit above v1's fully timecoded comments, and in compare
  // mode above the other pane's.
  React.useEffect(() => {
    setExportError(null);
  }, [currentAsset?.id, currentVersion?.id, exportVersionId]);

  const searchRef = React.useRef<HTMLInputElement>(null);

  React.useEffect(() => {
    if (searchOpen) searchRef.current?.focus();
  }, [searchOpen]);

  const hasActiveFilters = Object.values(filters).some(Boolean);

  // ─── Computed list ──────────────────────────────────────────────────

  const topLevel = React.useMemo(
    () => comments.filter((c) => c.parent_id === null),
    [comments],
  );

  // Canonical, filter-independent numbering. Derived from `comments` (not from
  // `sorted`) on purpose: sorting or searching must not renumber anything.
  const commentNumbers = React.useMemo(
    () => buildCommentNumbers(comments),
    [comments],
  );

  const publicCount = React.useMemo(
    () => topLevel.filter((c) => c.visibility !== "internal").length,
    [topLevel],
  );
  const internalCount = React.useMemo(
    () => topLevel.filter((c) => c.visibility === "internal").length,
    [topLevel],
  );

  const filtered = React.useMemo(() => {
    let list = [...topLevel];

    // Filter by visibility
    if (visibility === "public")
      list = list.filter((c) => c.visibility !== "internal");
    else if (visibility === "internal")
      list = list.filter((c) => c.visibility === "internal");

    // Filter by completion
    if (filters.completed && !filters.incomplete)
      list = list.filter((c) => c.resolved);
    else if (filters.incomplete && !filters.completed)
      list = list.filter((c) => !c.resolved);

    // Filter by annotations
    if (filters.annotations) list = list.filter((c) => c.annotation !== null);

    // Search
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      list = list.filter(
        (c) =>
          c.body.toLowerCase().includes(q) ||
          (c.author?.name ?? "").toLowerCase().includes(q),
      );
    }

    return list;
  }, [topLevel, visibility, filters, searchQuery]);

  const sorted = React.useMemo(() => {
    return [...filtered].sort((a, b) => {
      if (sortMode === "newest")
        return (
          new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
        );
      if (sortMode === "commenter")
        return (a.author?.name ?? "").localeCompare(b.author?.name ?? "");
      if (sortMode === "completed") {
        if (a.resolved && !b.resolved) return -1;
        if (!a.resolved && b.resolved) return 1;
      }
      if (sortMode === "oldest")
        return (
          new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
        );
      // Default (sortMode === "timecode"): timecoded ascending, then
      // untimecoded last (by created_at ascending).
      const aHasTime =
        a.timecode_start !== null && a.timecode_start !== undefined;
      const bHasTime =
        b.timecode_start !== null && b.timecode_start !== undefined;
      if (aHasTime && bHasTime)
        return (a.timecode_start as number) - (b.timecode_start as number);
      if (aHasTime && !bHasTime) return -1;
      if (!aHasTime && bHasTime) return 1;
      return (
        new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
      );
    });
  }, [filtered, sortMode]);

  const visLabel =
    visibility === "all"
      ? "All comments"
      : visibility === "public"
        ? "Public comments"
        : "Internal comments";

  function toggleFilter(key: keyof FilterState) {
    setFilters((prev) => ({ ...prev, [key]: !prev[key] }));
  }

  function handleReply(parentId: string) {
    setReplyingTo(parentId);
    onReply(parentId);
  }

  async function handleExport(format: ExportFormat, fps?: number) {
    setExportOpen(false);
    setExportError(null);
    const versionId = exportVersionId ?? currentVersion?.id;
    if (!currentAsset || !versionId) {
      // Folded into the error line rather than returning ahead of it: a guard
      // that returns silently is the shape of bug this panel just had.
      setExportError("Select an asset to export its comments");
      return;
    }
    try {
      await exportComments({
        assetId: currentAsset.id,
        versionId,
        format,
        fps,
      });
    } catch (err) {
      if (err instanceof FpsRequiredError) {
        setFpsPromptFormat(format);
      } else {
        // Every other export failure used to go to the console, where nobody
        // looks: an unsupported frame rate, a non-video asset and a version with
        // nothing timecoded all produced a click that did nothing at all. Shown
        // in the panel rather than as a toast, next to the control that failed
        // and alongside the fps prompt, which is where this component already
        // answers for this button.
        // `err.message` and not `err instanceof Error` alone: an Error with an
        // empty message is falsy, and the line below renders on truthiness --
        // so the branch meant to explain the failure would show nothing at all.
        setExportError(
          (err instanceof Error && err.message) || "Export failed",
        );
      }
    }
  }

  return (
    <>
    <div className={cn("flex flex-col flex-1 min-h-0", className)}>
      {/* ─── Toolbar ──────────────────────────────────────────────── */}
      <div className="flex items-center justify-between px-4 py-2.5 shrink-0">
        {/* Visibility dropdown */}
        <div className="relative">
          <button
            className={cn(
              "flex items-center gap-1.5 text-[13px] font-medium transition-colors rounded-md px-2 py-1",
              visOpen
                ? "bg-bg-tertiary text-text-primary"
                : "text-text-secondary hover:text-text-primary",
            )}
            onClick={() => {
              setVisOpen((p) => !p);
              setFilterOpen(false);
              setSortOpen(false);
            }}
          >
            {visLabel}
            <ChevronDown className="h-3.5 w-3.5" />
          </button>
          <Dropdown
            open={visOpen}
            onClose={() => setVisOpen(false)}
            className="w-52"
          >
            {[
              {
                id: "all" as const,
                label: "All comments",
                count: topLevel.length,
              },
              {
                id: "public" as const,
                label: "Public comments",
                count: publicCount,
              },
              {
                id: "internal" as const,
                label: "Internal comments",
                count: internalCount,
              },
            ].map((item) => (
              <button
                key={item.id}
                className={cn(
                  "flex w-full items-center justify-between px-3 py-2 text-[13px] transition-colors",
                  visibility === item.id
                    ? "text-text-primary bg-bg-tertiary"
                    : "text-text-secondary hover:bg-bg-tertiary",
                )}
                onClick={() => {
                  setVisibility(item.id);
                  setVisOpen(false);
                }}
              >
                {item.label}
                <span className="text-[12px] text-text-tertiary tabular-nums">
                  {item.count}
                </span>
              </button>
            ))}
          </Dropdown>
        </div>

        {/* Right toolbar icons */}
        <div className="flex items-center gap-0.5">
          {/* Filter */}
          <div className="relative">
            <button
              className={cn(
                "h-7 w-7 flex items-center justify-center rounded-md transition-colors",
                filterOpen || hasActiveFilters
                  ? "text-accent bg-accent/10"
                  : "text-text-tertiary hover:text-text-secondary hover:bg-bg-tertiary",
              )}
              title="Filter"
              onClick={() => {
                setFilterOpen((p) => !p);
                setVisOpen(false);
                setSortOpen(false);
              }}
            >
              <ListFilter className="h-4 w-4" />
            </button>
            <Dropdown
              open={filterOpen}
              onClose={() => setFilterOpen(false)}
              align="right"
              className="w-56"
            >
              <div className="px-3 py-2 text-[11px] text-text-tertiary uppercase tracking-wider font-medium">
                Filter by...
              </div>
              {[
                {
                  key: "annotations" as const,
                  icon: Pencil,
                  label: "Annotations",
                },
                {
                  key: "attachments" as const,
                  icon: Paperclip,
                  label: "Attachments",
                },
                {
                  key: "completed" as const,
                  icon: CheckCircle2,
                  label: "Completed",
                },
                {
                  key: "incomplete" as const,
                  icon: Circle,
                  label: "Incomplete",
                },
                { key: "unread" as const, icon: Mail, label: "Unread" },
                {
                  key: "mentionsReactions" as const,
                  icon: AtSign,
                  label: "Mentions and reactions",
                },
              ].map(({ key, icon: Icon, label }) => (
                <button
                  key={key}
                  className="flex w-full items-center justify-between px-3 py-2 text-[13px] text-text-secondary hover:bg-bg-tertiary transition-colors"
                  onClick={() => toggleFilter(key)}
                >
                  <div className="flex items-center gap-2.5">
                    <Icon className="h-4 w-4" />
                    {label}
                  </div>
                  <div
                    className={cn(
                      "h-4 w-4 rounded border flex items-center justify-center transition-colors",
                      filters[key]
                        ? "bg-accent border-accent"
                        : "border-white/20",
                    )}
                  >
                    {filters[key] && (
                      <Check className="h-3 w-3 text-text-inverse" />
                    )}
                  </div>
                </button>
              ))}
              <div className="border-t border-border mt-1 pt-1">
                <button className="flex w-full items-center gap-2.5 px-3 py-2 text-[13px] text-text-secondary hover:bg-bg-tertiary transition-colors">
                  <Hash className="h-4 w-4" />
                  Hashtag
                  <ChevronRight className="h-3.5 w-3.5 ml-auto" />
                </button>
                <button className="flex w-full items-center gap-2.5 px-3 py-2 text-[13px] text-text-secondary hover:bg-bg-tertiary transition-colors">
                  <User className="h-4 w-4" />
                  Person
                  <ChevronRight className="h-3.5 w-3.5 ml-auto" />
                </button>
              </div>
              {hasActiveFilters && (
                <div className="border-t border-border mt-1 pt-1 px-1.5 pb-1">
                  <button
                    className="w-full py-1.5 text-[13px] text-text-secondary bg-bg-tertiary hover:bg-bg-hover rounded-lg transition-colors font-medium"
                    onClick={() => setFilters(EMPTY_FILTERS)}
                  >
                    Clear Filters
                  </button>
                </div>
              )}
            </Dropdown>
          </div>

          {/* Sort */}
          <div className="relative">
            <button
              className={cn(
                "h-7 w-7 flex items-center justify-center rounded-md transition-colors",
                sortOpen
                  ? "text-accent bg-accent/10"
                  : "text-text-tertiary hover:text-text-secondary hover:bg-bg-tertiary",
              )}
              title="Sort"
              onClick={() => {
                setSortOpen((p) => !p);
                setVisOpen(false);
                setFilterOpen(false);
              }}
            >
              <ArrowUpDown className="h-4 w-4" />
            </button>
            <Dropdown
              open={sortOpen}
              onClose={() => setSortOpen(false)}
              align="right"
              className="w-52"
            >
              <div className="px-3 py-2 text-[11px] text-text-tertiary uppercase tracking-wider font-medium">
                Sort thread by...
              </div>
              {[
                { id: "timecode" as const, label: "Timecode (Default)" },
                { id: "oldest" as const, label: "Oldest" },
                { id: "newest" as const, label: "Newest" },
                { id: "commenter" as const, label: "Commenter" },
                { id: "completed" as const, label: "Completed" },
              ].map((item) => (
                <button
                  key={item.id}
                  className={cn(
                    "flex w-full items-center justify-between px-3 py-2 text-[13px] transition-colors",
                    sortMode === item.id
                      ? "text-text-primary"
                      : "text-text-secondary hover:bg-bg-tertiary",
                  )}
                  onClick={() => {
                    setSortMode(item.id);
                    setSortOpen(false);
                  }}
                >
                  {item.label}
                  {sortMode === item.id && (
                    <Check className="h-4 w-4 text-accent" />
                  )}
                </button>
              ))}
            </Dropdown>
          </div>

          {/* Search */}
          <button
            className={cn(
              "h-7 w-7 flex items-center justify-center rounded-md transition-colors",
              searchOpen
                ? "text-accent bg-accent/10"
                : "text-text-tertiary hover:text-text-secondary hover:bg-bg-tertiary",
            )}
            title="Search"
            onClick={() => {
              setSearchOpen((p) => !p);
              if (searchOpen) setSearchQuery("");
            }}
          >
            <Search className="h-4 w-4" />
          </button>

          {/* Export */}
          {canExport && (
            <div className="relative">
              <button
                className={cn(
                  "h-7 w-7 flex items-center justify-center rounded-md transition-colors",
                  exportOpen
                    ? "text-accent bg-accent/10"
                    : "text-text-tertiary hover:text-text-secondary hover:bg-bg-tertiary",
                )}
                title="Export comments"
                onClick={() => {
                  // Opening the menu is the start of a new attempt, so the
                  // previous refusal stops being the answer to anything.
                  if (!exportOpen) setExportError(null);
                  setExportOpen((p) => !p);
                  setVisOpen(false);
                  setFilterOpen(false);
                  setSortOpen(false);
                }}
              >
                <Download className="h-4 w-4" />
              </button>
              <Dropdown
                open={exportOpen}
                onClose={() => setExportOpen(false)}
                align="right"
                className="w-56"
              >
                <div className="px-3 py-2 text-[11px] text-text-tertiary uppercase tracking-wider font-medium">
                  Export comments
                </div>
                {currentAsset?.asset_type === "video" && (
                  <>
                    <button
                      className="flex w-full items-center gap-2.5 px-3 py-2 text-[13px] text-text-secondary hover:bg-bg-tertiary transition-colors"
                      onClick={() => handleExport("edl")}
                    >
                      DaVinci Resolve (EDL)
                    </button>
                    <button
                      className="flex w-full items-center gap-2.5 px-3 py-2 text-[13px] text-text-secondary hover:bg-bg-tertiary transition-colors"
                      onClick={() => handleExport("fcpxml")}
                    >
                      Final Cut Pro (FCPXML)
                    </button>
                    <button
                      className="flex w-full items-center gap-2.5 px-3 py-2 text-[13px] text-text-secondary hover:bg-bg-tertiary transition-colors"
                      onClick={() => handleExport("premiere_xml")}
                    >
                      Premiere Pro (XML)
                    </button>
                  </>
                )}
                <button
                  className="flex w-full items-center gap-2.5 px-3 py-2 text-[13px] text-text-secondary hover:bg-bg-tertiary transition-colors"
                  onClick={() => handleExport("csv")}
                >
                  CSV
                </button>
              </Dropdown>
            </div>
          )}
        </div>
      </div>

      {exportError && (
        <div className="px-4 pb-2 shrink-0">
          <p className="text-[11px] text-status-error">{exportError}</p>
        </div>
      )}

      {/* ─── Search bar ───────────────────────────────────────────── */}
      {searchOpen && (
        <div className="px-4 pb-2 shrink-0">
          <div className="flex items-center gap-2 rounded-lg border border-border bg-bg-tertiary px-3 py-1.5">
            <Search className="h-3.5 w-3.5 text-text-tertiary shrink-0" />
            <input
              ref={searchRef}
              type="text"
              className="flex-1 bg-transparent text-[16px] [@media(hover:hover)]:text-[13px] text-text-primary placeholder:text-text-tertiary focus:outline-none"
              placeholder="Search..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
            {searchQuery && (
              <button
                onClick={() => setSearchQuery("")}
                className="text-text-tertiary hover:text-text-secondary"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
            <button
              onClick={() => {
                setSearchOpen(false);
                setSearchQuery("");
              }}
              className="text-[12px] text-text-tertiary hover:text-text-secondary font-medium"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* ─── Comment list ─────────────────────────────────────────── */}
      <div className="flex-1 overflow-y-auto">
        {isLoading && (
          <div className="flex items-center justify-center py-12">
            <div className="h-5 w-5 animate-spin rounded-full border-2 border-border border-t-accent" />
          </div>
        )}

        {!isLoading && sorted.length === 0 && (
          <div className="flex flex-col items-center justify-center py-16 text-center px-6">
            <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-bg-tertiary text-text-tertiary mb-3">
              <MessageSquare className="h-6 w-6" />
            </div>
            <p className="text-sm text-text-secondary font-medium">
              No comments yet
            </p>
            <p className="text-xs text-text-tertiary mt-1">
              Leave a comment below to start the review
            </p>
          </div>
        )}

        {!isLoading &&
          sorted.map((comment) => (
            <div key={comment.id} className="px-3 pt-2 first:pt-3">
              <CommentItem
                comment={comment}
                commentNumber={commentNumbers.get(comment.id)}
                currentUserId={currentUserId}
                newCommentIds={newCommentIds}
                canDeleteComment={canDeleteComment}
                canManageComment={canManageComment}
                canModerate={canModerate}
                onUpdate={onUpdate}
                replyingTo={replyingTo}
                isFocused={focusedCommentId === comment.id}
                onResolve={onResolve}
                onDelete={onDelete}
                onAddReaction={onAddReaction}
                onRemoveReaction={onRemoveReaction}
                onReply={handleReply}
                onCancelReply={() => setReplyingTo(null)}
                onSubmitReply={onSubmitReply}
                onAttachmentsUploaded={onAttachmentsUploaded}
                onDeleteAttachment={onDeleteAttachment}
                disableAttachments={disableAttachments}
                onSeekToTimecode={onSeekToTimecode}
                onShowAnnotation={onShowAnnotation}
              />
            </div>
          ))}
      </div>
    </div>
    <FpsPromptDialog
      open={fpsPromptFormat !== null}
      onOpenChange={(open) => !open && setFpsPromptFormat(null)}
      onConfirm={(fps) =>
        fpsPromptFormat && handleExport(fpsPromptFormat, fps)
      }
    />
    </>
  );
}
