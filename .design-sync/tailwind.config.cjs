// Static reproduction of the Tailwind CDN config inline in index.html.
// This repo styles itself entirely via the Tailwind CDN script (runtime JIT),
// so there is no compiled stylesheet to scrape. This config + tailwind-input.css
// compile a real stylesheet for design-sync's cssEntry. Keep in sync with
// index.html's `tailwind.config` block if that theme changes.
module.exports = {
  darkMode: 'class',
  content: ['./components/**/*.{ts,tsx}', './App.tsx'],
  theme: {
    extend: {
      colors: {
        cream: {
          50: '#FFFEFA',
          100: '#FAF9F6',
          200: '#F5F2E9',
          300: '#EBE8DE',
          400: '#D6D3CA',
          800: '#8C8982',
          900: '#1A1F2E',
        },
        charcoal: {
          DEFAULT: '#1A1F2E',
          surface: '#252B3D',
          light: '#2C3344',
          border: '#3E4559',
        },
        emerald: {
          400: '#34D399',
          500: '#10B981',
          600: '#059669',
          900: '#064E3B',
        },
      },
      fontFamily: {
        serif: ['Playfair Display', 'serif'],
        sans: ['Inter', 'sans-serif'],
        mono: ['JetBrains Mono', 'monospace'],
      },
      boxShadow: {
        paper: '0 2px 8px rgba(0, 0, 0, 0.05)',
        float: '0 8px 30px rgba(0, 0, 0, 0.12)',
        'right-depth': '8px 0 30px rgba(0, 0, 0, 0.12)',
        'dark-float': '0 8px 30px rgba(0, 0, 0, 0.4)',
      },
      transitionTimingFunction: {
        'ios-ease': 'cubic-bezier(0.16, 1, 0.3, 1)',
      },
    },
  },
};
