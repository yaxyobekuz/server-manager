/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: {
        // Railway-inspired dark palette.
        bg: {
          DEFAULT: '#0b0b0f', // app background (near-black, slight purple)
          raised: '#13131a', // cards / panels
          hover: '#1a1a23',
          input: '#0e0e13',
        },
        line: {
          DEFAULT: '#24242e', // borders
          soft: '#1c1c24',
        },
        brand: {
          DEFAULT: '#a26bff', // Railway purple
          soft: '#7c4dff',
          glow: 'rgba(162,107,255,0.25)',
        },
        ok: '#3ecf8e',
        warn: '#f5a623',
        danger: '#f5455c',
        muted: '#7a7a8c',
      },
      fontFamily: {
        sans: ['Inter', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'ui-monospace', 'SFMono-Regular', 'monospace'],
      },
      boxShadow: {
        card: '0 1px 0 0 rgba(255,255,255,0.03) inset, 0 8px 24px -12px rgba(0,0,0,0.6)',
        glow: '0 0 0 1px rgba(162,107,255,0.4), 0 0 24px -4px rgba(162,107,255,0.4)',
      },
      backgroundImage: {
        'grid-fade':
          'radial-gradient(circle at 50% 0%, rgba(162,107,255,0.08), transparent 60%)',
      },
    },
  },
  plugins: [],
};
