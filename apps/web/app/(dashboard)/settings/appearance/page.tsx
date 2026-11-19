'use client'

import * as React from 'react'
import { Monitor, Moon, Sun, Check } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useThemeStore, type Theme } from '@/stores/theme-store'

const themes: { value: Theme; label: string; description: string; icon: React.ElementType }[] = [
  {
    value: 'dark',
    label: 'Dark',
    description: 'Dark background with light text',
    icon: Moon,
  },
  {
    value: 'light',
    label: 'Light',
    description: 'Light background with dark text',
    icon: Sun,
  },
  {
    value: 'system',
    label: 'System',
    description: 'Follows your operating system preference',
    icon: Monitor,
  },
]

export default function AppearancePage() {
  const { theme, setTheme } = useThemeStore()

  return (
    <div className="p-6 max-w-2xl">
      <div className="mb-6">
        <h2 className="text-lg font-semibold text-text-primary">Appearance</h2>
        <p className="text-sm text-text-tertiary mt-1">
          Customize how FreeFrame looks on your device.
        </p>
      </div>

      {/* Theme selector */}
      <div className="space-y-3">
        <h2 className="text-sm font-medium text-text-primary">Theme</h2>
        <div className="grid grid-cols-3 gap-3">
          {themes.map((t) => {
            const Icon = t.icon
            const isActive = theme === t.value
            return (
              <button
                key={t.value}
                onClick={() => setTheme(t.value)}
                className={cn(
                  'relative flex flex-col items-center gap-3 rounded-xl border p-4 transition-all text-center',
                  isActive
                    ? 'border-accent bg-accent/5 ring-1 ring-accent/30'
                    : 'border-border bg-bg-secondary hover:bg-bg-tertiary hover:border-border-focus',
                )}
              >
                {/* Preview */}
                <div
                  className={cn(
                    'w-full aspect-[4/3] rounded-lg border overflow-hidden flex flex-col',
                    t.value === 'dark' && 'bg-[#0d0d10] border-[#2e2e3a]',
                    t.value === 'light' && 'bg-white border-[#e0e0e6]',
                    t.value === 'system' && 'border-[#2e2e3a]',
                  )}
                >
                  {t.value === 'system' ? (
                    <div className="flex-1 flex">
                      <div className="flex-1 bg-[#0d0d10]" />
                      <div className="flex-1 bg-white" />
                    </div>
                  ) : (
                    <>
                      <div
                        className={cn(
                          'h-2.5 flex items-center gap-1 px-2',
                          t.value === 'dark' ? 'bg-[#16161a]' : 'bg-[#f0f0f4]',
                        )}
                      >
                        <div className={cn('h-1 w-1 rounded-full', t.value === 'dark' ? 'bg-[#5e5e6e]' : 'bg-[#c0c0c8]')} />
                        <div className={cn('h-1 w-1 rounded-full', t.value === 'dark' ? 'bg-[#5e5e6e]' : 'bg-[#c0c0c8]')} />
                        <div className={cn('h-1 w-1 rounded-full', t.value === 'dark' ? 'bg-[#5e5e6e]' : 'bg-[#c0c0c8]')} />
                      </div>
                      <div className="flex-1 flex gap-px p-1">
                        <div className={cn('w-1/4 rounded-sm', t.value === 'dark' ? 'bg-[#16161a]' : 'bg-[#f0f0f4]')} />
                        <div className="flex-1 flex flex-col gap-px p-0.5">
                          <div className={cn('h-1/2 rounded-sm', t.value === 'dark' ? 'bg-[#1e1e24]' : 'bg-[#e8e8ee]')} />
                          <div className={cn('h-1/2 rounded-sm', t.value === 'dark' ? 'bg-[#1e1e24]' : 'bg-[#e8e8ee]')} />
                        </div>
                      </div>
                    </>
                  )}
                </div>

                {/* Label */}
                <div>
                  <div className="flex items-center justify-center gap-1.5">
                    <Icon className="h-4 w-4 text-text-secondary" />
                    <span className="text-sm font-medium text-text-primary">{t.label}</span>
                  </div>
                  <p className="text-2xs text-text-tertiary mt-0.5">{t.description}</p>
                </div>

                {/* Active indicator */}
                {isActive && (
                  <div className="absolute top-2 right-2 flex h-5 w-5 items-center justify-center rounded-full bg-accent text-white">
                    <Check className="h-3 w-3" />
                  </div>
                )}
              </button>
            )
          })}
        </div>
      </div>
    </div>
  )
}
