"use client";

import * as React from "react";
import useSWR, { useSWRConfig } from "swr";
import { ChevronRight, HardDrive, Trash2 } from "lucide-react";
import { cn, formatBytes } from "@/lib/utils";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { StorageBar } from "@/components/shared/storage-usage";
import {
  ActionBar,
  Bytes,
  Checkbox,
  ListFrame,
  ListState,
  Name,
  TD,
  TypedConfirmDialog,
} from "./admin-list";
import type {
  AdminDeleteResponse,
  AdminPurgeResponse,
  StorageOverview,
  StorageProjectFiles,
  TrashOverview,
} from "@/types";

/**
 * What takes up the instance's storage, and the two ways to get it back.
 *
 * One line, one list, one button. A project row expands to its files, a file to
 * its versions, and a checkbox at any level puts that thing in the trash, which
 * is a second list behind one link. A row's figure is everything that thing
 * costs, transcode output included, which is what gets freed when it goes.
 *
 * Both dangerous actions are gated here and again on the server, and each is
 * deliberate about which it is: delete puts things in the trash for the
 * retention window, purge destroys them now, and nothing here can do the
 * second to something that has not been through the first.
 */

/** A percentage of `max`, where a zero or missing maximum means an empty bar. */
function share(bytes: number, max: number): number {
  return max > 0 ? (bytes / max) * 100 : 0;
}

function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

/** Everything currently ticked, across the three levels a selection can span. */
type Selection = {
  projects: Set<string>;
  assets: Set<string>;
  versions: Set<string>;
};

const EMPTY: Selection = { projects: new Set(), assets: new Set(), versions: new Set() };

function toggleIn(set: Set<string>, id: string): Set<string> {
  const next = new Set(set);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

function selectionSize(s: Selection): number {
  return s.projects.size + s.assets.size + s.versions.size;
}

/** The message the server sent back, or a usable fallback. */
function reason(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
}

/**
 * The HTTP status of a failed request, where the client reported one.
 *
 * Read by duck typing rather than from `ApiError`, so the component keeps
 * working behind any client that reports a status, and a thrown `Error`
 * without one simply reads as undefined.
 */
function statusOf(err: unknown): number | undefined {
  return typeof err === "object" && err !== null && "status" in err
    ? (err as { status?: number }).status
    : undefined;
}

/** The figure above which the server asks for the typed phrase. */
const CONFIRM_ABOVE_BYTES = 10 * 1024 ** 3;

/** Days left of zero: the next cleanup pass takes the row, so it is past restoring. */
function expired(daysLeft: number | null): boolean {
  return daysLeft === 0;
}

/**
 * One line in the trash, whichever level it came from. `bytes` is null when a
 * parent is trashed too: those bytes are counted on the parent's row, and such
 * an entry has no restore and no permanent delete of its own either.
 *
 * `holder` is what has to come back first for a blocked entry, named per level:
 * "the project above it" is wrong for a version whose file is what is trashed.
 */
type TrashEntry = {
  key: string;
  what: string;
  where: string;
  daysLeft: number | null;
  blocked: boolean;
  holder: string;
  bytes: number | null;
  payload: Record<string, string[]>;
};

/**
 * What the one permanent-delete dialog is open for.
 *
 * "all" carries the count and the byte figure read when it opened, not live SWR
 * data. `revalidateOnFocus` is on, so switching window and back while a
 * colleague trashes a project moved both the text and the echo together, and
 * the server's check passed on figures nobody had read. The snapshot is what
 * makes that 409 happen.
 */
type PurgeTarget =
  | { kind: "one"; entry: TrashEntry }
  | { kind: "all"; count: number; bytes: number };


// ── the expanded levels ───────────────────────────────────────────────────────

function VersionRows({
  files,
  selection,
  onToggle,
}: {
  files: StorageProjectFiles;
  selection: Selection;
  onToggle: (level: keyof Selection, id: string) => void;
}) {
  const largest = files.assets[0]?.total_bytes ?? 0;
  const [open, setOpen] = React.useState<Set<string>>(new Set());

  if (files.assets.length === 0) {
    return (
      <p className="px-4 py-2 text-xs text-text-tertiary">
        Nothing stored in this project.
      </p>
    );
  }

  return (
    <ul className="divide-y divide-border border-t border-border">
      {files.assets.map((asset) => {
        const expanded = open.has(asset.asset_id);
        const assetChosen = selection.assets.has(asset.asset_id);
        const biggestVersion = asset.versions[0]?.total_bytes ?? 0;
        return (
          <li key={asset.asset_id}>
            <div className="flex items-center gap-3 py-2 pl-10 pr-4">
              <Checkbox
                checked={assetChosen}
                onChange={() => onToggle("assets", asset.asset_id)}
                label={`Select ${asset.name}`}
              />
              <button
                type="button"
                aria-expanded={expanded}
                onClick={() => setOpen((s) => toggleIn(s, asset.asset_id))}
                className="flex min-w-0 flex-1 items-center gap-1.5 rounded text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
              >
                <ChevronRight
                  className={cn(
                    "h-3.5 w-3.5 shrink-0 text-text-tertiary transition-transform",
                    expanded && "rotate-90",
                  )}
                />
                <span className="min-w-0 flex-1">
                  <Name title={asset.name}>{asset.name}</Name>
                </span>
              </button>
              <span className="w-[22%] shrink-0">
                <StorageBar
                  pct={share(asset.total_bytes, largest)}
                  label={`${asset.name}: ${formatBytes(asset.total_bytes)}`}
                />
              </span>
              <span className="w-24 shrink-0">
                <Bytes>{formatBytes(asset.total_bytes)}</Bytes>
              </span>
            </div>

            {expanded && (
              <ul className="bg-bg-tertiary/40">
                {asset.versions.map((v) => {
                  // The newest version only goes with the whole file. Ticking it
                  // on its own would quietly demote the file to an older cut, so
                  // the box is held shut until the file itself is ticked, and
                  // the row says why rather than failing at the server.
                  const locked = v.is_latest && !assetChosen;
                  return (
                    <li
                      key={v.version_id}
                      className="flex items-center gap-3 py-1.5 pl-[4.5rem] pr-4"
                    >
                      <Checkbox
                        checked={selection.versions.has(v.version_id) || assetChosen}
                        disabled={locked || assetChosen}
                        onChange={() => onToggle("versions", v.version_id)}
                        label={`Select version ${v.version_number} of ${asset.name}`}
                      />
                      <span className="min-w-0 flex-1 truncate text-xs text-text-secondary">
                        Version {v.version_number}
                        {locked && (
                          <span className="text-text-tertiary">
                            {" "}
                            · newest, only deletable with the whole file
                          </span>
                        )}
                      </span>
                      <span className="w-[22%] shrink-0">
                        <StorageBar
                          pct={share(v.total_bytes, biggestVersion)}
                          label={`Version ${v.version_number}: ${formatBytes(v.total_bytes)}`}
                        />
                      </span>
                      <span className="w-24 shrink-0 text-right text-xs tabular-nums text-text-tertiary">
                        {formatBytes(v.total_bytes)}
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function ProjectFiles({
  projectId,
  selection,
  onToggle,
}: {
  projectId: string;
  selection: Selection;
  onToggle: (level: keyof Selection, id: string) => void;
}) {
  const { data, isLoading, error } = useSWR<StorageProjectFiles>(
    `/admin/storage/projects/${projectId}`,
    (key: string) => api.get<StorageProjectFiles>(key),
  );

  if (isLoading) {
    return <div className="m-3 h-8 animate-pulse rounded bg-bg-tertiary" />;
  }
  if (error) {
    return (
      <p className="px-4 py-2 text-xs text-status-error">
        {reason(error, "Could not load this project")}
      </p>
    );
  }
  if (!data) return null;
  return <VersionRows files={data} selection={selection} onToggle={onToggle} />;
}

// ── the trash ─────────────────────────────────────────────────────────────────

function TrashList({
  onChanged,
  onBack,
}: {
  onChanged: () => void;
  onBack: () => void;
}) {
  const { data, isLoading, error, mutate } = useSWR<TrashOverview>(
    "/admin/trash",
    (key: string) => api.get<TrashOverview>(key),
  );
  // One dialog for both permanent deletes: `null` closed, an entry for that one
  // row, a snapshot for the whole bin. Two dialogs meant two copies of the same
  // gate, which is how the two drift apart.
  const [purging, setPurging] = React.useState<PurgeTarget | null>(null);
  // Two places a refusal can belong: restore has no dialog, so its reason goes
  // above the list; a purge refusal belongs in the dialog that is still open,
  // and printing it in both put the same sentence on screen twice.
  const [failure, setFailure] = React.useState<string | null>(null);
  const [purgeFailure, setPurgeFailure] = React.useState<string | null>(null);

  const entries = React.useMemo<TrashEntry[]>(() => {
    if (!data) return [];
    return [
      ...data.projects.map((p) => ({
        key: `p-${p.project_id}`,
        what: p.name,
        where: "Project",
        daysLeft: p.days_left,
        blocked: false,
        holder: "",
        bytes: p.total_bytes,
        payload: { project_ids: [p.project_id] },
      })),
      ...data.assets.map((a) => ({
        key: `a-${a.asset_id}`,
        what: a.name,
        where: a.project_name,
        daysLeft: a.days_left,
        blocked: a.blocked_by_project,
        holder: "project",
        bytes: a.total_bytes,
        payload: { asset_ids: [a.asset_id] },
      })),
      ...data.versions.map((v) => ({
        key: `v-${v.version_id}`,
        what: `${v.asset_name} · version ${v.version_number}`,
        where: v.project_name,
        daysLeft: v.days_left,
        blocked: v.blocked_by_parent,
        // Either the file or the project can be the one in the trash, and the
        // response does not say which, so the row names both rather than the
        // wrong one.
        holder: "file or project",
        bytes: v.total_bytes,
        payload: { version_ids: [v.version_id] },
      })),
    ];
  }, [data]);

  const restore = async (payload: Record<string, string[]>) => {
    setFailure(null);
    try {
      await api.post("/admin/trash/restore", payload);
      await mutate();
      onChanged();
    } catch (err: unknown) {
      setFailure(reason(err, "Could not restore that"));
    }
  };

  /**
   * The one permanent delete, for a single row and for the whole bin alike.
   *
   * Both figures go back exactly as they were read, and the server refuses if
   * either has moved since. That is what makes the number in the dialog a
   * promise rather than a decoration, and it only works if a refusal is shown:
   * the 409s and "A cleanup pass is already running" used to look like a button
   * that did nothing. The list is refetched either way, so a page the server
   * called stale is a page that has caught up by the time it is read.
   */
  const purge = async (
    payload: Record<string, unknown>,
    count: number,
    bytes: number,
    fallback: string,
  ) => {
    setPurgeFailure(null);
    try {
      await api.post<AdminPurgeResponse>("/admin/trash/purge", {
        ...payload,
        confirm_count: count,
        confirm_bytes: bytes,
        confirm_text: "DELETE",
      });
    } catch (err: unknown) {
      setPurgeFailure(reason(err, fallback));
      await mutate();
      // Rethrown so the dialog stays open carrying the server's own reason.
      throw err;
    }
    await mutate();
    onChanged();
  };


  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <button
          type="button"
          onClick={onBack}
          className="text-sm text-text-secondary underline-offset-2 hover:text-text-primary hover:underline"
        >
          ← Back to storage
        </button>
        {entries.length > 0 && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setPurgeFailure(null);
              setPurging({
                kind: "all",
                count: entries.length,
                bytes: data?.total_bytes ?? 0,
              });
            }}
          >
            <Trash2 className="h-3.5 w-3.5" />
            Empty trash ({formatBytes(data?.total_bytes ?? 0)})
          </Button>
        )}
      </div>

      {failure && <p className="text-sm text-status-error">{failure}</p>}

      {/* Said here because the delete dialog told the owner the share links
          stop working, which is true until the project comes back. */}
      {data && data.projects.length > 0 && (
        <p className="text-xs text-text-tertiary">
          Restoring a project brings its share links and its public setting back as they were.
        </p>
      )}

      <ListState
        isLoading={isLoading}
        error={error}
        isEmpty={entries.length === 0}
        icon={Trash2}
        title="The trash is empty"
        description="Deleted projects and files wait here before their storage is reclaimed."
      >
        <ListFrame>
          <colgroup>
            <col />
            <col className="w-[22%]" />
            <col className="w-28" />
            <col className="w-24" />
            <col className="w-72" />
          </colgroup>
          <tbody>
            {entries.map((e) => (
              <tr key={e.key} className="border-b border-border last:border-0">
                <td className={cn(TD, "overflow-hidden")}>
                  <Name title={e.what}>{e.what}</Name>
                  {/* The reason used to live in the Restore button's tooltip,
                      which is nothing on a touch screen and nothing to a
                      glance. It belongs in the row. */}
                  {e.blocked && (
                    <span className="block text-2xs text-status-warning">
                      Restore the {e.holder} above it first
                    </span>
                  )}
                  {!e.blocked && expired(e.daysLeft) && (
                    <span className="block text-2xs text-status-warning">
                      Past the window: the next cleanup pass removes it
                    </span>
                  )}
                </td>
                <td className={cn(TD, "truncate text-xs text-text-tertiary")}>{e.where}</td>
                <td className={cn(TD, "text-xs text-text-tertiary")}>
                  {e.daysLeft === null
                    ? "kept until deleted"
                    : `${count(e.daysLeft, "day")} left`}
                </td>
                <td className={cn(TD, "text-right text-xs tabular-nums text-text-tertiary")}>
                  {/* A child of a trashed project prices nothing of its own:
                      those bytes are the project's figure. */}
                  {e.bytes === null ? "" : formatBytes(e.bytes)}
                </td>
                <td className={TD}>
                  {/* One row, right aligned: stacked buttons made every entry
                      twice as tall and the column ragged. Each button names its
                      own row, or a screen reader hears the same two words all
                      the way down the list. */}
                  <div className="flex items-center justify-end gap-1">
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-label={`Restore ${e.what}`}
                      // Days left of zero answers 409: the window is over and
                      // the row is the collector's now.
                      disabled={e.blocked || expired(e.daysLeft)}
                      onClick={() => restore(e.payload)}
                    >
                      Restore
                    </Button>
                    {!e.blocked && (
                      <Button
                        variant="ghost"
                        size="sm"
                        aria-label={`Delete ${e.what} permanently`}
                        onClick={() => {
                          setPurgeFailure(null);
                          setPurging({ kind: "one", entry: e });
                        }}
                      >
                        Delete permanently
                      </Button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </ListFrame>
      </ListState>

      <TypedConfirmDialog
        open={purging !== null}
        onOpenChange={(open) => {
          if (!open) {
            setPurging(null);
            setPurgeFailure(null);
          }
        }}
        title={
          purging?.kind === "all"
            ? `Permanently delete ${count(purging.count, "item")}?`
            : `Permanently delete ${purging?.entry.what ?? ""}?`
        }
        description={
          // The figures the dialog opened with, not whatever has arrived since.
          `This frees ${formatBytes(
            (purging?.kind === "all" ? purging.bytes : purging?.entry.bytes) ?? 0,
          )} right away and cannot be undone. ` +
          (purging?.kind === "all"
            ? "Everything in the trash is removed from the database and from storage, "
            : "It is removed from the database and from storage, ") +
          "originals and transcoded versions alike. " +
          (purging?.kind === "all"
            ? "There is no way back afterwards."
            : "Everything else in the trash stays.")
        }
        // Typed at every size: the soft delete has a threshold because it comes
        // back, and nothing here does.
        requiredText="DELETE"
        prompt="Type DELETE to confirm:"
        confirmLabel="Delete permanently"
        error={purgeFailure}
        onConfirm={async () => {
          if (purging?.kind === "all") {
            await purge(
              { everything: true },
              purging.count,
              purging.bytes,
              "Could not empty the trash",
            );
          } else if (purging) {
            await purge(
              purging.entry.payload,
              1,
              purging.entry.bytes ?? 0,
              "Could not delete that for good",
            );
          }
          setPurging(null);
        }}
      />
    </section>
  );
}

// ── the tab ───────────────────────────────────────────────────────────────────

export function StorageTab() {
  const { data, isLoading, error, mutate } = useSWR<StorageOverview>(
    "/admin/storage",
    (key: string) => api.get<StorageOverview>(key),
  );
  const { data: trash, mutate: mutateTrash } = useSWR<TrashOverview>(
    "/admin/trash",
    (key: string) => api.get<TrashOverview>(key),
  );
  const { mutate: revalidate } = useSWRConfig();

  const [showTrash, setShowTrash] = React.useState(false);
  const [expanded, setExpanded] = React.useState<Set<string>>(new Set());
  const [selection, setSelection] = React.useState<Selection>(EMPTY);
  const [confirming, setConfirming] = React.useState(false);
  const [failure, setFailure] = React.useState<string | null>(null);
  // Set when the server answers 428. The thresholds below are a courtesy, and
  // this is what keeps the server the only authority: a selection the dialog
  // thought was small enough gets the field and stays open, rather than asking
  // for a word typed somewhere that does not exist.
  const [phraseRequired, setPhraseRequired] = React.useState(false);

  const projects = React.useMemo(() => data?.projects ?? [], [data]);
  const largest = projects[0]?.total_bytes ?? 0;
  const summary = data?.summary;
  const retentionDays = summary?.retention_days ?? 30;
  const chosen = selectionSize(selection);
  const trashCount =
    (trash?.projects.length ?? 0) + (trash?.assets.length ?? 0) + (trash?.versions.length ?? 0);

  // Only projects can be priced from this list; files and versions are inside
  // a response the summary does not carry. The dialog therefore names the
  // number of items always and the size only when it can stand behind it,
  // rather than quoting a figure that silently omits the rest.
  const projectBytes = projects
    .filter((p) => selection.projects.has(p.project_id))
    .reduce((sum, p) => sum + p.total_bytes, 0);
  const onlyProjects = selection.assets.size === 0 && selection.versions.size === 0;

  const toggle = (level: keyof Selection, id: string) =>
    setSelection((s) => ({ ...s, [level]: toggleIn(s[level], id) }));

  // The thresholds the server applies, mirrored so the dialog can ask first,
  // plus whatever the server has already refused for. Files and versions are
  // priced inside a response this list does not carry, so their size cannot be
  // mirrored at all: a 428 is what asks for the phrase there.
  const needsPhrase =
    phraseRequired ||
    selection.projects.size > 1 ||
    (onlyProjects && projectBytes > CONFIRM_ABOVE_BYTES);

  const refresh = async () => {
    await Promise.all([
      mutate(),
      mutateTrash(),
      // The open project lists too, or a file deleted from an expanded project
      // keeps its row and its live checkbox, and ticking it again gets a 409.
      ...[...expanded].map((id) => revalidate(`/admin/storage/projects/${id}`)),
    ]);
  };

  const handleDelete = async () => {
    setFailure(null);
    try {
      await api.post<AdminDeleteResponse>("/admin/delete", {
        project_ids: [...selection.projects],
        asset_ids: [...selection.assets],
        version_ids: [...selection.versions],
        confirm_count: chosen,
        confirm_text: needsPhrase ? "DELETE" : null,
      });
    } catch (err: unknown) {
      // Rethrown so the dialog stays open carrying the server's own reason,
      // which is the only place the refusal is explained.
      if (statusOf(err) === 428) setPhraseRequired(true);
      setFailure(reason(err, "Could not delete that selection"));
      throw err;
    }
    setSelection(EMPTY);
    setPhraseRequired(false);
    await refresh();
  };

  if (showTrash) {
    return (
      <TrashList
        onChanged={refresh}
        onBack={() => {
          setShowTrash(false);
          void refresh();
        }}
      />
    );
  }

  return (
    <section className="space-y-4">
      {summary && (
        <div className="space-y-2">
          <p className="text-sm text-text-primary tabular-nums">
            {summary.capacity_bytes === null ? (
              // No limit configured means no capacity this app can learn, so
              // it says what is used and stops rather than inventing one.
              <>{formatBytes(summary.used_bytes)} used</>
            ) : (
              <>
                {formatBytes(summary.used_bytes)} of {formatBytes(summary.capacity_bytes)} used,{" "}
                <span className="text-text-tertiary">
                  {formatBytes(summary.free_bytes ?? 0)} free
                </span>
              </>
            )}
          </p>
          {summary.capacity_bytes !== null && (
            <StorageBar
              pct={share(summary.used_bytes, summary.capacity_bytes)}
              level={
                summary.used_bytes / summary.capacity_bytes >= 0.9
                  ? "critical"
                  : summary.used_bytes / summary.capacity_bytes >= 0.8
                    ? "warn"
                    : "ok"
              }
              label={`${formatBytes(summary.used_bytes)} of ${formatBytes(summary.capacity_bytes)} used`}
            />
          )}
          {/* "Of which", not "plus": used is every committed byte the bucket
              still holds, the trash included, because that is what the upload
              limit blocks on. So the live rows plus this figure add up to the
              number above, and free is space the next upload really has. A
              trash holding rows but no bytes still needs its link. */}
          {(summary.trash_bytes > 0 || trashCount > 0) && (
            <p className="text-xs text-text-tertiary">
              {summary.trash_bytes > 0 && `Of which ${formatBytes(summary.trash_bytes)} is in the `}
              <button
                type="button"
                onClick={() => setShowTrash(true)}
                className="underline underline-offset-2 hover:text-text-secondary"
              >
                {summary.trash_bytes > 0 ? "trash" : "Trash"}
              </button>
              {summary.trash_bytes > 0 &&
                (retentionDays > 0
                  ? `, gone for good after ${retentionDays} days.`
                  : `, kept until somebody empties it.`)}
            </p>
          )}
          {/* The figure is a floor until the backfill has run, and saying so is
              the difference between an incomplete number and a wrong one. */}
          {summary.unmeasured_files > 0 && (
            <p className="text-xs text-text-tertiary">
              {count(summary.unmeasured_files, "file")} not measured yet, so this figure is low.
            </p>
          )}
        </div>
      )}

      {/* A delete refusal is shown in the dialog, which stays open to carry it;
          printing it out here as well put the same sentence on screen twice. */}

      <ListState
        isLoading={isLoading}
        error={error}
        isEmpty={projects.length === 0}
        icon={HardDrive}
        title="Nothing stored yet"
        description="Projects appear here once they hold uploaded media."
      >
        <ListFrame>
          <colgroup>
            <col className="w-10" />
            <col />
            <col className="w-[26%]" />
            <col className="w-28" />
          </colgroup>
          <tbody>
            {projects.map((p) => {
              const open = expanded.has(p.project_id);
              return (
                <React.Fragment key={p.project_id}>
                  <tr className="border-b border-border last:border-0 hover:bg-bg-tertiary/50 transition-colors">
                    <td className={TD}>
                      <Checkbox
                        checked={selection.projects.has(p.project_id)}
                        onChange={() => toggle("projects", p.project_id)}
                        label={`Select ${p.name}`}
                      />
                    </td>
                    <td className={cn(TD, "overflow-hidden")}>
                      <button
                        type="button"
                        aria-expanded={open}
                        onClick={() => setExpanded((s) => toggleIn(s, p.project_id))}
                        className="flex w-full min-w-0 items-center gap-1.5 rounded text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                      >
                        <ChevronRight
                          className={cn(
                            "h-3.5 w-3.5 shrink-0 text-text-tertiary transition-transform",
                            open && "rotate-90",
                          )}
                        />
                        {/* min-w-0 on the flex child, or a long name widens the
                            cell instead of being truncated inside it. */}
                        <span className="min-w-0 flex-1">
                          <Name title={p.name}>{p.name}</Name>
                        </span>
                      </button>
                    </td>
                    <td className={TD}>
                      <StorageBar
                        pct={share(p.total_bytes, largest)}
                        label={`${p.name}: ${formatBytes(p.total_bytes)} of ${formatBytes(largest)} in the largest project`}
                      />
                    </td>
                    <td className={TD}>
                      <Bytes>{formatBytes(p.total_bytes)}</Bytes>
                    </td>
                  </tr>
                  {open && (
                    <tr className="border-b border-border last:border-0">
                      <td colSpan={4} className="p-0">
                        <ProjectFiles
                          projectId={p.project_id}
                          selection={selection}
                          onToggle={toggle}
                        />
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              );
            })}
          </tbody>
        </ListFrame>
      </ListState>

      {data && data.project_count > projects.length && (
        <p className="text-xs text-text-tertiary">
          Showing the {projects.length} largest of {data.project_count} projects.
        </p>
      )}

      <ActionBar
        show={chosen > 0}
        label={
          onlyProjects && projectBytes > 0
            ? `Delete ${chosen} (${formatBytes(projectBytes)})`
            : `Delete ${chosen}`
        }
        onClick={() => {
          setFailure(null);
          setConfirming(true);
        }}
      />

      <TypedConfirmDialog
        open={confirming}
        onOpenChange={(open) => {
          setConfirming(open);
          if (!open) {
            setFailure(null);
            setPhraseRequired(false);
          }
        }}
        title={`Delete ${count(chosen, "item")}?`}
        description={
          (onlyProjects && projectBytes > 0
            ? `That is ${formatBytes(projectBytes)}. `
            : "") +
          // With the window switched off there is no number of days to name,
          // and "for 0 days" read as if the trash were pointless.
          (retentionDays > 0
            ? `They go to the trash for ${retentionDays} days and are removed for good after that. `
            : "They go to the trash, which is kept until somebody empties it. ") +
          `Everyone in them loses access right away.`
        }
        requiredText={needsPhrase ? "DELETE" : null}
        // Names the threshold that actually tripped. One sentence for both read
        // "More than one project" at a single 200 GB project, which is the kind
        // of small lie that teaches people to stop reading dialogs.
        prompt={
          selection.projects.size > 1
            ? "More than one project: type DELETE to confirm."
            : onlyProjects && projectBytes > CONFIRM_ABOVE_BYTES
              ? "More than 10 GB: type DELETE to confirm."
              : "Type DELETE to confirm."
        }
        confirmLabel="Delete"
        error={failure}
        onConfirm={handleDelete}
      />
    </section>
  );
}
