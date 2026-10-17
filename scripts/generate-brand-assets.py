"""Package the original navy H/red swoosh, without redrawing its silhouette.

Manual Python 3/Pillow tool; generated assets are committed, no build dependency.
The canonical recovered root logo.png remains byte-identical.
"""
from pathlib import Path
from PIL import Image, ImageDraw, PngImagePlugin

ROOT = Path(__file__).resolve().parents[1]
RES = ROOT / "android/app/src/main/res"
BRAND = ROOT / "public/brand"
ORIGIN = "Original recovered Tayyn Hyzmat navy H/red swoosh; logo.png; scripts/generate-brand-assets.py"


def save(image, path):
    path.parent.mkdir(parents=True, exist_ok=True)
    metadata = PngImagePlugin.PngInfo()
    metadata.add_text("Source", ORIGIN)
    metadata.add_text("impeccable:prompt", "Source: " + ORIGIN + "; extract original colored artwork from white tile, preserve shapes and colors, center visible bounds and downsample.")
    image.save(path, pnginfo=metadata)


def prepare(source):
    image = Image.open(source).convert("RGBA")
    extracted = []
    # The source has a neutral white tile and gray drop shadow. Chroma separates
    # its original navy/red artwork from that baked background. Unmatting edge
    # pixels avoids a white fringe when the transparent result is downsampled.
    for r, g, b, _ in image.getdata():
        chroma = max(r, g, b) - min(r, g, b)
        if chroma <= 8:
            extracted.append((0, 0, 0, 0))
            continue
        coverage = min(1.0, chroma / (190 if r > b else 45))
        rgb = tuple(round(max(0, min(255, 255 + (c - 255) / coverage))) for c in (r, g, b))
        extracted.append((*rgb, round(255 * coverage)))
    image.putdata(extracted)
    cropped = image.crop(image.getchannel("A").getbbox())
    side = max(cropped.size)
    canvas = Image.new("RGBA", (side, side))
    canvas.alpha_composite(cropped, ((side-cropped.width)//2, (side-cropped.height)//2))
    return canvas


artwork = prepare(ROOT / "logo.png")


def mark(size, foreground=False, round_icon=False, backing=True):
    image = Image.new("RGBA", (size, size))
    if not foreground and backing:
        draw = ImageDraw.Draw(image)
        if round_icon:
            draw.ellipse((0, 0, size-1, size-1), fill="white")
        else:
            draw.rounded_rectangle((0, 0, size-1, size-1), radius=round(size*0.2), fill="white")
    # Center the EXTRACTED artwork, never the off-centre source tile. No fixed
    # optical offsets. 48% adaptive foreground stays inside Android's mask-safe
    # circle; ordinary icons use 72% of their tile. The tile is painted once.
    inner = max(1, round(size * (0.48 if foreground else 0.72)))
    scaled = artwork.resize((inner, inner), Image.Resampling.LANCZOS)
    image.alpha_composite(scaled, ((size-inner)//2, (size-inner)//2))
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
    inner = round(min(width,height)*0.28)
    canvas.alpha_composite(mark(inner, backing=False), ((width-inner)//2,(height-inner)//2))
    save(canvas,path)
(RES / "drawable-v24/ic_launcher_foreground.xml").write_text(
    '<bitmap xmlns:android="http://schemas.android.com/apk/res/android" '
    'android:src="@mipmap/ic_launcher_foreground" android:gravity="fill"/>\n')
