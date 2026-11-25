import { describe, it, expect } from 'vitest'
import {
  ACCOUNT_ITEMS,
  INSTANCE_ITEMS,
  INSTANCE_SECTIONS,
  instanceHrefForLegacyTab,
  isInstanceSection,
  settingsSection,
} from '../settings-nav'

describe('settingsSection', () => {
  it.each([
    ['/settings', 'account'],
    ['/settings/profile', 'account'],
    ['/settings/appearance', 'account'],
    ['/settings/notifications', 'account'],
    ['/settings/instance', 'instance'],
    ['/settings/instance/users', 'instance'],
    ['/settings/instance/storage', 'instance'],
    ['/settings/projects', 'projects'],
    ['/settings/projects/p1', 'projects'],
  ])('puts %s in the %s section', (pathname, section) => {
    expect(settingsSection(pathname)).toBe(section)
  })

  it('does not take a sibling route that only shares a prefix for Instance or Projects', () => {
    expect(settingsSection('/settings/instances')).toBe('account')
    expect(settingsSection('/settings/projects-old')).toBe('account')
  })

  it('treats a missing pathname as Account', () => {
    expect(settingsSection(null)).toBe('account')
    expect(settingsSection(undefined)).toBe('account')
  })
})

describe('instanceHrefForLegacyTab', () => {
  it.each([
    ['users', '/settings/instance/users'],
    ['storage', '/settings/instance/storage'],
    ['instance', '/settings/instance/settings'],
    ['branding', '/settings/instance/branding'],
    ['nonsense', '/settings/instance/users'],
    ['', '/settings/instance/users'],
    ['toString', '/settings/instance/users'],
    [null, '/settings/instance/users'],
    [undefined, '/settings/instance/users'],
  ])('maps the old tab %s to %s', (tab, href) => {
    expect(instanceHrefForLegacyTab(tab)).toBe(href)
  })
})

describe('nav tables', () => {
  it('lists one rail item per Instance section, in order, each under /settings/instance', () => {
    expect(INSTANCE_ITEMS.map((i) => i.key)).toEqual([...INSTANCE_SECTIONS])
    expect(INSTANCE_ITEMS.map((i) => i.href)).toEqual(
      INSTANCE_SECTIONS.map((s) => `/settings/instance/${s}`),
    )
    expect(INSTANCE_ITEMS.map((i) => i.label)).toEqual([
      'Users',
      'Storage',
      'Instance settings',
      'Branding',
    ])
  })

  it('keeps the three Account pages at their old addresses', () => {
    expect(ACCOUNT_ITEMS.map((i) => i.href)).toEqual([
      '/settings/profile',
      '/settings/appearance',
      '/settings/notifications',
    ])
  })

  it('recognises only the four Instance sections', () => {
    expect(isInstanceSection('settings')).toBe(true)
    expect(isInstanceSection('instance')).toBe(false)
    expect(isInstanceSection(undefined)).toBe(false)
  })
})
