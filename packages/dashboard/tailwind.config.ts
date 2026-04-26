import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // Single-source brand palette. If we ever want a dark mode toggle,
        // add a complementary set here under e.g. `dark`.
        brand: {
          50:  '#eef9ff',
          100: '#d9f0ff',
          500: '#0ea5e9',
          600: '#0284c7',
          700: '#0369a1',
          900: '#0c4a6e',
        },
      },
    },
  },
  plugins: [],
};

export default config;
