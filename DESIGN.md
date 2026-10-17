---
name: Tayyn Hyzmat
description: Compact navy, red and white dispatch and driver interfaces
colors:
  ink: "#122d4b"
  brand-swoosh: "#c81022"
  paper: "#ffffff"
  story-muted: "#c1cddd"
  background: "#f5f7fa"
  foreground: "#13283f"
  secondary: "#e9eef4"
  muted-foreground: "#526174"
  border: "#d9e1e9"
  dark-card: "#172334"
  dark-foreground: "#f5f5f5"
  dark-secondary: "#253246"
  dark-muted-foreground: "#bac6d4"
  dark-border: "#3a4a60"
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

The user restored the original navy H and red swoosh from recovered `logo.png`. Preserve its exact silhouette and colors. Navy primary controls and white surfaces retain the earlier compact, restrained interface; the red swoosh supplies the brand accent without coloring every action red. No Uber mark, font or artwork is used. Green remains operational readiness and active-region status; amber and destructive red retain their warning meanings alongside icons or labels.

## Colors

`src/shared/theme.css` is the runtime authority. Light uses background `#f5f7fa`, card `#ffffff`, foreground `#13283f`, navy primary `#122d4b`, secondary `#e9eef4`, muted text `#526174`, border `#d9e1e9`. Dark uses background `#0e1724`, card `#172334`, foreground/primary `#f5f5f5`, secondary `#253246`, muted text `#bac6d4`, border `#3a4a60`. The login story uses the same navy. Interface accents use red `#c81022` in light mode and `#ff7983` in dark mode; the artwork keeps its original red. Red navigation accents do not indicate readiness. Destructive actions remain white on `#b42318` in light mode and `#4a0903` on `#ffb4ab` in dark mode. GPS/shift success remains `#137333` / `#8bd5a5`.

## Typography

Manrope Variable is self-hosted through the existing Fontsource package. Its open counters and broad Cyrillic/Latin extended coverage suit compact Russian controls and Turkmen names. Use one family, 400 body, 500 labels, 600 headings and 750 wordmark, with tabular numerals for operational data. The OFL license ships in `public/brand/`. No remote font service is required.

## Layout

The dispatcher overview uses one compact three-column summary band followed immediately by a ruled regional list; historical metrics sit below it. Both regional demand and supply remain visible on phones. Region boundaries have one 44px action per compact row. Driver home preserves its fixed viewport grid.

## Elevation & Depth

Shared shadcn-vue primitives keep their behavior. Panels remain flat and ruled; soft offset shadows distinguish floating dialogs and menus. Use the existing restrained motion, reduced-motion support, 44px driver controls and borderless close icons. Fixed `+993` phone prefixes and formatted digits must fit narrow forms without clipping.

## Components

`src/shared/BrandLogo.vue` displays `public/brand/mark-light.png` and `mark-dark.png` alongside the live Latin wordmark. Both use the original navy/red artwork: dark mode adds a white backing to preserve contrast. Root `logo.png` remains unchanged; the later black/green uploads remain archived under `public/brand/source/`. `scripts/generate-brand-assets.py` extracts the colored artwork from the source tile/shadow, centers its alpha-weighted visible ink mass, then pads/downsamples without redrawing. Placement is calculated from the artwork geometry and kept inside the Android mask-safe circle. Android adaptive foregrounds and splash icons have transparent backgrounds, preventing nested tiles; mask-safe margins protect the swoosh. The manifest, launcher and launch screen use this identity. Modern active-navigation icons use a restrained red accent; selection fills, chat bubbles, fields, menus, tables and primary controls inherit shared navy tokens. Dialog scrims use a navy-tinted transparent layer rather than a detached black palette. Browser theme chrome derives from the current runtime background token; native location/readiness and active-order green, amber warnings and destructive colors stay semantic. These are build assets, not a database migration.

Verification covers both actors, light/dark, desktop/mobile and the driver viewport. A polished visual test does not certify financial integrity, background notification delivery or production readiness; those have separate release gates.

Driver order offers use a single dialog surface. The quote uses a responsive 28–36px price with a smaller TMT unit; large-text settings can increase it further. Header content reserves the borderless close target, and private-offer countdowns occupy their own line so translated or enlarged titles cannot collide. ETA and accept/decline actions retain at least 44px touch targets.

### Glass navigation

The user additionally requested restrained transparent glass and professional shadows. Apple’s [Materials guidance](https://developer.apple.com/design/human-interface-guidelines/materials) places Liquid Glass in a distinct functional navigation/control layer, recommends sparing use, and keeps it out of the content layer. This implementation follows that hierarchy using a modest 12px CSS backdrop blur on the workspace header, dispatcher sidebar and driver bottom navigation. It does not claim to reproduce Apple's native material or rely on an unverified iOS version.

Navigation surfaces retain 88–90% opacity and solid text; forms, order cards, GPS/availability controls and dialogs remain opaque. There are no nested blurred controls, animated blur or full-page glass. Unsupported WebViews receive solid surfaces. Reduced-transparency, increased-contrast and forced-color preferences turn blur and shadows off. Apple source consulted on 2026-10-16; JSON documentation lists Liquid Glass guidance updated September 2025.

### Driver trip feed

An active trip leads the home feed with an ordered, current-step lifecycle, a prominent quote, customer call action and one next-step control. Full route text, navigation, ETA and cancellation remain in the details dialog. A two-line route preview keeps the feed bounded; the details action exposes the complete information. The nine-region overview stays visible below, with smaller scores and tighter spacing during a trip. Each region and action retains a 44px target.

Regional queues use a bounded internal scrolling list and one flat surface. The price leads each order; arrival selection and acceptance remain adjacent. Routine refresh is automatic through order events, region updates, reconnect and foreground return. A failed request exposes a deliberate retry. Taken orders disappear before list reconciliation so a slower response cannot briefly restore a claimed item.
