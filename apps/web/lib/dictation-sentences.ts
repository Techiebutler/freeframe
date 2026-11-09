import type { DictationSegment } from './agents'

// Whole spoken sentences out of a Whisper result. Segments are acoustic chunks, not sentences: a long sentence spans
// several, a short pause makes a new one. Segment text carries the punctuation, word timestamps carry the exact times.

export interface DictationWord { start: number; end: number; word: string }
export interface Sentence { /** Seconds into the recording when the first word was said. */ start: number; end: number; text: string }

/** A pause longer than this between two words ends the sentence even without punctuation. */
export const PAUSE_S = 1.5
const ABBREVIATIONS = new Set(['z.b.', 'd.h.', 'bzw.', 'ca.', 'usw.', 'etc.', 'nr.', 'vs.', 'u.a.', 'z.t.', 'evtl.', 'ggf.', 'inkl.', 'max.', 'min.', 'sek.', 'dr.', 'e.g.', 'i.e.'])
const norm = (s: string) => s.toLowerCase().replace(/[.,;:!?"'„“”‚‘’»«()[\]…–—-]/g, '')

interface Token { text: string; start: number; end: number }

/** True when the token closes a sentence: ends in . ? ! … but is not an abbreviation (z.B.) or an ordinal (3.). */
function endsSentence(t: string): boolean {
  const bare = t.replace(/["'”“»«)\]]+$/, '')
  if (!/[.?!…]$/.test(bare)) return false
  if (/[?!…]$/.test(bare)) return true
  const lower = bare.toLowerCase()
  return !(ABBREVIATIONS.has(lower) || /^\d+\.$/.test(bare) || /^([A-Za-zÄÖÜäöüß]\.){2,}$/.test(bare))
}

/** Tokens with times: each token of the segment text is matched forward against the word list; unmatched ones are spread over their segment. */
function tokenise(segments: DictationSegment[], words: DictationWord[]): Token[] {
  const out: Token[] = []
  let j = 0
  const spoken = segments.filter(s => s.text.trim())
  const sourceSegments: DictationSegment[] = spoken.length ? spoken : words.length ? [{ start: words[0].start, end: words[words.length - 1].end, text: words.map(w => w.word.trim()).join(' ') }] : []
  for (const seg of sourceSegments) {
    const toks = seg.text.trim().split(/\s+/)
    const total = toks.reduce((n, t) => n + t.length + 1, 0)
    let at = 0
    for (const t of toks) {
      const guess = { start: seg.start + (at / total) * (seg.end - seg.start), end: seg.start + ((at + t.length) / total) * (seg.end - seg.start) }
      at += t.length + 1
      const n = norm(t)
      let hit: { start: number; end: number; next: number } | null = null
      for (let i = j; n && i < Math.min(words.length, j + 4) && !hit; i++) {
        if (norm(words[i].word) === n) hit = { start: words[i].start, end: words[i].end, next: i + 1 }
        else if (i + 1 < words.length && norm(words[i].word + words[i + 1].word) === n) hit = { start: words[i].start, end: words[i + 1].end, next: i + 2 }
        else if (i + 2 < words.length && norm(words[i].word + words[i + 1].word + words[i + 2].word) === n) hit = { start: words[i].start, end: words[i + 2].end, next: i + 3 }
      }
      if (hit) { out.push({ text: t, start: hit.start, end: hit.end }); j = hit.next }
      else out.push({ text: t, ...guess })
    }
  }
  return out
}

/** Whole sentences in speaking order. A sentence ends at . ? ! or a pause over PAUSE_S; it is never cut anywhere else. */
export function sentencesFromDictation(segments: DictationSegment[], words: DictationWord[] = []): Sentence[] {
  const tokens = tokenise(segments, words)
  const out: Sentence[] = []
  let cur: Token[] = []
  const flush = () => {
    if (!cur.length) return
    out.push({ start: cur[0].start, end: cur[cur.length - 1].end, text: cur.map(t => t.text).join(' ') })
    cur = []
  }
  tokens.forEach((t, i) => {
    cur.push(t)
    const next = tokens[i + 1]
    if (endsSentence(t.text) || (next && next.start - t.end > PAUSE_S)) flush()
  })
  flush()
  return out
}
