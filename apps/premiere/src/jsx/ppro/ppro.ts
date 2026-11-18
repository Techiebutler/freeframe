/**
 * FreeFrame CEP panel — Premiere Pro host functions.
 *
 * ExtendScript is ES3: no `forEach`/`map`/`indexOf`/`trim` on the built-ins.
 * `JSON` comes from `lib/json2.js`, included by `src/jsx/index.ts`.
 */
import { dispatchTS } from "../utils/utils";
import { getPrMetadata, setPrMetadata } from "./ppro-utils";

const TICKS_PER_SECOND = 254016000000;

/** Every marker this panel owns carries `[ff:<comment-id>]` in its comment. */
const MARKER_TAG_OPEN = "[ff:";
const MARKER_TAG_CLOSE = "]";

/** XMP field on the sequence's project item holding the FreeFrame link. */
const LINK_FIELD = "FreeFrameLink";
const LINK_FIELD_ID = "FreeFrame.Link";
const SEGMENT_LINKS_FIELD = "FreeFrameSegmentLinks";
const SEGMENT_LINKS_FIELD_ID = "FreeFrame.SegmentLinks";

// -- types shared with the panel ----------------------------------------------

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

export interface MarkerInput {
  /** FreeFrame comment id — the marker's identity across syncs. */
  id: string;
  /** Seconds from the start of the media the comment was left on. */
  start: number;
  /** Optional range end, in seconds. */
  end?: number;
  name: string;
  comment: string;
  /** Premiere marker colour index, 0-7. */
  colorIndex?: number;
}

export interface SyncResult {
  ok: boolean;
  error?: string;
  added: number;
  removed: number;
  skipped: number;
}

export interface AssetLink {
  assetId: string;
  assetName: string;
  projectId: string;
  projectName: string;
  versionId?: string;
  /** Seconds added to every comment timecode when placing markers. */
  offsetSeconds?: number;
}

/** A saved In/Out delivery within a shared timeline. */
export interface SegmentLink extends AssetLink {
  id: string;
  inPoint: number;
  outPoint: number;
}

// -- small ES3 helpers --------------------------------------------------------

const trim = (s: string): string => {
  return s.replace(/^\s+/, "").replace(/\s+$/, "");
};

const tagFor = (id: string): string => {
  return MARKER_TAG_OPEN + id + MARKER_TAG_CLOSE;
};

/** Returns the FreeFrame comment id encoded in a marker comment, or null. */
const idFromMarker = (marker: Marker): string | null => {
  const body = marker.comments || "";
  const open = body.indexOf(MARKER_TAG_OPEN);
  if (open < 0) return null;
  const close = body.indexOf(MARKER_TAG_CLOSE, open);
  if (close < 0) return null;
  return body.substring(open + MARKER_TAG_OPEN.length, close);
};

const activeSequence = (): Sequence | null => {
  if (!app.project) return null;
  const seq = app.project.activeSequence;
  return seq ? seq : null;
};

const sequenceFps = (seq: Sequence): number => {
  // `timebase` is ticks per frame; more reliable than the settings round-trip.
  const timebase = parseFloat(seq.timebase);
  if (timebase > 0) return TICKS_PER_SECOND / timebase;
  const settings = seq.getSettings();
  if (settings && settings.videoFrameRate) {
    return 1 / settings.videoFrameRate.seconds;
  }
  return 0;
};

/** Sequence start timecode in ticks — the playhead is absolute, markers are not. */
const zeroPointTicks = (seq: Sequence): number => {
  const zero = parseFloat(seq.zeroPoint);
  return isNaN(zero) ? 0 : zero;
};

/** Collects every marker on the sequence into a plain array (ES3-safe walk). */
const allMarkers = (seq: Sequence): Marker[] => {
  const out: Marker[] = [];
  const markers = seq.markers;
  if (!markers) return out;
  let marker = markers.getFirstMarker();
  while (marker) {
    out.push(marker);
    marker = markers.getNextMarker(marker);
  }
  return out;
};

// -- host state ---------------------------------------------------------------

export const getHostInfo = (): HostInfo => {
  if (!app.project) {
    return { ok: false, error: "no_project" };
  }
  const seq = activeSequence();
  if (!seq) {
    return {
      ok: false,
      error: "no_sequence",
      projectName: app.project.name,
      projectPath: app.project.path,
    };
  }
  const end = parseFloat(seq.end);
  return {
    ok: true,
    projectName: app.project.name,
    projectPath: app.project.path,
    sequenceId: seq.sequenceID,
    sequenceName: seq.name,
    fps: sequenceFps(seq),
    durationSeconds: isNaN(end) ? 0 : end / TICKS_PER_SECOND,
    playheadSeconds:
      seq.getPlayerPosition().seconds - zeroPointTicks(seq) / TICKS_PER_SECOND,
    // numMarkers is a property read; walking every marker each 1.5s poll cost
    // Premiere main-thread time on marker-heavy sequences.
    markerCount: seq.markers ? seq.markers.numMarkers : 0,
  };
};

export const getSequences = (): { id: string; name: string; active: boolean }[] => {
  const out: { id: string; name: string; active: boolean }[] = [];
  if (!app.project) return out;
  const active = activeSequence();
  const activeId = active ? active.sequenceID : "";
  for (let i = 0; i < app.project.sequences.numSequences; i++) {
    const seq = app.project.sequences[i];
    out.push({ id: seq.sequenceID, name: seq.name, active: seq.sequenceID === activeId });
  }
  return out;
};

export const openSequence = (sequenceId: string): boolean => {
  for (let i = 0; i < app.project.sequences.numSequences; i++) {
    const seq = app.project.sequences[i];
    if (seq.sequenceID === sequenceId) {
      app.project.openSequence(sequenceId);
      app.project.activeSequence = seq;
      return true;
    }
  }
  return false;
};

// -- playhead -----------------------------------------------------------------

/** Moves the CTI of the active sequence to `seconds` from the sequence start. */
export const setPlayheadSeconds = (seconds: number): boolean => {
  const seq = activeSequence();
  if (!seq) return false;
  const ticks = Math.round(seconds * TICKS_PER_SECOND) + zeroPointTicks(seq);
  seq.setPlayerPosition(String(ticks < 0 ? 0 : ticks));
  return true;
};

export const getPlayheadSeconds = (): number => {
  const seq = activeSequence();
  if (!seq) return -1;
  return seq.getPlayerPosition().seconds - zeroPointTicks(seq) / TICKS_PER_SECOND;
};

// -- markers ------------------------------------------------------------------

/**
 * Reconciles the sequence's FreeFrame markers with `items`: markers whose
 * comment id is gone are deleted, missing ones are created, and markers the
 * user made by hand are never touched.
 */
export const syncMarkers = (items: MarkerInput[], offsetSeconds: number): SyncResult => {
  const seq = activeSequence();
  if (!seq) return { ok: false, error: "no_sequence", added: 0, removed: 0, skipped: 0 };

  const duration = parseFloat(seq.end) / TICKS_PER_SECOND;
  const offset = offsetSeconds || 0;

  const wanted: { [id: string]: MarkerInput } = {};
  for (let i = 0; i < items.length; i++) wanted[items[i].id] = items[i];

  // Drop ours that went stale or are at the wrong timeline position. The
  // latter happens when an asset was exported from an In/Out segment: its
  // comments are relative to the clip, while Premiere markers are absolute.
  const existing: { [id: string]: boolean } = {};
  let removed = 0;
  const current = allMarkers(seq);
  for (let i = 0; i < current.length; i++) {
    const id = idFromMarker(current[i]);
    if (id === null) continue;
    const item = wanted[id];
    if (item) {
      const expectedStart = item.start + offset;
      // Frame precision is sufficient here; avoid recreating a marker because
      // Premiere returned an insignificant floating-point difference.
      if (Math.abs(current[i].start.seconds - expectedStart) <= 0.001) {
        existing[id] = true;
      } else {
        seq.markers.deleteMarker(current[i]);
        removed++;
      }
    } else {
      seq.markers.deleteMarker(current[i]);
      removed++;
    }
  }

  let added = 0;
  let skipped = 0;
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (existing[item.id]) continue;
    const start = item.start + offset;
    // Premiere silently misplaces markers outside the sequence; report instead.
    if (start < 0 || (duration > 0 && start > duration)) {
      skipped++;
      continue;
    }
    const marker = seq.markers.createMarker(start);
    marker.name = item.name;
    marker.comments = item.comment + "\n" + tagFor(item.id);
    if (typeof item.end === "number" && item.end > item.start) {
      const end = item.end + offset;
      try {
        // Premiere accepts a plain seconds number here despite the Time type.
        //@ts-ignore
        marker.end = duration > 0 && end > duration ? duration : end;
      } catch (e) {}
    }
    if (typeof item.colorIndex === "number") {
      try {
        marker.setColorByIndex(item.colorIndex);
      } catch (e) {}
    }
    added++;
  }

  return { ok: true, added: added, removed: removed, skipped: skipped };
};

/** Deletes every marker this panel created, leaving hand-made ones alone. */
export const clearMarkers = (): SyncResult => {
  const seq = activeSequence();
  if (!seq) return { ok: false, error: "no_sequence", added: 0, removed: 0, skipped: 0 };
  let removed = 0;
  const current = allMarkers(seq);
  for (let i = 0; i < current.length; i++) {
    if (idFromMarker(current[i]) !== null) {
      seq.markers.deleteMarker(current[i]);
      removed++;
    }
  }
  return { ok: true, added: 0, removed: removed, skipped: 0 };
};

export const listMarkers = (): { id: string; name: string; start: number }[] => {
  const out: { id: string; name: string; start: number }[] = [];
  const seq = activeSequence();
  if (!seq) return out;
  const current = allMarkers(seq);
  for (let i = 0; i < current.length; i++) {
    const id = idFromMarker(current[i]);
    if (id === null) continue;
    out.push({ id: id, name: current[i].name, start: current[i].start.seconds });
  }
  return out;
};

/** Every marker on the sequence, for "upload markers as comments". */
export const listAllMarkers = (): { name: string; comment: string; start: number; end: number }[] => {
  const out: { name: string; comment: string; start: number; end: number }[] = [];
  const seq = activeSequence();
  if (!seq) return out;
  const current = allMarkers(seq);
  for (let i = 0; i < current.length; i++) {
    const marker = current[i];
    out.push({
      name: marker.name || "",
      comment: marker.comments || "",
      start: marker.start.seconds,
      end: marker.end ? marker.end.seconds : marker.start.seconds,
    });
  }
  return out;
};

// -- asset <-> sequence link --------------------------------------------------

/**
 * The link lives in the sequence project item's XMP so it travels with the
 * .prproj. The panel keeps a local copy as a fallback when XMP is unavailable.
 */
export const getLink = (): AssetLink | null => {
  const seq = activeSequence();
  if (!seq || !seq.projectItem) return null;
  try {
    const meta = getPrMetadata(seq.projectItem, [LINK_FIELD]);
    const raw = meta[LINK_FIELD];
    if (!raw || trim(raw) === "") return null;
    return JSON.parse(raw) as AssetLink;
  } catch (e) {
    return null;
  }
};

export const setLink = (link: AssetLink): { ok: boolean; error?: string } => {
  const seq = activeSequence();
  if (!seq) return { ok: false, error: "no_sequence" };
  if (!seq.projectItem) return { ok: false, error: "no_project_item" };
  try {
    setPrMetadata(seq.projectItem, [
      { fieldName: LINK_FIELD, fieldId: LINK_FIELD_ID, value: JSON.stringify(link) },
    ]);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
};

export const clearLink = (): { ok: boolean; error?: string } => {
  const seq = activeSequence();
  if (!seq) return { ok: false, error: "no_sequence" };
  if (!seq.projectItem) return { ok: false, error: "no_project_item" };
  try {
    setPrMetadata(seq.projectItem, [
      { fieldName: LINK_FIELD, fieldId: LINK_FIELD_ID, value: "" },
    ]);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
};

export const getSegmentLinks = (): SegmentLink[] => {
  const seq = activeSequence();
  if (!seq || !seq.projectItem) return [];
  try {
    const meta = getPrMetadata(seq.projectItem, [SEGMENT_LINKS_FIELD]);
    const raw = meta[SEGMENT_LINKS_FIELD];
    if (!raw || trim(raw) === "") return [];
    const parsed = JSON.parse(raw);
    return parsed && parsed.length !== undefined ? parsed as SegmentLink[] : [];
  } catch (e) {
    return [];
  }
};

export const upsertSegmentLink = (link: SegmentLink): { ok: boolean; error?: string } => {
  const seq = activeSequence();
  if (!seq) return { ok: false, error: "no_sequence" };
  if (!seq.projectItem) return { ok: false, error: "no_project_item" };
  try {
    const links = getSegmentLinks();
    let replaced = false;
    for (let i = 0; i < links.length; i++) {
      if (links[i].id === link.id) {
        links[i] = link;
        replaced = true;
        break;
      }
    }
    if (!replaced) links.push(link);
    setPrMetadata(seq.projectItem, [
      {
        fieldName: SEGMENT_LINKS_FIELD,
        fieldId: SEGMENT_LINKS_FIELD_ID,
        value: JSON.stringify(links),
      },
    ]);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
};

/** Removes one exported In/Out segment's asset association from this sequence. */
export const removeSegmentLink = (id: string): { ok: boolean; error?: string } => {
  const seq = activeSequence();
  if (!seq) return { ok: false, error: "no_sequence" };
  if (!seq.projectItem) return { ok: false, error: "no_project_item" };
  try {
    const links = getSegmentLinks();
    const remaining = links.filter((link) => link.id !== id);
    if (remaining.length === links.length) return { ok: true };
    setPrMetadata(seq.projectItem, [
      {
        fieldName: SEGMENT_LINKS_FIELD,
        fieldId: SEGMENT_LINKS_FIELD_ID,
        value: JSON.stringify(remaining),
      },
    ]);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
};

/** The current sequence In/Out, in seconds from its start. */
export const getInOut = (): { inPoint: number; outPoint: number } | null => {
  const seq = activeSequence();
  if (!seq) return null;
  try {
    const inTime = seq.getInPointAsTime();
    const outTime = seq.getOutPointAsTime();
    return { inPoint: inTime.seconds, outPoint: outTime.seconds };
  } catch (e) {
    return null;
  }
};

// -- export to Media Encoder --------------------------------------------------

let encoderBound = false;

/** Forwards AME job events to the panel so it can upload when the render lands. */
const bindEncoder = () => {
  if (encoderBound) return;
  //@ts-ignore — `encoder` is missing from the shipped Premiere typings
  const encoder = app.encoder;
  if (!encoder || !encoder.bind) return;
  encoder.bind("onEncoderJobComplete", (jobID: string, outputFilePath: string) => {
    dispatchTS("encodeComplete", { jobID: String(jobID), outputPath: String(outputFilePath) });
  });
  encoder.bind("onEncoderJobError", (jobID: string, message: string) => {
    dispatchTS("encodeError", { jobID: String(jobID), message: String(message) });
  });
  encoder.bind("onEncoderJobProgress", (jobID: string, progress: number) => {
    dispatchTS("encodeProgress", { jobID: String(jobID), progress: Number(progress) });
  });
  encoderBound = true;
};

export interface EncodeResult {
  ok: boolean;
  error?: string;
  jobID?: string;
  outputPath?: string;
}

/**
 * Queues the active sequence in Media Encoder.
 * `presetPath` is an .epr file chosen in the export dialog; `workArea` is 0
 * (entire sequence) or 1 (in/out points).
 */
export const encodeActiveSequence = (
  presetPath: string,
  outputPath: string,
  workArea: number
): EncodeResult => {
  const seq = activeSequence();
  if (!seq) return { ok: false, error: "no_sequence" };
  //@ts-ignore
  const encoder = app.encoder;
  if (!encoder) return { ok: false, error: "no_encoder" };
  try {
    bindEncoder();
    encoder.setEmbeddedXMPEnabled(false);
    encoder.setSidecarXMPEnabled(false);
    encoder.launchEncoder();
    const jobID = encoder.encodeSequence(
      seq,
      outputPath,
      presetPath,
      workArea,
      0 /* removeUponCompletion */
    );
    if (!jobID) return { ok: false, error: "encode_rejected" };
    encoder.startBatch();
    return { ok: true, jobID: String(jobID), outputPath: outputPath };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
};

/**
 * Renders inside Premiere instead of handing the job to Media Encoder.
 *
 * This blocks the ExtendScript engine until the render finishes — Premiere
 * shows its own progress and the panel gets no progress events — but it needs
 * no second application, and the file is on disk when this returns.
 */
export const renderInPremiere = (
  presetPath: string,
  outputPath: string,
  workArea: number
): EncodeResult => {
  const seq = activeSequence();
  if (!seq) return { ok: false, error: "no_sequence" };
  try {
    const result = seq.exportAsMediaDirect(outputPath, presetPath, workArea);
    // Premiere returns a status string; anything but "0" is a failure code.
    if (result && String(result) !== "0" && String(result) !== "undefined") {
      return { ok: false, error: String(result) };
    }
    return { ok: true, outputPath: outputPath };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
};

/** Directory Premiere can safely write renders into, used as the export default. */
export const getScratchPath = (): string => {
  try {
    if (app.project && app.project.path) {
      return new File(app.project.path).parent.fsName;
    }
  } catch (e) {}
  return Folder.temp.fsName;
};
