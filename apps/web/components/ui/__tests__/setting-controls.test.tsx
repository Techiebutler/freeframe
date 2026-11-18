import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { SegmentRow, SelectRow, ToggleRow } from '../setting-controls'

// Shared by the folder Appearance popover and a share link's Appearance
// block, so assistive tech gets the state and names in both.

describe('setting controls', () => {
  it('a segment is a named group whose current option is pressed', () => {
    const onChange = vi.fn()
    render(
      <SegmentRow
        label="Card Size"
        options={[{ value: 's', label: 'S' }, { value: 'm', label: 'M' }]}
        value="m"
        onChange={onChange}
      />,
    )
    expect(screen.getByRole('group', { name: 'Card Size' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'M' }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByRole('button', { name: 'S' }).getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(screen.getByRole('button', { name: 'S' }))
    expect(onChange).toHaveBeenCalledWith('s')
  })

  it('a toggle row names its switch by its label and description', () => {
    render(
      <ToggleRow label="Watermark" description="Overlay watermark" checked={false} onCheckedChange={() => {}} />,
    )
    const sw = screen.getByRole('switch', { name: 'Watermark' })
    expect(sw.getAttribute('aria-describedby')).toBeTruthy()
    expect(sw.className).toContain('focus-visible:ring-2')
  })

  it('a select row labels its select and shows a focus ring', () => {
    render(
      <SelectRow
        label="Sort By"
        value="name"
        options={[{ value: 'name', label: 'Name' }]}
        onChange={() => {}}
      />,
    )
    expect(screen.getByLabelText('Sort By').className).toContain('focus-visible:ring-2')
  })
})
