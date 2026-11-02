"use client";

import * as React from "react";
import useSWR from "swr";
import Link from "next/link";
import { Clock, FolderOpen, HardDrive, Share2, Users, UserX } from "lucide-react";
import { cn, formatBytes, formatRelativeTime } from "@/lib/utils";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Avatar } from "@/components/shared/avatar";
import { ProjectPoster } from "@/components/projects/project-poster";
import { useAdminViewStore } from "@/stores/admin-view-store";
import {
  ActionBar,
  Bytes,
  Card,
  CardFact,
  CardGrid,
  Checkbox,
  ListFrame,
  ListState,
  Name,
  Pill,
  TabBar,
  TD,
  TH,
  TypedConfirmDialog,
} from "./admin-list";
import type {
  AdminProjectRow,
  ExternalShareRow,
  InternalShareRow,
  InternalSharePerson,
} from "@/types";

/**
 * The three tabs that are mostly reading: Projects, Internal sharing, External
 * sharing.
 *
 * Each answers one question, with at most four facts per entry and at most one
 * action. None of them writes a role or a membership of its own: editing goes
 * to the project's own page through the Edit link, so there is one place in the
 * app where access is granted rather than two that can disagree.
 *
 * Two of them offer cards as well as rows, through the projects page's own
 * layout switch and nothing new. Where cards help they are the default:
 * Projects, because a poster is how a person recognises a project, and that is
 * what the projects page shows. Where rows read better they stay the default:
 * Internal sharing is read down the role column.
 */

function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

function people(n: number): string {
  return n === 1 ? "1 person" : `${n} people`;
}

/** "an hour ago", or "never" for a project nothing has happened in. */
function activity(at: string | null): string {
  return at ? formatRelativeTime(at) : "never";
}

/**
 * Where an admin goes to change a project: its own page.
 *
 * Not `/projects/{id}/settings`, which is branding, watermarks and metadata
 * fields. Members, roles and the project's own settings dialog all hang off the
 * project page, and since this release an instance admin reaches it without
 * being a member, so the link works for exactly the people who see this tab.
 */
function EditLink({ projectId }: { projectId: string }) {
  return (
    <Button variant="ghost" size="sm" asChild>
      <Link href={`/projects/${projectId}`}>Edit</Link>
    </Button>
  );
}

// ── Projects ──────────────────────────────────────────────────────────────────

/**
 * A project as a card: poster, name, and the same three facts the row carries.
 *
 * Built from `ProjectPoster`, the tokens and the shared `Card`, which is what
 * the projects page's own card is built from. It is not `ProjectCard` itself
 * because that one carries the project menu (rename, delete, poster) and wants
 * a full project object; this tab reads, and its one action is Edit.
 */
function ProjectCardView({ project }: { project: AdminProjectRow }) {
  return (
    <Card>
      <Link
        href={`/projects/${project.project_id}`}
        className="relative block aspect-square w-full overflow-hidden"
      >
        <ProjectPoster
          project={{
            id: project.project_id,
            name: project.name,
            poster_url: project.poster_url,
          }}
        />
        <div className="absolute inset-x-0 bottom-0 h-24 bg-gradient-to-t from-black/70 via-black/30 to-transparent" />
        <div className="absolute inset-x-0 bottom-0 p-3">
          <p className="line-clamp-2 text-sm font-semibold text-white drop-shadow-sm">
            {project.name}
          </p>
        </div>
      </Link>
      <div className="flex items-center justify-between gap-2 px-3 py-2">
        <div className="flex min-w-0 flex-col gap-1">
          <CardFact icon={HardDrive}>{formatBytes(project.total_bytes)}</CardFact>
          <CardFact icon={Users}>{count(project.member_count, "member")}</CardFact>
          <CardFact icon={Clock}>{activity(project.last_activity_at)}</CardFact>
        </div>
        <EditLink projectId={project.project_id} />
      </div>
    </Card>
  );
}

export function AdminProjectsTab() {
  const { data, isLoading, error } = useSWR<AdminProjectRow[]>(
    "/admin/projects",
    (key: string) => api.get<AdminProjectRow[]>(key),
  );
  const rows = data ?? [];
  const layout = useAdminViewStore((s) => s.layouts.projects);
  const setLayout = useAdminViewStore((s) => s.setLayout);

  return (
    <section className="space-y-3">
      <TabBar
        hint={rows.length > 0 ? count(rows.length, "project") : undefined}
        layout={layout}
        onLayout={(next) => setLayout("projects", next)}
      />

      <ListState
        isLoading={isLoading}
        error={error}
        isEmpty={rows.length === 0}
        icon={FolderOpen}
        title="No projects"
        description="Projects appear here once somebody creates one."
      >
        {layout === "grid" ? (
          <CardGrid>
            {rows.map((p) => (
              <ProjectCardView key={p.project_id} project={p} />
            ))}
          </CardGrid>
        ) : (
          <ListFrame>
            <colgroup>
              <col />
              <col className="w-28" />
              <col className="w-28" />
              <col className="w-40" />
              <col className="w-20" />
            </colgroup>
            <thead>
              <tr className="border-b border-border bg-bg-tertiary">
                <th className={TH}>Project</th>
                <th className={TH}>Members</th>
                <th className={cn(TH, "text-right")}>Size</th>
                <th className={cn(TH, "text-right")}>Last activity</th>
                <th className={TH} />
              </tr>
            </thead>
            <tbody>
              {rows.map((p) => (
                <tr
                  key={p.project_id}
                  className="border-b border-border last:border-0 hover:bg-bg-tertiary/50 transition-colors"
                >
                  <td className={cn(TD, "overflow-hidden")}>
                    <Name title={p.name}>{p.name}</Name>
                  </td>
                  <td className={cn(TD, "text-sm tabular-nums text-text-secondary")}>
                    {p.member_count}
                  </td>
                  <td className={TD}>
                    <Bytes>{formatBytes(p.total_bytes)}</Bytes>
                  </td>
                  <td className={cn(TD, "text-right text-xs text-text-tertiary")}>
                    {activity(p.last_activity_at)}
                  </td>
                  <td className={cn(TD, "text-right")}>
                    <EditLink projectId={p.project_id} />
                  </td>
                </tr>
              ))}
            </tbody>
          </ListFrame>
        )}
      </ListState>
    </section>
  );
}

// ── Internal sharing ──────────────────────────────────────────────────────────

/**
 * What a project with nobody left says.
 *
 * A project whose only members were deleted as users used to drop off this tab
 * altogether, while Projects and Storage went on showing it. The block stays,
 * and it says what is wrong and what to do about it, because the Edit link next
 * to this sentence is the fix.
 */
function NobodyLeft() {
  return (
    <p className="flex items-center gap-2 px-4 py-3 text-xs text-status-warning">
      <UserX className="h-3.5 w-3.5 shrink-0" />
      Nobody can reach this project any more: every member was deleted as a
      user. Add somebody through Edit.
    </p>
  );
}

function PersonLine({
  person,
  size = "sm",
}: {
  person: InternalSharePerson;
  size?: "sm" | "md";
}) {
  return (
    <>
      <Avatar
        src={person.avatar_url}
        name={person.name}
        color={person.avatar_color}
        size={size}
      />
      <span className="min-w-0 flex-1">
        <Name title={`${person.name} (${person.email})`}>{person.name}</Name>
      </span>
      <Pill>{person.role}</Pill>
    </>
  );
}

/** One project, its people and their roles, with one Edit for the project. */
function ProjectAccessCard({ row }: { row: InternalShareRow }) {
  return (
    <Card>
      <div className="flex items-start justify-between gap-2 border-b border-border px-4 py-2.5">
        <div className="min-w-0">
          <Name title={row.project_name}>{row.project_name}</Name>
          <span className="text-2xs text-text-tertiary">
            {row.has_live_people ? people(row.people.length) : "nobody"}
          </span>
        </div>
        <EditLink projectId={row.project_id} />
      </div>

      {row.has_live_people ? (
        <ul className="divide-y divide-border">
          {row.people.map((person) => (
            <li
              key={person.user_id}
              className="flex items-center gap-2.5 px-4 py-2"
            >
              <PersonLine person={person} />
            </li>
          ))}
        </ul>
      ) : (
        <NobodyLeft />
      )}
    </Card>
  );
}

export function AdminInternalTab() {
  const { data, isLoading, error } = useSWR<InternalShareRow[]>(
    "/admin/shares/internal",
    (key: string) => api.get<InternalShareRow[]>(key),
  );
  const rows = data ?? [];
  const layout = useAdminViewStore((s) => s.layouts.internal);
  const setLayout = useAdminViewStore((s) => s.setLayout);

  return (
    <section className="space-y-3">
      <TabBar
        hint={rows.length > 0 ? count(rows.length, "project") : undefined}
        layout={layout}
        onLayout={(next) => setLayout("internal", next)}
      />

      <ListState
        isLoading={isLoading}
        error={error}
        isEmpty={rows.length === 0}
        icon={Users}
        title="Nobody shares a project yet"
        description="People appear here once they are added to a project."
      >
        {/* Both views group by project; the grid puts the blocks side by side,
            the list keeps them full width so the roles line up down the page.
            Grouping is the point either way: the question is who can reach a
            project, and a flat row per person asked it once per line. */}
        {layout === "grid" ? (
          <CardGrid>
            {rows.map((row) => (
              <ProjectAccessCard key={row.project_id} row={row} />
            ))}
          </CardGrid>
        ) : (
          <div className="space-y-3">
            {rows.map((row) => (
              <ProjectAccessCard key={row.project_id} row={row} />
            ))}
          </div>
        )}
      </ListState>
    </section>
  );
}

// ── External sharing ──────────────────────────────────────────────────────────

/** "view", plus the download right when the link grants it. */
function rights(row: ExternalShareRow): { label: string; risky: boolean } {
  const base = row.permission === "view" ? "view" : row.permission;
  const parts = [base];
  if (row.has_password) parts.push("password");
  const label = row.allow_download ? `${parts.join(" + ")} + download` : parts.join(" + ");
  return { label, risky: row.allow_download };
}

/**
 * How long a link has left, looking forward.
 *
 * `formatRelativeTime` only reads backwards: it takes the difference as a
 * positive age, so a link expiring in twelve days came out as "just now", which
 * is the opposite of what the column is for. This says "in 12 days", and names
 * an already-expired link rather than counting into the past.
 */
function expiresIn(iso: string): string {
  const seconds = Math.round((new Date(iso).getTime() - Date.now()) / 1000);
  if (seconds <= 0) return "expired";
  const plural = (n: number, unit: string) => `in ${n} ${unit}${n === 1 ? "" : "s"}`;
  if (seconds < 3600) return plural(Math.max(1, Math.round(seconds / 60)), "minute");
  if (seconds < 86_400) return plural(Math.round(seconds / 3600), "hour");
  if (seconds < 2_592_000) return plural(Math.round(seconds / 86_400), "day");
  return plural(Math.round(seconds / 2_592_000), "month");
}

export function AdminExternalTab() {
  const { data, isLoading, error, mutate } = useSWR<ExternalShareRow[]>(
    "/admin/shares/external",
    (key: string) => api.get<ExternalShareRow[]>(key),
  );
  const rows = data ?? [];

  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const [confirming, setConfirming] = React.useState(false);
  const [failure, setFailure] = React.useState<string | null>(null);

  const toggle = (token: string) =>
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(token)) next.delete(token);
      else next.add(token);
      return next;
    });

  const switchOff = async () => {
    setFailure(null);
    const failed: string[] = [];
    for (const token of selected) {
      try {
        // The app's own revoke, which notifies nobody. There is deliberately no
        // admin-only path beside it that could start behaving differently.
        await api.delete(`/share/${token}`);
      } catch {
        failed.push(token);
      }
    }
    await mutate();
    setSelected(new Set());
    if (failed.length > 0) {
      setFailure(`${count(failed.length, "link")} could not be switched off.`);
      throw new Error("partial failure");
    }
  };

  return (
    <section className="space-y-3">
      {/* The column of boxes used to be the only hint that anything could be
          done here, and the button appeared only once something was ticked, so
          a first visit saw a column that said nothing about itself. */}
      <TabBar
        hint={
          rows.length > 0
            ? "Tick a link to switch it off. Nobody is notified."
            : undefined
        }
      />

      {failure && <p className="text-sm text-status-error">{failure}</p>}

      <ListState
        isLoading={isLoading}
        error={error}
        isEmpty={rows.length === 0}
        icon={Share2}
        title="No links lead outside"
        description="Active share links appear here, with the rights they grant."
      >
        <ListFrame>
          <colgroup>
            <col className="w-16" />
            <col />
            <col className="w-48" />
            <col className="w-32" />
            <col className="w-36" />
          </colgroup>
          <thead>
            <tr className="border-b border-border bg-bg-tertiary">
              <th scope="col" className={TH}>
                Select
              </th>
              <th scope="col" className={TH}>
                Shared
              </th>
              <th scope="col" className={TH}>
                Rights
              </th>
              <th scope="col" className={TH}>
                Expires
              </th>
              <th scope="col" className={cn(TH, "text-right")}>
                Created by
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const right = rights(row);
              return (
                <tr
                  key={row.token}
                  className="border-b border-border last:border-0 hover:bg-bg-tertiary/50 transition-colors"
                >
                  <td className={TD}>
                    <Checkbox
                      checked={selected.has(row.token)}
                      onChange={() => toggle(row.token)}
                      label={`Select the link to ${row.what}`}
                    />
                  </td>
                  <td className={cn(TD, "overflow-hidden")}>
                    <Name title={row.what}>
                      {row.what}{" "}
                      <span className="text-xs text-text-tertiary">{row.kind}</span>
                    </Name>
                  </td>
                  <td className={TD}>
                    <Pill tone={right.risky ? "warning" : "neutral"}>{right.label}</Pill>
                  </td>
                  <td className={TD}>
                    {row.expires_at === null ? (
                      // A link with no expiry and a link with download are the
                      // two an admin opens this tab to find, so they are the
                      // only things on the page with a colour.
                      <span className="text-xs text-status-warning">never</span>
                    ) : (
                      <span className="text-xs text-text-tertiary">
                        {expiresIn(row.expires_at)}
                      </span>
                    )}
                  </td>
                  <td className={cn(TD, "truncate text-right text-xs text-text-tertiary")}>
                    {row.created_by_name ?? "unknown"}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </ListFrame>
      </ListState>

      <ActionBar
        show={selected.size > 0}
        label={`Switch off ${selected.size}`}
        onClick={() => {
          setFailure(null);
          setConfirming(true);
        }}
      />

      <TypedConfirmDialog
        open={confirming}
        onOpenChange={(open) => {
          setConfirming(open);
          if (!open) setFailure(null);
        }}
        title={`Switch off ${count(selected.size, "link")}?`}
        description={
          "Anyone holding the link stops getting in straight away. Nobody is " +
          "notified, and the project itself is unchanged."
        }
        // No typing here: switching a link off takes nothing away permanently,
        // and a gate on a reversible action only teaches people to type through
        // gates.
        requiredText={null}
        confirmLabel="Switch off"
        error={failure}
        onConfirm={switchOff}
      />
    </section>
  );
}
