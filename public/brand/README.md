# Tayyn Hyzmat identity

The current identity restores the original navy H and red swoosh from the recovered root `logo.png`, at the user's request. That canonical file remains byte-identical. The later black/green ChatGPT sources remain archived under `source/`; they no longer generate the shipped identity.

`mark-light.png` extracts the original colored artwork from its baked white tile and shadow. `mark-dark.png` places the same original colors on a white backing for contrast. No silhouette is redrawn. The live Latin wordmark remains Manrope Variable.

Run `python3 scripts/generate-brand-assets.py` with Pillow installed to regenerate web and Android assets. Centering uses the extracted artwork's alpha-weighted ink mass, rather than the bounding box of its long, thin swoosh. The optical offset is measured from the source, not hard-coded. Artwork is scaled down as necessary to fit a 44% radius on ordinary tiles and Android's 66/108-diameter safe circle on adaptive foregrounds. Android paints its own white adaptive and splash surface, so neither asset nests a second tile. Asset metadata records the source. Generated assets are committed; Pillow is not a production build dependency.

Navy `#122d4b` anchors primary controls and the login surface; the original red swoosh carries the brand accent. Operational GPS/shift green and destructive/error colors keep their separate meanings.

Manrope is distributed under SIL Open Font License 1.1; see `Manrope-LICENSE.txt`. All font files are served with the app, including Cyrillic and Latin extended subsets; no Google Fonts request is needed.
