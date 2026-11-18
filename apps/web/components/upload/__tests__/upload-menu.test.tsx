/**
 * The project page's Upload button: a menu of Upload files and Upload folder.
 *
 * The two file inputs must live outside the menu's content. Radix unmounts the
 * content when the menu closes, which happens as the item is chosen, so an
 * input inside it would be gone by the time the system file dialog answers and
 * the pick would be lost.
 */
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { UploadMenu } from '../upload-menu'
import type { Collected } from '@/lib/upload-folder-walk'

function renderMenu(onPick = vi.fn()) {
  render(<UploadMenu onPick={onPick} trigger={<button>Upload</button>} />)
  return onPick
}

const filesInput = () => screen.getByTestId('upload-files-input') as HTMLInputElement
const folderInput = () => screen.getByTestId('upload-folder-input') as HTMLInputElement

function pick(input: HTMLInputElement, files: File[]) {
  Object.defineProperty(input, 'files', { value: files, configurable: true })
  fireEvent.change(input)
}

describe('UploadMenu', () => {
  it('offers Upload files and Upload folder', async () => {
    renderMenu()

    await userEvent.click(screen.getByRole('button', { name: 'Upload' }))

    expect(screen.getByRole('menuitem', { name: /Upload files/ })).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: /Upload folder/ })).toBeInTheDocument()
  })

  it('keeps both inputs mounted while the menu is closed', async () => {
    renderMenu()
    expect(filesInput()).toBeInTheDocument()
    expect(folderInput()).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'Upload' }))
    const menu = screen.getByRole('menu')
    expect(menu.contains(filesInput())).toBe(false)
    expect(menu.contains(folderInput())).toBe(false)
  })

  it('opens the folder picker from Upload folder, and the file picker from Upload files', async () => {
    renderMenu()
    const folderClick = vi.spyOn(folderInput(), 'click')
    const filesClick = vi.spyOn(filesInput(), 'click')

    await userEvent.click(screen.getByRole('button', { name: 'Upload' }))
    await userEvent.click(screen.getByRole('menuitem', { name: /Upload folder/ }))
    expect(folderClick).toHaveBeenCalledTimes(1)
    // The menu closed as the item was chosen; the input it opens is still here.
    expect(screen.queryByRole('menu')).toBeNull()
    expect(folderInput()).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'Upload' }))
    await userEvent.click(screen.getByRole('menuitem', { name: /Upload files/ }))
    expect(filesClick).toHaveBeenCalledTimes(1)
  })

  it('makes the folder input a directory picker and the files input a multiple picker', () => {
    renderMenu()

    expect(folderInput().hasAttribute('webkitdirectory')).toBe(true)
    expect(folderInput().hasAttribute('directory')).toBe(true)
    expect(filesInput().multiple).toBe(true)
    expect(filesInput().hasAttribute('webkitdirectory')).toBe(false)
  })

  it('hands a picked folder on with each file’s folders, and resets the input', () => {
    const onPick = renderMenu()
    const a = new File([new Uint8Array(1)], 'a.mov')
    Object.defineProperty(a, 'webkitRelativePath', { value: 'Shoot/Day 1/a.mov' })
    const input = folderInput()
    input.value = ''
    const reset = vi.spyOn(input, 'value', 'set')

    pick(input, [a])

    expect(onPick).toHaveBeenCalledTimes(1)
    const collected = onPick.mock.calls[0][0] as Collected
    expect(collected.files).toEqual([{ file: a, dirs: ['Shoot', 'Day 1'] }])
    // Picking the same folder again has to fire `change` again.
    expect(reset).toHaveBeenCalledWith('')
  })

  it('hands picked files on as loose files', () => {
    const onPick = renderMenu()
    const a = new File([new Uint8Array(1)], 'a.mov')

    pick(filesInput(), [a])

    expect((onPick.mock.calls[0][0] as Collected).files).toEqual([{ file: a, dirs: [] }])
  })

  it('hands on nothing when the picker was cancelled', () => {
    const onPick = renderMenu()

    pick(filesInput(), [])

    expect(onPick).not.toHaveBeenCalled()
  })
})
