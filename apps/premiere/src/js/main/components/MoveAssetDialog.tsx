import { IconFolder, IconHome } from "./Icons";
import type { FolderNode } from "../../lib/freeframe/types";

interface FolderOption {
  id: string | null;
  name: string;
  depth: number;
}

const flattenFolders = (nodes: FolderNode[], depth = 0): FolderOption[] =>
  nodes.flatMap((folder) => [
    { id: folder.id, name: folder.name, depth },
    ...flattenFolders(folder.children ?? [], depth + 1),
  ]);

/** Destination picker for keeping assets organised without leaving the panel. */
export const MoveAssetDialog = ({
  assetName,
  count = 1,
  tree,
  currentFolderId,
  busy,
  error,
  onMove,
  onClose,
}: {
  assetName: string;
  /** How many assets are moving (multi-select). */
  count?: number;
  tree: FolderNode[];
  currentFolderId: string | null;
  busy?: boolean;
  error?: string;
  onMove: (folderId: string | null) => void;
  onClose: () => void;
}) => {
  const destinations: FolderOption[] = [
    { id: null, name: "Project root", depth: 0 },
    ...flattenFolders(tree),
  ];

  return (
    <div className="scrim" onClick={onClose}>
      <div className="dialog move-asset" onClick={(event) => event.stopPropagation()}>
        <h3>{count > 1 ? `Move ${count} assets` : "Move asset"}</h3>
        <p>{count > 1 ? `Choose where to place these ${count} assets.` : `Choose where to place “${assetName}”.`}</p>
        <div className="move-destinations" role="listbox" aria-label="Asset destination">
          {destinations.map((destination) => {
            const active = destination.id === currentFolderId;
            return (
              <button
                key={destination.id ?? "root"}
                className={active ? "active" : ""}
                disabled={busy || active}
                style={{ paddingLeft: 10 + destination.depth * 16 }}
                onClick={() => onMove(destination.id)}
              >
                {destination.id ? <IconFolder width={14} height={14} /> : <IconHome width={14} height={14} />}
                <span>{destination.name}</span>
                {active && <em>Current</em>}
              </button>
            );
          })}
        </div>
        {error && <p className="error">{error}</p>}
        <div className="dialog-actions">
          <button onClick={onClose} disabled={busy}>Cancel</button>
        </div>
      </div>
    </div>
  );
};
