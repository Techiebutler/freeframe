"use client";

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { api } from "@/lib/api";
import { useReviewStore } from "@/stores/review-store";
import type { AssetResponse, AssetVersion, Comment } from "@/types";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface CreateCommentPayload {
  body: string;
  version_id?: string;
  parent_id?: string;
  timecode_start?: number;
  timecode_end?: number;
  annotation?: { drawing_data: Record<string, unknown> };
}

interface ReviewContextValue {
  assetId: string;
  asset: AssetResponse | null;
  shareToken?: string;
  shareSession?: string | null;
  versions: AssetVersion[];
  comments: Comment[];
  isLoading: boolean;
  error: string | null;
  addComment: (payload: CreateCommentPayload) => Promise<Comment>;
  resolveComment: (commentId: string) => Promise<void>;
  seekTo: (time: number) => void;
  refetchComments: () => Promise<void>;
  refetchVersions: () => Promise<void>;
  pauseVideo: () => void;
  registerPauseHandler: (handler: () => void) => void;
}

// ─── Context ──────────────────────────────────────────────────────────────────

const ReviewContext = createContext<ReviewContextValue | null>(null);

// ─── Provider ─────────────────────────────────────────────────────────────────

interface ReviewProviderProps {
  assetId: string;
  shareToken?: string; // If set, uses share token API instead of authenticated API
  shareSession?: string | null;
  children: React.ReactNode;
}

export function ReviewProvider({
  assetId,
  shareToken,
  shareSession,
  children,
}: ReviewProviderProps) {
  const [asset, setAsset] = useState<AssetResponse | null>(null);
  const [versions, setVersions] = useState<AssetVersion[]>([]);
  const [comments, setComments] = useState<Comment[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const pauseHandlerRef = useRef<(() => void) | null>(null);

  const { setCurrentAsset, setCurrentVersion, setPlayheadTime, currentVersion } =
    useReviewStore();

  // Track whether component is still mounted to avoid state updates after unmount
  const mountedRef = useRef(true);
  // In share mode, remembers which version the current stream_url corresponds to,
  // so switching versions refetches the stream but the initial load does not double-fetch.
  const streamedVersionRef = useRef<string | null>(null);
  // Guards against a stale comments fetch (e.g. an in-flight all-versions request)
  // overwriting a newer version-scoped one — only the latest request applies its result.
  const commentsReqRef = useRef(0);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const shareSessionParam = shareSession ? `&share_session=${encodeURIComponent(shareSession)}` : '';

  const fetchAsset = useCallback(async () => {
    try {
      let data: AssetResponse;

      if (shareToken) {
        // Share mode: fetch stream info to build a pseudo asset
        const API_URL =
          process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";
        const headers: Record<string, string> = {};
        try {
          const t = localStorage.getItem("ff_access_token");
          if (t) headers["Authorization"] = `Bearer ${t}`;
        } catch {}
        const streamRes = await fetch(
          `${API_URL}/share/${shareToken}/stream/${assetId}?_=1${shareSessionParam}`,
          { headers },
        );
        const streamData = streamRes.ok ? await streamRes.json() : null;
        // Build pseudo asset from available data
        data = {
          id: assetId,
          name: streamData?.name || "Asset",
          description: null,
          asset_type: streamData?.asset_type || "image",
          status: "in_review",
          rating: null,
          assignee_id: null,
          folder_id: null,
          due_date: null,
          keywords: [],
          project_id: "",
          created_by: "",
          created_at: "",
          updated_at: "",
          deleted_at: null,
          stream_url: streamData?.url,
          thumbnail_url: streamData?.thumbnail_url,
          latest_version: streamData?.version_id
            ? {
                id: streamData.version_id,
                asset_id: assetId,
                version_number: 1,
                processing_status: "ready",
                created_by: "",
                created_at: "",
                deleted_at: null,
                files: [],
              }
            : null,
        } as AssetResponse;
      } else {
        // Normal mode: authenticated API
        data = await api.get<AssetResponse>(`/assets/${assetId}`);
      }

      if (!mountedRef.current) return;
      setAsset(data);
      setCurrentAsset(data);

      if (!shareToken) {
        // Fetch all versions for the version switcher (not available in share mode)
        const allVersions = await api.get<AssetVersion[]>(
          `/assets/${assetId}/versions`,
        );
        if (!mountedRef.current) return;
        setVersions(allVersions ?? []);

        const readyVersion = (allVersions ?? [])
          .sort((a, b) => b.version_number - a.version_number)
          .find((v) => v.processing_status === "ready");
        if (readyVersion) {
          setCurrentVersion(readyVersion);
        } else if (data.latest_version) {
          setCurrentVersion(data.latest_version);
        }
      } else {
        // Share mode: fetch the versions the guest may see (the server exposes all ready
        // versions only when the link enables "Show all versions", else just the latest).
        // The initial stream_url above already corresponds to the latest version.
        streamedVersionRef.current = data.latest_version?.id ?? null;
        const API_URL =
          process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";
        const headers: Record<string, string> = {};
        try {
          const t = localStorage.getItem("ff_access_token");
          if (t) headers["Authorization"] = `Bearer ${t}`;
        } catch {}
        try {
          const vres = await fetch(
            `${API_URL}/share/${shareToken}/assets/${assetId}/versions?_=1${shareSessionParam}`,
            { headers },
          );
          const vlist = vres.ok ? await vres.json() : [];
          if (!mountedRef.current) return;
          const mapped = ((vlist as any[]) ?? []).map((v) => ({
            id: v.id,
            asset_id: assetId,
            version_number: v.version_number,
            processing_status: v.processing_status,
            created_by: "",
            created_at: v.created_at,
            deleted_at: null,
            files: [],
          })) as AssetVersion[];
          setVersions(mapped);
          if (mapped.length > 0) setCurrentVersion(mapped[0]);
          else if (data.latest_version) setCurrentVersion(data.latest_version);
        } catch {
          if (data.latest_version) setCurrentVersion(data.latest_version);
        }
      }
    } catch (err) {
      if (!mountedRef.current) return;
      setError(err instanceof Error ? err.message : "Failed to load asset");
    }
  }, [assetId, shareToken, shareSessionParam, setCurrentAsset, setCurrentVersion]);

  const fetchComments = useCallback(async () => {
    const reqId = ++commentsReqRef.current;
    try {
      let data: Comment[];
      if (shareToken) {
        const API_URL =
          process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";
        // Scope comments to the version currently being viewed (read non-reactively so
        // this callback stays stable; a dedicated effect re-runs it when the version changes).
        const versionId = useReviewStore.getState().currentVersion?.id;
        const vParam = versionId ? `&version_id=${versionId}` : "";
        const res = await fetch(
          `${API_URL}/share/${shareToken}/comments?asset_id=${assetId}${vParam}${shareSessionParam}`,
        );
        if (res.ok) {
          const json = await res.json();
          // Handle both formats: array directly or {comments: [...]}
          data = Array.isArray(json) ? json : (json.comments ?? []);
        } else {
          data = [];
        }
      } else {
        data = await api.get<Comment[]>(`/assets/${assetId}/comments`);
      }
      if (!mountedRef.current || reqId !== commentsReqRef.current) return;
      setComments(data ?? []);
    } catch {
      // Comments failing silently — asset is still viewable
    }
  }, [assetId, shareToken]);

  const refetchComments = useCallback(async () => {
    await fetchComments();
  }, [fetchComments]);

  const refetchVersions = useCallback(async () => {
    if (shareToken) return;
    try {
      const allVersions = await api.get<AssetVersion[]>(`/assets/${assetId}/versions`);
      if (!mountedRef.current) return;
      setVersions(allVersions ?? []);
    } catch {
      // ignore
    }
  }, [assetId, shareToken]);

  useEffect(() => {
    setIsLoading(true);
    setError(null);
    // In share mode, comments are version-scoped and fetched by the effect below once
    // the version is known — so the first (and only) comments request is already scoped
    // to the viewed version, avoiding an all-versions flash on open.
    const commentsPromise = shareToken ? Promise.resolve() : fetchComments();
    Promise.all([fetchAsset(), commentsPromise]).finally(() => {
      if (mountedRef.current) setIsLoading(false);
    });
  }, [fetchAsset, fetchComments, shareToken]);

  // Share mode: (re)scope comments to the selected version — but only once a version is
  // known, so we never fetch the unfiltered all-versions list.
  const currentVersionId = currentVersion?.id;
  useEffect(() => {
    if (!shareToken || !currentVersionId) return;
    fetchComments();
    // fetchComments reads the current version via getState, so it is intentionally
    // not a dependency here — currentVersionId is the trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shareToken, currentVersionId]);

  // Share mode: swap the video stream to the selected version's media when it changes.
  useEffect(() => {
    if (!shareToken || !currentVersionId) return;
    if (currentVersionId === streamedVersionRef.current) return; // already showing this version
    let cancelled = false;
    const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";
    const headers: Record<string, string> = {};
    try {
      const t = localStorage.getItem("ff_access_token");
      if (t) headers["Authorization"] = `Bearer ${t}`;
    } catch {}
    fetch(
      `${API_URL}/share/${shareToken}/stream/${assetId}?version_id=${currentVersionId}${shareSessionParam}`,
      { headers },
    )
      .then((r) => (r.ok ? r.json() : null))
      .then((streamData) => {
        if (cancelled || !mountedRef.current || !streamData?.url) return;
        streamedVersionRef.current = currentVersionId;
        setAsset((prev) =>
          prev ? ({ ...prev, stream_url: streamData.url } as AssetResponse) : prev,
        );
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [shareToken, assetId, currentVersionId, shareSessionParam]);

  const addComment = useCallback(
    async (payload: CreateCommentPayload): Promise<Comment> => {
      let comment: Comment;
      if (shareToken) {
        const API_URL =
          process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";
        const headers: Record<string, string> = {
          "Content-Type": "application/json",
        };
        try {
          const t = localStorage.getItem("ff_access_token");
          if (t) headers["Authorization"] = `Bearer ${t}`;
        } catch {}
        // Include guest identity if available (for non-authenticated users)
        const guestFields: Record<string, string> = {};
        try {
          const stored = localStorage.getItem("ff_guest_identity");
          if (stored) {
            const guest = JSON.parse(stored);
            guestFields.guest_name = guest.name;
            guestFields.guest_email = guest.email;
          }
        } catch {}
        const res = await fetch(`${API_URL}/share/${shareToken}/comment?_=1${shareSessionParam}`, {
          method: "POST",
          headers,
          body: JSON.stringify({ ...payload, ...guestFields, asset_id: assetId }),
        });
        if (!res.ok) throw new Error("Failed to post comment");
        comment = await res.json();
      } else {
        comment = await api.post<Comment>(
          `/assets/${assetId}/comments`,
          payload,
        );
      }
      if (mountedRef.current) {
        setComments((prev) => [...prev, comment]);
      }
      return comment;
    },
    [assetId],
  );

  const resolveComment = useCallback(
    async (commentId: string): Promise<void> => {
      await api.post(`/comments/${commentId}/resolve`);
      if (mountedRef.current) {
        setComments((prev) =>
          prev.map((c) => (c.id === commentId ? { ...c, resolved: true } : c)),
        );
      }
    },
    [],
  );

  const seekTo = useCallback(
    (time: number) => {
      setPlayheadTime(time);
    },
    [setPlayheadTime],
  );

  const pauseVideo = useCallback(() => {
    if (pauseHandlerRef.current) {
      pauseHandlerRef.current();
    }
  }, []);

  const registerPauseHandler = useCallback((handler: () => void) => {
    pauseHandlerRef.current = handler;
  }, []);

  const value = useMemo<ReviewContextValue>(
    () => ({
      assetId,
      asset,
      shareToken,
      shareSession,
      versions,
      comments,
      isLoading,
      error,
      addComment,
      resolveComment,
      seekTo,
      refetchComments,
      refetchVersions,
      pauseVideo,
      registerPauseHandler,
    }),
    [
      assetId,
      asset,
      versions,
      comments,
      isLoading,
      error,
      addComment,
      resolveComment,
      seekTo,
      refetchComments,
      refetchVersions,
      pauseVideo,
      registerPauseHandler,
    ],
  );

  return (
    <ReviewContext.Provider value={value}>{children}</ReviewContext.Provider>
  );
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function useReview(): ReviewContextValue {
  const ctx = useContext(ReviewContext);
  if (!ctx) {
    throw new Error("useReview must be used inside <ReviewProvider>");
  }
  return ctx;
}
