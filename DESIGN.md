---
name: Tayyn Hyzmat
description: Compact monochrome dispatch and driver interfaces
colors:
  ink: "#111111"
  paper: "#ffffff"
  background: "#f6f6f6"
  foreground: "#141414"
  secondary: "#ebebeb"
  muted-foreground: "#5c5c5c"
  border: "#dcdcdc"
  dark-card: "#1c1c1c"
  dark-foreground: "#f5f5f5"
  dark-secondary: "#292929"
  dark-muted-foreground: "#b8b8b8"
  dark-border: "#404040"
  destructive: "#b42318"
  dark-destructive: "#ffb4ab"
  dark-destructive-foreground: "#4a0903"
typography:
  body:
    fontFamily: "Manrope Variable, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.6
  wordmark:
    fontFamily: "Manrope Variable, sans-serif"
    fontWeight: 750
    letterSpacing: "-0.035em"
rounded:
  sm: "6px"
  md: "8px"
  lg: "12px"
  xl: "16px"
spacing:
  sm: "8px"
  md: "16px"
  lg: "24px"
---

# Design system: Tayyn Hyzmat

## Overview

Dispatcher and driver interfaces use Operate mode. Drivers need to scan regions, confirm orders and manage a trip in a compact phone viewport. Dispatchers create and assign orders, manage drivers and monitor regions. Preserve Russian operational copy, Latin `Tayyn Hyzmat`, TMT, current business rules and the existing fixed driver grid.

The user requested a replacement black-and-white identity inspired by the clarity of Uber's interfaces. The identity is original: a square T cut from solid ink, with a Latin Manrope wordmark. No Uber mark, font or artwork is used. White and near-black establish hierarchy; neutral surfaces distinguish panels without decorative cards or gradients. Primary actions reverse ink and paper between light and dark mode. Green remains only for operational readiness and regions with active orders; amber and red continue to communicate uncertainty and failure alongside icons, labels or accessible descriptions.

## Colors

`src/shared/theme.css` is the runtime authority. Light uses background `#f6f6f6`, card `#ffffff`, foreground `#141414`, primary `#111111`, secondary `#ebebeb`, muted text `#5c5c5c`, border `#dcdcdc`. Dark uses background `#111111`, card `#1c1c1c`, foreground/primary `#f5f5f5`, secondary `#292929`, muted text `#b8b8b8`, border `#404040`. Destructive actions use white on `#b42318` in light mode and `#4a0903` on `#ffb4ab` in dark mode; never white on a pale red background.

## Typography

Manrope Variable is self-hosted through the existing Fontsource package. Its open counters and broad Cyrillic/Latin extended coverage suit compact Russian controls and Turkmen names. Use one family, 400 body, 500 labels, 600 headings and 750 wordmark, with tabular numerals for operational data. The OFL license ships in `public/brand/`. No remote font service is required.

## Layout

The dispatcher overview uses one compact three-column summary band followed immediately by a ruled regional list; historical metrics sit below it. Both regional demand and supply remain visible on phones. Region boundaries have one 44px action per compact row. Driver home preserves its fixed viewport grid.

## Elevation & Depth

Shared shadcn-vue primitives keep their behavior. Panels remain flat and ruled; soft offset shadows distinguish floating dialogs and menus. Use the existing restrained motion, reduced-motion support, 44px driver controls and borderless close icons. Fixed `+993` phone prefixes and formatted digits must fit narrow forms without clipping.

## Components

`src/shared/BrandLogo.vue` owns the theme-aware mark and live wordmark. `public/brand/mark.svg` is the standalone vector source. `scripts/generate-brand-assets.py` reproduces web and Android raster assets with source metadata; Android adaptive foregrounds retain a safe margin for system masks. The manifest, browser chrome, launcher icon and launch screen use this identity. These are build assets, not a backend or database migration.

Verification covers both actors, light/dark, desktop/mobile and the driver viewport. A polished visual test does not certify financial integrity, background notification delivery or production readiness; those have separate release gates.

### Glass navigation

The user additionally requested restrained transparent glass and professional shadows. Apple’s [Materials guidance](https://developer.apple.com/design/human-interface-guidelines/materials) places Liquid Glass in a distinct functional navigation/control layer, recommends sparing use, and keeps it out of the content layer. This implementation follows that hierarchy using a modest 12px CSS backdrop blur on the workspace header, dispatcher sidebar and driver bottom navigation. It does not claim to reproduce Apple's native material or rely on an unverified iOS version.

Navigation surfaces retain 88–90% opacity and solid text; forms, order cards, GPS/availability controls and dialogs remain opaque. There are no nested blurred controls, animated blur or full-page glass. Unsupported WebViews receive solid surfaces. Reduced-transparency, increased-contrast and forced-color preferences turn blur and shadows off. Apple source consulted on 2026-10-16; JSON documentation lists Liquid Glass guidance updated September 2025.
