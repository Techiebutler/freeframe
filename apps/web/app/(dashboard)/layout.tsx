"use client";

import * as React from "react";
import { usePathname } from "next/navigation";
import { useAuthStore } from "@/stores/auth-store";
import { useUploadStore } from "@/stores/upload-store";
import { Sidebar } from "@/components/layout/sidebar";
import { Header } from "@/components/layout/header";
import { CommandPalette } from "@/components/layout/command-palette";
import { UploadsPanel } from "@/components/layout/uploads-panel";
import { UploadSSEBridge } from "@/components/layout/upload-sse-bridge";
import { PoweredByBadge } from "@/components/shared/powered-by-badge";
import { refuseFileDrag } from "@/lib/drag";
import { cn } from "@/lib/utils";

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const [sidebarCollapsed, setSidebarCollapsed] = React.useState(true);
  const [commandOpen, setCommandOpen] = React.useState(false);
  const { fetchUser } = useAuthStore();
  const { fetchHistory } = useUploadStore();

  // The asset viewer renders its own top bar, carrying both the header's role
  // and the attribution credit, so the shell supplies neither here.
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

  return (
    // The shell refuses a file drag nothing inside it took. Every drop target
    // stops the event when it accepts, so anything arriving here was wanted by
    // nobody, and the browser's own handling of it navigates the tab to the
    // file. The rail, the header and the attribution badge are all siblings of
    // the page rather than parts of it, and the badge in particular floats over
    // the asset area a project page offers as a drop target -- releasing a few
    // pixels off it used to load `file:///...` over the session.
    <div
      className="flex h-dvh overflow-hidden bg-bg-primary pl-safe pr-safe"
      onDragOver={refuseFileDrag}
      onDrop={refuseFileDrag}
    >
      <Sidebar
        collapsed={sidebarCollapsed}
        onToggle={() => setSidebarCollapsed((c) => !c)}
      />

      {/* Main content area */}
      <main
        className={cn(
          "flex flex-1 flex-col overflow-hidden transition-[margin] duration-200 ease-spring",
          sidebarCollapsed ? "ml-[52px]" : "ml-[220px]",
        )}
      >
        {!isAssetViewer && <Header onSearchOpen={() => setCommandOpen(true)} />}

        <div className="relative flex-1 overflow-y-auto">{children}</div>
      </main>

      {/* Attribution floats over the content rather than living in the sidebar,
          so it stays put whether the rail is collapsed or expanded and doesn't
          compete with the org name for the 48px logo header. Renders nothing
          when an admin turns "Powered by FreeFrame" off.

          Not on the asset viewer. That route carries its own credit centred in
          the top bar it renders in place of the header, so the floating one was
          a second copy -- and at 173px wide it covered the 28px send button in
          the corner of the comment composer completely, so every click on Send
          opened the repository in a new tab instead of posting the comment.
          Enter still posted, which is why it went unseen. */}
      {!isAssetViewer && (
        <PoweredByBadge className="fixed bottom-safe right-safe [--ff-bottom:1rem] [--ff-right:1rem] z-20 rounded-full border border-border bg-bg-elevated/90 px-3 py-1.5 shadow-lg backdrop-blur-sm" />
      )}

      <UploadsPanel />
      <UploadSSEBridge />
      <CommandPalette open={commandOpen} onOpenChange={setCommandOpen} />
    </div>
  );
}
