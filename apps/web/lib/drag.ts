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
 */
export function carriesFiles(e: React.DragEvent): boolean {
  return Array.from(e.dataTransfer.types).includes("Files");
}
