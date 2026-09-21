"use client";

import { refuseFileDrag } from "@/lib/drag";

// Mirrors the dashboard shell's own fix (see `(dashboard)/layout.tsx`): a
// file dropped anywhere that does not accept it reaches the browser's own
// handling, which navigates the tab to `file:///...` and loses the page. A
// share link has no drop target anywhere in this tree (folder-based upload
// is deliberately disabled in share mode), so nothing here ever needs to
// stop this from bubbling up. It matters more here than on the dashboard: a
// guest has no session to come back to, and loses any comment they had
// typed along with the page.
export default function ShareLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div onDragOver={refuseFileDrag} onDrop={refuseFileDrag}>
      {children}
    </div>
  );
}
