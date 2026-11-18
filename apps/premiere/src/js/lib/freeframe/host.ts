/**
 * Typed wrappers around the ExtendScript host, plus a poller that keeps the
 * panel in sync with whichever sequence is in front.
 */
import { evalTS } from "../utils/bolt";
import type { Comment } from "./types";
import { buildCommentNumbers } from "./comment-numbers";
import { snapToFrame } from "./timecode";

export interface HostInfo {
  ok: boolean;
  error?: string;
  projectName?: string;
  projectPath?: string;
  sequenceId?: string;
  sequenceName?: string;
  fps?: number;
  durationSeconds?: number;
  playheadSeconds?: number;
  markerCount?: number;
}

/** Premiere marker colours: green for resolved, red for open notes. */
const COLOR_OPEN = 1;
const COLOR_RESOLVED = 4;

export const inPremiere = () => typeof window !== "undefined" && !!window.cep;

export const getHostInfo = async (): Promise<HostInfo> => {
  if (!inPremiere()) return { ok: false, error: "not_in_host" };
  try {
    return (await evalTS("getHostInfo")) as HostInfo;
  } catch (e) {
    return { ok: false, error: String(e) };
  }
};

export const setPlayheadSeconds = (seconds: number) => evalTS("setPlayheadSeconds", seconds);

export const getPlayheadSeconds = () => evalTS("getPlayheadSeconds");

export const listMarkers = () => evalTS("listMarkers");

export const clearMarkers = () => evalTS("clearMarkers");

export const listAllMarkers = () =>
  evalTS("listAllMarkers") as Promise<
    { name: string; comment: string; start: number; end: number }[]
  >;

const authorOf = (comment: Comment) =>
  comment.author?.name || comment.guest_author?.name || "Guest";

/** One line of context per marker, mirroring what Frame.io writes. */
const markerBody = (comment: Comment) => {
  const replies = comment.replies?.length
    ? `\n\n${comment.replies
        .map((reply) => `↳ ${authorOf(reply)}: ${reply.body}`)
        .join("\n")}`
    : "";
  return `${authorOf(comment)}: ${comment.body}${replies}`;
};

export interface SyncResult {
  ok: boolean;
  error?: string;
  added: number;
  removed: number;
  skipped: number;
}

/**
 * Pushes comments onto the active sequence as markers. Comments without a
 * timecode have nowhere to go and are left out.
 */
export const syncComments = async (
  comments: Comment[],
  options: { offsetSeconds?: number; fps?: number; includeResolved?: boolean }
): Promise<SyncResult> => {
  const { offsetSeconds = 0, fps, includeResolved = true } = options;

  // Same root-thread numbering as the web review panel, regardless of sorting.
  const numbers = buildCommentNumbers(comments);

  const markers = comments
    .filter((c) => c.timecode_start !== null && c.timecode_start !== undefined)
    .filter((c) => includeResolved || !c.resolved)
    .map((c) => {
      const number = numbers.get(c.id);
      return {
        id: c.id,
        start: snapToFrame(c.timecode_start as number, fps),
        end:
          c.timecode_end !== null && c.timecode_end !== undefined
            ? snapToFrame(c.timecode_end, fps)
            : undefined,
        name: `${number !== undefined ? `#${number} ` : ""}${authorOf(c)}${
          c.resolved ? " ✓" : ""
        }`,
        comment: markerBody(c),
        colorIndex: c.resolved ? COLOR_RESOLVED : COLOR_OPEN,
      };
    });
  return (await evalTS("syncMarkers", markers, offsetSeconds)) as SyncResult;
};

export interface AssetLink {
  assetId: string;
  assetName: string;
  projectId: string;
  projectName: string;
  versionId?: string;
  offsetSeconds?: number;
}

export interface SegmentLink extends AssetLink {
  id: string;
  inPoint: number;
  outPoint: number;
}

export const getLink = () => evalTS("getLink") as Promise<AssetLink | null>;
export const setLink = (link: AssetLink) => evalTS("setLink", link);
export const clearLink = () => evalTS("clearLink");
export const getSegmentLinks = () => evalTS("getSegmentLinks") as Promise<SegmentLink[]>;
export const upsertSegmentLink = (link: SegmentLink) => evalTS("upsertSegmentLink", link);
export const removeSegmentLink = (id: string) => evalTS("removeSegmentLink", id);
export const getInOut = () =>
  evalTS("getInOut") as Promise<{ inPoint: number; outPoint: number } | null>;

export const getScratchPath = () => evalTS("getScratchPath");

export const renderInPremiere = (
  presetPath: string,
  outputPath: string,
  workArea: number
) => evalTS("renderInPremiere", presetPath, outputPath, workArea);

export const encodeActiveSequence = (
  presetPath: string,
  outputPath: string,
  workArea: number
) => evalTS("encodeActiveSequence", presetPath, outputPath, workArea);

/**
 * Polls the host, because CEP gets no event when the user switches sequences.
 * 1.5s is frequent enough to feel live without loading the ExtendScript engine.
 */
export const watchHost = (
  callback: (info: HostInfo) => void,
  intervalMs = 1500
): (() => void) => {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout>;
  let lastKey = "";
  const tick = async () => {
    if (stopped) return;
    const info = await getHostInfo();
    // Every tick returns a fresh object, so passing it straight to setState
    // re-rendered the whole panel every 1.5s. Only report real changes (the
    // playhead at 0.1s resolution is enough for placing a comment).
    const key = JSON.stringify({
      ...info,
      playheadSeconds:
        typeof info?.playheadSeconds === "number" ? Math.round(info.playheadSeconds * 10) : null,
    });
    if (key !== lastKey) {
      lastKey = key;
      callback(info);
    }
    if (!stopped) timer = setTimeout(tick, intervalMs);
  };
  tick();
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
};
