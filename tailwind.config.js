import containerQueries from '@tailwindcss/container-queries';
import plugin from 'tailwindcss/plugin';

/**
 * Compiled at build time (it used to run in the browser from Tailwind's CDN script, which cost a
 * render-blocking download, an in-page compile and a flash of unstyled content on every load).
 * Class names must appear whole in the scanned files: build them from full strings, never
 * `bg-${tone}-500`.
 */
/** @type {import('tailwindcss').Config} */
export default {
  darkMode: 'class',
  content: ['./index.html', './App.tsx', './index.tsx', './components/**/*.{ts,tsx}', './services/**/*.{ts,tsx}', './constants/**/*.ts'],
  theme: {
    extend: {
      colors: {
        cream: {
          50: '#FFFEFA',
          100: '#FAF9F6',
          200: '#F5F2E9', // Base Cream (Light Mode Bg)
          300: '#EBE8DE', // Sand (User Bubble)
          400: '#D6D3CA',
          800: '#8C8982',
          900: '#1A1F2E',
        },
        charcoal: {
          DEFAULT: '#1A1F2E', // Dark Mode Bg & Text
          surface: '#252B3D',
          light: '#2C3344',
          border: '#3E4559',
        },
        emerald: {
          400: '#34D399', // Sage
          500: '#10B981', // Primary Data
          600: '#059669',
          900: '#064E3B',
        },
        // Edition inks: a card's version reads by colour as well as by name. Prime is gold,
        // a named era is a cool blue, a single season is copper; current form stays emerald.
        gold: { 400: '#D9B061', 500: '#C29A45', 600: '#9A7424', 700: '#7C5C17' },
        era: { 400: '#93AEE3', 500: '#6B8CCF', 600: '#3F63A8', 700: '#304D86' },
        copper: { 400: '#E2A283', 500: '#C97B57', 600: '#A65A3A', 700: '#86452B' },
        // The Overall's ramp above the World-Class line: a muted sage, then the app's emerald,
        // then violet for the greatest, so it climbs without borrowing an edition's ink.
        tier: {
          wc: '#5E8C74', 'wc-dark': '#8FB9A2',
          elite: '#059669', 'elite-dark': '#34D399',
          icon: '#6D3FD1', 'icon-dark': '#B79CFF',
        },
      },
      fontFamily: {
        serif: ['Playfair Display', 'Georgia', 'serif'],
        sans: ['Inter', 'system-ui', 'sans-serif'],
        mono: ['JetBrains Mono', 'ui-monospace', 'monospace'],
      },
      boxShadow: {
        paper: '0 2px 8px rgba(0, 0, 0, 0.05)',
        float: '0 8px 30px rgba(0, 0, 0, 0.12)',
        'right-depth': '8px 0 30px rgba(0, 0, 0, 0.12)',
        'dark-float': '0 8px 30px rgba(0, 0, 0, 0.4)',
        // Resting and lifted card depth: a tight contact shadow plus a soft ambient one.
        card: '0 1px 2px rgba(26, 31, 46, 0.04), 0 2px 8px -2px rgba(26, 31, 46, 0.06)',
        lift: '0 2px 4px rgba(26, 31, 46, 0.04), 0 18px 40px -16px rgba(26, 31, 46, 0.22)',
        'lift-dark': '0 2px 4px rgba(0, 0, 0, 0.2), 0 18px 40px -14px rgba(0, 0, 0, 0.6)',
        menu: '0 1px 2px rgba(26, 31, 46, 0.06), 0 12px 32px -8px rgba(26, 31, 46, 0.2)',
      },
      keyframes: {
        'fade-in': { from: { opacity: '0', transform: 'translateY(4px)' }, to: { opacity: '1', transform: 'translateY(0)' } },
        'picker-in': { from: { opacity: '0', transform: 'scale(0.985)' }, to: { opacity: '1', transform: 'scale(1)' } },
        // A scout's sweep: a short bar crossing the row while the card is built.
        'scout-sweep': { from: { transform: 'translateX(-100%)' }, to: { transform: 'translateX(250%)' } },
        // A card that just landed on the desk settles from emerald to the row's own colour.
        'scout-landed': { from: { backgroundColor: 'rgba(16, 185, 129, 0.16)' }, to: { backgroundColor: 'rgba(16, 185, 129, 0)' } },
        // Hub entries rise into place, slightly blurred, on first paint and after a filter change.
        'rise-in': {
          from: { opacity: '0', transform: 'translateY(10px)', filter: 'blur(3px)' },
          to: { opacity: '1', transform: 'translateY(0)', filter: 'blur(0)' },
        },
        'menu-in': {
          from: { opacity: '0', transform: 'translateY(-4px) scale(0.98)' },
          to: { opacity: '1', transform: 'translateY(0) scale(1)' },
        },
        shimmer: { from: { backgroundPosition: '150% 0' }, to: { backgroundPosition: '-50% 0' } },
        'bar-grow': { from: { transform: 'scaleX(0)' }, to: { transform: 'scaleX(1)' } },
      },
      animation: {
        'fade-in': 'fade-in 220ms cubic-bezier(0.23, 1, 0.32, 1) both',
        'picker-in': 'picker-in 160ms cubic-bezier(0.23, 1, 0.32, 1) both',
        'scout-sweep': 'scout-sweep 1.6s cubic-bezier(0.77, 0, 0.175, 1) infinite',
        'scout-landed': 'scout-landed 2.4s cubic-bezier(0.23, 1, 0.32, 1) both',
        'rise-in': 'rise-in 520ms cubic-bezier(0.16, 1, 0.3, 1) both',
        'menu-in': 'menu-in 160ms cubic-bezier(0.23, 1, 0.32, 1) both',
        shimmer: 'shimmer 1.6s linear infinite',
        'bar-grow': 'bar-grow 900ms cubic-bezier(0.16, 1, 0.3, 1) both',
      },
      transitionTimingFunction: {
        'ios-ease': 'cubic-bezier(0.16, 1, 0.3, 1)',
        'out-expo': 'cubic-bezier(0.16, 1, 0.3, 1)',
      },
    },
  },
  plugins: [
    containerQueries,
    // Hover effects only where there is a real pointer: a tap on a phone shouldn't leave a card lifted.
    plugin(({ addVariant }) => addVariant('can-hover', '@media (hover: hover) and (pointer: fine)')),
  ],
};
