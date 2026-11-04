import { afterEach, describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { api } from '@/lib/api'
import { ConnectTelegram } from '../connect-telegram'

afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('ConnectTelegram', () => {
  it('requests a link and opens the returned url', async () => {
    const post = vi.spyOn(api, 'post').mockResolvedValue({ url: 'https://t.me/bot?start=abc' })
    const open = vi.spyOn(window, 'open').mockReturnValue(null)
    render(<ConnectTelegram />)
    fireEvent.click(screen.getByRole('button', { name: 'Connect Telegram' }))
    expect(await screen.findByRole('link', { name: 'open Telegram' })).toHaveAttribute('href', 'https://t.me/bot?start=abc')
    expect(post).toHaveBeenCalledWith('/me/telegram/link')
    expect(open).toHaveBeenCalledWith('https://t.me/bot?start=abc', '_blank', 'noopener,noreferrer')
  })
  it('shows an error and keeps the button on failure', async () => {
    vi.spyOn(api, 'post').mockRejectedValue(new Error('x'))
    render(<ConnectTelegram />)
    fireEvent.click(screen.getByRole('button', { name: 'Connect Telegram' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/could not start/i)
    expect(screen.getByRole('button', { name: 'Connect Telegram' })).toBeEnabled()
  })
  it('shows Connected when a chat is already linked', () => {
    render(<ConnectTelegram connected />)
    expect(screen.getByText('Connected')).toBeInTheDocument()
  })
})
