# -*- coding: utf-8 -*-
"""Generate the add-on's static artwork (dev-only helper, not used at runtime).

    python3 kodi-addon/tools/make-assets.py

Requires Pillow, which is why it lives in tools/ and is never imported by the
add-on: the add-on itself is standard library only.  The generated
resources/icon.png (512x512) and resources/fanart.jpg (1920x1080) are committed,
so installing the add-on needs no artwork step.
"""

from __future__ import annotations

import os

from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
RESOURCES = os.path.join(os.path.dirname(HERE), "program.dsh", "resources")
FONT_BOLD = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"
FONT_REGULAR = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"

BACKGROUND = (16, 19, 26)
ACCENT = (72, 132, 255)
ACCENT_ALT = (140, 92, 255)
TEXT = (245, 247, 252)
MUTED = (150, 158, 175)


def _font(path, size):
    try:
        return ImageFont.truetype(path, size)
    except OSError:
        return ImageFont.load_default()


def _gradient(size, top, bottom):
    width, height = size
    image = Image.new("RGB", size, top)
    draw = ImageDraw.Draw(image)
    for y in range(height):
        ratio = y / float(max(1, height - 1))
        colour = tuple(int(round(top[i] + (bottom[i] - top[i]) * ratio)) for i in range(3))
        draw.line([(0, y), (width, y)], fill=colour)
    return image


def _centered(draw, box, text, font, fill):
    left, top, right, bottom = box
    width, height = draw.textbbox((0, 0), text, font=font)[2:]
    draw.text((left + (right - left - width) / 2.0, top + (bottom - top - height) / 2.0), text, font=font, fill=fill)


def make_icon(path):
    size = (512, 512)
    image = _gradient(size, (24, 28, 38), BACKGROUND)
    draw = ImageDraw.Draw(image)
    # Accent bar: two stacked rounded rectangles read as a progress bar on a TV.
    draw.rounded_rectangle([64, 92, 448, 108], radius=8, fill=ACCENT)
    draw.rounded_rectangle([64, 92, 300, 108], radius=8, fill=ACCENT_ALT)
    _centered(draw, (0, 130, 512, 330), "DSH", _font(FONT_BOLD, 186), TEXT)
    _centered(draw, (0, 330, 512, 400), "KODI", _font(FONT_BOLD, 54), MUTED)
    draw.rounded_rectangle([64, 404, 448, 440], radius=18, outline=ACCENT, width=4)
    _centered(draw, (64, 404, 448, 440), "ASK · PICK · PLAY", _font(FONT_REGULAR, 26), MUTED)
    image.save(path, "PNG", optimize=True)
    return path


def make_fanart(path):
    size = (1920, 1080)
    image = _gradient(size, (22, 26, 36), (8, 9, 13))
    draw = ImageDraw.Draw(image)
    for index, colour in enumerate((ACCENT, ACCENT_ALT)):
        draw.rounded_rectangle([140, 330 + index * 26, 140 + (620 - index * 210), 348 + index * 26], radius=9, fill=colour)
    draw.text((140, 390), "DSH", font=_font(FONT_BOLD, 300), fill=TEXT)
    draw.text((150, 730), "DeepSeek Harness on Kodi", font=_font(FONT_REGULAR, 64), fill=MUTED)
    draw.text(
        (150, 830),
        "Ask the agent from the sofa. Pick something for tonight. Resume where you stopped.",
        font=_font(FONT_REGULAR, 38),
        fill=MUTED,
    )
    draw.rounded_rectangle([140, 250, 1780, 254], radius=2, outline=ACCENT)
    image.save(path, "JPEG", quality=90, optimize=True)
    return path


if __name__ == "__main__":
    os.makedirs(RESOURCES, exist_ok=True)
    print(make_icon(os.path.join(RESOURCES, "icon.png")))
    print(make_fanart(os.path.join(RESOURCES, "fanart.jpg")))
