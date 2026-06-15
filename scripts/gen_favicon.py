"""logo.svg のデザインを元に favicon.ico を生成する（Pillow 使用）。

使い方:
    python scripts/gen_favicon.py

frontend/static/favicon.ico を複数サイズ（16/32/48/64）入りで出力する。
"""
from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageDraw

ACCENT = (37, 99, 235, 255)   # #2563eb
WHITE = (255, 255, 255, 255)

S = 256  # 高解像度で描いてから縮小


def build() -> Image.Image:
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    # 背景の角丸スクエア
    d.rounded_rectangle([(0, 0), (S - 1, S - 1)], radius=56, fill=ACCENT)

    # チャットバブル（白の角丸）
    d.rounded_rectangle([(48, 60), (208, 168)], radius=30, fill=WHITE)
    # 吹き出しのしっぽ
    d.polygon([(92, 162), (92, 202), (132, 162)], fill=WHITE)

    # 3つのドット
    cy = 114
    r = 13
    for cx in (96, 128, 160):
        d.ellipse([(cx - r, cy - r), (cx + r, cy + r)], fill=ACCENT)

    return img


def main() -> None:
    out = Path("frontend/static/favicon.ico")
    out.parent.mkdir(parents=True, exist_ok=True)
    img = build()
    img.save(out, format="ICO", sizes=[(16, 16), (32, 32), (48, 48), (64, 64)])
    print(f"生成しました: {out.resolve()}")


if __name__ == "__main__":
    main()
