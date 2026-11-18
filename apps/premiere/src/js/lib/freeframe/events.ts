/**
 * Live project events (SSE).
 *
 * The API publishes `transcode_complete` / `transcode_failed` per project, so
 * the panel can refresh the moment a thumbnail exists instead of waiting for
 * the user to navigate somewhere and back.
 */
import { useEffect, useRef } from "react";
import type { FreeFrameApi } from "./api";

export type ProjectEvent = "transcode_complete" | "transcode_failed";

export const useProjectEvents = (
  api: FreeFrameApi,
  projectId: string | null | undefined,
  onEvent: (event: ProjectEvent) => void
) => {
  // Callers pass inline callbacks. Depending on their identity tore the
  // EventSource down and reopened it on every render (every host poll tick).
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;

  useEffect(() => {
    if (!projectId || !api.accessToken || typeof EventSource === "undefined") return;

    let source: EventSource | null = null;
    let retry: ReturnType<typeof setTimeout>;
    let closed = false;

    const connect = () => {
      if (closed) return;
      source = new EventSource(api.eventStreamUrl(projectId));
      const handler = (type: ProjectEvent) => () => onEventRef.current(type);
      source.addEventListener("transcode_complete", handler("transcode_complete"));
      source.addEventListener("transcode_failed", handler("transcode_failed"));
      source.onerror = () => {
        // The stream drops on token expiry, server restarts and sleep; back off
        // and reconnect rather than leaving the panel silently stale.
        source?.close();
        if (!closed) retry = setTimeout(connect, 10000);
      };
    };

    connect();
    return () => {
      closed = true;
      clearTimeout(retry);
      source?.close();
    };
  }, [api, projectId]);
};
