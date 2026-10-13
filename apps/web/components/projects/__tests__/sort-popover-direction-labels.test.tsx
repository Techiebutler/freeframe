import { describe, it, expect } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { SortPopoverView, dateDirectionLabels, type SortOption } from '../sort-popover'

type Key = 'date' | 'name'
const options: SortOption<Key>[] = [
  { value: 'date', label: 'Date', directionLabels: dateDirectionLabels },
  { value: 'name', label: 'Name' },
]

function open(sortKey: Key, sortDirection: 'asc' | 'desc') {
  render(
    <SortPopoverView
      options={options}
      sortKey={sortKey}
      sortDirection={sortDirection}
      onSortKeyChange={() => {}}
      onToggleDirection={() => {}}
    />,
  )
  fireEvent.click(screen.getByRole('button', { name: /sorted by/i }))
}

describe('SortPopoverView direction labels', () => {
  it('reads a newest-first date sort as Newest', () => {
    open('date', 'desc')
    expect(screen.getByText('Newest')).toBeInTheDocument()
    expect(screen.queryByText('Z-A')).not.toBeInTheDocument()
  })

  it('reads an oldest-first date sort as Oldest', () => {
    open('date', 'asc')
    expect(screen.getByText('Oldest')).toBeInTheDocument()
  })

  it('keeps A-Z / Z-A for alphabetical sorts', () => {
    open('name', 'asc')
    expect(screen.getByText('A-Z')).toBeInTheDocument()
  })
})
