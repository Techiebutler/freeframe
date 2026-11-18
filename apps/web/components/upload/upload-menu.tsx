'use client'

/**
 * The Upload button's menu: Upload files and Upload folder. What is picked
 * starts at once, as a drop does, with no dialog in between: each asset is
 * named after its file, and a picked folder's folders are made again under the
 * folder on screen.
 *
 * The two inputs live outside the menu's content. Radix unmounts the content
 * when the menu closes, which it does as an item is chosen, and an input that
 * went with it would not be there to report the pick when the system's file
 * dialog closes.
 */
import * as React from 'react'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { FileUp, FolderUp } from 'lucide-react'

import { MenuItem, menuContentClass, menuItemClass } from '@/components/shared/item-menu'
import { collectInputFiles, type Collected } from '@/lib/upload-folder-walk'

/** Not in React's input typings. `webkitdirectory` turns the picker into a
 *  folder picker in every browser the app supports; `directory` is the
 *  unprefixed spelling some have read. */
const FOLDER_PICKER = { webkitdirectory: '', directory: '' } as React.InputHTMLAttributes<HTMLInputElement>

export function UploadMenu({
  onPick,
  trigger,
  open,
  onOpenChange,
}: {
  /** What was picked, each file with its folders inside a picked folder. */
  onPick: (picked: Collected) => void
  /** The button that opens the menu. */
  trigger: React.ReactNode
  /** Controlled, for a page that opens the menu from elsewhere too. */
  open?: boolean
  onOpenChange?: (open: boolean) => void
}) {
  const filesInput = React.useRef<HTMLInputElement>(null)
  const folderInput = React.useRef<HTMLInputElement>(null)

  const picked = (e: React.ChangeEvent<HTMLInputElement>) => {
    const input = e.currentTarget
    const list = input.files
    if (list && list.length > 0) onPick(collectInputFiles(list))
    // Without this, picking the same files or folder again fires no change.
    input.value = ''
  }

  return (
    <>
      <DropdownMenu.Root open={open} onOpenChange={onOpenChange}>
        <DropdownMenu.Trigger asChild>{trigger}</DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content align="end" sideOffset={6} className={menuContentClass}>
            <MenuItem className={menuItemClass} onSelect={() => filesInput.current?.click()}>
              <FileUp className="h-4 w-4" />
              Upload files
            </MenuItem>
            <MenuItem className={menuItemClass} onSelect={() => folderInput.current?.click()}>
              <FolderUp className="h-4 w-4" />
              Upload folder
            </MenuItem>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
      <input
        ref={filesInput}
        type="file"
        multiple
        accept="video/*,audio/*,image/*"
        className="hidden"
        tabIndex={-1}
        aria-hidden="true"
        data-testid="upload-files-input"
        onChange={picked}
      />
      <input
        ref={folderInput}
        type="file"
        {...FOLDER_PICKER}
        className="hidden"
        tabIndex={-1}
        aria-hidden="true"
        data-testid="upload-folder-input"
        onChange={picked}
      />
    </>
  )
}
