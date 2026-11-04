import { afterEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor, fireEvent, cleanup } from '@testing-library/react'
import { api, ApiError } from '@/lib/api'
import { SendToAgent } from '../send-to-agent'

const agents = [{ user_id: 'u1', name: 'Claude Code', program: 'claude-code' }]
const round = { round_id: 'rd1', files: [{ comments: [{}, {}] }, { comments: [{}] }] }
afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('SendToAgent', () => {
  it('closes the round, confirms with agent and count, then offers rules one tap each', async () => {
    const post = vi.spyOn(api, 'post').mockImplementation(async (p: string) => (p.endsWith('/close') ? round : undefined) as never)
    vi.spyOn(api, 'get').mockResolvedValue([{ suggestion_id: 's1', text: 'Hook within 2 seconds', comment_id: 'c1' }])
    render(<SendToAgent requestId="rq1" agents={agents} />)
    fireEvent.click(screen.getByRole('button', { name: /send to agent/i }))
    expect(await screen.findByText('Sent to Claude Code · 3 comments')).toBeInTheDocument()
    expect(post).toHaveBeenCalledWith('/requests/rq1/feedback-rounds/close', { reason: 'button' })
    expect(await screen.findByText('Remember as rules?')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /remember: hook within 2 seconds/i }))
    await waitFor(() => expect(post).toHaveBeenCalledWith('/feedback-rounds/rd1/rule-suggestions/s1/accept'))
    expect(await screen.findByText('Remembered')).toBeInTheDocument()
  })

  it('skips the rules sheet when there are no suggestions', async () => {
    vi.spyOn(api, 'post').mockResolvedValue(round as never)
    vi.spyOn(api, 'get').mockResolvedValue([])
    render(<SendToAgent requestId="rq1" agents={agents} />)
    fireEvent.click(screen.getByRole('button', { name: /send to agent/i }))
    await screen.findByText(/Sent to Claude Code/)
    expect(screen.queryByText('Remember as rules?')).not.toBeInTheDocument()
  })

  it('explains a 409 and keeps the button', async () => {
    vi.spyOn(api, 'post').mockRejectedValue(new ApiError(409, 'no_open_round'))
    render(<SendToAgent requestId="rq1" agents={agents} />)
    fireEvent.click(screen.getByRole('button', { name: /send to agent/i }))
    expect(await screen.findByRole('alert')).toHaveTextContent('No new comments to send yet.')
    expect(screen.getByRole('button', { name: /send to agent/i })).toBeEnabled()
  })
})
