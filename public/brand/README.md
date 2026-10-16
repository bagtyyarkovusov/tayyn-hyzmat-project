# Tayyn Hyzmat identity

The square T mark is original vector artwork created for this repository. Its authoritative geometry is `mark.svg`; the Vue lockup uses the same geometry with theme-aware ink. The Latin wordmark is live text in the bundled Manrope Variable typeface. No Uber artwork, font or trademark is included.

Manrope is distributed under SIL Open Font License 1.1; see `Manrope-LICENSE.txt`. The installed Fontsource package supplies Cyrillic, Cyrillic extended, Latin and Latin extended subsets for Russian and Turkmen. All font files are served with the app, without a Google Fonts request.

Run `python3 scripts/generate-brand-assets.py` with Pillow installed to reproduce the web and Android raster assets. Raster metadata records their vector origin. These generated assets are committed; Pillow is not required to build the web app or APK.
