# Tayyn Hyzmat identity

The user supplied the final ChatGPT-generated H-and-swoosh artwork in two transparent PNGs: black uprights/green for light surfaces, white uprights/light green for dark surfaces. Byte-identical originals are retained in `source/supplied-light.png` and `source/supplied-dark.png`. They replace the temporary T interpretation. Historical root `logo.png` remains unchanged.

`mark-light.png` and `mark-dark.png` preserve the uploaded artwork. Preparation removes detached alpha specks smaller than 64 pixels, trims transparent margins, centers the result and adds consistent padding. It does not redraw, recolor or invent a vector substitute. Slight textured/ragged edges in the uploaded white version remain visible at large sizes. The live Latin wordmark remains Manrope Variable.

Run `python3 scripts/generate-brand-assets.py` with Pillow installed to regenerate web and Android assets. Android adaptive and fallback drawables use the same artwork with safe margins. Asset metadata records the supplied source. Generated assets are committed; Pillow is not a production build dependency.

Manrope is distributed under SIL Open Font License 1.1; see `Manrope-LICENSE.txt`. All font files are served with the app, including Cyrillic and Latin extended subsets; no Google Fonts request is needed.
