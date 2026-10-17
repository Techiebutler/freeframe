"""Bounded filename footer for public OG images only. Never writes to storage."""
from io import BytesIO
import unicodedata

from PIL import Image, ImageDraw, ImageFont, ImageOps

MAX_PREVIEW_IMAGE_BYTES = 4 * 1024 * 1024
MAX_PREVIEW_PIXELS = 16_000_000
MAX_PREVIEW_DIMENSION = 8192
PREVIEW_FONT_PATH = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"


def fit_preview_label(name: str, font: ImageFont.FreeTypeFont, width: int) -> str:
    # Strip control/bidi characters and collapse whitespace into a single line.
    text = unicodedata.normalize("NFC", name[:2048])
    text = "".join(" " if ch.isspace() else ch for ch in text if ch.isspace() or not unicodedata.category(ch).startswith("C"))
    text = " ".join(text.split())
    truncated = len(text) > 512
    text = text[:512]
    if not truncated and font.getlength(text) <= width:
        return text
    while text and font.getlength(text + "…") > width:
        text = text[:-1]
    return text + "…"


def compose_preview_image(data: bytes, filename: str) -> bytes | None:
    """Return a fresh JPEG, or None so the caller serves the original image.

    Limit compressed input and inspect dimensions BEFORE decoding pixels.
    Output is fixed-size, single-frame and metadata-free. DejaVu covers Polish.
    Missing fonts, unsupported images and decoding failures are non-fatal.
    """
    if not filename or len(data) > MAX_PREVIEW_IMAGE_BYTES:
        return None
    try:
        with Image.open(BytesIO(data)) as source:
            width, height = source.size
            if max(width, height) > MAX_PREVIEW_DIMENSION or width * height > MAX_PREVIEW_PIXELS:
                return None
            frame = ImageOps.exif_transpose(source).convert("RGBA")
            frame = ImageOps.contain(frame, (1200, 554), Image.Resampling.LANCZOS)
            canvas = Image.new("RGB", (1200, 630), (20, 22, 27))
            canvas.paste(frame, ((1200 - frame.width) // 2, (554 - frame.height) // 2), frame)
            font = ImageFont.truetype(PREVIEW_FONT_PATH, 32)
            label = fit_preview_label(filename, font, 1136)
            draw = ImageDraw.Draw(canvas)
            draw.rectangle((0, 554, 1200, 630), fill=(20, 22, 27))
            draw.text((32, 592), label, font=font, fill=(245, 245, 247), anchor="lm")
            output = BytesIO()
            canvas.save(output, "JPEG", quality=88)
            return output.getvalue()
    except Exception:
        return None
