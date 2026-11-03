"use client";

import * as React from "react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Input } from "@/components/ui/input";
import { EmptyState } from "@/components/shared/empty-state";
import type { LucideIcon } from "lucide-react";

/**
 * The parts an admin tab is built from.
 *
 * A tab is a list, at most four fields wide, with at most one button.
 * Factoring that out is not tidiness, it is the only way further tabs stay the
 * same shape a year from now; a tab with its own hand-written table drifts
 * within a release.
 *
 * Nothing new is introduced here. The row is a `<tr>`, the button is `Button`,
 * the confirmation is `ConfirmDialog`, the empty state is `EmptyState` and the
 * colours are the existing tokens, so dark and light follow without a second
 * palette.
 */

/** Cell padding, shared so columns line up between tabs. */
export const TD = "px-4 py-2.5";

export function Checkbox({
  checked,
  onChange,
  label,
  disabled = false,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <input
      type="checkbox"
      checked={checked}
      disabled={disabled}
      onChange={(e) => onChange(e.target.checked)}
      aria-label={label}
      // accent-accent resolves to the theme's --accent, so the box follows dark
      // and light without a colour of its own, and [color-scheme:auto] is what
      // the app's other native controls carry (see ui/setting-controls.tsx).
      className="h-4 w-4 shrink-0 cursor-pointer rounded border-border accent-accent [color-scheme:auto] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:cursor-not-allowed disabled:opacity-40"
    />
  );
}

/** A size, right-aligned and in tabular figures so columns of them line up. */
export function Bytes({ children }: { children: React.ReactNode }) {
  return (
    <span className="block text-right text-sm tabular-nums text-text-primary">
      {children}
    </span>
  );
}

/** A name that gets an ellipsis rather than widening its column. */
export function Name({ children, title }: { children: React.ReactNode; title: string }) {
  return (
    <span className="block truncate text-sm text-text-primary" title={title}>
      {children}
    </span>
  );
}

/**
 * Loading, failed or empty, in that order.
 *
 * The order matters: a failed request used to fall through to the empty state,
 * so `/admin/storage` answering 500 rendered "Nothing stored yet" and an
 * instance with a full disk was told it had no media at all.
 */
export function ListState({
  isLoading,
  error,
  isEmpty,
  icon,
  title,
  description,
  rows = 5,
  children,
}: {
  isLoading: boolean;
  error: unknown;
  isEmpty: boolean;
  icon: LucideIcon;
  title: string;
  description: string;
  rows?: number;
  children: React.ReactNode;
}) {
  if (isLoading) {
    return (
      <div className="space-y-2">
        {Array.from({ length: rows }).map((_, i) => (
          <div key={i} className="h-10 animate-pulse rounded-lg bg-bg-tertiary" />
        ))}
      </div>
    );
  }
  if (error) {
    return (
      <p className="text-sm text-status-error">
        {error instanceof Error ? error.message : "Could not load this list."}
      </p>
    );
  }
  if (isEmpty) {
    return (
      <div className="rounded-lg border border-border bg-bg-secondary">
        <EmptyState icon={icon} title={title} description={description} />
      </div>
    );
  }
  return <>{children}</>;
}

/** The bordered card every tab's table sits in. */
export function ListFrame({ children }: { children: React.ReactNode }) {
  return (
    <div className="overflow-hidden rounded-lg border border-border bg-bg-secondary">
      <table className="w-full table-fixed text-sm">{children}</table>
    </div>
  )
}

/**
 * The one button, bottom right, only once something is selected.
 *
 * It carries the count in its label rather than a separate "N selected" line:
 * that line scrolled out of sight above a long list, which is the one place it
 * was needed.
 */
export function ActionBar({
  show,
  label,
  onClick,
  variant = "destructive",
}: {
  show: boolean;
  label: string;
  onClick: () => void;
  variant?: "destructive" | "primary" | "secondary";
}) {
  if (!show) return null;
  return (
    <div className="sticky bottom-0 flex justify-end bg-gradient-to-t from-bg-primary via-bg-primary pt-3 pb-1">
      <Button variant={variant} size="sm" onClick={onClick}>
        {label}
      </Button>
    </div>
  );
}

/**
 * `ConfirmDialog` with a phrase to type before the button works.
 *
 * The typing is asked for here and enforced again on the server, which is the
 * part that counts: a gate that only lives in the browser is a suggestion, and
 * the dialog is a courtesy to the person using it rather than the check itself.
 *
 * `requiredText` of null is the ordinary dialog with no field, so one component
 * covers both sides of a threshold and the wording above the field cannot drift
 * between them.
 */
export function TypedConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  requiredText,
  prompt,
  confirmLabel,
  error,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  /** null means no field: a small, reversible action needs one click. */
  requiredText: string | null;
  prompt?: string;
  confirmLabel: string;
  error?: string | null;
  onConfirm: () => Promise<void>;
}) {
  const [typed, setTyped] = React.useState("");
  const satisfied = requiredText === null || typed.trim() === requiredText;

  // Cleared on the way out rather than in an effect on the way in, so a phrase
  // typed for one selection cannot carry over to the next. Every exit runs
  // through here: cancel, Escape, the overlay, and a successful confirm, which
  // closes the dialog the same way.
  const handleOpenChange = (next: boolean) => {
    if (!next) setTyped("");
    onOpenChange(next);
  };

  return (
    <ConfirmDialog
      open={open}
      onOpenChange={handleOpenChange}
      title={title}
      description={description}
      confirmLabel={confirmLabel}
      variant="danger"
      error={error}
      onConfirm={async () => {
        if (!satisfied) throw new Error("confirmation not typed");
        await onConfirm();
      }}
      confirmDisabled={!satisfied}
    >
      {requiredText === null ? null : (
        <div className="flex flex-col gap-1.5">
          <label
            htmlFor="admin-confirm-phrase"
            className="text-sm text-text-secondary"
          >
            {prompt ?? `Type ${requiredText} to confirm:`}
          </label>
          <Input
            id="admin-confirm-phrase"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            placeholder={requiredText}
            autoComplete="off"
          />
        </div>
      )}
    </ConfirmDialog>
  );
}
