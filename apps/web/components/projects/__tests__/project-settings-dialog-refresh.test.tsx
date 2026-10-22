import { afterEach, describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { ProjectSettingsDialog } from '../project-settings-dialog'
import type { Project } from '@/types'

// The projects page refetches its list on window focus, which hands every
// card a new project object with the same content. An open settings dialog
// must keep the user's unsaved edits and chosen poster across that refresh.

const base: Project = {
  id: 'p1',
  name: 'Original',
  description: 'desc',
  is_public: false,
  poster_url: null,
} as unknown as Project

function Harness({ project, open = true }: { project: Project; open?: boolean }) {
  return (
    <ProjectSettingsDialog
      project={project}
      open={open}
      onOpenChange={() => {}}
      onUpdated={() => {}}
    />
  )
}

describe('ProjectSettingsDialog', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('keeps unsaved edits and the chosen poster when the project object is refreshed', () => {
    const { rerender } = render(<Harness project={base} />)

    const nameInput = screen.getByDisplayValue('Original') as HTMLInputElement
    fireEvent.change(nameInput, { target: { value: 'Edited name' } })

    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement
    const file = new File(['img'], 'poster.jpg', { type: 'image/jpeg' })
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:poster-preview')
    fireEvent.change(fileInput, { target: { files: [file] } })
    expect(screen.getByAltText('Poster')).toBeTruthy()

    // Same project, new object identity, as after an SWR revalidation.
    rerender(<Harness project={{ ...base }} />)

    expect((screen.getByDisplayValue('Edited name') as HTMLInputElement).value).toBe('Edited name')
    expect(screen.getByAltText('Poster').getAttribute('src')).toBe('blob:poster-preview')
  })

  it('resets unsaved edits and poster selection when reopened', () => {
    const { rerender } = render(<Harness project={base} />)

    fireEvent.change(screen.getByDisplayValue('Original'), {
      target: { value: 'Edited name' },
    })
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:poster-preview')
    fireEvent.change(document.querySelector('input[type="file"]') as HTMLInputElement, {
      target: { files: [new File(['img'], 'poster.jpg', { type: 'image/jpeg' })] },
    })
    expect(screen.getByAltText('Poster')).toBeTruthy()

    rerender(<Harness project={base} open={false} />)
    rerender(<Harness project={base} open />)

    expect(screen.getByDisplayValue('Original')).toBeTruthy()
    expect(screen.queryByAltText('Poster')).toBeNull()
  })
})
