/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: {
        // All Drift colors resolve through CSS variables so the
        // daybreak/nightshift themes switch without class changes.
        paper: 'var(--os-bg)',
        surface: 'var(--os-surface)',
        ink: 'var(--os-ink)',
        muted: 'var(--os-muted)',
        accent: 'var(--os-accent)',
        accentink: 'var(--os-accent-ink)',
        osborder: 'var(--os-border)',
        sage: '#5F7161',
      },
      fontFamily: {
        sans: ['"Avenir Next"', '"Segoe UI"', 'system-ui', '-apple-system', 'sans-serif'],
      },
      transitionDuration: {
        160: '160ms',
      },
      boxShadow: {
        os: 'var(--os-shadow)',
        win: '0 18px 60px rgba(28, 25, 23, 0.16)',
      },
      borderRadius: {
        os: '16px',
      },
    },
  },
  plugins: [],
};
