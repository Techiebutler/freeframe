// ─── Enums ───────────────────────────────────────────────────────────────────

export type AssetType = "image" | "image_carousel" | "audio" | "video";

export type AssetStatus = "draft" | "in_review" | "approved" | "rejected" | "archived";

export type AssetVersionStatus = "uploading" | "processing" | "ready" | "failed";

export type OrgRole = "owner" | "admin" | "member";

export type TeamRole = "lead" | "member";

export type ProjectRole = "owner" | "editor" | "reviewer" | "viewer";

export type ProjectType = "personal" | "team";

export type SharePermission = "view" | "comment" | "approve";

export type NotificationType = "mention" | "assignment" | "due_soon" | "comment" | "approval";

export type UserStatus = "active" | "deactivated" | "pending_invite" | "pending_verification";

export type ActivityAction =
  | "created"
  | "commented"
  | "mentioned"
  | "shared"
  | "assigned"
  | "approved"
  | "rejected";

export type FileType = "image" | "audio" | "video" | "document";

export type MetadataFieldType = "text" | "number" | "date" | "select" | "multi_select";

export type WatermarkPosition = "center" | "corner" | "tiled";

export type WatermarkContent = "email" | "name" | "custom_text";

export type ViewerLayout = "grid" | "reel";

export type ApprovalStatus = "approved" | "rejected" | "pending";

// ─── Core Entities ────────────────────────────────────────────────────────────

export interface User {
  id: string;
  email: string;
  name: string;
  avatar_url: string | null;
  avatar_color: string | null;
  status: UserStatus;
  is_superadmin: boolean;
  email_verified: boolean;
  invite_token?: string | null;
  preferences: Record<string, unknown>;
  created_at: string;
  deleted_at: string | null;
}

export interface InstanceSettings {
  storage_limit_bytes: number;
  storage_used_bytes: number;
  /** Admins only. 0 sizes upload parts from each file; anything else is fixed. */
  upload_part_size_bytes?: number;
  /** Admins only. Whether people outside a project may download originals. */
  allow_original_downloads?: boolean;
}

// ─── The admin Storage tab ────────────────────────────────────────────────────
//
// One figure per row. `total_bytes` is the originals plus the derived output
// that has actually been measured (renditions and HLS segments, the single-file
// download, poster thumbnails, audio waveforms). The split between the two
// stays on the server: a storage page answers how big a thing is, not how its
// bytes are apportioned.

export interface StorageSummary {
  used_bytes: number;
  /** null when the instance has no storage limit set. There is no capacity to
   *  read then, so the header says what is used rather than inventing a
   *  denominator. */
  capacity_bytes: number | null;
  free_bytes: number | null;
  unmeasured_files: number;
  /** Bytes still held by things in the trash, not yet reclaimed. */
  trash_bytes: number;
  retention_days: number;
}

export interface StorageProjectRow {
  project_id: string;
  name: string;
  total_bytes: number;
}

export interface StorageOverview {
  summary: StorageSummary;
  projects: StorageProjectRow[];
  /** How many projects hold bytes in total; `projects` is the largest `limit`
   *  of them. The summary is always instance-wide. */
  project_count: number;
  limit: number;
}

export interface StorageVersionRow {
  version_id: string;
  version_number: number;
  total_bytes: number;
  /** The file's newest version. It can only be deleted together with the whole
   *  file; the server refuses it either way, this just lets the row say so. */
  is_latest: boolean;
}

export interface StorageAssetRow {
  asset_id: string;
  name: string;
  total_bytes: number;
  versions: StorageVersionRow[];
}

export interface StorageProjectFiles {
  project_id: string;
  name: string;
  assets: StorageAssetRow[];
}

export interface AdminProjectRow {
  project_id: string;
  name: string;
  /** The project's poster, presigned, or null. The card falls back to the
   *  gradient the project id picks, exactly as everywhere else in the app. */
  poster_url: string | null;
  member_count: number;
  total_bytes: number;
  last_activity_at: string | null;
}

export interface InternalSharePerson {
  user_id: string;
  name: string;
  email: string;
  /** So a grouped card draws the same avatar the rest of the app draws. */
  avatar_url: string | null;
  avatar_color: string | null;
  role: string;
}

export interface InternalShareRow {
  project_id: string;
  project_name: string;
  people: InternalSharePerson[];
  /** False when every member of this project has been deleted as a user. The
   *  project still appears, because its access is still an administrator's to
   *  repair, and the block says so instead of standing empty. */
  has_live_people: boolean;
}

export interface ExternalShareRow {
  token: string;
  /** "project" | "folder" | "asset" */
  kind: string;
  what: string;
  title: string | null;
  permission: string;
  allow_download: boolean;
  has_password: boolean;
  expires_at: string | null;
  created_by_name: string | null;
  created_at: string | null;
}

export interface AdminDeleteResponse {
  deleted_projects: number;
  deleted_assets: number;
  deleted_versions: number;
  freed_bytes: number;
  retention_days: number;
  restorable_until: string | null;
}

export interface TrashProjectRow {
  project_id: string;
  name: string;
  deleted_at: string | null;
  days_left: number | null;
  /** What deleting this one entry for good would free. */
  total_bytes: number | null;
}

export interface TrashAssetRow {
  asset_id: string;
  name: string;
  project_id: string;
  project_name: string;
  deleted_at: string | null;
  days_left: number | null;
  blocked_by_project: boolean;
  /** null while the project above it is in the trash: those bytes are counted
   *  on the project's row, and this entry has no delete of its own. */
  total_bytes: number | null;
}

export interface TrashVersionRow {
  version_id: string;
  version_number: number;
  asset_id: string;
  asset_name: string;
  project_id: string;
  project_name: string;
  deleted_at: string | null;
  days_left: number | null;
  blocked_by_parent: boolean;
  /** null while a parent is in the trash, for the reason above. */
  total_bytes: number | null;
}

export interface TrashOverview {
  retention_days: number;
  /** What emptying the whole trash would free. */
  total_bytes: number;
  projects: TrashProjectRow[];
  assets: TrashAssetRow[];
  versions: TrashVersionRow[];
}

export interface AdminPurgeResponse {
  purged_projects: number;
  purged_assets: number;
  purged_versions: number;
  freed_bytes: number;
  s3_deletes: number;
}

export interface Team {
  id: string;
  org_id: string;
  name: string;
  description: string | null;
  created_at: string;
  deleted_at: string | null;
}

export interface TeamMember {
  id: string;
  team_id: string;
  user_id: string;
  role: TeamRole;
  added_at: string;
  deleted_at: string | null;
}

export interface Project {
  id: string;
  name: string;
  description: string | null;
  created_by: string;
  org_id?: string;
  project_type: ProjectType;
  team_id?: string | null;
  poster_url?: string | null;
  is_public?: boolean;
  created_at: string;
  deleted_at: string | null;
  asset_count?: number;
  storage_bytes?: number;
  member_count?: number;
  role?: string | null;
}

export interface ProjectMember {
  id: string;
  project_id: string;
  user_id: string;
  role: ProjectRole;
  invited_by: string | null;
  invited_at: string | null;
  deleted_at: string | null;
}

// ─── Asset & Media Entities ───────────────────────────────────────────────────

export interface Asset {
  id: string;
  project_id: string;
  name: string;
  description: string | null;
  asset_type: AssetType;
  status: AssetStatus;
  rating: number | null;
  assignee_id: string | null;
  folder_id: string | null;
  due_date: string | null;
  keywords: string[];
  created_by: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  /** Comments on the latest version, replies included, as its comment panel shows them. */
  comment_count?: number;
}

export interface AssetVersion {
  id: string;
  asset_id: string;
  version_number: number;
  processing_status: AssetVersionStatus;
  created_by: string;
  created_at: string;
  deleted_at: string | null;
  /** When the upload last moved; see `mergeHistoryAssets`. */
  last_activity_at?: string | null;
  files?: MediaFile[];
}

/** Backend returns AssetResponse with latest_version embedded */
export interface AssetResponse extends Asset {
  latest_version: AssetVersion | null;
  thumbnail_url: string | null;
}

export interface MediaFile {
  id: string;
  version_id: string;
  file_type: FileType;
  original_filename: string;
  mime_type: string;
  file_size_bytes: number;
  s3_key_raw: string | null;
  s3_key_processed: string | null;
  s3_key_thumbnail: string | null;
  width: number | null;
  height: number | null;
  duration_seconds: number | null;
  fps: number | null;
  sequence_order: number | null;
  created_at: string;
}

/** One file a version can be downloaded as: the original, or a transcode. */
export interface DownloadOption {
  /** "original" or "transcode"; passed back as `rendition` when downloading. */
  id: string;
  label: string;
  format: string;
  size_bytes: number | null;
}

export interface CarouselItem {
  id: string;
  version_id: string;
  media_file_id: string;
  position: number;
}

// ─── Comments & Annotations ───────────────────────────────────────────────────

export interface GuestUser {
  id: string;
  email: string;
  name: string;
  created_at: string;
}

export interface CommentAuthor {
  id: string;
  name: string;
  avatar_url: string | null;
  avatar_color?: string | null;
}

export interface GuestAuthor {
  id: string;
  name: string;
  email?: string;
}

export interface Comment {
  id: string;
  asset_id: string;
  version_id: string;
  parent_id: string | null;
  author_id: string | null;
  guest_author_id: string | null;
  timecode_start: number | null;
  timecode_end: number | null;
  body: string;
  resolved: boolean;
  visibility: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  author?: CommentAuthor | null;
  guest_author?: GuestAuthor | null;
}

export interface Annotation {
  id: string;
  comment_id: string;
  drawing_data: Record<string, unknown>;
  frame_number: number | null;
  carousel_position: number | null;
}

export interface CommentAttachment {
  id: string;
  comment_id: string;
  file_type: FileType;
  s3_key: string;
  original_filename: string;
  file_size_bytes: number;
  created_at: string;
}

export interface CommentReaction {
  id: string;
  comment_id: string;
  user_id: string;
  emoji: string;
  created_at: string;
}

// ─── Approvals & Sharing ──────────────────────────────────────────────────────

export interface Approval {
  id: string;
  asset_id: string;
  version_id: string;
  user_id: string;
  status: ApprovalStatus;
  note: string | null;
  created_at: string;
  deleted_at: string | null;
}

export interface ShareLinkAppearance {
  layout: "grid" | "list"
  theme: "dark" | "light"
  accent_color: string | null
  open_in_viewer: boolean
  sort_by: "name" | "created_at" | "file_size"
  card_size: "s" | "m" | "l"
  aspect_ratio: "landscape" | "square" | "portrait"
  thumbnail_scale: "fit" | "fill"
  show_card_info: boolean
}

export interface ShareLink {
  id: string;
  asset_id: string | null;
  folder_id: string | null;
  project_id: string | null;
  token: string;
  title: string;
  description: string | null;
  created_by: string;
  expires_at: string | null;
  permission: SharePermission;
  allow_download: boolean;
  is_enabled: boolean;
  visibility: "public" | "secure";
  show_versions: boolean;
  show_watermark: boolean;
  appearance: ShareLinkAppearance | null;
  created_at: string;
  deleted_at: string | null;
  has_password: boolean;
  password_value: string | null;
}

export interface AssetShare {
  id: string;
  asset_id: string;
  shared_with_user_id: string | null;
  shared_with_team_id: string | null;
  permission: SharePermission;
  shared_by: string;
  created_at: string;
  deleted_at: string | null;
}

export interface ShareLinkListItem {
  id: string
  token: string
  title: string
  description: string | null
  is_enabled: boolean
  permission: SharePermission
  share_type: "asset" | "folder"
  target_name: string
  view_count: number
  last_viewed_at: string | null
  created_at: string
  expires_at: string | null
  /** True once expires_at has passed: the share page no longer opens the link. */
  is_expired: boolean
  /** Only when the list was asked about one asset: how this link shows it. */
  contains_asset?: "direct" | "indirect" | null
}

export type ShareActivityAction = "opened" | "viewed_asset" | "commented" | "approved" | "rejected" | "downloaded"

export interface ShareLinkActivity {
  id: string
  share_link_id: string
  action: ShareActivityAction
  actor_email: string
  actor_name: string | null
  asset_id: string | null
  asset_name: string | null
  /** For a download: "original" or "transcode". Null on older rows. */
  rendition?: string | null
  created_at: string
}

export interface FolderShareAssetItem {
  id: string
  name: string
  asset_type: string
  thumbnail_url: string | null
  file_size: number | null
  duration_seconds: number | null
  comment_count: number
  version_count?: number
  created_by_name: string | null
  created_at: string
}

export interface FolderShareSubfolder {
  id: string
  name: string
  item_count: number
  thumbnail_urls: string[]
}

export interface FolderShareAssetsResponse {
  assets: FolderShareAssetItem[]
  subfolders: FolderShareSubfolder[]
  total: number
  page: number
  per_page: number
}

// ─── Metadata & Collections ───────────────────────────────────────────────────

export interface MetadataField {
  id: string;
  project_id: string;
  name: string;
  field_type: MetadataFieldType;
  options: unknown[] | null;
  required: boolean;
  created_at: string;
  deleted_at: string | null;
}

export interface AssetMetadata {
  id: string;
  asset_id: string;
  field_id: string;
  value: unknown;
  created_at: string;
  updated_at: string;
}

export interface Collection {
  id: string;
  project_id: string;
  name: string;
  description: string | null;
  filter_rules: Record<string, unknown> | null;
  created_by: string;
  created_at: string;
  deleted_at: string | null;
}

export interface CollectionShare {
  id: string;
  collection_id: string;
  token: string;
  permission: SharePermission;
  expires_at: string | null;
  created_by: string;
  created_at: string;
  deleted_at: string | null;
}

// ─── Activity, Mentions & Notifications ───────────────────────────────────────

export interface Mention {
  id: string;
  comment_id: string;
  mentioned_user_id: string;
  created_at: string;
}

export interface ActivityLog {
  id: string;
  user_id: string;
  asset_id: string;
  action: ActivityAction;
  created_at: string;
}

export interface Notification {
  id: string;
  user_id: string;
  comment_id: string | null;
  asset_id: string;
  type: NotificationType;
  read: boolean;
  created_at: string;
  asset_name: string | null;
  actor_name: string | null;
  actor_is_guest?: boolean;
  comment_preview: string | null;
  project_id: string | null;
}

// ─── Branding & Watermarking ──────────────────────────────────────────────────

/** GET/PUT /projects/{id}/branding. */
export interface ProjectBranding {
  id: string;
  project_id: string;
  logo_s3_key: string | null;
  /** A signed URL for `logo_s3_key`, or null when there is no logo. */
  logo_url: string | null;
  primary_color: string | null;
  secondary_color: string | null;
  custom_title: string | null;
  custom_footer: string | null;
  viewer_layout: ViewerLayout;
  featured_field: string | null;
  /** Share pages show the project cover as their logo when one is set. */
  use_cover_as_logo: boolean;
}

/** The project branding a share link's validate response carries, for every link type. */
export interface ShareBranding {
  /** Already resolved by the API: the cover when the project uses it, else the logo. */
  logo_url: string | null;
  primary_color: string | null;
  custom_footer: string | null;
}

export interface WatermarkSettings {
  id: string;
  project_id: string;
  share_link_id: string | null;
  enabled: boolean;
  position: WatermarkPosition;
  content: WatermarkContent;
  custom_text: string | null;
  opacity: number;
  created_at: string;
}

// ─── Folders ──────────────────────────────────────────────────────────────────

export interface Folder {
  id: string
  project_id: string
  parent_id: string | null
  name: string
  created_by: string
  created_at: string
  updated_at: string
  item_count: number
}

export interface FolderTreeNode {
  id: string
  name: string
  parent_id: string | null
  item_count: number
  children: FolderTreeNode[]
}

export interface TrashItem {
  id: string
  name: string
  type: string
  parent_id?: string | null
  folder_id?: string | null
  deleted_at: string | null
}

export interface TrashResponse {
  folders: TrashItem[]
  assets: TrashItem[]
}

// ─── API Response Wrappers ────────────────────────────────────────────────────

export interface ApiError {
  detail: string;
  status_code: number;
}

export interface PaginatedResponse<T> {
  items: T[];
  total: number;
  page: number;
  per_page: number;
}

export interface SetupStatus {
  needs_setup: boolean;
}

export interface MagicCodeResponse {
  message: string;
}

export interface VerifyCodeResponse {
  access_token: string;
  refresh_token: string;
  token_type: string;
  needs_password: boolean;
}

export interface AuthTokens {
  access_token: string;
  refresh_token: string;
  token_type: string;
}
