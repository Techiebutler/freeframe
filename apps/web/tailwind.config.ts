import type { Config } from 'tailwindcss'
import plugin from 'tailwindcss/plugin'
import animate from 'tailwindcss-animate'

const config: Config = {
  darkMode: 'class',
  content: [
    './app/**/*.{ts,tsx}',
    './components/**/*.{ts,tsx}',
  ],
  theme: {
    borderRadius: {
      none: '0px',
      sm: 'var(--radius-sm)',
      DEFAULT: 'var(--radius-md)',
      md: 'var(--radius-md)',
      lg: 'var(--radius-lg)',
      xl: 'var(--radius-xl)',
      '2xl': 'var(--radius-xl)',
      '3xl': 'var(--radius-xl)',
      full: '9999px',
    },
    boxShadow: {
      sm: '0 0 #0000',
      DEFAULT: '0 0 #0000',
      md: '0 0 #0000',
      lg: '0 0 #0000',
      // xl / 2xl carry overlay elevation (floating surfaces); inline tiers
      // stay flat per the mono system. Theme-aware via globals.css tokens.
      xl: 'var(--shadow-overlay)',
      '2xl': 'var(--shadow-overlay-lg)',
      inner: '0 0 #0000',
      none: '0 0 #0000',
    },
    extend: {
      colors: {
        bg: {
          primary: 'rgb(var(--bg-primary-rgb) / <alpha-value>)',
          secondary: 'rgb(var(--bg-secondary-rgb) / <alpha-value>)',
          tertiary: 'rgb(var(--bg-tertiary-rgb) / <alpha-value>)',
          elevated: 'rgb(var(--bg-elevated-rgb) / <alpha-value>)',
          hover: 'var(--bg-hover)',
        },
        border: {
          DEFAULT: 'var(--border-primary)',
          secondary: 'var(--border-secondary)',
          focus: 'var(--border-focus)',
          strong: 'var(--border-strong)',
        },
        text: {
          primary: 'rgb(var(--text-primary-rgb) / <alpha-value>)',
          secondary: 'var(--text-secondary)',
          tertiary: 'var(--text-tertiary)',
          inverse: 'var(--text-inverse)',
        },
        accent: {
          DEFAULT: 'rgb(var(--accent-rgb) / <alpha-value>)',
          hover: 'var(--accent-hover)',
          muted: 'var(--accent-muted)',
          line: 'var(--accent-line)',
        },
        status: {
          success: 'rgb(var(--status-success-rgb) / <alpha-value>)',
          warning: 'var(--status-warning)',
          error: 'rgb(var(--status-error-rgb) / <alpha-value>)',
          info: 'var(--status-info)',
        },
      },
      ringColor: {
        DEFAULT: 'rgb(var(--accent-rgb) / 1)',
      },
      fontFamily: {
        sans: ['var(--font-sans)'],
        mono: ['var(--font-mono)'],
        dot: ['var(--font-dot)'],
      },
      fontSize: {
        '2xs': ['0.625rem', { lineHeight: '0.875rem' }],
      },
      animation: {
        'fade-in': 'fade-in 0.2s ease-out',
        'fade-in-slow': 'fade-in 0.4s ease-out',
        'slide-up': 'slide-up 0.3s cubic-bezier(0.16, 1, 0.3, 1)',
        'slide-down': 'slide-down 0.3s cubic-bezier(0.16, 1, 0.3, 1)',
        'slide-in-right': 'slide-in-right 0.3s cubic-bezier(0.16, 1, 0.3, 1)',
        'slide-in-left': 'slide-in-left 0.3s cubic-bezier(0.16, 1, 0.3, 1)',
        'scale-in': 'scale-in 0.2s cubic-bezier(0.16, 1, 0.3, 1)',
        'shimmer': 'shimmer 2s linear infinite',
        'pulse-soft': 'pulse-soft 2s cubic-bezier(0.4, 0, 0.6, 1) infinite',
        'blink': 'blink 1.4s steps(1) infinite',
        'indeterminate-slide': 'indeterminate-slide 1.3s ease-in-out infinite',
        'shake': 'shake 280ms linear',
        'check-pop': 'check-pop 450ms cubic-bezier(0.34,1.35,0.64,1)',
      },
      keyframes: {
        'fade-in': {
          from: { opacity: '0' },
          to: { opacity: '1' },
        },
        'slide-up': {
          from: { opacity: '0', transform: 'translateY(8px)' },
          to: { opacity: '1', transform: 'translateY(0)' },
        },
        'slide-down': {
          from: { opacity: '0', transform: 'translateY(-8px)' },
          to: { opacity: '1', transform: 'translateY(0)' },
        },
        'slide-in-right': {
          from: { opacity: '0', transform: 'translateX(8px)' },
          to: { opacity: '1', transform: 'translateX(0)' },
        },
        'slide-in-left': {
          from: { opacity: '0', transform: 'translateX(-8px)' },
          to: { opacity: '1', transform: 'translateX(0)' },
        },
        'scale-in': {
          from: { opacity: '0', transform: 'scale(0.95)' },
          to: { opacity: '1', transform: 'scale(1)' },
        },
        'shimmer': {
          from: { backgroundPosition: '-200% 0' },
          to: { backgroundPosition: '200% 0' },
        },
        'pulse-soft': {
          '0%, 100%': { opacity: '1' },
          '50%': { opacity: '0.6' },
        },
        blink: {
          '50%': { opacity: '0.25' },
        },
        'indeterminate-slide': {
          '0%': { transform: 'translateX(-120%)' },
          '100%': { transform: 'translateX(360%)' },
        },
        // transitions.dev error-state-shake, tuned values. Cumulative-duration
        // %-stops for legs 80/60/80/60ms = 280ms total; per-stop easing shapes
        // each leg. Recompute stops if durations change.
        'shake': {
          '0%': { transform: 'translateX(0)', animationTimingFunction: 'cubic-bezier(0.22,1,0.36,1)' },
          '28.57%': { transform: 'translateX(6px)', animationTimingFunction: 'cubic-bezier(0.22,1,0.36,1)' },
          '57.14%': { transform: 'translateX(-6px)', animationTimingFunction: 'cubic-bezier(0.22,1,0.36,1)' },
          '78.57%': { transform: 'translateX(4px)', animationTimingFunction: 'cubic-bezier(0.22,1,0.36,1)' },
          '100%': { transform: 'translateX(0)' },
        },
        // Right-sized success-check: rotate-in + settle overshoot on the
        // confirmation icon (transitions.dev success-check, minus the SVG
        // stroke-draw that a lucide line icon can't carry).
        'check-pop': {
          '0%': { opacity: '0', transform: 'scale(0.25) rotate(-80deg)' },
          '60%': { transform: 'scale(1.08) rotate(4deg)' },
          '100%': { opacity: '1', transform: 'scale(1) rotate(0)' },
        },
      },
      transitionTimingFunction: {
        'spring': 'cubic-bezier(0.16, 1, 0.3, 1)',
        'smooth': 'cubic-bezier(0.4, 0, 0.2, 1)',
      },
    },
  },
  plugins: [
    plugin(({ addVariant }) => {
      addVariant('pointer-coarse', '@media (pointer: coarse)')
    }),
    animate,
  ],
}

export default config
