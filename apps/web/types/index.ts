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
  status: UserStatus;
  is_superadmin: boolean;
  email_verified: boolean;
  invite_token?: string | null;
  created_at: string;
  deleted_at: string | null;
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
}

export interface AssetVersion {
  id: string;
  asset_id: string;
  version_number: number;
  processing_status: AssetVersionStatus;
  created_by: string;
  created_at: string;
  deleted_at: string | null;
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
}

// ─── Branding & Watermarking ──────────────────────────────────────────────────

export interface ProjectBranding {
  id: string;
  project_id: string;
  logo_s3_key: string | null;
  primary_color: string | null;
  secondary_color: string | null;
  custom_title: string | null;
  custom_footer: string | null;
  viewer_layout: ViewerLayout;
  featured_field: string | null;
  created_at: string;
  updated_at: string;
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
