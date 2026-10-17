"""Package the original navy H/red swoosh, without redrawing its silhouette.

Manual Python 3/Pillow tool; generated assets are committed, no build dependency.
The supplied navy/red artwork remains byte-identical in public/brand/source/supplied-navy-red.png.
"""
from pathlib import Path
from math import hypot
from PIL import Image, ImageDraw, PngImagePlugin

ROOT = Path(__file__).resolve().parents[1]
RES = ROOT / "android/app/src/main/res"
BRAND = ROOT / "public/brand"
ORIGIN = "User-supplied navy H/red swoosh; public/brand/source/supplied-navy-red.png; scripts/generate-brand-assets.py"


def save(image, path):
    path.parent.mkdir(parents=True, exist_ok=True)
    metadata = PngImagePlugin.PngInfo()
    metadata.add_text("Source", ORIGIN)
    metadata.add_text("impeccable:prompt", "Source: " + ORIGIN + "; preserve supplied RGB/alpha artwork, crop transparent margins, center visible ink mass and downsample inside the Android safe circle.")
    image.save(path, pnginfo=metadata)


def prepare(source):
    # The supplied artwork is already transparent. Preserve its exact RGB/A
    # pixels and only remove transparent margins before optical centering.
    image = Image.open(source).convert("RGBA")
    bbox = image.getchannel("A").getbbox()
    if bbox is None:
        raise ValueError("supplied logo has no visible pixels")
    cropped = image.crop(bbox)
    side = max(cropped.size)
    canvas = Image.new("RGBA", (side, side), (0, 0, 0, 0))
    canvas.alpha_composite(cropped, ((side-cropped.width)//2, (side-cropped.height)//2))
    return canvas


artwork = prepare(BRAND / "source/supplied-navy-red.png")


def ink_geometry(image):
    """The thin swoosh tip must not determine the apparent H's center."""
    alpha = image.getchannel("A")
    pixels = [(x, y, value) for y in range(image.height)
              for x in range(image.width) if (value := alpha.getpixel((x, y)))]
    weight = sum(value for _, _, value in pixels)
    center = (sum(x * value for x, _, value in pixels) / weight,
              sum(y * value for _, y, value in pixels) / weight)
    radius = max(hypot(x - center[0], y - center[1])
                 for x, y, value in pixels if value > 16)
    return center, radius


ARTWORK_CENTER, ARTWORK_RADIUS = ink_geometry(artwork)


def mark(size, foreground=False, round_icon=False, backing=True):
    image = Image.new("RGBA", (size, size))
    if not foreground and backing:
        draw = ImageDraw.Draw(image)
        if round_icon:
            draw.ellipse((0, 0, size-1, size-1), fill="white")
        else:
            draw.rounded_rectangle((0, 0, size-1, size-1), radius=round(size*0.2), fill="white")
    # Center alpha-weighted ink, not the silhouette box: its long narrow swoosh
    # makes box-centering visibly left-heavy. Derive the offset from the source,
    # rather than guessing a fixed horizontal nudge. The full silhouette stays
    # inside the 66/108 Android safe circle, including after optical centering.
    scale = min(size * (0.48 if foreground else 0.72) / artwork.width,
                size * (66 / 108 / 2 if foreground else 0.44) / ARTWORK_RADIUS)
    inner = max(1, round(artwork.width * scale))
    scaled = artwork.resize((inner, inner), Image.Resampling.LANCZOS)
    center_x, center_y = ARTWORK_CENTER
    offset = (round((size - 1) / 2 - ((center_x + 0.5) * inner / artwork.width - 0.5)),
              round((size - 1) / 2 - ((center_y + 0.5) * inner / artwork.height - 0.5)))
    image.alpha_composite(scaled, offset)
    return image


# Both modes use the original colors. A white backing on dark surfaces protects
# the navy mark's contrast without recoloring it or changing the silhouette.
save(mark(1024, backing=False), BRAND / "mark-light.png")
save(mark(1024), BRAND / "mark-dark.png")
for path in (ROOT / "public/img/icons").glob("*.png"):
    with Image.open(path) as old:
        size = old.width
    save(mark(size, foreground="maskable" in path.name, backing=True), path)
    # Maskable web icons need an opaque full square under the safe-area artwork.
    if "maskable" in path.name:
        icon = Image.new("RGBA", (size, size), "white")
        icon.alpha_composite(mark(size, foreground=True))
        save(icon, path)
for density, size in {"mdpi":48,"hdpi":72,"xhdpi":96,"xxhdpi":144,"xxxhdpi":192}.items():
    directory = RES / f"mipmap-{density}"
    save(mark(size), directory / "ic_launcher.png")
    save(mark(size, round_icon=True), directory / "ic_launcher_round.png")
    save(mark(round(size*108/48), foreground=True), directory / "ic_launcher_foreground.png")
# Android 12 already provides the launch surface: only transparent artwork here,
# not a second rounded tile inside the system splash icon.
save(mark(288, backing=False), RES / "drawable/splash_icon.png")
for path in RES.glob("drawable*/splash.png"):
    with Image.open(path) as old:
        width,height = old.size
    canvas = Image.new("RGBA", (width,height), "white")
    inner = round(min(width,height)*0.5)
    canvas.alpha_composite(mark(inner, backing=False), ((width-inner)//2,(height-inner)//2))
    save(canvas,path)
(RES / "drawable-v24/ic_launcher_foreground.xml").write_text(
    '<bitmap xmlns:android="http://schemas.android.com/apk/res/android" '
    'android:src="@mipmap/ic_launcher_foreground" android:gravity="fill"/>\n')
