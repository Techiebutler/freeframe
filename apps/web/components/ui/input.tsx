'use client'

import * as React from 'react'
import { Eye, EyeOff } from 'lucide-react'
import { cn } from '@/lib/utils'

export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  label?: string
  error?: string
  icon?: React.ReactNode
}

const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, label, error, icon, id, type, ...props }, ref) => {
    const inputId = id || label?.toLowerCase().replace(/\s+/g, '-')
    const [showPassword, setShowPassword] = React.useState(false)
    const isPassword = type === 'password'

    return (
      <div className="flex flex-col gap-1.5">
        {label && (
          <label
            htmlFor={inputId}
            className="font-mono text-[11px] font-normal uppercase tracking-[0.14em] text-text-secondary"
          >
            {label}
          </label>
        )}
        {/* ponytail: shake replays when error goes falsy→truthy; a repeat
            submit with the same error still showing won't re-fire. Forms here
            clear error onChange, so a resubmit does replay. Good enough. */}
        <div className={cn('relative', error && 'animate-shake')}>
          {icon && (
            <div className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-text-tertiary">
              {icon}
            </div>
          )}
          <input
            id={inputId}
            ref={ref}
            type={isPassword && showPassword ? 'text' : type}
            className={cn(
              'flex h-11 w-full rounded border border-border-strong bg-bg-secondary px-3 py-2 text-sm text-text-primary placeholder:text-text-tertiary',
              'transition-[border-color,box-shadow] duration-150 focus:outline-none focus:border-accent focus:shadow-[inset_0_0_0_1px_var(--accent)]',
              'disabled:cursor-not-allowed disabled:opacity-45',
              icon && 'pl-9',
              isPassword && 'pr-9',
              error && 'border-accent focus:border-accent',
              className,
            )}
            {...props}
          />
          {isPassword && (
            <button
              type="button"
              tabIndex={-1}
              onClick={() => setShowPassword((v) => !v)}
              className="absolute inset-y-0 right-2.5 flex items-center text-text-tertiary hover:text-text-secondary transition-colors"
            >
              {showPassword ? (
                <EyeOff className="h-4 w-4" />
              ) : (
                <Eye className="h-4 w-4" />
              )}
            </button>
          )}
        </div>
        {error && (
          <p className="font-mono text-[11px] tracking-[0.04em] text-accent">{error}</p>
        )}
      </div>
    )
  },
)
Input.displayName = 'Input'

export { Input }
