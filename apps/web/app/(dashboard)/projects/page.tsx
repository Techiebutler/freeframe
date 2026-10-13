"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import useSWR from "swr";
import * as Dialog from "@radix-ui/react-dialog";
import {
  Plus,
  FolderOpen,
  X,
  Users,
  Share2,
  Globe,
} from "lucide-react";
import { cn, formatBytes } from "@/lib/utils";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ProjectCard } from "@/components/projects/project-card";
import { ProjectsAppearancePopover } from "@/components/projects/projects-appearance-popover";
import { ProjectsSortPopover } from "@/components/projects/projects-sort-popover";
import { EmptyState } from "@/components/shared/empty-state";
import { useAuthStore } from "@/stores/auth-store";
import { useProjectsViewStore } from "@/stores/projects-view-store";
import type { ViewLayout, CardSize } from "@/stores/view-store";
import { sortProjects } from "@/lib/project-sort";
import { usePageTitle } from "@/hooks/use-page-title";
import type { Project, ProjectType } from "@/types";

const projectGridColsMap: Record<CardSize, string> = {
  S: "grid-cols-3 sm:grid-cols-4 lg:grid-cols-6 xl:grid-cols-8",
  M: "grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5",
  L: "grid-cols-1 sm:grid-cols-2 lg:grid-cols-3",
};

// Runs before paint in the browser, so the cached appearance replaces the
// server-rendered defaults without a visible flash. useLayoutEffect warns on the server.
const useIsomorphicLayoutEffect =
  typeof window !== "undefined" ? React.useLayoutEffect : React.useEffect;

interface CreateProjectForm {
  name: string;
  description: string;
  project_type: ProjectType;
}

function ProjectListRow({
  project,
  showRole,
}: {
  project: Project;
  showRole?: boolean;
}) {
  const roleName =
    project.role === "owner"
      ? "Owner"
      : project.role === "editor"
        ? "Editor"
        : project.role === "reviewer"
          ? "Reviewer"
          : project.role === "viewer"
            ? "Viewer"
            : "Member";

  return (
    <Link
      href={`/projects/${project.id}`}
      className="flex items-center gap-4 px-4 py-3 hover:bg-bg-hover transition-colors border-b border-border last:border-b-0"
    >
      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-violet-600 to-fuchsia-500">
        <FolderOpen className="h-4 w-4 text-white" />
      </div>
      <div className="flex-1 min-w-0">
        <span className="text-sm font-medium text-text-primary truncate block">
          {project.name}
        </span>
        <span className="text-2xs text-text-tertiary">
          {(project.asset_count ?? 0) > 0
            ? `${project.asset_count} item${(project.asset_count ?? 0) !== 1 ? "s" : ""} · ${formatBytes(project.storage_bytes ?? 0)}`
            : "No assets yet"}
        </span>
      </div>
      <div className="hidden sm:flex items-center gap-1.5 text-xs text-text-tertiary">
        <Users className="h-3 w-3" />
        {project.member_count ?? 1}
      </div>
      <span className="hidden md:block text-xs text-text-tertiary w-28">
        {new Date(project.created_at).toLocaleDateString("en-US", {
          month: "short",
          day: "numeric",
          year: "numeric",
        })}
      </span>
      {showRole && (
        <span
          className={cn(
            "hidden sm:inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium w-fit",
            project.role === "owner"
              ? "bg-accent/10 text-accent"
              : project.role === "editor"
                ? "bg-blue-500/10 text-blue-400"
                : project.role === "reviewer"
                  ? "bg-amber-500/10 text-amber-400"
                  : "bg-bg-tertiary text-text-tertiary",
          )}
        >
          {roleName}
        </span>
      )}
    </Link>
  );
}

function ProjectSection({
  title,
  icon,
  projects,
  viewMode,
  cardSize,
  showCardInfo,
  emptyMessage,
  onNewProject,
  showNewButton,
  showRole,
  userId,
  onMutate,
}: {
  title: string;
  icon?: React.ReactNode;
  projects: Project[];
  viewMode: ViewLayout;
  cardSize: CardSize;
  showCardInfo: boolean;
  emptyMessage: string;
  onNewProject?: () => void;
  showNewButton?: boolean;
  showRole?: boolean;
  userId?: string;
  onMutate?: () => void;
}) {
  if (projects.length === 0 && !showNewButton) {
    return null;
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        {icon}
        <h2 className="text-sm font-medium text-text-secondary">{title}</h2>
        <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-bg-tertiary px-1.5 text-[10px] font-medium text-text-tertiary">
          {projects.length}
        </span>
      </div>

      {projects.length === 0 && showNewButton ? (
        <button
          onClick={onNewProject}
          className="group flex w-full items-center gap-4 rounded-xl border-2 border-dashed border-border bg-bg-secondary/30 px-5 py-8 hover:border-accent/40 hover:bg-bg-secondary/60 transition-all duration-200"
        >
          <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-bg-tertiary text-text-tertiary group-hover:bg-accent group-hover:text-white transition-colors">
            <Plus className="h-5 w-5" />
          </div>
          <div className="text-left">
            <p className="text-sm font-medium text-text-primary">
              Create your first project
            </p>
            <p className="text-xs text-text-tertiary mt-0.5">
              Organize and review your media assets
            </p>
          </div>
        </button>
      ) : viewMode === "grid" ? (
        <div className={cn("grid gap-4", projectGridColsMap[cardSize])}>
          {projects.map((project) => (
            <ProjectCard
              key={project.id}
              project={project}
              showRole={showRole}
              isOwner={!!userId && project.created_by === userId}
              showInfo={showCardInfo}
              onMutate={onMutate}
            />
          ))}
          {showNewButton && onNewProject && (
            <button
              onClick={onNewProject}
              className="group flex flex-col items-center justify-center gap-2.5 rounded-xl border-2 border-dashed border-border bg-bg-secondary/30 aspect-square hover:border-accent/40 hover:bg-bg-secondary/60 transition-all duration-200"
            >
              <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-bg-tertiary text-text-tertiary group-hover:bg-accent group-hover:text-white transition-colors">
                <Plus className="h-5 w-5" />
              </div>
              <span className="text-sm text-text-secondary group-hover:text-text-primary transition-colors">
                New Project
              </span>
            </button>
          )}
        </div>
      ) : (
        <div className="rounded-xl border border-border overflow-hidden bg-bg-secondary">
          {projects.map((project) => (
            <ProjectListRow
              key={project.id}
              project={project}
              showRole={showRole}
            />
          ))}
          {showNewButton && onNewProject && (
            <button
              onClick={onNewProject}
              className="flex items-center gap-3 px-4 py-3 w-full hover:bg-bg-hover transition-colors text-left border-t border-border"
            >
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border-2 border-dashed border-border text-text-tertiary">
                <Plus className="h-3.5 w-3.5" />
              </div>
              <span className="text-sm text-text-secondary">New Project</span>
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export default function ProjectsPage() {
  usePageTitle("Projects");
  const router = useRouter();
  const { user } = useAuthStore();
  const {
    layout: viewMode,
    cardSize,
    showCardInfo,
    sortKey,
    sortDirection,
    syncFromServer,
  } = useProjectsViewStore();
  const [dialogOpen, setDialogOpen] = React.useState(false);
  const [isCreating, setIsCreating] = React.useState(false);
  const [formError, setFormError] = React.useState("");

  const [form, setForm] = React.useState<CreateProjectForm>({
    name: "",
    description: "",
    project_type: "personal",
  });

  const {
    data: projects,
    isLoading,
    mutate,
  } = useSWR<Project[]>("/projects", () => api.get<Project[]>("/projects"));

  const sortedProjects = React.useMemo(
    () => sortProjects(projects ?? [], sortKey, sortDirection),
    [projects, sortKey, sortDirection],
  );

  const myProjects = React.useMemo(
    () => sortedProjects.filter((p) => p.created_by === user?.id),
    [sortedProjects, user?.id],
  );

  const sharedProjects = React.useMemo(
    () => sortedProjects.filter((p) => p.created_by !== user?.id && p.role),
    [sortedProjects, user?.id],
  );

  const publicProjects = React.useMemo(
    () =>
      sortedProjects.filter(
        (p) => p.is_public && p.created_by !== user?.id && !p.role,
      ),
    [sortedProjects, user?.id],
  );

  // Read this browser's cached appearance only after hydration, so the first
  // client render matches the server's (default) HTML.
  useIsomorphicLayoutEffect(() => {
    useProjectsViewStore.persist.rehydrate();
  }, []);

  // The account's saved appearance wins over this browser's cached one.
  React.useEffect(() => {
    if (user?.preferences) syncFromServer(user.preferences);
  }, [user?.preferences, syncFromServer]);

  const resetForm = () => {
    setForm({ name: "", description: "", project_type: "personal" });
    setFormError("");
  };

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.name.trim()) {
      setFormError("Project name is required.");
      return;
    }
    setIsCreating(true);
    setFormError("");
    try {
      const created = await api.post<Project>("/projects", {
        name: form.name.trim(),
        description: form.description.trim() || null,
        project_type: form.project_type,
      });
      await mutate();
      setDialogOpen(false);
      resetForm();
      router.push(`/projects/${created.id}`);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to create project";
      setFormError(message);
    } finally {
      setIsCreating(false);
    }
  };

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      {/* Title, view controls, New Project on one line; on a phone the
          view controls drop to their own line under the title. The title
          sits in an h-8 row so it centers with the h-8 buttons. */}
      <div className="flex flex-wrap items-start gap-x-4 gap-y-2">
        <div>
          <h1 className="flex h-8 items-center text-lg font-semibold text-text-primary">
            Projects
          </h1>
          {projects && projects.length > 0 && (
            <p className="mt-0.5 text-sm text-text-tertiary">
              {projects.length} project{projects.length !== 1 ? "s" : ""}
            </p>
          )}
        </div>

        <div className="order-last flex w-full items-center gap-1 sm:order-none sm:w-auto">
          <ProjectsAppearancePopover />
          <div className="h-4 w-px bg-border mx-0.5" />
          <ProjectsSortPopover />
        </div>

        <div className="ml-auto flex items-center gap-2">
          <Dialog.Root
            open={dialogOpen}
            onOpenChange={(open) => {
              setDialogOpen(open);
              if (!open) resetForm();
            }}
          >
            <Dialog.Trigger asChild>
              <Button size="sm">
                <Plus className="h-4 w-4" />
                New Project
              </Button>
            </Dialog.Trigger>

            <Dialog.Portal>
              <Dialog.Overlay className="fixed inset-0 z-40 bg-black/50 backdrop-blur-sm data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0" />
              <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-full max-w-md -translate-x-1/2 -translate-y-1/2 data-[state=open]:slide-in-from-left-1/2 data-[state=open]:slide-in-from-top-[48%] data-[state=closed]:slide-out-to-left-1/2 data-[state=closed]:slide-out-to-top-[48%] rounded-xl border border-border bg-bg-secondary p-6 shadow-xl data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95">
                <Dialog.Close className="absolute right-4 top-4 text-text-tertiary hover:text-text-primary transition-colors">
                  <X className="h-4 w-4" />
                </Dialog.Close>

                <Dialog.Title className="text-base font-semibold text-text-primary">
                  New Project
                </Dialog.Title>
                <Dialog.Description className="mt-1 text-sm text-text-secondary">
                  Create a new project to organize your assets.
                </Dialog.Description>

                <form onSubmit={handleCreate} className="mt-5 space-y-4">
                  <Input
                    label="Project name"
                    placeholder="e.g. Brand Campaign 2025"
                    value={form.name}
                    onChange={(e) =>
                      setForm((f) => ({ ...f, name: e.target.value }))
                    }
                    required
                  />

                  <div className="flex flex-col gap-1.5">
                    <label className="text-sm font-medium text-text-secondary">
                      Description
                    </label>
                    <textarea
                      rows={2}
                      placeholder="Optional description..."
                      value={form.description}
                      onChange={(e) =>
                        setForm((f) => ({ ...f, description: e.target.value }))
                      }
                      className="flex w-full rounded-md border border-border bg-bg-secondary px-3 py-2 text-sm text-text-primary placeholder:text-text-tertiary resize-none focus:outline-none focus:border-border-focus focus:ring-1 focus:ring-border-focus"
                    />
                  </div>

                  {formError && (
                    <p className="text-sm text-status-error">{formError}</p>
                  )}

                  <div className="flex justify-end gap-2 pt-2">
                    <Dialog.Close asChild>
                      <Button type="button" variant="secondary" size="sm">
                        Cancel
                      </Button>
                    </Dialog.Close>
                    <Button type="submit" size="sm" loading={isCreating}>
                      Create project
                    </Button>
                  </div>
                </form>
              </Dialog.Content>
            </Dialog.Portal>
          </Dialog.Root>
        </div>
      </div>

      {/* Content */}
      {isLoading ? (
        viewMode === "list" ? (
          <div className="rounded-xl border border-border overflow-hidden bg-bg-secondary">
            {Array.from({ length: 5 }).map((_, i) => (
              <div
                key={i}
                className="flex items-center gap-4 px-4 py-3 border-b border-border last:border-b-0"
              >
                <div className="h-9 w-9 shrink-0 animate-pulse rounded-lg bg-bg-tertiary" />
                <div className="flex-1 space-y-1.5">
                  <div className="h-3 w-1/3 animate-pulse rounded bg-bg-tertiary" />
                  <div className="h-2.5 w-1/5 animate-pulse rounded bg-bg-tertiary" />
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className={cn("grid gap-4", projectGridColsMap[cardSize])}>
            {Array.from({ length: 5 }).map((_, i) => (
              <div
                key={i}
                className="flex flex-col rounded-xl overflow-hidden border border-border"
              >
                <div className="aspect-square animate-pulse bg-bg-tertiary" />
                {showCardInfo && (
                  <div className="px-3 py-2.5">
                    <div className="h-3 w-2/3 animate-pulse rounded bg-bg-tertiary" />
                  </div>
                )}
              </div>
            ))}
          </div>
        )
      ) : !projects || projects.length === 0 ? (
        <div className="rounded-xl border border-border bg-bg-secondary">
          <EmptyState
            icon={FolderOpen}
            title="No projects yet"
            description="Create your first project to start organizing assets."
            action={{
              label: "New Project",
              onClick: () => setDialogOpen(true),
            }}
          />
        </div>
      ) : (
        <div className="space-y-8">
          <ProjectSection
            title="My Projects"
            icon={<FolderOpen className="h-4 w-4 text-text-tertiary" />}
            projects={myProjects}
            viewMode={viewMode}
            cardSize={cardSize}
            showCardInfo={showCardInfo}
            emptyMessage="You haven't created any projects yet."
            onNewProject={() => setDialogOpen(true)}
            showNewButton
            userId={user?.id}
            onMutate={() => mutate()}
          />
          {sharedProjects.length > 0 && (
            <ProjectSection
              title="Shared with Me"
              icon={<Share2 className="h-4 w-4 text-text-tertiary" />}
              projects={sharedProjects}
              viewMode={viewMode}
              cardSize={cardSize}
              showCardInfo={showCardInfo}
              emptyMessage=""
              showRole
              userId={user?.id}
              onMutate={() => mutate()}
            />
          )}
          {publicProjects.length > 0 && (
            <ProjectSection
              title="Public Projects"
              icon={<Globe className="h-4 w-4 text-text-tertiary" />}
              projects={publicProjects}
              viewMode={viewMode}
              cardSize={cardSize}
              showCardInfo={showCardInfo}
              emptyMessage=""
              userId={user?.id}
              onMutate={() => mutate()}
            />
          )}
        </div>
      )}
    </div>
  );
}
