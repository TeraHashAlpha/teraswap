import type { Config } from 'tailwindcss'

const config: Config = {
  content: ['./src/**/*.{js,ts,jsx,tsx,mdx}'],
  theme: {
    extend: {
      colors: {
        // v2.0 — "The Gold Standard Protocol" palette
        surface: {
          DEFAULT: '#080B10',
          secondary: '#0F1318',
          tertiary: '#151A22',
          hover: '#1E2530',
        },
        cream: {
          DEFAULT: '#F5F0E8',    // near-white cream (v2 spec)
          warm: '#E8D5B7',       // shimmer accent
          gold: '#C8B89A',       // gold accent (buttons, accents)
          95: 'rgba(245, 240, 232, 0.95)',
          80: 'rgba(245, 240, 232, 0.80)',
          75: 'rgba(245, 240, 232, 0.75)',
          65: 'rgba(245, 240, 232, 0.65)',
          50: 'rgba(245, 240, 232, 0.50)',
          35: 'rgba(245, 240, 232, 0.35)',
          20: 'rgba(245, 240, 232, 0.20)',
          15: 'rgba(245, 240, 232, 0.15)',
          '08': 'rgba(245, 240, 232, 0.08)',
          '04': 'rgba(245, 240, 232, 0.04)',
        },
        gold: {
          DEFAULT: '#C8B89A',
          light: '#E8D5B7',
          dark: '#A89878',
          '40': 'rgba(200, 184, 154, 0.40)',
          '20': 'rgba(200, 184, 154, 0.20)',
          '08': 'rgba(200, 184, 154, 0.08)',
          '04': 'rgba(200, 184, 154, 0.04)',
        },
        success: '#4ADE80',      // emerald-green (security)
        'success-soft': '#E8F5EC', // warm cream+green for headlines
        warning: '#F59E0B',
        danger: '#EF4444',
        text: {
          primary: '#F5F0E8',
          secondary: 'rgba(245, 240, 232, 0.75)',
          muted: 'rgba(245, 240, 232, 0.50)',
          subtle: 'rgba(245, 240, 232, 0.35)',
        },
        border: {
          DEFAULT: 'rgba(245, 240, 232, 0.08)',
          hover: 'rgba(200, 184, 154, 0.40)',
          card: '#1E2530',
        },
      },
      fontFamily: {
        display: ['Clash Display', 'Inter', 'sans-serif'],
        sans: ['Inter', '-apple-system', 'BlinkMacSystemFont', 'sans-serif'],
        mono: ['JetBrains Mono', 'Fira Code', 'monospace'],
      },
      animation: {
        'pulse-slow': 'pulse 3s cubic-bezier(0.4, 0, 0.6, 1) infinite',
        'glow': 'glow 2s ease-in-out infinite alternate',
        'fade-slide-in': 'fadeSlideIn 0.5s ease-out',
        'shimmer': 'shimmer 1.2s ease-in-out forwards',
        'pulse-glow': 'pulseGlow 3s ease-in-out infinite',
        'spin-slow': 'spin 20s linear infinite',
      },
      keyframes: {
        glow: {
          '0%': { boxShadow: '0 0 5px rgba(200,184,154,0.05), 0 0 20px rgba(200,184,154,0.02)' },
          '100%': { boxShadow: '0 0 10px rgba(200,184,154,0.08), 0 0 40px rgba(200,184,154,0.04)' },
        },
        fadeSlideIn: {
          '0%': { opacity: '0', transform: 'translateY(20px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        pulseGlow: {
          '0%, 100%': { transform: 'scale(1)', opacity: '0.08' },
          '50%': { transform: 'scale(1.4)', opacity: '0.04' },
        },
      },
    },
  },
  plugins: [],
}

export default config
