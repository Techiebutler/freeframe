import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, within } from '@testing-library/react'
import { useReviewStore } from '@/stores/review-store'
import { CommentPanel } from '../comment-panel'

beforeEach(() => {
  useReviewStore.getState().reset()
  Element.prototype.scrollIntoView = vi.fn()
})

const noop = async () => {}

function makeComment(over: Record<string, unknown>) {
  return {
    id: over.id, asset_id: 'a1', version_id: 'v1', parent_id: null,
    author: { id: 'u1', name: 'Maya Chen', avatar_url: null },
    timecode_end: null, resolved: false, visibility: 'public',
    updated_at: new Date().toISOString(),
    replies: [], reactions: [], attachments: [],
    ...over,
  } as never
}

// created 10:00, tc=26 / created 10:30, tc=None / created 11:00, tc=3
const c26 = makeComment({
  id: 'c26', body: 'Comment Alpha tc26',
  timecode_start: 26, created_at: '2026-01-01T10:00:00.000Z',
})
const cNone = makeComment({
  id: 'cNone', body: 'Comment Beta noTc',
  timecode_start: null, created_at: '2026-01-01T10:30:00.000Z',
})
const c3 = makeComment({
  id: 'c3', body: 'Comment Gamma tc3',
  timecode_start: 3, created_at: '2026-01-01T11:00:00.000Z',
})

function renderPanel() {
  return render(
    <CommentPanel
      comments={[c26, cNone, c3]}
      onResolve={noop} onDelete={noop}
      onAddReaction={noop} onRemoveReaction={noop}
      onReply={() => {}}
    />,
  )
}

function bodyOrder() {
  return screen.getAllByText(/^Comment /).map((el) => el.textContent)
}

function openSortMenu() {
  fireEvent.click(screen.getByTitle('Sort'))
}

describe('CommentPanel sort modes', () => {
  it('menu offers Timecode (Default), Oldest, Newest, Commenter, Completed — in that order', () => {
    renderPanel()
    openSortMenu()
    const menu = screen.getByText('Sort thread by...').parentElement as HTMLElement
    const labels = within(menu)
      .getAllByRole('button')
      .map((b) => b.textContent)
    expect(labels).toEqual([
      'Timecode (Default)',
      'Oldest',
      'Newest',
      'Commenter',
      'Completed',
    ])
  })

  it('defaults to timecode order: timecoded ascending, then untimecoded last', () => {
    renderPanel()
    expect(bodyOrder()).toEqual([
      'Comment Gamma tc3',
      'Comment Alpha tc26',
      'Comment Beta noTc',
    ])
  })

  it('"Oldest" sorts by created_at ascending', () => {
    renderPanel()
    openSortMenu()
    fireEvent.click(screen.getByText('Oldest'))
    expect(bodyOrder()).toEqual([
      'Comment Alpha tc26',
      'Comment Beta noTc',
      'Comment Gamma tc3',
    ])
  })

  it('"Newest" sorts by created_at descending', () => {
    renderPanel()
    openSortMenu()
    fireEvent.click(screen.getByText('Newest'))
    expect(bodyOrder()).toEqual([
      'Comment Gamma tc3',
      'Comment Beta noTc',
      'Comment Alpha tc26',
    ])
  })
})
