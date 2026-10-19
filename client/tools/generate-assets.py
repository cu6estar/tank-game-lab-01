#!/usr/bin/env python3
"""Генератор ассетів для lab-03: спрайтшит, атлас та звуки.

Усе намальовано/синтезовано кодом (оригінальна графіка, жодних сторонніх файлів),
результат детермінований (фіксований seed), тож перегенерація дає ті самі файли.

Запуск:  python3 tools/generate-assets.py
Потрібно: Pillow, numpy.
Вихід:    public/assets/sprites.png, sprites.json, shoot.wav, hit.wav, explosion.wav
"""

import json
import math
import wave
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

OUT = Path(__file__).resolve().parent.parent / "public" / "assets"
OUT.mkdir(parents=True, exist_ok=True)

SCALE = 2  # 1 логічна одиниця гри = 2 пікселі спрайта (різкість на retina)
SS = 4  # суперсемплінг для згладжування (малюємо в SS разів більше й зменшуємо)
K = SCALE * SS  # логічні одиниці -> піксель суперсемпла
PAD = 4  # прозорий відступ між кадрами в атласі (щоб сусіди не "підтікали")

rng = np.random.default_rng(20261007)


def hex_rgb(value, alpha=255):
    value = value.lstrip("#")
    return tuple(int(value[i : i + 2], 16) for i in (0, 2, 4)) + (alpha,)


def shade(color, factor):
    r, g, b, a = color
    return (
        max(0, min(255, int(r * factor))),
        max(0, min(255, int(g * factor))),
        max(0, min(255, int(b * factor))),
        a,
    )


def canvas(width, height):
    """Суперсемпл-полотно розміром у логічних одиницях (width x height)."""
    return Image.new("RGBA", (int(width * K), int(height * K)), (0, 0, 0, 0))


def finish(image):
    return image.resize((image.width // SS, image.height // SS), Image.LANCZOS)


def box(draw, x0, y0, x1, y1, ox, oy, **kw):
    """Прямокутник у логічних координатах з початком (ox, oy) у центрі."""
    draw.rectangle(
        [(x0 + ox) * K, (y0 + oy) * K, (x1 + ox) * K - 1, (y1 + oy) * K - 1], **kw
    )


def circle(draw, cx, cy, r, ox, oy, **kw):
    draw.ellipse(
        [(cx - r + ox) * K, (cy - r + oy) * K, (cx + r + ox) * K, (cy + r + oy) * K],
        **kw,
    )


# ---------------------------------------------------------------- корпус танка
def make_hull(hull, deck):
    """Вид зверху, ніс дивиться вправо (+x). Логічно 56x50, як у lab-01."""
    w, h = 56 + 4, 50 + 4
    ox, oy = w / 2, h / 2
    img = canvas(w, h)
    d = ImageDraw.Draw(img)

    track = hex_rgb("#161616")
    track_hi = hex_rgb("#343434")
    for y0, y1 in ((-25, -13), (13, 25)):
        box(d, -28, y0, 28, y1, ox, oy, fill=track)
        # траки: світліші поперечні смужки
        x = -26
        while x < 27:
            box(d, x, y0 + 1, x + 2, y1 - 1, ox, oy, fill=track_hi)
            x += 5
        box(d, -28, y0, 28, y0 + 1, ox, oy, fill=hex_rgb("#050505"))
        box(d, -28, y1 - 1, 28, y1, ox, oy, fill=hex_rgb("#050505"))

    box(d, -24, -18, 24, 18, ox, oy, fill=hull, outline=shade(hull, 0.55), width=K)
    # бронеплита спереду
    d.polygon(
        [
            ((14 + ox) * K, (-18 + oy) * K),
            ((24 + ox) * K, (-18 + oy) * K),
            ((24 + ox) * K, (18 + oy) * K),
            ((14 + ox) * K, (18 + oy) * K),
            ((18 + ox) * K, (0 + oy) * K),
        ],
        fill=shade(hull, 1.12),
    )
    box(d, -15, -13, 15, 13, ox, oy, fill=deck, outline=shade(deck, 0.6), width=K)
    # решітка двигуна ззаду
    for i in range(4):
        box(d, -13 + i * 2.2, -10, -12 + i * 2.2, 10, ox, oy, fill=shade(deck, 0.7))
    # заклепки
    for sx in (-21, 21):
        for sy in (-15, 15):
            circle(d, sx, sy, 1.1, ox, oy, fill=shade(hull, 1.35))
    return finish(img), (ox * SCALE, oy * SCALE)


# --------------------------------------------------------------------- башта
def make_turret(base, barrel):
    """Башта + ствол, центр обертання в центрі кола. Ствол вправо (+x)."""
    x_min, x_max, y_half = -17, 44, 17
    w, h = x_max - x_min, y_half * 2
    ox, oy = -x_min, y_half
    img = canvas(w, h)
    d = ImageDraw.Draw(img)

    box(d, 0, -4, 36, 4, ox, oy, fill=barrel, outline=shade(barrel, 0.5), width=K // 2)
    box(d, 34, -5.5, 42, 5.5, ox, oy, fill=shade(barrel, 1.25), outline=shade(barrel, 0.5), width=K // 2)
    circle(d, 0, 0, 15, ox, oy, fill=base, outline=shade(base, 0.5), width=K)
    circle(d, -2, -2, 10, ox, oy, fill=shade(base, 1.18))
    circle(d, 2, 1, 5.5, ox, oy, fill=shade(base, 0.62), outline=shade(base, 0.4), width=K // 2)
    circle(d, 2, 1, 2, ox, oy, fill=shade(base, 1.4))
    return finish(img), (ox * SCALE, oy * SCALE)


# ---------------------------------------------------------------------- кулі
def make_bullet(core, glow):
    """Куля зі шлейфом; "голова" в точці (20, 5), шлейф тягнеться вліво."""
    w, h = 26, 12
    head_x, head_y = 20, h / 2
    img = canvas(w, h)

    trail = Image.new("RGBA", img.size, (0, 0, 0, 0))
    td = ImageDraw.Draw(trail)
    steps = 40
    for i in range(steps):
        t = i / (steps - 1)  # 0 = хвіст, 1 = голова
        x = 1 + t * (head_x - 1)
        r = 0.6 + 2.6 * t
        a = int(220 * t ** 1.6)
        td.ellipse(
            [(x - r) * K, (head_y - r) * K, (x + r) * K, (head_y + r) * K],
            fill=glow[:3] + (a,),
        )
    img = Image.alpha_composite(img, trail)

    halo = Image.new("RGBA", img.size, (0, 0, 0, 0))
    hd = ImageDraw.Draw(halo)
    circle(hd, head_x, head_y, 5.2, 0, 0, fill=glow[:3] + (110,))
    halo = halo.filter(ImageFilter.GaussianBlur(K * 0.9))
    img = Image.alpha_composite(img, halo)

    d = ImageDraw.Draw(img)
    circle(d, head_x, head_y, 3.4, 0, 0, fill=core)
    circle(d, head_x + 0.6, head_y - 0.4, 1.7, 0, 0, fill=(255, 255, 255, 255))
    return finish(img), (head_x * SCALE, head_y * SCALE)


# ------------------------------------------------------------------ астероїди
def make_asteroid(seed, base, rim_light, seeker=False):
    """Кам'яна брила 192x192 з освітленням згори-ліворуч, кратерами й шумом."""
    local = np.random.default_rng(seed)
    size = 96  # логічно; фінальний кадр 192 px
    img_px = size * K
    cx = cy = img_px / 2
    radius = img_px * 0.46

    # нерівний контур
    n = 16
    angles = np.linspace(0, 2 * math.pi, n, endpoint=False)
    radii = radius * local.uniform(0.80, 1.0, n)
    pts = [(cx + math.cos(a) * r, cy + math.sin(a) * r) for a, r in zip(angles, radii)]

    mask_img = Image.new("L", (img_px, img_px), 0)
    ImageDraw.Draw(mask_img).polygon(pts, fill=255)
    mask_img = mask_img.filter(ImageFilter.GaussianBlur(K * 0.5))
    mask = np.asarray(mask_img, dtype=np.float32) / 255.0

    # "висота": розмита маска, а поверх — шум
    height = np.asarray(
        mask_img.filter(ImageFilter.GaussianBlur(K * 9)), dtype=np.float32
    ) / 255.0
    noise = local.normal(0, 1, (img_px // 8, img_px // 8)).astype(np.float32)
    noise_img = Image.fromarray(
        np.uint8(np.clip(128 + noise * 60, 0, 255))
    ).resize((img_px, img_px), Image.BICUBIC).filter(ImageFilter.GaussianBlur(K * 1.2))
    height = height * 0.9 + (np.asarray(noise_img, dtype=np.float32) / 255.0 - 0.5) * 0.25

    # кратери
    crater = Image.new("L", (img_px, img_px), 128)
    cd = ImageDraw.Draw(crater)
    for _ in range(int(local.integers(3, 6))):
        a = local.uniform(0, 2 * math.pi)
        dist = local.uniform(0, radius * 0.6)
        r = local.uniform(radius * 0.10, radius * 0.22)
        x, y = cx + math.cos(a) * dist, cy + math.sin(a) * dist
        cd.ellipse([x - r, y - r, x + r, y + r], fill=40)
        cd.ellipse([x - r * 0.75 + r * 0.25, y - r * 0.75 + r * 0.25,
                    x + r * 0.75 + r * 0.25, y + r * 0.75 + r * 0.25], fill=200)
    crater = crater.filter(ImageFilter.GaussianBlur(K * 1.0))
    height += (np.asarray(crater, dtype=np.float32) / 255.0 - 0.5) * 0.35

    # нормалі з висоти -> Ламберт, світло згори-ліворуч
    gy, gx = np.gradient(height)
    strength = 38.0
    nx, ny, nz = -gx * strength, -gy * strength, np.ones_like(height)
    length = np.sqrt(nx * nx + ny * ny + nz * nz)
    light = np.array([-0.55, -0.65, 0.52])
    light = light / np.linalg.norm(light)
    lambert = np.clip((nx * light[0] + ny * light[1] + nz * light[2]) / length, 0, 1)
    lit = 0.30 + 0.95 * lambert

    base_rgb = np.array(base[:3], dtype=np.float32)
    rgb = base_rgb[None, None, :] * lit[:, :, None]
    # світла кромка знизу праворуч (відбите світло) і темна обводка
    edge = np.clip(1.0 - height / (height.max() * 0.35 + 1e-6), 0, 1) * mask
    rgb += np.array(rim_light[:3], dtype=np.float32)[None, None, :] * (edge[:, :, None] * 0.18)

    if seeker:
        # розжарені тріщини для "переслідувача"
        glow = Image.new("RGBA", (img_px, img_px), (0, 0, 0, 0))
        gd = ImageDraw.Draw(glow)
        for _ in range(7):
            a = local.uniform(0, 2 * math.pi)
            x, y = cx, cy
            path = [(x, y)]
            for _ in range(int(local.integers(4, 7))):
                a += local.uniform(-0.7, 0.7)
                step = radius * local.uniform(0.12, 0.2)
                x, y = x + math.cos(a) * step, y + math.sin(a) * step
                path.append((x, y))
            gd.line(path, fill=(255, 150, 60, 255), width=int(K * 1.3))
        glow_blur = glow.filter(ImageFilter.GaussianBlur(K * 1.8))
        glow_a = np.asarray(glow_blur, dtype=np.float32)[:, :, 3:4] / 255.0
        glow_core = np.asarray(glow, dtype=np.float32)[:, :, 3:4] / 255.0
        rgb = rgb * (1 - glow_a * 0.55) + np.array([255, 110, 40], np.float32) * glow_a * 0.9
        rgb = rgb * (1 - glow_core) + np.array([255, 225, 150], np.float32) * glow_core

    rgb = np.clip(rgb, 0, 255)
    alpha = np.clip(mask * 255, 0, 255)
    out = np.dstack([rgb, alpha]).astype(np.uint8)
    img = Image.fromarray(out, "RGBA")

    # тонка темна обводка
    outline = Image.new("RGBA", img.size, (0, 0, 0, 0))
    ImageDraw.Draw(outline).polygon(pts, outline=shade(base, 0.35), width=int(K * 0.7))
    img = Image.alpha_composite(img, outline.filter(ImageFilter.GaussianBlur(K * 0.25)))

    final = img.resize((img_px // SS, img_px // SS), Image.LANCZOS)
    return final, (final.width / 2, final.height / 2)


# --------------------------------------------------------------------- атлас
def build_sprites():
    frames = []  # (name, image, (pivot_x, pivot_y))

    for team, hull, deck, turret, barrel in (
        ("player", "#4f7f45", "#6f9c5e", "#3d6337", "#293f25"),
        ("enemy", "#8a4a3a", "#b0665a", "#6b3329", "#43201a"),
    ):
        img, pivot = make_hull(hex_rgb(hull), hex_rgb(deck))
        frames.append((f"hull_{team}", img, pivot))
        img, pivot = make_turret(hex_rgb(turret), hex_rgb(barrel))
        frames.append((f"turret_{team}", img, pivot))

    for name, core, glow in (
        ("bullet_player", hex_rgb("#ffe56a"), hex_rgb("#ffb62e")),
        ("bullet_enemy", hex_rgb("#ff9a7a"), hex_rgb("#ff4a2a")),
        ("bullet_homing", hex_rgb("#ff9be6"), hex_rgb("#ff2fc4")),
    ):
        img, pivot = make_bullet(core, glow)
        frames.append((name, img, pivot))

    rocks = (
        ("asteroid_0", 11, "#8b8175", "#d9cbb8", False),
        ("asteroid_1", 23, "#74695e", "#cbb9a0", False),
        ("asteroid_2", 37, "#8a7b6d", "#e0cfb6", False),
        ("asteroid_seeker", 53, "#6d3a34", "#ff9a6a", True),
    )
    for name, seed, base, rim, seeker in rocks:
        img, pivot = make_asteroid(seed, hex_rgb(base), hex_rgb(rim), seeker)
        frames.append((name, img, pivot))

    # shelf-упаковка в аркуш 1024 px завширшки
    sheet_w = 1024
    x = y = row_h = PAD
    placed = []
    for name, img, pivot in sorted(frames, key=lambda f: -f[1].height):
        if x + img.width + PAD > sheet_w:
            x = PAD
            y += row_h + PAD
            row_h = 0
        placed.append((name, img, pivot, x, y))
        x += img.width + PAD
        row_h = max(row_h, img.height)
    sheet_h = y + row_h + PAD

    sheet = Image.new("RGBA", (sheet_w, sheet_h), (0, 0, 0, 0))
    atlas = {"image": "sprites.png", "scale": SCALE, "frames": {}}
    for name, img, pivot, px, py in placed:
        sheet.alpha_composite(img, (px, py))
        atlas["frames"][name] = {
            "x": px, "y": py, "w": img.width, "h": img.height,
            "ax": round(pivot[0], 2), "ay": round(pivot[1], 2),
        }

    sheet.save(OUT / "sprites.png", optimize=True)
    (OUT / "sprites.json").write_text(
        json.dumps(atlas, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
    )
    print(f"sprites.png {sheet_w}x{sheet_h}, {len(placed)} кадрів")


# --------------------------------------------------------------------- звуки
RATE = 22050


def lowpass(signal, cutoff):
    """Однополюсний фільтр низьких частот; cutoff — масив (Гц) або число."""
    out = np.zeros_like(signal)
    cut = np.broadcast_to(cutoff, signal.shape)
    acc = 0.0
    for i, s in enumerate(signal):
        alpha = 1 - math.exp(-2 * math.pi * float(cut[i]) / RATE)
        acc += alpha * (s - acc)
        out[i] = acc
    return out


def write_wav(name, samples, peak=0.8):
    samples = samples / (np.max(np.abs(samples)) + 1e-9) * peak
    data = np.int16(np.clip(samples, -1, 1) * 32767)
    with wave.open(str(OUT / name), "wb") as f:
        f.setnchannels(1)
        f.setsampwidth(2)
        f.setframerate(RATE)
        f.writeframes(data.tobytes())
    print(f"{name} {len(data) / RATE:.2f} с, {(OUT / name).stat().st_size // 1024} KiB")


def build_sounds():
    local = np.random.default_rng(7)

    # постріл: швидкий спад частоти + короткий "клац"
    n = int(RATE * 0.20)
    t = np.arange(n) / RATE
    freq = 1100 * np.exp(-t * 13) + 160
    phase = 2 * math.pi * np.cumsum(freq) / RATE
    tone = np.sign(np.sin(phase)) * 0.45 + np.sin(phase) * 0.55
    click = local.normal(0, 1, n) * np.exp(-t * 90)
    write_wav("shoot.wav", (tone * np.exp(-t * 14) + click * 0.7))

    # влучання: глухий удар + шматочок шуму
    n = int(RATE * 0.16)
    t = np.arange(n) / RATE
    thump = np.sin(2 * math.pi * (190 * np.exp(-t * 18) + 70) * t) * np.exp(-t * 26)
    crack = lowpass(local.normal(0, 1, n), 3500) * np.exp(-t * 45)
    write_wav("hit.wav", thump + crack * 0.8)

    # вибух: шум, що "темнішає", + низький гул
    n = int(RATE * 0.9)
    t = np.arange(n) / RATE
    noise = local.normal(0, 1, n)
    body = lowpass(noise, 2600 * np.exp(-t * 4.2) + 110) * np.exp(-t * 3.4)
    rumble = np.sin(2 * math.pi * (58 * np.exp(-t * 1.4) + 24) * t) * np.exp(-t * 2.4)
    initial = lowpass(noise, 6000) * np.exp(-t * 60)
    write_wav("explosion.wav", body * 1.0 + rumble * 0.9 + initial * 0.6)


if __name__ == "__main__":
    build_sprites()
    build_sounds()
