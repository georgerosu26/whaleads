import animate from 'tailwindcss-animate'
import type { Config } from 'tailwindcss'

const c = (n: string) => `hsl(var(--${n}) / <alpha-value>)`
export default {
  content: ['./ui/index.html', './ui/src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      fontFamily: { sans: ['"Manrope Variable"', 'system-ui', 'sans-serif'] },
      colors: {
        background: c('background'), surface: c('surface'), foreground: c('foreground'),
        muted: c('muted'), 'muted-foreground': c('muted-foreground'), border: c('border'),
        accent: c('accent'), 'accent-foreground': c('accent-foreground'), danger: c('danger'), ring: c('accent'),
      },
      fontSize: { xs: ['13px', '18px'], sm: ['14px', '20px'], base: ['16px', '24px'], xl: ['20px', '28px'] },
      borderRadius: { md: '8px', lg: '12px' },
    },
  },
  plugins: [animate],
} satisfies Config
