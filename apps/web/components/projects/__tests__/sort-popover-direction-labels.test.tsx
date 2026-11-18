import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { SortPopover, SortPopoverView, dateDirectionLabels, type SortOption } from '../sort-popover'
import { useViewStore } from '@/stores/view-store'

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

// The in-project menu itself, wired to the real view store, not just the view.
describe('SortPopover inside a project', () => {
  beforeEach(() => {
    useViewStore.setState({ sortKey: 'date', sortDirection: 'desc' })
  })

  function menuItem(label: string) {
    return screen.getByRole('button', { name: new RegExp(`^${label}`) })
  }

  it('labels the date direction Newest and Oldest as it is flipped', () => {
    render(<SortPopover />)
    fireEvent.click(screen.getByRole('button', { name: /sorted by/i }))

    expect(menuItem('Date')).toHaveTextContent('Newest')
    fireEvent.click(menuItem('Date'))
    expect(useViewStore.getState().sortDirection).toBe('asc')
    expect(menuItem('Date')).toHaveTextContent('Oldest')
  })

  it('starts Name at A-Z after a newest-first date sort, and Date back at Newest', () => {
    render(<SortPopover />)
    fireEvent.click(screen.getByRole('button', { name: /sorted by/i }))

    fireEvent.click(menuItem('Name'))
    expect(menuItem('Name')).toHaveTextContent('A-Z')

    fireEvent.click(menuItem('Date'))
    expect(menuItem('Date')).toHaveTextContent('Newest')
  })
})
