"use client";

import * as React from "react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Input } from "@/components/ui/input";
import { Segment } from "@/components/ui/setting-controls";
import { EmptyState } from "@/components/shared/empty-state";
import { LAYOUT_OPTIONS } from "@/components/projects/appearance-popover";
import type { ViewLayout } from "@/stores/view-store";
import type { LucideIcon } from "lucide-react";

/**
 * The parts every admin tab is built from.
 *
 * All four tabs are the same thing with different columns: a list, at most four
 * fields wide, and at most one button. Factoring that out is not tidiness, it
 * is the only way four tabs stay the same shape a year from now; a tab with its
 * own hand-written table drifts within a release.
 *
 * Nothing new is introduced here. The row is a `<tr>`, the button is `Button`,
 * the confirmation is `ConfirmDialog`, the empty state is `EmptyState` and the
 * colours are the existing tokens, so dark and light follow without a second
 * palette.
 */

/** Cell padding, shared so columns line up between tabs. */
export const TD = "px-4 py-2.5";
export const TH = "px-4 py-2 text-left text-xs font-medium text-text-tertiary";

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

/** A role or permission, as a quiet pill. */
export function Pill({
  children,
  tone = "neutral",
}: {
  children: React.ReactNode;
  tone?: "neutral" | "warning";
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2 py-0.5 text-xs",
        tone === "warning"
          ? "bg-status-warning/15 text-status-warning"
          : "bg-bg-tertiary text-text-secondary",
      )}
    >
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
 * Cards or rows, as the projects page asks it.
 *
 * `Segment` with `LAYOUT_OPTIONS` is literally the control the projects page's
 * Appearance popover uses, so the icons, their order and their labels are one
 * definition rather than a lookalike. `tone` stays the default here because
 * these tabs sit on the themed settings surface, not in the popover's fixed
 * dark frame.
 */
export function LayoutSwitch({
  value,
  onChange,
}: {
  value: ViewLayout;
  onChange: (next: ViewLayout) => void;
}) {
  return (
    <Segment<ViewLayout>
      label="Layout"
      options={LAYOUT_OPTIONS}
      value={value}
      onChange={onChange}
    />
  );
}

/**
 * A tab's one line above its content: what the list answers, and the switch.
 *
 * The hint is not decoration. A tab whose only affordance appears once
 * something is selected has to say what the selecting is for before it happens,
 * which is the finding that put this here.
 */
export function TabBar({
  hint,
  layout,
  onLayout,
}: {
  hint?: string;
  layout?: ViewLayout;
  onLayout?: (next: ViewLayout) => void;
}) {
  if (!hint && !layout) return null;
  return (
    <div className="flex items-center justify-between gap-3">
      <p className="text-xs text-text-tertiary">{hint}</p>
      {layout && onLayout && <LayoutSwitch value={layout} onChange={onLayout} />}
    </div>
  );
}

/**
 * The grid the cards sit in.
 *
 * The same column steps the projects page uses at card size M, so a card here
 * is the size a card there is and the two pages do not look like two products.
 */
export function CardGrid({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
      {children}
    </div>
  );
}

/** One card: the same frame as a project card, without its menus. */
export function Card({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <article
      className={cn(
        "flex flex-col overflow-hidden rounded-xl border border-border bg-bg-secondary transition-colors hover:border-accent/40",
        className,
      )}
    >
      {children}
    </article>
  );
}

/** A quiet fact under a card's title: an icon and a short value. */
export function CardFact({
  icon: Icon,
  children,
}: {
  icon: LucideIcon;
  children: React.ReactNode;
}) {
  return (
    <span className="flex items-center gap-1.5 text-2xs text-text-tertiary">
      <Icon className="h-3 w-3 shrink-0" />
      {children}
    </span>
  );
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
