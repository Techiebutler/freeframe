"use client";

import * as React from "react";
import { Command } from "cmdk";
import * as Dialog from "@radix-ui/react-dialog";
import { useRouter } from "next/navigation";
import useSWR from "swr";
import {
  LayoutDashboard,
  Layers,
  FolderOpen,
  Settings,
  Bell,
  FolderPlus,
  Upload,
  Search,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { api } from "@/lib/api";
import { Film, Music, Image as ImageIcon } from "lucide-react";
import type { Project, AssetResponse } from "@/types";

interface CommandPaletteProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

interface CommandItem {
  id: string;
  label: string;
  icon: React.ElementType;
  href?: string;
  action?: () => void;
  shortcut?: string;
  group: "navigation" | "actions";
}

export function CommandPalette({ open, onOpenChange }: CommandPaletteProps) {
  const router = useRouter();
  const [query, setQuery] = React.useState("");

  const [debouncedQuery, setDebouncedQuery] = React.useState("");

  // Fetch projects when palette is open
  const { data: projects } = useSWR<Project[]>(open ? "/projects" : null, () =>
    api.get<Project[]>("/projects"),
  );

  // Debounce search query for asset search
  React.useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery(query), 200);
    return () => clearTimeout(timer);
  }, [query]);

  // Search assets and folders when query is present
  const searchQ = debouncedQuery.trim();
  const { data: assets } = useSWR<AssetResponse[]>(
    open && searchQ.length >= 2
      ? `/me/assets?q=${encodeURIComponent(searchQ)}&limit=8`
      : null,
    (key: string) => api.get<AssetResponse[]>(key),
  );
  const { data: folders } = useSWR<
    {
      id: string;
      name: string;
      project_id: string;
      project_name: string | null;
    }[]
  >(
    open && searchQ.length >= 2
      ? `/me/folders?q=${encodeURIComponent(searchQ)}&limit=8`
      : null,
    (key: string) =>
      api.get<
        {
          id: string;
          name: string;
          project_id: string;
          project_name: string | null;
        }[]
      >(key),
  );

  // Reset query when dialog closes
  React.useEffect(() => {
    if (!open) {
      setQuery("");
      setDebouncedQuery("");
    }
  }, [open]);

  const staticItems: CommandItem[] = [
    {
      id: "home",
      label: "Home",
      icon: LayoutDashboard,
      href: "/",
      group: "navigation",
      shortcut: "G H",
    },
    {
      id: "projects",
      label: "Projects",
      icon: Layers,
      href: "/projects",
      group: "navigation",
      shortcut: "G P",
    },
    {
      id: "notifications",
      label: "Notifications",
      icon: Bell,
      href: "/notifications",
      group: "navigation",
    },
    {
      id: "settings",
      label: "Settings",
      icon: Settings,
      href: "/settings",
      group: "navigation",
    },
    {
      id: "new-project",
      label: "New Project",
      icon: FolderPlus,
      href: "/projects/new",
      group: "actions",
      shortcut: "N P",
    },
    {
      id: "upload-asset",
      label: "Upload Asset",
      icon: Upload,
      href: "/assets/upload",
      group: "actions",
      shortcut: "N A",
    },
  ];

  function handleSelect(item: CommandItem) {
    onOpenChange(false);
    if (item.action) {
      item.action();
    } else if (item.href) {
      router.push(item.href);
    }
  }

  function handleProjectSelect(project: Project) {
    onOpenChange(false);
    router.push(`/projects/${project.id}`);
  }

  function handleAssetSelect(asset: AssetResponse) {
    onOpenChange(false);
    router.push(`/projects/${asset.project_id}/assets/${asset.id}`);
  }

  function handleFolderSelect(folder: { id: string; project_id: string }) {
    onOpenChange(false);
    router.push(`/projects/${folder.project_id}?folder=${folder.id}`);
  }

  function getAssetIcon(type: string) {
    switch (type) {
      case "video":
        return Film;
      case "audio":
        return Music;
      default:
        return ImageIcon;
    }
  }

  const navItems = staticItems.filter((i) => i.group === "navigation");
  const actionItems = staticItems.filter((i) => i.group === "actions");

  const hasQuery = query.trim().length > 0;

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:duration-200" />
        <Dialog.Content className="fixed left-1/2 top-[20%] z-50 w-full max-w-lg -translate-x-1/2 -translate-y-0">
          <Dialog.Title className="sr-only">Command Palette</Dialog.Title>
          <Command
            className="overflow-hidden rounded border border-border bg-bg-elevated shadow-2xl animate-scale-in"
            loop
            shouldFilter={true}
          >
            <div className="flex items-center border-b border-border px-3 gap-2">
              <Search className="h-4 w-4 text-text-tertiary shrink-0" />
              <Command.Input
                placeholder="Search projects, assets, or jump to..."
                value={query}
                onValueChange={setQuery}
                className="h-12 w-full bg-transparent text-sm text-text-primary placeholder:text-text-tertiary focus:outline-none"
              />
            </div>
            <Command.List className="max-h-80 overflow-y-auto p-1.5">
              <Command.Empty className="py-8 text-center text-sm text-text-tertiary">
                No results found
              </Command.Empty>

              {/* Projects — show when searching */}
              {hasQuery && projects && projects.length > 0 && (
                <Command.Group
                  heading="Projects"
                  className="[&>[cmdk-group-heading]]:px-2 [&>[cmdk-group-heading]]:py-1.5 [&>[cmdk-group-heading]]:font-mono [&>[cmdk-group-heading]]:text-[10px] [&>[cmdk-group-heading]]:font-normal [&>[cmdk-group-heading]]:text-text-tertiary [&>[cmdk-group-heading]]:uppercase [&>[cmdk-group-heading]]:tracking-[0.16em]"
                >
                  {projects.map((project) => (
                    <Command.Item
                      key={`project-${project.id}`}
                      value={`project ${project.name} ${project.description || ""}`}
                      onSelect={() => handleProjectSelect(project)}
                      className={cn(
                        "flex cursor-pointer items-center gap-3 rounded-md px-2 py-2 text-sm text-text-secondary",
                        "data-[selected=true]:bg-bg-hover data-[selected=true]:text-text-primary",
                        "transition-colors",
                      )}
                    >
                      <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-gradient-to-br from-violet-600 to-fuchsia-500">
                        <FolderOpen className="h-3 w-3 text-white" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <span className="block truncate">{project.name}</span>
                        {project.description && (
                          <span className="block text-2xs text-text-tertiary truncate">
                            {project.description}
                          </span>
                        )}
                      </div>
                      <span className="text-2xs text-text-tertiary shrink-0">
                        {project.asset_count ?? 0} items
                      </span>
                    </Command.Item>
                  ))}
                </Command.Group>
              )}

              {/* Folders — show when searching (2+ chars) */}
              {hasQuery && folders && folders.length > 0 && (
                <Command.Group
                  heading="Folders"
                  className="[&>[cmdk-group-heading]]:px-2 [&>[cmdk-group-heading]]:py-1.5 [&>[cmdk-group-heading]]:font-mono [&>[cmdk-group-heading]]:text-[10px] [&>[cmdk-group-heading]]:font-normal [&>[cmdk-group-heading]]:text-text-tertiary [&>[cmdk-group-heading]]:uppercase [&>[cmdk-group-heading]]:tracking-[0.16em]"
                >
                  {folders.map((folder) => (
                    <Command.Item
                      key={`folder-${folder.id}`}
                      value={`folder ${folder.name} ${folder.project_name || ""}`}
                      onSelect={() => handleFolderSelect(folder)}
                      className={cn(
                        "flex cursor-pointer items-center gap-3 rounded-md px-2 py-2 text-sm text-text-secondary",
                        "data-[selected=true]:bg-bg-hover data-[selected=true]:text-text-primary",
                        "transition-colors",
                      )}
                    >
                      <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded bg-bg-tertiary">
                        <FolderOpen className="h-3 w-3 text-text-tertiary" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <span className="block truncate">{folder.name}</span>
                        {folder.project_name && (
                          <span className="block text-2xs text-text-tertiary truncate">
                            in {folder.project_name}
                          </span>
                        )}
                      </div>
                    </Command.Item>
                  ))}
                </Command.Group>
              )}

              {/* Assets — show when searching (2+ chars) */}
              {hasQuery && assets && assets.length > 0 && (
                <Command.Group
                  heading="Assets"
                  className="[&>[cmdk-group-heading]]:px-2 [&>[cmdk-group-heading]]:py-1.5 [&>[cmdk-group-heading]]:font-mono [&>[cmdk-group-heading]]:text-[10px] [&>[cmdk-group-heading]]:font-normal [&>[cmdk-group-heading]]:text-text-tertiary [&>[cmdk-group-heading]]:uppercase [&>[cmdk-group-heading]]:tracking-[0.16em]"
                >
                  {assets.map((asset) => {
                    const Icon = getAssetIcon(asset.asset_type);
                    return (
                      <Command.Item
                        key={`asset-${asset.id}`}
                        value={`asset ${asset.name} ${asset.asset_type}`}
                        onSelect={() => handleAssetSelect(asset)}
                        className={cn(
                          "flex cursor-pointer items-center gap-3 rounded-md px-2 py-2 text-sm text-text-secondary",
                          "data-[selected=true]:bg-bg-hover data-[selected=true]:text-text-primary",
                          "transition-colors",
                        )}
                      >
                        {asset.thumbnail_url ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img
                            src={asset.thumbnail_url}
                            alt=""
                            className="h-6 w-6 rounded object-cover shrink-0"
                          />
                        ) : (
                          <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded bg-bg-tertiary">
                            <Icon className="h-3 w-3 text-text-tertiary" />
                          </div>
                        )}
                        <div className="flex-1 min-w-0">
                          <span className="block truncate">{asset.name}</span>
                        </div>
                        <span className="text-2xs text-text-tertiary shrink-0 capitalize">
                          {asset.asset_type.replace("_", " ")}
                        </span>
                      </Command.Item>
                    );
                  })}
                </Command.Group>
              )}

              {/* Navigation */}
              <Command.Group
                heading="Navigation"
                className="[&>[cmdk-group-heading]]:px-2 [&>[cmdk-group-heading]]:py-1.5 [&>[cmdk-group-heading]]:font-mono [&>[cmdk-group-heading]]:text-[10px] [&>[cmdk-group-heading]]:font-normal [&>[cmdk-group-heading]]:text-text-tertiary [&>[cmdk-group-heading]]:uppercase [&>[cmdk-group-heading]]:tracking-[0.16em]"
              >
                {navItems.map((item) => (
                  <CommandItemRow
                    key={item.id}
                    item={item}
                    onSelect={() => handleSelect(item)}
                  />
                ))}
              </Command.Group>

              <Command.Separator className="my-1 h-px bg-border-secondary" />

              <Command.Group
                heading="Actions"
                className="[&>[cmdk-group-heading]]:px-2 [&>[cmdk-group-heading]]:py-1.5 [&>[cmdk-group-heading]]:font-mono [&>[cmdk-group-heading]]:text-[10px] [&>[cmdk-group-heading]]:font-normal [&>[cmdk-group-heading]]:text-text-tertiary [&>[cmdk-group-heading]]:uppercase [&>[cmdk-group-heading]]:tracking-[0.16em]"
              >
                {actionItems.map((item) => (
                  <CommandItemRow
                    key={item.id}
                    item={item}
                    onSelect={() => handleSelect(item)}
                  />
                ))}
              </Command.Group>
            </Command.List>

            <div className="border-t border-border px-3 py-2">
              <p className="text-2xs text-text-tertiary">
                <kbd className="rounded border border-border px-1 py-0.5 font-mono text-2xs">
                  ↑↓
                </kbd>{" "}
                navigate{" "}
                <kbd className="rounded border border-border px-1 py-0.5 font-mono text-2xs">
                  ↵
                </kbd>{" "}
                select{" "}
                <kbd className="rounded border border-border px-1 py-0.5 font-mono text-2xs">
                  esc
                </kbd>{" "}
                close
              </p>
            </div>
          </Command>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function CommandItemRow({
  item,
  onSelect,
}: {
  item: CommandItem;
  onSelect: () => void;
}) {
  const Icon = item.icon;
  return (
    <Command.Item
      value={item.label}
      onSelect={onSelect}
      className={cn(
        "flex cursor-pointer items-center gap-3 rounded-md px-2 py-2 text-sm text-text-secondary",
        "data-[selected=true]:bg-bg-hover data-[selected=true]:text-text-primary",
        "transition-colors",
      )}
    >
      <Icon className="h-4 w-4 shrink-0" />
      <span className="flex-1">{item.label}</span>
      {item.shortcut && (
        <span className="text-2xs text-text-tertiary">{item.shortcut}</span>
      )}
    </Command.Item>
  );
}
