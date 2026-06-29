/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        brand: 'var(--brand-color)',
        'brand-light': 'var(--brand-light)',
        'brand-bg': 'var(--brand-bg)',
      },
    },
  },
  plugins: [],
};
