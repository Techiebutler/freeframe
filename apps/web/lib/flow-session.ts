// What happened in this visit, for the closing moment ("All done · 7 approved, 3 with feedback"). Memory only: a new visit starts fresh.

interface Session { approved: Set<string>; feedback: Set<string> }
const sessions = new Map<string, Session>()
const get = (key: string) => { let s = sessions.get(key); if (!s) { s = { approved: new Set(), feedback: new Set() }; sessions.set(key, s) } return s }

export const markApproved = (key: string, assetId: string) => { get(key).approved.add(assetId) }
export const unmarkApproved = (key: string, assetId: string) => { get(key).approved.delete(assetId) }
export const markFeedback = (key: string, assetId: string) => { get(key).feedback.add(assetId) }
export const sessionSummary = (key: string) => { const s = get(key); return { approved: s.approved.size, feedback: s.feedback.size } }
export const resetSession = (key?: string) => { if (key) sessions.delete(key); else sessions.clear() }

export function doneLine(s: { approved: number; feedback: number }): string {
  const parts = [s.approved > 0 && `${s.approved} approved`, s.feedback > 0 && `${s.feedback} with feedback`].filter(Boolean)
  return parts.length ? `All done · ${parts.join(', ')}` : 'All done'
}
export function sentLine(notes: number, agent: boolean): string {
  const n = `${notes} ${notes === 1 ? 'note' : 'notes'}`
  return agent ? `${n} with the agent · it replies with the next version` : `${n} sent`
}
