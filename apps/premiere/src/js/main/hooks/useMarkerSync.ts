import { useCallback } from "react";
import { syncComments, type SyncResult } from "../../lib/freeframe/host";
import type { Comment } from "../../lib/freeframe/types";

interface UseMarkerSyncOptions {
  offsetSeconds: number;
  fps?: number;
  includeResolved: boolean;
  refreshHost: () => Promise<void>;
  onError: (message: string) => void;
}

/**
 * Synchronizes the review thread with Premiere-owned markers. AssetView owns
 * the decision of when markers should exist; this hook only performs the host
 * operation and reports a user-facing failure.
 */
export const useMarkerSync = ({
  offsetSeconds,
  fps,
  includeResolved,
  refreshHost,
  onError,
}: UseMarkerSyncOptions) => {
  const pushMarkers = useCallback(
    async (comments: Comment[]): Promise<SyncResult | null> => {
      const result = await syncComments(comments, {
        offsetSeconds,
        fps,
        includeResolved,
      });
      if (!result.ok) {
        onError(
          result.error === "no_sequence"
            ? "Open a sequence in Premiere first."
            : `Marker sync failed: ${result.error}`
        );
        return null;
      }
      // Only re-read the host when markers actually changed.
      if (result.added || result.removed) await refreshHost();
      return result;
    },
    [offsetSeconds, fps, includeResolved, refreshHost, onError]
  );

  return { pushMarkers };
};
