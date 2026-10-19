import { describe, it, expect, vi } from 'vitest'
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

function Harness({ project }: { project: Project }) {
  return (
    <ProjectSettingsDialog
      project={project}
      open
      onOpenChange={() => {}}
      onUpdated={() => {}}
    />
  )
}

describe('ProjectSettingsDialog', () => {
  it('keeps unsaved edits and the chosen poster when the project object is refreshed', () => {
    const { rerender } = render(<Harness project={base} />)

    const nameInput = screen.getByDisplayValue('Original') as HTMLInputElement
    fireEvent.change(nameInput, { target: { value: 'Edited name' } })

    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement
    const file = new File(['img'], 'poster.jpg', { type: 'image/jpeg' })
    // jsdom has no object URL support, so stub it for the preview.
    URL.createObjectURL = vi.fn(() => 'blob:poster-preview')
    fireEvent.change(fileInput, { target: { files: [file] } })
    expect(screen.getByAltText('Poster')).toBeTruthy()

    // Same project, new object identity, as after an SWR revalidation.
    rerender(<Harness project={{ ...base }} />)

    expect((screen.getByDisplayValue('Edited name') as HTMLInputElement).value).toBe('Edited name')
    expect(screen.getByAltText('Poster').getAttribute('src')).toBe('blob:poster-preview')
  })
})
