"use client";

import * as React from "react";
import useSWR from "swr";
import { api } from "@/lib/api";
import type { Project } from "@/types";
import { canManageWorkspace } from "@/lib/workspace-access";
import { EditorSubmissions } from "@/components/handin/editor-submissions";
import { usePathname } from "next/navigation";
import { useAuthStore } from "@/stores/auth-store";
import { useUploadStore } from "@/stores/upload-store";
import { Sidebar } from "@/components/layout/sidebar";
import { Header } from "@/components/layout/header";
import { CommandPalette } from "@/components/layout/command-palette";
import { UploadsPanel } from "@/components/layout/uploads-panel";
import { UploadSSEBridge } from "@/components/layout/upload-sse-bridge";
import { cn } from "@/lib/utils";
import { CampaignBoundary } from "@/components/campaign-boundary";
import { CustomerEntry } from "@/components/v2/customer-entry";
import { canSetUpAutoReview } from "@/lib/onboarding";

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const [sidebarCollapsed, setSidebarCollapsed] = React.useState(false);
  const [commandOpen, setCommandOpen] = React.useState(false);
  const { user, fetchUser } = useAuthStore();
  const setupRoute = pathname === '/start';
  const managementRoute = ["/home", "/rules", "/insights", "/start"].includes(pathname);
  const { data: projects, error: projectsError, mutate: retryProjects } = useSWR<Project[]>(managementRoute ? '/projects' : null, () => api.get<Project[]>('/projects'));
  const managementLoading = managementRoute && !projectsError && (!user || !projects);
  const editorRoute = managementRoute && !canManageWorkspace(user, projects) && !canSetUpAutoReview(user, projects);
  const { fetchHistory } = useUploadStore();

  // Hide header on asset viewer pages — the viewer has its own top bar
  const isAssetViewer = /\/projects\/[^/]+\/assets\/[^/]+/.test(pathname);

  React.useEffect(() => {
    fetchUser();
    fetchHistory();
  }, [fetchUser, fetchHistory]);

  // Global keyboard shortcut for command palette
  React.useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setCommandOpen((prev) => !prev);
      }
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, []);

  const content = projectsError ? <div role="alert" className="p-8">Could not open your workspace. <button className="min-h-11 px-3 text-accent" onClick={() => void retryProjects()}>Try again</button></div> : managementLoading ? <p role="status" className="p-8 text-text-secondary">Opening your workspace…</p> : editorRoute ? <EditorSubmissions /> : children;
  if (setupRoute) return <main className="owner-workspace min-h-screen bg-bg-primary"><CampaignBoundary>{content}</CampaignBoundary></main>;

  return (
    <div className={cn("flex h-screen overflow-hidden bg-bg-primary", ["/home", "/rules", "/agents", "/handin"].includes(pathname) && "owner-workspace")}>
      <Sidebar
        collapsed={sidebarCollapsed}
        onToggle={() => setSidebarCollapsed((c) => !c)}
      />

      {/* Main content area */}
      <main
        className={cn(
          "dashboard-main flex min-w-0 flex-1 flex-col overflow-hidden transition-[margin] duration-200 ease-spring",
          sidebarCollapsed ? "md:ml-[72px]" : "md:ml-[220px]",
        )}
      >
        {!isAssetViewer && <Header onSearchOpen={() => setCommandOpen(true)} />}

        <div className="relative flex-1 overflow-y-auto"><CampaignBoundary>{pathname === '/home' ? <CustomerEntry projects={projects}>{content}</CustomerEntry> : content}</CampaignBoundary></div>
      </main>

      <UploadsPanel />
      <UploadSSEBridge />
      <CommandPalette open={commandOpen} onOpenChange={setCommandOpen} />
    </div>
  );
}
