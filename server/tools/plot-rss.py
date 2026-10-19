"""Графік rss сервера під час повільного завантаження 200 МБ логу.
Дані: docs/rss-pipeline.csv, docs/rss-naive.csv (їх пише server/experiments/rss-backpressure.js).
Запуск з кореня репозиторію: python3 server/tools/plot-rss.py"""
import csv
import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt


def read(path):
    with open(path) as f:
        rows = list(csv.DictReader(f))
    return [float(r["seconds"]) for r in rows], [float(r["rss_mb"]) for r in rows]


SURFACE, INK, MUTED, GRID = "#fcfcfb", "#0b0b0b", "#52514e", "#e6e5e0"
BLUE, ORANGE = "#2a78d6", "#eb6834"

tp, rp = read("docs/rss-pipeline.csv")
tn, rn = read("docs/rss-naive.csv")

fig, ax = plt.subplots(figsize=(8, 4.2), dpi=160, facecolor=SURFACE)
ax.set_facecolor(SURFACE)
ax.plot(tn, rn, color=ORANGE, lw=2, label="write() без перевірки")
ax.plot(tp, rp, color=BLUE, lw=2, label="pipeline (наш /api/replays/:id)")
ax.set_ylim(0, 300)
ax.set_xlim(0, 20)
ax.set_xlabel("секунди від початку завантаження 200 МБ (канал ≈ 10 МБ/с)", color=MUTED)
ax.set_ylabel("rss сервера, МБ", color=MUTED)
ax.set_title("Пам'ять сервера при повільному клієнті", loc="left", color=INK, fontsize=12, fontweight="bold")
ax.grid(axis="y", color=GRID, lw=0.8)
for side in ("top", "right", "left"):
    ax.spines[side].set_visible(False)
ax.spines["bottom"].set_color(GRID)
ax.tick_params(colors=MUTED, length=0)
ax.annotate(f"{rn[-1]:.0f} МБ — весь файл осів у пам'яті", (tn[-1], rn[-1]), xytext=(-6, 8),
            textcoords="offset points", ha="right", color=INK, fontsize=9)
ax.annotate(f"{rp[-1]:.0f} МБ — пласка лінія", (tp[-1], rp[-1]), xytext=(-6, 8),
            textcoords="offset points", ha="right", color=INK, fontsize=9)
ax.legend(loc="center right", frameon=False, labelcolor=INK, fontsize=9)
fig.tight_layout()
fig.savefig("docs/rss-backpressure.png", facecolor=SURFACE)
