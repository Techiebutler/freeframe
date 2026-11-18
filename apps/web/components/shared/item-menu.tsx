'use client'

import * as React from 'react'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import * as ContextMenu from '@radix-ui/react-context-menu'
import { cn } from '@/lib/utils'

/**
 * One set of menu items, shown two ways: from a ⋯ button (a dropdown) and on
 * right-click (a context menu at the pointer).
 *
 * Radix's dropdown and context menus are built from the same parts, but each
 * menu only accepts its own: a DropdownMenu.Item inside a context menu throws.
 * The wrappers below render the right one for the menu they sit in, so an
 * object's items are written once and both menus show exactly the same list.
 */

type MenuKind = 'dropdown' | 'context'

const MenuKindContext = React.createContext<MenuKind>('dropdown')

const useMenuKind = () => React.useContext(MenuKindContext)

/**
 * Most picks open a dialog (Rename, Delete, Share, Move to…) or remove the
 * row the menu belongs to, so they run once the menu has fully closed, not
 * while it is still on screen.
 *
 * A menu and a dialog each set `pointer-events: none` on <body> while open and
 * put back what they found. A dialog that opens while the closing menu still
 * holds the page saves that lock as the value to restore; when two copies of
 * Radix's layer code are installed (npm resolving its own versions does this)
 * the menu then unlocks, the dialog closes, puts the lock back, and nothing on
 * the page can be clicked until a reload. Waiting for the menu removes the
 * overlap. Radix signals the end with onCloseAutoFocus, after its exit
 * animation and after it has released <body>.
 */
const AfterCloseContext = React.createContext<((action: () => void) => void) | null>(null)

/** Exported for the Log out confirmation in the sidebar, which opens a dialog
 *  from a menu item the same way. */
export function useAfterClose() {
  const pending = React.useRef<(() => void) | null>(null)
  const schedule = React.useCallback((action: () => void) => {
    pending.current = action
  }, [])
  const onCloseAutoFocus = React.useCallback(() => {
    const action = pending.current
    if (!action) return
    pending.current = null
    // Focus still goes back to the trigger afterwards. A dialog or a rename
    // field the action opens mounts after that and takes it from there, and a
    // pick that opens nothing (Disable Access, a cancelled confirm) leaves the
    // keyboard where it was rather than on <body>.
    action()
  }, [])
  return { schedule, onCloseAutoFocus }
}

export const menuContentClass =
  'z-[100] min-w-[200px] rounded-xl border border-border bg-bg-elevated shadow-2xl py-1.5 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95'

export const menuItemClass =
  'flex items-center gap-2.5 mx-1 px-2.5 py-2 rounded-lg text-sm text-text-secondary hover:bg-bg-hover hover:text-text-primary data-[highlighted]:bg-bg-hover data-[highlighted]:text-text-primary data-[disabled]:opacity-50 data-[disabled]:pointer-events-none cursor-pointer outline-none transition-colors'

export const menuDangerItemClass =
  'flex items-center gap-2.5 mx-1 px-2.5 py-2 rounded-lg text-sm text-status-error hover:bg-status-error/10 data-[highlighted]:bg-status-error/10 data-[disabled]:opacity-50 data-[disabled]:pointer-events-none cursor-pointer outline-none transition-colors'

export const menuLabelClass =
  'px-3.5 pt-1 pb-1.5 text-2xs font-medium uppercase tracking-wide text-text-tertiary'

type ItemProps = React.ComponentPropsWithoutRef<typeof DropdownMenu.Item>

export const MenuItem = React.forwardRef<HTMLDivElement, ItemProps>(function MenuItem(props, ref) {
  const Item = useMenuKind() === 'context' ? ContextMenu.Item : DropdownMenu.Item
  return <Item ref={ref} {...props} />
})

export function MenuSeparator({ className }: { className?: string }) {
  const Separator = useMenuKind() === 'context' ? ContextMenu.Separator : DropdownMenu.Separator
  return <Separator className={cn('my-1 h-px bg-border mx-1', className)} />
}

export function MenuLabel({ children, className }: { children: React.ReactNode; className?: string }) {
  const Label = useMenuKind() === 'context' ? ContextMenu.Label : DropdownMenu.Label
  return <Label className={cn(menuLabelClass, className)}>{children}</Label>
}

type SubProps = React.ComponentPropsWithoutRef<typeof DropdownMenu.Sub>

export function MenuSub(props: SubProps) {
  const Sub = useMenuKind() === 'context' ? ContextMenu.Sub : DropdownMenu.Sub
  return <Sub {...props} />
}

type SubTriggerProps = React.ComponentPropsWithoutRef<typeof DropdownMenu.SubTrigger>

export const MenuSubTrigger = React.forwardRef<HTMLDivElement, SubTriggerProps>(
  function MenuSubTrigger(props, ref) {
    const SubTrigger = useMenuKind() === 'context' ? ContextMenu.SubTrigger : DropdownMenu.SubTrigger
    return <SubTrigger ref={ref} {...props} />
  },
)

type SubContentProps = React.ComponentPropsWithoutRef<typeof DropdownMenu.SubContent>

/** A submenu's content, in its own portal. */
export const MenuSubContent = React.forwardRef<HTMLDivElement, SubContentProps>(
  function MenuSubContent(props, ref) {
    const kind = useMenuKind()
    const Portal = kind === 'context' ? ContextMenu.Portal : DropdownMenu.Portal
    const SubContent = kind === 'context' ? ContextMenu.SubContent : DropdownMenu.SubContent
    return (
      <Portal>
        <SubContent ref={ref} {...props} />
      </Portal>
    )
  },
)

/** The usual entry: an icon and a label. `danger` for destructive actions. */
export function MenuAction({
  icon: Icon,
  children,
  onSelect,
  danger,
  disabled,
  immediate,
}: {
  icon: React.ElementType
  children: React.ReactNode
  onSelect: () => void
  danger?: boolean
  disabled?: boolean
  /** Run at once, inside the click, instead of after the menu closes: for
   *  what needs the click itself (opening a tab, writing the clipboard) and
   *  opens no dialog. */
  immediate?: boolean
}) {
  const afterClose = React.useContext(AfterCloseContext)
  return (
    <MenuItem
      onSelect={() => (immediate || !afterClose ? onSelect() : afterClose(onSelect))}
      disabled={disabled}
      className={danger ? menuDangerItemClass : menuItemClass}
    >
      <Icon className={cn('h-3.5 w-3.5', !danger && 'text-text-tertiary')} />
      {children}
    </MenuItem>
  )
}

// A portal still bubbles through the React tree, and these menus sit inside
// clickable cards and rows: a pick must not also select or open what is behind.
const stopPropagation = (e: React.SyntheticEvent) => e.stopPropagation()

// The same for right-click in an open ⋯ menu: it would reach the row's
// ContextMenuArea and open a second menu on top. The browser's is no use here.
const swallowContextMenu = (e: React.MouseEvent) => {
  e.preventDefault()
  e.stopPropagation()
}

/** A ⋯ button's menu. `children` is the trigger. */
export function DotsMenu({
  items,
  children,
  align = 'end',
  onOpenChange,
}: {
  items: React.ReactNode
  children: React.ReactNode
  align?: 'start' | 'center' | 'end'
  onOpenChange?: (open: boolean) => void
}) {
  const { schedule, onCloseAutoFocus } = useAfterClose()
  return (
    <DropdownMenu.Root onOpenChange={onOpenChange}>
      <DropdownMenu.Trigger asChild>{children}</DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align={align}
          sideOffset={4}
          className={menuContentClass}
          onClick={stopPropagation}
          onContextMenu={swallowContextMenu}
          onCloseAutoFocus={onCloseAutoFocus}
        >
          <MenuKindContext.Provider value="dropdown">
            <AfterCloseContext.Provider value={schedule}>{items}</AfterCloseContext.Provider>
          </MenuKindContext.Provider>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )
}

/**
 * Right-click (or long-press) on `children` opens `items` at the pointer.
 *
 * `children` must be one element that takes a ref and props: it becomes the
 * trigger. With no `items`, or while `disabled` (a rename field showing), the
 * browser's own menu is left alone. Areas must not nest: the event bubbles, and
 * the outer one would open too.
 */
export function ContextMenuArea({
  items,
  disabled,
  children,
  onOpenChange,
}: {
  items: React.ReactNode
  disabled?: boolean
  children: React.ReactElement
  onOpenChange?: (open: boolean) => void
}) {
  const { schedule, onCloseAutoFocus } = useAfterClose()
  if (!items) return children
  return (
    <ContextMenu.Root onOpenChange={onOpenChange}>
      <ContextMenu.Trigger asChild disabled={disabled}>
        {children}
      </ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content
          className={menuContentClass}
          onClick={stopPropagation}
          onCloseAutoFocus={onCloseAutoFocus}
        >
          <MenuKindContext.Provider value="context">
            <AfterCloseContext.Provider value={schedule}>{items}</AfterCloseContext.Provider>
          </MenuKindContext.Provider>
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  )
}
