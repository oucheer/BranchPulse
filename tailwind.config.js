/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        canvas: 'rgb(var(--canvas) / <alpha-value>)',
        surface: 'rgb(var(--surface) / <alpha-value>)',
        elevated: 'rgb(var(--surface-elevated) / <alpha-value>)',
        line: 'rgb(var(--line) / <alpha-value>)',
        primary: 'rgb(var(--primary) / <alpha-value>)',
        secondary: 'rgb(var(--secondary) / <alpha-value>)',
        ok: 'rgb(var(--ok) / <alpha-value>)',
        warn: 'rgb(var(--warn) / <alpha-value>)',
        danger: 'rgb(var(--danger) / <alpha-value>)',
        info: 'rgb(var(--info) / <alpha-value>)',
        muted: 'rgb(var(--muted) / <alpha-value>)'
      },
      fontFamily: {
        sans: [
          'Inter Variable',
          'Inter',
          'Segoe UI',
          'PingFang SC',
          'Microsoft YaHei',
          'system-ui',
          'sans-serif'
        ],
        mono: ['JetBrains Mono', 'Cascadia Code', 'Consolas', 'monospace']
      },
      borderRadius: {
        button: '8px',
        input: '8px',
        card: '12px',
        dialog: '16px',
        floating: '18px',
        badge: '9999px'
      },
      boxShadow: {
        glow: '0 0 0 1px rgb(var(--primary) / 0.25), 0 8px 40px -12px rgb(var(--primary) / 0.35)',
        panel: '0 20px 60px -24px rgba(0, 0, 0, 0.6)'
      }
    }
  },
  plugins: []
}
