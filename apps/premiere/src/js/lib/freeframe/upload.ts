/**
 * Uploads a rendered file from disk to FreeFrame as a new asset version.
 *
 * The panel has Node access, so the render is streamed off disk one part at
 * a time instead of being loaded into memory whole. The server picks the part
 * size when the upload starts and pins it to the version; 10 MB is the
 * fallback for servers that do not report one.
 */
import { fs, path } from "../cep/node";
import { FreeFrameApi } from "./api";

const DEFAULT_CHUNK_SIZE = 10 * 1024 * 1024;
const MAX_PART_ATTEMPTS = 3;

const MIME_BY_EXT: Record<string, string> = {
  ".mp4": "video/mp4",
  ".m4v": "video/mp4",
  ".mov": "video/quicktime",
  ".avi": "video/x-msvideo",
  ".mkv": "video/x-matroska",
  ".webm": "video/webm",
  ".mpg": "video/mpeg",
  ".mpeg": "video/mpeg",
  ".wmv": "video/x-ms-wmv",
  ".wav": "audio/wav",
  ".mp3": "audio/mpeg",
  ".aac": "audio/aac",
  ".flac": "audio/flac",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
};

export const mimeForPath = (filePath: string): string =>
  MIME_BY_EXT[path.extname(filePath).toLowerCase()] ?? "";

/** Reads one part off disk without pulling the whole file into memory. */
const readPart = (
  filePath: string,
  partNumber: number,
  fileSize: number,
  chunkSize: number
): Uint8Array => {
  const start = (partNumber - 1) * chunkSize;
  const length = Math.min(chunkSize, fileSize - start);
  const buffer = Buffer.alloc(length);
  const fd = fs.openSync(filePath, "r");
  try {
    fs.readSync(fd, buffer, 0, length, start);
  } finally {
    fs.closeSync(fd);
  }
  return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
};

export interface UploadOptions {
  api: FreeFrameApi;
  filePath: string;
  projectId: string;
  /** Set to add a version to an existing asset; omit to create a new one. */
  assetId?: string;
  folderId?: string | null;
  assetName?: string;
  onProgress?: (percent: number) => void;
  /** Set to true to stop between parts; the upload is then aborted server-side. */
  isCancelled?: () => boolean;
}

export class UploadCancelled extends Error {
  constructor() {
    super("Upload cancelled");
    this.name = "UploadCancelled";
  }
}

export const uploadFile = async (
  options: UploadOptions
): Promise<{ assetId: string; versionId: string }> => {
  const { api, filePath, projectId, assetId, folderId, onProgress, isCancelled } = options;

  if (!fs.existsSync(filePath)) throw new Error(`Render not found at ${filePath}`);
  const fileSize = fs.statSync(filePath).size;
  if (fileSize === 0) throw new Error("Render is empty");

  const fileName = path.basename(filePath);
  const mimeType = mimeForPath(filePath);
  if (!mimeType) throw new Error(`FreeFrame does not accept ${path.extname(fileName)} files`);

  const initiated = await api.initiateUpload({
    project_id: projectId,
    asset_name: options.assetName || path.basename(fileName, path.extname(fileName)),
    original_filename: fileName,
    mime_type: mimeType,
    file_size_bytes: fileSize,
    asset_id: assetId,
    folder_id: folderId ?? undefined,
  });

  const chunkSize =
    initiated.chunk_size_bytes && initiated.chunk_size_bytes > 0
      ? initiated.chunk_size_bytes
      : DEFAULT_CHUNK_SIZE;
  const totalParts = Math.ceil(fileSize / chunkSize);
  const parts: { PartNumber: number; ETag: string }[] = [];

  try {
    for (let partNumber = 1; partNumber <= totalParts; partNumber++) {
      if (isCancelled?.()) throw new UploadCancelled();

      const { presigned_url } = await api.presignPart(
        initiated.s3_key,
        initiated.upload_id,
        partNumber
      );
      const body = readPart(filePath, partNumber, fileSize, chunkSize);

      let etag = "";
      for (let attempt = 1; attempt <= MAX_PART_ATTEMPTS; attempt++) {
        // Chromium's fetch takes a typed array fine; the DOM lib types built
        // against @types/node don't line up on the ArrayBuffer generic.
        const res = await fetch(presigned_url, {
          method: "PUT",
          body: body as unknown as BodyInit,
        });
        if (res.ok) {
          etag = res.headers.get("ETag") ?? "";
          break;
        }
        if (attempt === MAX_PART_ATTEMPTS) {
          throw new Error(`Part ${partNumber} failed: HTTP ${res.status}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
      }

      parts.push({ PartNumber: partNumber, ETag: etag });
      // Hold back the last 5% for the server-side complete call.
      onProgress?.(Math.round((partNumber / totalParts) * 95));
    }

    await api.completeUpload({
      s3_key: initiated.s3_key,
      upload_id: initiated.upload_id,
      asset_id: initiated.asset_id,
      version_id: initiated.version_id,
      parts,
    });
    onProgress?.(100);
    return { assetId: initiated.asset_id, versionId: initiated.version_id };
  } catch (error) {
    // Leaving a multipart upload open bills storage for bytes nothing owns.
    try {
      await api.abortUpload({
        s3_key: initiated.s3_key,
        upload_id: initiated.upload_id,
        version_id: initiated.version_id,
      });
    } catch (abortError) {
      console.error("Could not abort the upload", abortError);
    }
    throw error;
  }
};
