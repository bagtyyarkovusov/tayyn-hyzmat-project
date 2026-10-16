"""Package the user-supplied ChatGPT H-and-swoosh artwork without redrawing it.
Manual Python 3/Pillow tool; generated assets are committed, no build dependency.
Original uploads remain byte-identical under public/brand/source/.
"""
from collections import deque
from pathlib import Path
import xml.etree.ElementTree as ET
from PIL import Image, ImageDraw, PngImagePlugin

ROOT = Path(__file__).resolve().parents[1]
RES = ROOT / "android/app/src/main/res"
BRAND = ROOT / "public/brand"
ORIGIN = "User-supplied ChatGPT H-and-swoosh logo; public/brand/source/supplied-light.png and supplied-dark.png; scripts/generate-brand-assets.py"


def save(image, path):
    path.parent.mkdir(parents=True, exist_ok=True)
    metadata = PngImagePlugin.PngInfo()
    metadata.add_text("Source", ORIGIN)
    metadata.add_text("impeccable:prompt", "Source: " + ORIGIN + "; preserve supplied artwork; trim transparent margins, center and downsample only.")
    image.save(path, pnginfo=metadata)


def prepare(source):
    image = Image.open(source).convert("RGBA")
    # Remove detached alpha specks, never redraw or recolor the supplied shapes.
    # The four intended H/swoosh components each contain thousands of pixels.
    alpha = image.getchannel("A")
    width, height = image.size
    pixels = alpha.load()
    seen = bytearray(width * height)
    retained = Image.new("L", image.size)
    output = retained.load()
    for y in range(height):
        for x in range(width):
            index = y * width + x
            if seen[index] or pixels[x, y] < 16:
                continue
            seen[index] = 1
            queue = deque([(x, y)])
            component = []
            while queue:
                px, py = queue.popleft()
                component.append((px, py))
                for nx, ny in [(px-1, py), (px+1, py), (px, py-1), (px, py+1)]:
                    if 0 <= nx < width and 0 <= ny < height:
                        ni = ny * width + nx
                        if not seen[ni] and pixels[nx, ny] >= 16:
                            seen[ni] = 1
                            queue.append((nx, ny))
            if len(component) >= 64:
                for px, py in component:
                    output[px, py] = pixels[px, py]
    # Keep original edge alpha around retained shapes, including antialiasing.
    from PIL import ImageFilter, ImageChops
    edge = retained.filter(ImageFilter.MaxFilter(3)).point(lambda value: 255 if value else 0)
    image.putalpha(ImageChops.multiply(alpha, edge))
    bbox = image.getchannel("A").getbbox()
    cropped = image.crop(bbox)
    side = max(cropped.size)
    canvas = Image.new("RGBA", (side, side))
    canvas.alpha_composite(cropped, ((side-cropped.width)//2, (side-cropped.height)//2))
    return canvas


light = prepare(BRAND / "source/supplied-light.png")
dark = prepare(BRAND / "source/supplied-dark.png")
# A fixed 12% transparent margin keeps the in-app mark comfortably aligned.
for image, name in [(light, "mark-light.png"), (dark, "mark-dark.png")]:
    canvas = Image.new("RGBA", (1024, 1024))
    mark = image.resize((778, 778), Image.Resampling.LANCZOS)
    canvas.alpha_composite(mark, (123, 123))
    save(canvas, BRAND / name)


def mark(size, foreground=False, round_icon=False, android=False):
    image = Image.new("RGBA", (size, size))
    if not foreground:
        draw = ImageDraw.Draw(image)
        if round_icon:
            draw.ellipse((0, 0, size-1, size-1), fill="white")
        else:
            draw.rounded_rectangle((0, 0, size-1, size-1), radius=round(size*0.2), fill="white")
    # Android's launcher mask centers the bitmap box, but the supplied H and
    # rising swoosh carry more visual weight on the left.  Apply a small
    # optical correction to the Android rasters only so the mark reads
    # centered inside the launcher/splash safe area.  The source artwork and
    # the web mark remain unchanged.
    ratio = 0.48 if foreground and android else 0.54 if foreground else 0.76
    inner = max(1, round(size * ratio))
    artwork = light.resize((inner, inner), Image.Resampling.LANCZOS)
    optical_shift = round(size * (0.065 if foreground else 0.10)) if android else 0
    image.alpha_composite(
        artwork,
        ((size-inner)//2 + optical_shift, (size-inner)//2),
    )
    return image


for path in (ROOT / "public/img/icons").glob("*.png"):
    with Image.open(path) as old:
        size = old.width
    save(mark(size), path)
for density, size in {"mdpi":48,"hdpi":72,"xhdpi":96,"xxhdpi":144,"xxxhdpi":192}.items():
    directory = RES / f"mipmap-{density}"
    save(mark(size, android=True), directory / "ic_launcher.png")
    save(mark(size, round_icon=True, android=True), directory / "ic_launcher_round.png")
    save(mark(round(size*108/48), foreground=True, android=True), directory / "ic_launcher_foreground.png")
save(mark(288, android=True), RES / "drawable/splash_icon.png")
for path in RES.glob("drawable*/splash.png"):
    with Image.open(path) as old:
        width,height = old.size
    canvas = Image.new("RGBA", (width,height), "white")
    inner = round(min(width,height)*0.28)
    canvas.alpha_composite(mark(inner, android=True), ((width-inner)//2,(height-inner)//2))
    save(canvas,path)
# This fallback references the same supplied-artwork raster as the adaptive icon.
(RES / "drawable-v24/ic_launcher_foreground.xml").write_text(
    '<bitmap xmlns:android="http://schemas.android.com/apk/res/android" '
    'android:src="@mipmap/ic_launcher_foreground" android:gravity="fill"/>\n')
