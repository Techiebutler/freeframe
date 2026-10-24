/**
 * Whether a drag is carrying files from outside the browser.
 *
 * The grid and the folder targets are already drag surfaces: dragging an asset
 * card sets `application/json` with `effectAllowed = 'move'` so assets can be
 * moved into folders. A handler that does not tell the two apart starts an
 * upload when someone drags a card across the grid, and lights a folder up when
 * someone drags a file over it.
 *
 * `types` is the part of the DataTransfer that is readable during `dragover` --
 * the items themselves are protected until drop -- and a drag coming from the
 * operating system always lists `Files`.
 *
 * So does an image dragged out of this very page in Chrome and Safari: a
 * thumbnail or the logo carries itself as a file, and letting it go over the
 * asset area would upload the page's own image. A drag that began here fires
 * `dragstart` in this document and one from outside never does, so those are
 * told apart by that (see `pageDragActive`).
 */
export function carriesFiles(e: React.DragEvent): boolean {
  return listsFiles(e) && !pageDragActive;
}

function listsFiles(e: React.DragEvent): boolean {
  return Array.from(e.dataTransfer.types).includes("Files");
}

/**
 * Whether a drag that began on this page is under way.
 *
 * Set on `dragstart` and cleared on `dragend`, both listened for on `window` in
 * the capture phase, so no handler that stops propagation can hide them. A
 * `dragend` goes only to the drag's source, so when the source left the
 * document mid-drag (a list re-rendered under it) nothing hears it; the next
 * press of a pointer or key clears the flag instead, as none fires during a
 * drag and the user cannot start another without one.
 */
let pageDragActive = false;

if (typeof window !== "undefined") {
  const start = () => {
    pageDragActive = true;
  };
  const end = () => {
    pageDragActive = false;
  };
  window.addEventListener("dragstart", start, true);
  window.addEventListener("dragend", end, true);
  window.addEventListener("pointerdown", end, true);
  window.addEventListener("keydown", end, true);
}

/**
 * Whether the pointer is really over the element handling this event, rather
 * than the event having merely bubbled here.
 *
 * A Radix dialog renders its overlay into `document.body` but stays where it
 * was written in the React tree, and React propagates events along that tree.
 * So a drag over the folder rename or delete confirmation -- both rendered from
 * `FolderCard`, inside the asset grid -- arrives at the grid's own handlers as
 * if it had happened on the grid. The overlay is `fixed inset-0`, so a rect
 * test agrees: the dialog is centred inside the region it covers.
 *
 * The DOM answers what neither can. An overlay portalled to `document.body` is
 * not a descendant of the region, so `contains` is false for exactly the events
 * that only look local, whichever dialog they come from and wherever it sits.
 */
export function pointerIsOver(e: React.DragEvent): boolean {
  return e.currentTarget.contains(e.target as Node);
}

/**
 * Refuse a file drag that nothing wanted.
 *
 * Every element that accepts a file stops the event, so anything still
 * travelling was wanted by nobody -- and left alone it goes to the browser,
 * which navigates the tab to `file:///...` and takes the session with it. Two
 * pixels of gap between two sidebar rows are enough to lose the page that way,
 * which is how this was found.
 *
 * Belongs on the app shell rather than on a page: the header, the sidebar rail
 * and the attribution badge are siblings of the page, not inside it, and the
 * badge floats over the very asset area that advertises itself as a drop
 * target. Attached there it also catches portalled dialogs, which are children
 * of `document.body` in the DOM but of the shell in the React tree.
 */
export function refuseFileDrag(e: React.DragEvent): void {
  // Any drag listing files, including an image from this page, which no
  // target takes: left alone, the browser opens it in place of the app.
  if (!listsFiles(e)) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = "none";
}
