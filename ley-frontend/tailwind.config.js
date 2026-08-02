/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        // Paleta exclusiva da Ley — navy / midnight blue
        midnight: {
          950: '#040711',
          900: '#070b18',
          850: '#0a0f20',
          800: '#0d1428',
          700: '#121b38',
          600: '#182448',
          500: '#1f2f5c',
        },
        electric: {
          400: '#5ec2ff',
          500: '#2f8fff',
          600: '#1f6fe0',
          glow: '#3ea6ff',
        },
        cobalt: {
          400: '#4f7cff',
          500: '#2f56e0',
        },
      },
      fontFamily: {
        display: ['"Space Grotesk"', 'system-ui', 'sans-serif'],
        body: ['"Inter"', 'system-ui', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'ui-monospace', 'monospace'],
      },
      boxShadow: {
        glow: '0 0 20px rgba(47, 143, 255, 0.35)',
        'glow-sm': '0 0 10px rgba(47, 143, 255, 0.25)',
      },
      keyframes: {
        pulseDot: {
          '0%, 100%': { opacity: 1 },
          '50%': { opacity: 0.3 },
        },
        blink: {
          '0%, 100%': { opacity: 1 },
          '50%': { opacity: 0 },
        },
        statusProgress: {
          from: { width: '0%' },
          to: { width: '100%' },
        },
      },
      animation: {
        pulseDot: 'pulseDot 1.4s ease-in-out infinite',
        blink: 'blink 1s step-start infinite',
        statusProgress: 'statusProgress 5s linear forwards',
      },
    },
  },
  plugins: [],
}
