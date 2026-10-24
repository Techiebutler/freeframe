"use client";

import * as React from "react";
import { carriesFiles, pointerIsOver } from "@/lib/drag";
import { collectDataTransfer, type Collected } from "@/lib/upload-folder-walk";

/**
 * The asset area as a drop target for files from outside the browser.
 *
 * Lifted out of the project page for two reasons. It is the only owner of the
 * "exactly one frame is lit" rule -- the region gives up its own marking while
 * a folder holds it, and only the folder still holding it may give it back --
 * and a rule spread across four handlers and a timer is worth having in one
 * place. And inline in a 1100-line page it could not be tested at all, so the
 * things that make it subtle (a portalled dialog that bubbles here as if it
 * were local, a release outside the region, a handover between two folders)
 * were only ever checked by hand.
 */
export function useFileDropRegion({
  enabled,
  currentFolderId,
  onUploadFiles,
}: {
  /** False while nothing here can receive an upload: no permission, or the
   *  main pane is showing the trash or the share links rather than assets. */
  enabled: boolean;
  /** The folder the region is showing, which is where a drop on the region
   *  itself lands. `null` is the project root. */
  currentFolderId: string | null;
  /** `null` as the folder means the project root. `dropped` is what the drop
   *  held, still being read (a dropped folder is walked after the event). */
  onUploadFiles: (folderId: string | null, dropped: Promise<Collected>) => void;
}) {
  const regionRef = React.useRef<HTMLDivElement>(null);
  const dropDepth = React.useRef(0);
  const [isFileDragOver, setIsFileDragOver] = React.useState(false);
  // Which folder the drag is over, if any. A folder is the more specific
  // target, so the region gives up its own marking while one is lit -- two
  // frames at once do not say where the file will land.
  const [fileDragTarget, setFileDragTarget] = React.useState<string | null>(
    null,
  );
  const clearTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  // Claiming is immediate, releasing is not. The few pixels of gap between two
  // folder cards belong to the region, so a pointer crossing from one folder to
  // the next reports "no folder" in between -- and clearing at once makes the
  // big frame flash on and off in that gap. Any folder claiming the drag
  // cancels a pending release, so the handover looks like one thing moving.
  const setFolderTarget = React.useCallback(
    (folderId: string | null, from?: string) => {
      if (clearTimer.current) {
        clearTimeout(clearTimer.current);
        clearTimer.current = null;
      }
      if (folderId !== null) {
        setFileDragTarget(folderId);
        return;
      }
      clearTimer.current = setTimeout(() => {
        clearTimer.current = null;
        // Only the folder that still holds the marking may end it. Crossing
        // from one folder to the next raises the new folder's `dragenter`
        // BEFORE the old folder's `dragleave`, so the release arriving last
        // belongs to the folder already left behind -- and acting on it took
        // the marking off the folder under the pointer and put the whole-area
        // frame back up beside it.
        setFileDragTarget((cur) => (from && cur !== from ? cur : null));
      }, 90);
    },
    [],
  );

  React.useEffect(
    () => () => {
      if (clearTimer.current) clearTimeout(clearTimer.current);
    },
    [],
  );

  /**
   * Whether this drag is the region's business at all.
   *
   * `pointerIsOver` is the part that is easy to leave out and hard to notice
   * missing. A Radix dialog rendered anywhere inside this region -- the upload
   * dialog, or the rename and delete confirmations that every folder card
   * carries -- portals its overlay to `document.body` and keeps its place in
   * the React tree, so a drag over that overlay arrives here looking exactly
   * like a drag over the grid, and the overlay is `fixed inset-0`, so testing
   * the release point against the region's rectangle agrees. Without this the
   * answer to "delete this folder?" could be a file landing in it.
   */
  const mine = React.useCallback(
    (e: React.DragEvent) => enabled && carriesFiles(e) && pointerIsOver(e),
    [enabled],
  );

  const onDragEnter = React.useCallback(
    (e: React.DragEvent) => {
      if (!mine(e)) return;
      e.preventDefault();
      // Counted rather than toggled: dragenter and dragleave fire for every
      // child the pointer crosses, so a boolean flickers off on each card.
      dropDepth.current += 1;
      setIsFileDragOver(true);
    },
    [mine],
  );

  const onDragOver = React.useCallback(
    (e: React.DragEvent) => {
      if (!mine(e)) return;
      // Without this the browser handles the drop itself and navigates away
      // from the app to display the file.
      e.preventDefault();
      // Taken, so the shell's refusal does not overwrite the cursor with "you
      // cannot drop here" over the one place where you can.
      e.stopPropagation();
      e.dataTransfer.dropEffect = "copy";
    },
    [mine],
  );

  const onDragLeave = React.useCallback(
    (e: React.DragEvent) => {
      if (!mine(e)) return;
      dropDepth.current = Math.max(0, dropDepth.current - 1);
      if (dropDepth.current === 0) {
        setIsFileDragOver(false);
        setFolderTarget(null);
      }
    },
    [mine, setFolderTarget],
  );

  const onDrop = React.useCallback(
    (e: React.DragEvent) => {
      if (!mine(e)) return;
      // Always, even when the drop is refused below: without it the browser
      // handles the file itself and navigates away from the app.
      e.preventDefault();
      // The rule is what the user sees: the pointer has to be inside the region
      // when the button comes up. An event reaching this handler is not proof
      // of that -- a drag can end on a target that is no longer under the
      // pointer -- so the release point is checked against the region itself.
      const rect = regionRef.current?.getBoundingClientRect();
      const released =
        !rect ||
        (e.clientX >= rect.left &&
          e.clientX < rect.right &&
          e.clientY >= rect.top &&
          e.clientY < rect.bottom);
      dropDepth.current = 0;
      setIsFileDragOver(false);
      setFolderTarget(null);
      if (!released) return;
      // See onDragOver: taken, so the shell's refusal is not also run for a
      // file this region is about to upload.
      e.stopPropagation();
      // Read here, in the drop event's own turn: the drop's items answer only
      // now, and a dropped folder is nothing but an unreadable placeholder in
      // `files`. The walk itself goes on after the event. Handed on even when
      // the drop held nothing, so the Uploads panel can say so.
      //
      // The region means the folder it is showing. A drop on a folder card or
      // a sidebar row never reaches here -- those stop the event and call
      // `onDropToFolder` with their own id.
      onUploadFiles(currentFolderId, collectDataTransfer(e.dataTransfer));
    },
    [mine, setFolderTarget, onUploadFiles, currentFolderId],
  );

  /** A folder target -- a card or a sidebar row -- took the drop itself, and
   *  read it in its own drop handler. */
  const onDropToFolder = React.useCallback(
    (folderId: string | null, dropped: Promise<Collected>) => {
      setFolderTarget(null);
      setIsFileDragOver(false);
      dropDepth.current = 0;
      onUploadFiles(folderId, dropped);
    },
    [setFolderTarget, onUploadFiles],
  );

  return {
    regionRef,
    /** Spread onto the element that is the drop target. */
    regionProps: { onDragEnter, onDragOver, onDragLeave, onDrop },
    /** The whole-area frame shows only when no folder holds the marking. */
    showRegionFrame: isFileDragOver && !fileDragTarget,
    fileDragTarget,
    setFolderTarget,
    onDropToFolder,
  };
}
