/**
 * Decide what timecode (if any) a submitted comment should carry.
 *
 * Rules:
 * - Non-timed media (images) never carries a timecode.
 * - A timecode that is attached (the user left the clock toggle on) is
 *   always included, INCLUDING 0 — 0:00 is a valid, meaningful video time
 *   and must never be silently dropped just because it's falsy.
 * - A drawing (Fabric annotation) is frame-anchored: if the submit carries
 *   an annotation payload, the timecode is force-included even when the
 *   user detached the clock toggle, because a comment with a drawing but
 *   no timecode on timed media is never valid.
 */
export interface ResolveSubmitTimecodeArgs {
  /** Asset supports timecodes at all (video/audio). */
  hasTimecode: boolean;
  /** User has the clock toggle attached. */
  timecodeAttached: boolean;
  /** This submit carries an annotation (drawing) payload. */
  hasAnnotation: boolean;
  /** Current playhead position in seconds. */
  playheadTime: number;
}

export function resolveSubmitTimecode({
  hasTimecode,
  timecodeAttached,
  hasAnnotation,
  playheadTime,
}: ResolveSubmitTimecodeArgs): number | undefined {
  if (!hasTimecode) return undefined;
  if (timecodeAttached || hasAnnotation) return playheadTime;
  return undefined;
}
