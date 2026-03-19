'use client'

import * as React from 'react'
import { Command } from 'cmdk'
import * as Dialog from '@radix-ui/react-dialog'
import { useRouter } from 'next/navigation'
import {
  LayoutDashboard,
  Layers,
  FolderOpen,
  Settings,
  Bell,
  FolderPlus,
  Upload,
} from 'lucide-react'
import { cn } from '@/lib/utils'

interface CommandPaletteProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

interface CommandItem {
  id: string
  label: string
  icon: React.ElementType
  href?: string
  action?: () => void
  shortcut?: string
  group: 'navigation' | 'actions'
}

export function CommandPalette({ open, onOpenChange }: CommandPaletteProps) {
  const router = useRouter()

  const items: CommandItem[] = [
    {
      id: 'home',
      label: 'Home',
      icon: LayoutDashboard,
      href: '/',
      group: 'navigation',
      shortcut: 'G H',
    },
    {
      id: 'projects',
      label: 'Projects',
      icon: Layers,
      href: '/projects',
      group: 'navigation',
      shortcut: 'G P',
    },
    {
      id: 'assets',
      label: 'My Assets',
      icon: FolderOpen,
      href: '/assets',
      group: 'navigation',
      shortcut: 'G A',
    },
    {
      id: 'notifications',
      label: 'Notifications',
      icon: Bell,
      href: '/notifications',
      group: 'navigation',
    },
    {
      id: 'settings',
      label: 'Settings',
      icon: Settings,
      href: '/settings',
      group: 'navigation',
    },
    {
      id: 'new-project',
      label: 'New Project',
      icon: FolderPlus,
      href: '/projects/new',
      group: 'actions',
      shortcut: 'N P',
    },
    {
      id: 'upload-asset',
      label: 'Upload Asset',
      icon: Upload,
      href: '/assets/upload',
      group: 'actions',
      shortcut: 'N A',
    },
  ]

  function handleSelect(item: CommandItem) {
    onOpenChange(false)
    if (item.action) {
      item.action()
    } else if (item.href) {
      router.push(item.href)
    }
  }

  const navItems = items.filter((i) => i.group === 'navigation')
  const actionItems = items.filter((i) => i.group === 'actions')

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm data-[state=open]:animate-fade-in" />
        <Dialog.Content className="fixed left-1/2 top-[20%] z-50 w-full max-w-lg -translate-x-1/2 data-[state=open]:animate-slide-down">
          <Dialog.Title className="sr-only">Command Palette</Dialog.Title>
          <Command
            className="overflow-hidden rounded-xl border border-border bg-bg-elevated shadow-2xl"
            loop
          >
            <div className="flex items-center border-b border-border px-3">
              <Command.Input
                placeholder="Search or jump to..."
                className="h-12 w-full bg-transparent text-sm text-text-primary placeholder:text-text-tertiary focus:outline-none"
              />
            </div>
            <Command.List className="max-h-80 overflow-y-auto p-1.5">
              <Command.Empty className="py-8 text-center text-sm text-text-tertiary">
                No results found
              </Command.Empty>

              <Command.Group
                heading="Navigation"
                className="[&>[cmdk-group-heading]]:px-2 [&>[cmdk-group-heading]]:py-1.5 [&>[cmdk-group-heading]]:text-2xs [&>[cmdk-group-heading]]:font-medium [&>[cmdk-group-heading]]:text-text-tertiary [&>[cmdk-group-heading]]:uppercase [&>[cmdk-group-heading]]:tracking-wider"
              >
                {navItems.map((item) => (
                  <CommandItemRow
                    key={item.id}
                    item={item}
                    onSelect={() => handleSelect(item)}
                  />
                ))}
              </Command.Group>

              <Command.Separator className="my-1 h-px bg-border-secondary" />

              <Command.Group
                heading="Actions"
                className="[&>[cmdk-group-heading]]:px-2 [&>[cmdk-group-heading]]:py-1.5 [&>[cmdk-group-heading]]:text-2xs [&>[cmdk-group-heading]]:font-medium [&>[cmdk-group-heading]]:text-text-tertiary [&>[cmdk-group-heading]]:uppercase [&>[cmdk-group-heading]]:tracking-wider"
              >
                {actionItems.map((item) => (
                  <CommandItemRow
                    key={item.id}
                    item={item}
                    onSelect={() => handleSelect(item)}
                  />
                ))}
              </Command.Group>
            </Command.List>

            <div className="border-t border-border px-3 py-2">
              <p className="text-2xs text-text-tertiary">
                <kbd className="rounded border border-border px-1 py-0.5 font-mono text-2xs">↑↓</kbd>
                {' '}navigate{' '}
                <kbd className="rounded border border-border px-1 py-0.5 font-mono text-2xs">↵</kbd>
                {' '}select{' '}
                <kbd className="rounded border border-border px-1 py-0.5 font-mono text-2xs">esc</kbd>
                {' '}close
              </p>
            </div>
          </Command>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

function CommandItemRow({
  item,
  onSelect,
}: {
  item: CommandItem
  onSelect: () => void
}) {
  const Icon = item.icon
  return (
    <Command.Item
      value={item.label}
      onSelect={onSelect}
      className={cn(
        'flex cursor-pointer items-center gap-3 rounded-md px-2 py-2 text-sm text-text-secondary',
        'data-[selected=true]:bg-bg-hover data-[selected=true]:text-text-primary',
        'transition-colors',
      )}
    >
      <Icon className="h-4 w-4 shrink-0" />
      <span className="flex-1">{item.label}</span>
      {item.shortcut && (
        <span className="text-2xs text-text-tertiary">{item.shortcut}</span>
      )}
    </Command.Item>
  )
}
