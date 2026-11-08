#!/usr/bin/env python3
"""Графіки лаби 7. Числа — з `npm run bench:load` і `npm run bench:collision`.
   Запуск:  python3 docs/lab-07-charts.py  →  docs/lab-07-perf.png
"""
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

# --- навантаження: клієнти (кімнати по 8) vs час тіку, мс -------------------
clients = [8, 32, 64, 128]
p50 = [0.10, 0.23, 0.49, 1.01]
p95 = [0.40, 0.54, 1.07, 1.78]
p99 = [2.69, 0.82, 1.47, 2.14]
BUDGET = 33.33

# --- колізії: N сутностей, наївний O(n²) vs просторова сітка, мс ------------
N = [50, 100, 200, 400, 800, 1600]
naive = [0.033, 0.047, 0.191, 0.90, 3.79, 13.80]
grid = [0.054, 0.042, 0.102, 0.271, 0.597, 1.199]

fig, (ax1, ax2) = plt.subplots(1, 2, figsize=(11, 4.2))

ax1.plot(clients, p50, "o-", label="p50")
ax1.plot(clients, p95, "s-", label="p95")
ax1.plot(clients, p99, "^-", label="p99")
ax1.axhline(BUDGET, ls="--", color="crimson", label=f"бюджет {BUDGET:.1f} мс")
ax1.set_title("Навантаження: час тіку vs клієнти")
ax1.set_xlabel("клієнтів (кімнати по 8)")
ax1.set_ylabel("час тіку, мс")
ax1.set_xticks(clients)
ax1.set_ylim(0, 36)
ax1.legend()
ax1.grid(alpha=0.3)
ax1.annotate("усі перцентилі < 2.7 мс:\n~12× запас до бюджету",
             xy=(128, 2.14), xytext=(40, 12),
             arrowprops=dict(arrowstyle="->", color="gray"), fontsize=9, color="gray")

ax2.plot(N, naive, "o-", color="crimson", label="наївний O(n²)")
ax2.plot(N, grid, "s-", color="seagreen", label="просторова сітка")
ax2.set_title("Колізії: наївний O(n²) vs сітка")
ax2.set_xlabel("сутностей N")
ax2.set_ylabel("час одного проходу, мс")
ax2.set_xscale("log"); ax2.set_yscale("log")
ax2.legend()
ax2.grid(alpha=0.3, which="both")
ax2.annotate("×11 при N=1600", xy=(1600, 1.2), xytext=(300, 6),
             arrowprops=dict(arrowstyle="->", color="gray"), fontsize=9, color="gray")

fig.tight_layout()
fig.savefig("docs/lab-07-perf.png", dpi=110)
print("wrote docs/lab-07-perf.png")
