/**
 * FreeFrame API client for the panel.
 *
 * CEP 9+ runs Chromium, so `fetch` and `EventSource` are available. Access
 * tokens expire, so every request retries once through /auth/refresh.
 */
import type {
  Asset,
  AssetVersion,
  Comment,
  FolderNode,
  InitiateUploadResponse,
  Me,
  Project,
  ShareLink,
  SharePermission,
  ShareOptions,
  Tokens,
} from "./types";

type ShareCreateOptions = Partial<ShareOptions> & { title?: string };

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = "ApiError";
  }
}

const detailOf = async (res: Response): Promise<string> => {
  try {
    const body = await res.json();
    const detail = body?.detail;
    if (typeof detail === "string") return detail;
    if (detail?.message) return detail.message;
    return JSON.stringify(body);
  } catch {
    return res.statusText || `HTTP ${res.status}`;
  }
};

export interface ApiOptions {
  baseUrl: string;
  accessToken?: string;
  refreshToken?: string;
  /** Called whenever tokens change so the caller can persist them. */
  onTokens?: (tokens: { accessToken: string; refreshToken: string }) => void;
  /** Called when the refresh token is rejected and the user must log in again. */
  onLogout?: () => void;
}

export class FreeFrameApi {
  /**
   * Browse responses carry presigned thumbnail URLs. Keep them for this panel
   * session so changing tabs does not mint different URLs and force Chromium
   * to download the same image again.
   */
  private browseCache = new Map<string, { expiresAt: number; value: unknown }>();
  baseUrl: string;
  accessToken: string;
  refreshToken: string;
  private onTokens?: ApiOptions["onTokens"];
  private onLogout?: ApiOptions["onLogout"];
  /** In-flight refresh, shared so parallel 401s trigger only one round trip. */
  private refreshing: Promise<boolean> | null = null;

  constructor(options: ApiOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.accessToken = options.accessToken ?? "";
    this.refreshToken = options.refreshToken ?? "";
    this.onTokens = options.onTokens;
    this.onLogout = options.onLogout;
  }

  private setTokens(tokens: Tokens) {
    this.accessToken = tokens.access_token;
    this.refreshToken = tokens.refresh_token;
    this.onTokens?.({ accessToken: this.accessToken, refreshToken: this.refreshToken });
  }

  private async doRefresh(): Promise<boolean> {
    if (!this.refreshToken) return false;
    if (!this.refreshing) {
      this.refreshing = (async () => {
        try {
          const res = await fetch(`${this.baseUrl}/auth/refresh`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ refresh_token: this.refreshToken }),
          });
          if (!res.ok) {
            this.accessToken = "";
            this.refreshToken = "";
            this.onLogout?.();
            return false;
          }
          this.setTokens((await res.json()) as Tokens);
          return true;
        } finally {
          this.refreshing = null;
        }
      })();
    }
    return this.refreshing;
  }

  private cachedBrowse<T>(path: string, refresh = false): Promise<T> {
    const cached = this.browseCache.get(path);
    if (!refresh && cached && cached.expiresAt > Date.now()) {
      return Promise.resolve(cached.value as T);
    }

    return this.request<T>(path).then((value) => {
      this.browseCache.set(path, {
        value,
        expiresAt: Date.now() + 2 * 60 * 1000,
      });
      return value;
    });
  }

  async request<T>(path: string, init: RequestInit = {}, retry = true): Promise<T> {
    if (!this.baseUrl) throw new ApiError(0, "No server configured");
    const headers: Record<string, string> = {
      ...(init.headers as Record<string, string> | undefined),
    };
    const isFormData = typeof FormData !== "undefined" && init.body instanceof FormData;
    // Let the browser attach the multipart boundary when sending a selected
    // project cover image. JSON remains the default for every other request.
    if (init.body && !isFormData && !headers["Content-Type"]) {
      headers["Content-Type"] = "application/json";
    }
    if (this.accessToken) headers["Authorization"] = `Bearer ${this.accessToken}`;

    let res: Response;
    try {
      // The API sends no cache headers, and CEP's Chromium will happily serve a
      // stale GET — which showed deleted assets still counted on project cards.
      res = await fetch(`${this.baseUrl}${path}`, { ...init, headers, cache: "no-store" });
    } catch (e) {
      throw new ApiError(0, `Cannot reach ${this.baseUrl} — check the server URL`);
    }

    if (res.status === 401 && retry && (await this.doRefresh())) {
      return this.request<T>(path, init, false);
    }
    if (!res.ok) throw new ApiError(res.status, await detailOf(res));
    // Any successful mutation can change a project card or asset thumbnail.
    // Clear the short-lived browse cache rather than risking stale media.
    if (init.method && init.method !== "GET") this.browseCache.clear();
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  // -- auth -------------------------------------------------------------------

  async login(email: string, password: string): Promise<Tokens> {
    const tokens = await this.request<Tokens>("/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    });
    this.setTokens(tokens);
    return tokens;
  }

  me() {
    return this.request<Me>("/auth/me");
  }

  logout() {
    this.accessToken = "";
    this.refreshToken = "";
    this.browseCache.clear();
    this.onTokens?.({ accessToken: "", refreshToken: "" });
  }

  // -- browsing ---------------------------------------------------------------

  projects(refresh = false) {
    return this.cachedBrowse<Project[]>("/projects", refresh);
  }

  createProject(name: string) {
    return this.request<Project>("/projects", {
      method: "POST",
      body: JSON.stringify({ name }),
    });
  }

  /** Soft-deletes the project; it stays recoverable from the web app. */
  deleteProject(projectId: string) {
    return this.request<void>(`/projects/${projectId}`, { method: "DELETE" });
  }

  uploadProjectPoster(projectId: string, file: Blob, filename: string) {
    const body = new FormData();
    body.append("file", file, filename);
    return this.request<Project>(`/projects/${projectId}/poster`, {
      method: "POST",
      body,
    });
  }

  removeProjectPoster(projectId: string) {
    return this.request<void>(`/projects/${projectId}/poster`, { method: "DELETE" });
  }

  folderTree(projectId: string, refresh = false) {
    return this.cachedBrowse<FolderNode[]>(`/projects/${projectId}/folder-tree`, refresh);
  }

  createFolder(projectId: string, name: string, parentId: string | null = null) {
    return this.request<FolderNode>(`/projects/${projectId}/folders`, {
      method: "POST",
      body: JSON.stringify({ name, parent_id: parentId }),
    });
  }

  /** Move an asset to a folder, or to the project root when folderId is null. */
  moveAsset(assetId: string, folderId: string | null) {
    return this.request<{ ok: boolean }>(`/assets/${assetId}/move`, {
      method: "PATCH",
      body: JSON.stringify({ folder_id: folderId }),
    });
  }

  assets(projectId: string, folderId?: string | null, refresh = false) {
    const query = folderId ? `?folder_id=${encodeURIComponent(folderId)}` : "";
    return this.cachedBrowse<Asset[]>(`/projects/${projectId}/assets${query}`, refresh);
  }

  asset(assetId: string) {
    return this.request<Asset>(`/assets/${assetId}`);
  }

  versions(assetId: string) {
    return this.request<AssetVersion[]>(`/assets/${assetId}/versions`);
  }

  renameAsset(assetId: string, name: string) {
    return this.request<Asset>(`/assets/${assetId}`, {
      method: "PATCH",
      body: JSON.stringify({ name }),
    });
  }

  /** Review links already made for this asset, newest first. */
  shares(assetId: string) {
    return this.request<ShareLink[]>(`/assets/${assetId}/shares`);
  }

  createShare(assetId: string, options: ShareCreateOptions = {}) {
    return this.request<ShareLink>(`/assets/${assetId}/share`, {
      method: "POST",
      body: JSON.stringify({
        permission: "comment",
        visibility: "public",
        allow_download: true,
        show_versions: true,
        show_watermark: false,
        ...options,
      }),
    });
  }

  /** Creates a public review link for every asset within one folder. */
  createFolderShare(folderId: string, options: ShareCreateOptions = {}) {
    return this.request<ShareLink>(`/folders/${folderId}/share`, {
      method: "POST",
      body: JSON.stringify({
        permission: "comment",
        visibility: "public",
        allow_download: true,
        show_versions: true,
        show_watermark: false,
        ...options,
      }),
    });
  }

  /** At the Assets root, sharing applies to the project root instead of a folder. */
  createProjectShare(projectId: string, options: ShareCreateOptions = {}) {
    return this.request<ShareLink>(`/projects/${projectId}/share`, {
      method: "POST",
      body: JSON.stringify({
        permission: "comment",
        visibility: "public",
        allow_download: true,
        show_versions: true,
        show_watermark: false,
        ...options,
      }),
    });
  }

  /** Existing public links for exactly this folder (not its child assets). */
  folderShares(folderId: string) {
    return this.request<ShareLink[]>(`/folders/${folderId}/shares`);
  }

  /** Existing public links for exactly the project's Assets root. */
  projectShares(projectId: string) {
    return this.request<ShareLink[]>(`/projects/${projectId}/shares`);
  }

  revokeShare(token: string) {
    return this.request<void>(`/share/${encodeURIComponent(token)}`, { method: "DELETE" });
  }

  /** Grants a specific person access, by email. */
  shareWithUser(assetId: string, email: string, permission: SharePermission = "comment") {
    return this.request<{ id: string }>(`/assets/${assetId}/share/user`, {
      method: "POST",
      body: JSON.stringify({ email, permission }),
    });
  }

  /**
   * Presigned URL for the original file, with a download disposition. A plain
   * download serves the transcoded MP4, so the panel asks for the original by
   * name; project members and the asset's creator are always allowed it.
   */
  async downloadUrl(assetId: string) {
    const res = await this.request<{ url: string }>(
      `/assets/${assetId}/stream?download=true&rendition=original`
    );
    return res.url.startsWith("/") ? `${this.baseUrl}${res.url}` : res.url;
  }

  /** Moves the asset to the project trash; it is recoverable from the web app. */
  deleteAsset(assetId: string) {
    return this.request<void>(`/assets/${assetId}`, { method: "DELETE" });
  }

  /**
   * Playback URL for a version. Video comes back as an HLS path relative to
   * the API root (the proxy keeps the bucket private), so absolutise it.
   */
  async stream(assetId: string, versionId?: string) {
    const query = versionId ? `?version_id=${encodeURIComponent(versionId)}` : "";
    const res = await this.request<{ url: string; asset_type: string }>(
      `/assets/${assetId}/stream${query}`
    );
    return {
      ...res,
      url: res.url.startsWith("/") ? `${this.baseUrl}${res.url}` : res.url,
    };
  }

  comments(assetId: string, versionId?: string) {
    const query = versionId ? `?version_id=${encodeURIComponent(versionId)}` : "";
    return this.request<Comment[]>(`/assets/${assetId}/comments${query}`);
  }

  createComment(
    assetId: string,
    body: {
      version_id: string;
      body: string;
      timecode_start?: number | null;
      timecode_end?: number | null;
      /** "public" is visible to everyone on the asset; "internal" to the team. */
      visibility?: "public" | "internal";
    }
  ) {
    return this.request<Comment>(`/assets/${assetId}/comments`, {
      method: "POST",
      body: JSON.stringify(body),
    });
  }

  reply(assetId: string, commentId: string, versionId: string, text: string) {
    return this.request<Comment>(`/assets/${assetId}/comments/${commentId}/replies`, {
      method: "POST",
      body: JSON.stringify({ version_id: versionId, body: text }),
    });
  }

  /** Toggles the current user's reaction with this emoji. */
  react(commentId: string, emoji: string) {
    return this.request<void>(`/comments/${commentId}/react`, {
      method: "POST",
      body: JSON.stringify({ emoji }),
    });
  }

  resolve(commentId: string) {
    return this.request<Comment>(`/comments/${commentId}/resolve`, { method: "POST" });
  }

  deleteComment(commentId: string) {
    return this.request<void>(`/comments/${commentId}`, { method: "DELETE" });
  }

  createCommentAttachment(
    commentId: string,
    body: { file_name: string; file_size: number; content_type: string }
  ) {
    return this.request<{ upload_url: string; attachment_id: string }>(
      `/comments/${commentId}/attachments`,
      { method: "POST", body: JSON.stringify(body) }
    );
  }

  deleteCommentAttachment(commentId: string, attachmentId: string) {
    return this.request<void>(`/comments/${commentId}/attachments/${attachmentId}`, {
      method: "DELETE",
    });
  }

  // -- upload -----------------------------------------------------------------

  initiateUpload(body: {
    project_id: string;
    asset_name: string;
    original_filename: string;
    mime_type: string;
    file_size_bytes: number;
    asset_id?: string;
    folder_id?: string | null;
  }) {
    return this.request<InitiateUploadResponse>("/upload/initiate", {
      method: "POST",
      body: JSON.stringify(body),
    });
  }

  presignPart(s3Key: string, uploadId: string, partNumber: number) {
    return this.request<{ presigned_url: string; part_number: number }>(
      "/upload/presign-part",
      {
        method: "POST",
        body: JSON.stringify({ s3_key: s3Key, upload_id: uploadId, part_number: partNumber }),
      }
    );
  }

  completeUpload(body: {
    s3_key: string;
    upload_id: string;
    asset_id: string;
    version_id: string;
    parts: { PartNumber: number; ETag: string }[];
  }) {
    return this.request<{ status: string }>("/upload/complete", {
      method: "POST",
      body: JSON.stringify(body),
    });
  }

  abortUpload(body: { s3_key: string; upload_id: string; version_id: string }) {
    return this.request<void>("/upload/abort", {
      method: "POST",
      body: JSON.stringify(body),
    });
  }

  /** Live project updates. EventSource can't set headers, hence the token query. */
  eventStreamUrl(projectId: string) {
    return `${this.baseUrl}/events/${projectId}?token=${encodeURIComponent(this.accessToken)}`;
  }
}
