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

interface CreateCommentPayload {
  body: string;
  version_id: string;
  parent_id?: string;
  timecode_start?: number;
  timecode_end?: number;
  annotation?: Record<string, unknown>;
}

interface ReviewContextValue {
  assetId: string;
  asset: AssetResponse | null;
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
  children: React.ReactNode;
}

export function ReviewProvider({
  assetId,
  shareToken,
  children,
}: ReviewProviderProps) {
  const [asset, setAsset] = useState<AssetResponse | null>(null);
  const [versions, setVersions] = useState<AssetVersion[]>([]);
  const [comments, setComments] = useState<Comment[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const pauseHandlerRef = useRef<(() => void) | null>(null);

  const { setCurrentAsset, setCurrentVersion, setPlayheadTime } =
    useReviewStore();

  // Track whether component is still mounted to avoid state updates after unmount
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

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
          `${API_URL}/share/${shareToken}/stream/${assetId}`,
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
      } else if (data.latest_version) {
        setCurrentVersion(data.latest_version);
      }
    } catch (err) {
      if (!mountedRef.current) return;
      setError(err instanceof Error ? err.message : "Failed to load asset");
    }
  }, [assetId, shareToken, setCurrentAsset, setCurrentVersion]);

  const fetchComments = useCallback(async () => {
    try {
      let data: Comment[];
      if (shareToken) {
        const API_URL =
          process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";
        const res = await fetch(
          `${API_URL}/share/${shareToken}/comments?asset_id=${assetId}`,
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
      if (!mountedRef.current) return;
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
    Promise.all([fetchAsset(), fetchComments()]).finally(() => {
      if (mountedRef.current) setIsLoading(false);
    });
  }, [fetchAsset, fetchComments]);

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
        const res = await fetch(`${API_URL}/share/${shareToken}/comment`, {
          method: "POST",
          headers,
          body: JSON.stringify({ ...payload, asset_id: assetId }),
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
