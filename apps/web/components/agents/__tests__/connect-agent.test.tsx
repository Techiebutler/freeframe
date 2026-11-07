import { afterEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor, fireEvent, cleanup } from '@testing-library/react'
import { SWRConfig } from 'swr'
import { api } from '@/lib/api'
import { ConnectAgent } from '../connect-agent'

const agents = [
  { user_id: 'u1', name: 'Hermes (hermes)', program: 'hermes', agent_name: 'Hermes Box', created_at: '2026-11-01T00:00:00Z', last_used_at: null, revoked: false },
  { user_id: 'u2', name: 'Old (codex)', program: 'codex', agent_name: 'Old', created_at: '2026-11-01T00:00:00Z', last_used_at: null, revoked: true },
]
function mock() {
  vi.spyOn(api, 'get').mockImplementation(async (p: string) => (p.endsWith('/agents') ? agents : { agents_may_approve: false }) as never)
}
const wrap = () => render(<SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}><ConnectAgent projectId="p1" /></SWRConfig>)
afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('ConnectAgent', () => {
  it('generates a code and shows the copy block with countdown', async () => {
    mock()
    const post = vi.spyOn(api, 'post').mockResolvedValue({ code: 'ABCD2345', expires_at: new Date(Date.now() + 900_000).toISOString() })
    wrap()
    fireEvent.click(await screen.findByRole('button', { name: /create pairing code/i }))
    expect(await screen.findByText('ABCD2345')).toBeInTheDocument()
    expect(post).toHaveBeenCalledWith('/projects/p1/agent-pairing-codes')
    expect(screen.getByText('Pair with AutoReview: ABCD2345')).toBeInTheDocument()
    expect(screen.getByText(/Pair with code ABCD2345/)).toBeInTheDocument() // folded MCP path for Codex/Hermes
    expect(screen.getByRole('timer')).toHaveTextContent(/Expires in 1[45]:\d\d/)
  })

  it('copies the one kit line, not the MCP block', async () => {
    mock()
    vi.spyOn(api, 'post').mockResolvedValue({ code: 'ABCD2345', expires_at: new Date(Date.now() + 900_000).toISOString() })
    const write = vi.fn().mockResolvedValue(undefined)
    Object.assign(navigator, { clipboard: { writeText: write } })
    wrap()
    fireEvent.click(await screen.findByRole('button', { name: /create pairing code/i }))
    fireEvent.click(await screen.findByRole('button', { name: /^copy$/i }))
    await waitFor(() => expect(write).toHaveBeenCalledWith('Pair with AutoReview: ABCD2345'))
  })

  it('lists only active agents with a program badge and revokes after confirm', async () => {
    mock()
    const del = vi.spyOn(api, 'delete').mockResolvedValue(undefined)
    wrap()
    expect((await screen.findAllByText('Hermes Box')).length).toBeGreaterThan(0)
    expect(screen.getByText('Hermes')).toBeInTheDocument()
    expect(screen.queryByText('Old')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /revoke hermes box/i }))
    expect(del).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: /revoke access/i }))
    await waitFor(() => expect(del).toHaveBeenCalledWith('/projects/p1/agents/u1'))
  })

  it('"Agents may approve" starts off and saves on toggle', async () => {
    mock()
    const patch = vi.spyOn(api, 'patch').mockResolvedValue({})
    wrap()
    const sw = await screen.findByRole('switch', { name: /agents may approve/i })
    expect(sw).toHaveAttribute('aria-checked', 'false')
    fireEvent.click(sw)
    await waitFor(() => expect(patch).toHaveBeenCalledWith('/projects/p1', { agents_may_approve: true }))
  })

  it('shows an error and keeps the button when code creation fails', async () => {
    mock()
    vi.spyOn(api, 'post').mockRejectedValue(new Error('x'))
    wrap()
    fireEvent.click(await screen.findByRole('button', { name: /create pairing code/i }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/could not create a code/i)
    expect(screen.getByRole('button', { name: /create pairing code/i })).toBeInTheDocument()
  })

  it('Agents page: creates a read key for ChatGPT, shows it once in the prompt, copies it', async () => {
    mock()
    const reply = { agent_key: 'ara_test_0123456789', user_id: 'u9', project_id: 'p1', project_name: 'Brand A', scope: 'read' }
    const post = vi.spyOn(api, 'post').mockResolvedValue(reply)
    const write = vi.fn().mockResolvedValue(undefined)
    Object.assign(navigator, { clipboard: { writeText: write } })
    wrap()
    fireEvent.click(await screen.findByRole('radio', { name: 'ChatGPT' }))
    fireEvent.click(screen.getByRole('radio', { name: /read only/i }))
    fireEvent.click(screen.getByRole('button', { name: /create key/i }))
    expect(post).toHaveBeenCalledWith('/projects/p1/agent-keys', { program: 'chatgpt', agent_name: 'ChatGPT', scope: 'read' })
    const prompt = await screen.findByTestId('agent-prompt')
    expect(prompt).toHaveTextContent('https://review.aditor.ai/agent.md')
    expect(prompt).toHaveTextContent('ara_test_0123456789')
    expect(screen.getByText(/Authorization: Bearer ara_test_0123456789/)).toBeInTheDocument() // connector settings line
    fireEvent.click(screen.getByRole('button', { name: /copy prompt/i }))
    await waitFor(() => expect(write).toHaveBeenCalledWith(expect.stringContaining('ara_test_0123456789')))
    fireEvent.click(screen.getByRole('button', { name: /^done$/i }))
    expect(screen.queryByText(/ara_test_0123456789/)).not.toBeInTheDocument()
  })
})
