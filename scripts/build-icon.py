from pathlib import Path
from PIL import Image, ImageDraw
import io, struct

ROOT = Path(__file__).resolve().parents[1]
ASSETS = ROOT / "build"
ASSETS.mkdir(exist_ok=True)

size = 1024
image = Image.new("RGBA", (size, size), (0, 0, 0, 0))
pixels = image.load()

for y in range(96, 928):
    for x in range(96, 928):
        dx = min(x - 96, 927 - x)
        dy = min(y - 96, 927 - y)
        radius = 184
        if dx < radius and dy < radius and (dx - radius) ** 2 + (dy - radius) ** 2 > radius ** 2:
            continue
        blend = (x + y - 192) / 1662
        pixels[x, y] = (
            round(91 + 48 * blend),
            round(60 + 24 * blend),
            round(196 + 39 * blend),
            255,
        )

draw = ImageDraw.Draw(image)
draw.arc((252, 238, 772, 786), 48, 312, fill=(238, 248, 255, 255), width=112)
draw.rounded_rectangle((420, 386, 724, 462), radius=38, fill=(119, 234, 255, 255))
draw.rounded_rectangle((420, 540, 650, 616), radius=38, fill=(238, 248, 255, 255))
draw.rounded_rectangle((650, 540, 724, 616), radius=38, fill=(119, 234, 255, 255))

png_path = ASSETS / "caps-icon.png"
ico_path = ASSETS / "caps-icon.ico"
image.save(png_path, optimize=True)
frames = []
for n in [16, 20, 24, 32, 40, 48, 64, 256]:
    if n <= 24:
        # Pixel-aligned optical masters, not filtered reductions of the large art.
        im = Image.new("RGBA", (n, n), (0, 0, 0, 0))
        d = ImageDraw.Draw(im)
        bg, white, cyan = (113, 74, 210, 255), (246, 248, 255, 255), (119, 234, 255, 255)
        d.rounded_rectangle((1, 1, n-2, n-2), radius=3 if n == 16 else 4, fill=bg)
        x, y, t = {16: (4, 4, 2), 20: (5, 5, 2), 24: (6, 5, 3)}[n]
        d.rounded_rectangle((x, y, n-x-1, n-y-1), radius=t+1, fill=white)
        d.rounded_rectangle((x+t, y+t, n-x-t-1, n-y-t-1), radius=1, fill=bg)
        d.rectangle((n//2, y+t, n-x, n-y-t-1), fill=bg)
        d.rectangle((n//2, n//2-2, n-x, n//2-1), fill=cyan)
        d.rectangle((n//2, n//2+1, n-x-1, n//2+2), fill=white)
    else:
        im = image.resize((n, n), Image.Resampling.LANCZOS)
    frames.append((n, im))
# Write each optical master unchanged as its own PNG-backed ICO entry.
payloads = []
for n, im in frames:
    buffer = io.BytesIO(); im.save(buffer, format="PNG"); payloads.append(buffer.getvalue())
offset = 6 + 16 * len(frames)
with ico_path.open("wb") as f:
    f.write(struct.pack("<HHH", 0, 1, len(frames)))
    for (n, _), payload in zip(frames, payloads):
        f.write(struct.pack("<BBBBHHII", n if n < 256 else 0, n if n < 256 else 0, 0, 0, 1, 32, len(payload), offset)); offset += len(payload)
    for payload in payloads: f.write(payload)
qa = ROOT / "data" / "ui-qa" / "round3" / "icons"
qa.mkdir(parents=True, exist_ok=True)
for n, _ in frames:
    # Inspect the actual encoded ICO, rather than the pre-encoding image.
    extracted = Image.open(ico_path).ico.getimage((n, n)); extracted.save(qa / f"icon-{n}.png")
    extracted.resize((n*8, n*8), Image.Resampling.NEAREST).save(qa / f"icon-{n}-8x.png")
print(png_path)
print(ico_path)
