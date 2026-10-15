/**
 * Tailwind is scoped to coexist with the existing Vuetify-based pages during
 * the incremental migration (see migration plan, Этап 4): `preflight` is
 * disabled so Tailwind's base CSS reset does not repaint every existing
 * Vuetify page. Both the driver panel (src/driver/**) and the admin panel
 * (src/admin/**) use Tailwind utility classes; everything else (the original
 * client-facing scaffold) is untouched Vuetify.
 */
// The installed Tailwind CSS 2.2.17's *actual* default palette (verified via
// resolveConfig, not just this file's own assumptions) is only
// transparent/current/black/white/gray/red/yellow/green/blue/indigo/purple/
// pink - slate, emerald, amber, sky, teal etc. were added to Tailwind's
// bundled `colors` module in this same version but are NOT wired into the
// default theme automatically, only via explicit `require('tailwindcss/colors')`.
// Every driver-panel component (built before this redesign pass too) uses
// slate-*/emerald-*/amber-*/sky-* extensively assuming they exist; without
// this require they silently compile to nothing (no background, no border,
// no text color - not a build error, just missing CSS) everywhere in the
// app, light and dark mode alike. `blueGray` is this version's pre-rename
// name for the same palette later shipped as `slate` (identical hex values).
const twColors = require('tailwindcss/colors')

module.exports = {
  // Tailwind v2 (not v3) is used deliberately here: this project's webpack
  // pipeline comes from @vue/cli-service 4.x, whose bundled postcss-loader@3
  // is hard-pinned to the PostCSS 7 plugin API - Tailwind v3 requires
  // PostCSS 8 and fails to build under this toolchain. v2.2.19 is the last
  // major built against PostCSS 7, hence `purge` instead of v3's `content`.
  darkMode: 'class',
  purge: {
    enabled: process.env.NODE_ENV === 'production',
    // './src/admin/**' was missing here - PurgeCSS never saw the admin
    // panel's own source text, so in production every Tailwind class used
    // ONLY in src/admin/**/*.vue (not also used verbatim somewhere under
    // src/driver/**) was stripped as "unused": no grid layout, no dark-mode
    // colors, no spacing - exactly the broken/blank-looking admin screens
    // reported after deploy.
    content: ['./index.html', './src/driver/**/*.{vue,js}', './src/admin/**/*.{vue,js}', './src/App.vue', './src/main.js']
  },
  corePlugins: {
    preflight: false
  },
  theme: {
    extend: {
      colors: {
        // twColors.blueGray (this version's pre-rename `slate`) only goes
        // down to 900 - Tailwind v3 later added a darker 950 stop that a
        // lot of the admin panel's dark-mode classes (dark:bg-slate-950,
        // dark:border-slate-950 etc.) assume exists. Without this, every
        // one of those classes silently compiled to no CSS at all (not a
        // build error - Tailwind just skips unknown scale values), so
        // toggling dark mode never actually darkened page backgrounds/
        // borders, only whatever used a real shade (buttons on
        // slate-700/800, indigo-600...) appeared to change. Value matches
        // Tailwind v3's actual slate-950 hex.
        slate: { ...twColors.blueGray, 950: '#020617' },
        emerald: twColors.emerald,
        amber: twColors.amber,
        sky: twColors.sky,
        teal: twColors.teal,
        // Primary brand color - modern emerald green (see redesign spec
        // §17: emerald for online/active/positive states, red for
        // errors/offline, amber for warnings/waiting, everything else stays
        // neutral white/slate so the whole UI doesn't turn green).
        brand: {
          50: '#ecfdf5',
          100: '#d1fae5',
          200: '#a7f3d0',
          300: '#6ee7b7',
          400: '#34d399',
          500: '#10b981',
          600: '#059669',
          700: '#047857',
          800: '#065f46'
        },
        // Dark "SaaS dashboard" surface scale for the driver panel
        // (near-black page background, slightly-lighter card/sidebar
        // surfaces, thin low-contrast borders) - driver components use
        // these directly, unconditionally, instead of a light theme +
        // `dark:` variant pair, so the panel is always this look.
        ink: {
          950: '#090b10', // page background
          900: '#10131b', // sidebar / bottom-nav surface
          800: '#151923', // cards
          700: '#1c212d', // raised/hover surface, inputs
          600: '#262c3a' // borders
        }
      },
      // Tailwind v2's default maxHeight scale is only 0/full/screen (100vh) -
      // CreateOrderModal.vue needs a shorter cap so a tall form scrolls
      // inside the modal instead of the modal itself overflowing the
      // viewport. `max-h-[90vh]` (arbitrary-value bracket syntax) requires
      // Tailwind v3's JIT engine, unsupported on this v2 + PostCSS7 setup
      // (see tailwind.config.js's own top-of-file note) - it silently
      // compiled to no CSS at all, so the modal never actually capped its
      // height or gained the scroll it needed on tall forms/small screens.
      maxHeight: {
        '90vh': '90vh'
      },
      keyframes: {
        'pulse-ring': {
          '0%': { boxShadow: '0 0 0 0 currentColor' },
          '70%': { boxShadow: '0 0 0 8px transparent' },
          '100%': { boxShadow: '0 0 0 0 transparent' }
        },
        'fade-in': {
          from: { opacity: 0 },
          to: { opacity: 1 }
        },
        'scale-in': {
          from: { opacity: 0, transform: 'scale(0.95) translateY(8px)' },
          to: { opacity: 1, transform: 'scale(1) translateY(0)' }
        }
      },
      animation: {
        'pulse-ring': 'pulse-ring 2s cubic-bezier(0.4, 0, 0.6, 1) infinite',
        'fade-in': 'fade-in 0.2s ease-out',
        'scale-in': 'scale-in 0.25s cubic-bezier(0.16, 1, 0.3, 1)'
      }
    }
  },
  plugins: []
}
