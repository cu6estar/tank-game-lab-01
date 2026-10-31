import type { NetGame } from './net/net-game.ts';
import { MODES } from './net/net-game.ts';
import type { LagKey } from './net/lag.ts';
import type { Mode } from './net/scene.ts';

const HISTORY = 120; // точок на графіку (≈30 с при оновленні 4 рази/с)
const MODE_LABELS: Record<Mode, string> = {
  dumb: 'M1 тупий клієнт',
  predict: 'M2 передбачення',
  full: 'M3 передбачення + інтерполяція',
};

const fmt = (value: number | null | undefined, digits = 0, unit = ''): string =>
  value === null || value === undefined || Number.isNaN(value) ? '—' : `${value.toFixed(digits)}${unit}`;

export interface Netgraph {
  bind(netGame: NetGame): void;
  unbind(): void;
  toggle(): void;
}

/**
 * Netgraph: живі цифри мережі (RTT, вік знімка, трафік, черга вводів, корекція)
 * + елементи керування (режим, затримка інтерполяції, інжектор лагу).
 */
export function createNetgraph(root: HTMLElement): Netgraph {
  root.innerHTML = `
    <div class="ng-title">NETGRAPH <small>(N — сховати)</small></div>
    <pre class="ng-text" id="ng-text"></pre>
    <canvas class="ng-canvas" width="260" height="56"></canvas>
    <div class="ng-legend"><i style="color:#5fb8ff">■</i> RTT <i style="color:#ffb454">■</i> корекція <i style="color:#7ee787">■</i> інтервал знімків</div>
    <details class="ng-controls">
      <summary>керування (режим, затримка, лаг)</summary>
    <label>режим
      <select data-ng="mode">${MODES.map((m) => `<option value="${m}">${MODE_LABELS[m]}</option>`).join('')}</select>
    </label>
    <label>затримка інтерполяції <b data-out="delay"></b>
      <input type="range" data-ng="delay" min="0" max="300" step="5" />
    </label>
    <label>lag (RTT +) <b data-out="lag"></b>
      <input type="range" data-ng="lag" min="0" max="400" step="10" />
    </label>
    <label>jitter ± <b data-out="jitter"></b>
      <input type="range" data-ng="jitter" min="0" max="100" step="5" />
    </label>
    <label>втрата пакетів <b data-out="drop"></b>
      <input type="range" data-ng="drop" min="0" max="30" step="1" />
    </label>
    </details>
  `;

  const textEl = root.querySelector<HTMLElement>('#ng-text');
  const canvas = root.querySelector<HTMLCanvasElement>('canvas');
  const ctx = canvas?.getContext('2d') ?? null;
  const history: Record<'rtt' | 'correction' | 'interval', number[]> = { rtt: [], correction: [], interval: [] };
  let game: NetGame | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  let controller: AbortController | null = null;

  const control = (name: string): HTMLInputElement | null => root.querySelector<HTMLInputElement>(`[data-ng="${name}"]`);
  const setOut = (name: string, value: string): void => {
    const node = root.querySelector<HTMLElement>(`[data-out="${name}"]`);
    if (node) node.textContent = value;
  };

  function push(list: number[], value: number | null): void {
    list.push(value ?? 0);
    if (list.length > HISTORY) list.shift();
  }

  function plot(): void {
    if (!canvas || !ctx) return;
    const { width, height } = canvas;
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = 'rgba(255,255,255,0.04)';
    ctx.fillRect(0, 0, width, height);

    const series: [number[], string, number][] = [
      [history.rtt, '#5fb8ff', 300],
      [history.correction, '#ffb454', 10],
      [history.interval, '#7ee787', 150],
    ];
    for (const [data, color, max] of series) {
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      data.forEach((value, i) => {
        const x = (i / (HISTORY - 1)) * width;
        const y = height - Math.min(1, value / max) * (height - 2) - 1;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.stroke();
    }
  }

  function refresh(): void {
    if (!game) return;
    const s = game.stats();
    push(history.rtt, s.rtt);
    push(history.correction, s.correction);
    push(history.interval, s.snapshotInterval);

    if (textEl) {
      textEl.textContent = [
        `режим      ${s.mode}   кодек ${s.codec}   ${s.state}`,
        `RTT        ${fmt(s.rtt, 0, ' мс')}  (сер. ${fmt(s.rttAvg, 0)})`,
        `знімок     вік ${fmt(s.snapshotAge, 0, ' мс')}  інтервал ${fmt(s.snapshotInterval, 1, ' мс')}`,
        `           ${fmt(s.snapshotsPerSec, 0)}/с  втрачено ${s.missed}  голод ${s.starved}`,
        `трафік     ↓ ${fmt(s.bytesIn, 0, ' Б/с')}  ↑ ${fmt(s.bytesOut, 0, ' Б/с')}`,
        `черга вв.  ${s.inputQueue}  (непідтверджені)`,
        `корекція   ${fmt(s.correction, 1, ' px')}  макс ${fmt(s.correctionMax, 1)}`,
        `інтерп.    ${s.delay} мс в минулому   буфер ${s.buffered}`,
        `інжектор   lag ${s.lag.lag} ±${s.lag.jitter} drop ${s.lag.drop}% (-${s.lagStats.dropped})`,
      ].join('\n');
    }

    setOut('delay', `${s.delaySetting} мс`);
    setOut('lag', `${s.lag.lag} мс`);
    setOut('jitter', `±${s.lag.jitter} мс`);
    setOut('drop', `${s.lag.drop}%`);
    plot();
  }

  return {
    bind(netGame: NetGame): void {
      game = netGame;
      controller?.abort();
      controller = new AbortController();
      const { signal } = controller;

      const modeEl = control('mode');
      const delayEl = control('delay');
      if (modeEl) {
        modeEl.value = netGame.mode;
        modeEl.addEventListener('change', () => netGame.setMode(modeEl.value), { signal });
      }
      if (delayEl) {
        delayEl.value = String(netGame.delayMs);
        delayEl.addEventListener('input', () => netGame.setDelay(delayEl.value), { signal });
      }
      for (const key of ['lag', 'jitter', 'drop'] as LagKey[]) {
        const el = control(key);
        if (!el) continue;
        el.value = String(netGame.lag.config[key]);
        el.addEventListener('input', () => netGame.lag.configure({ [key]: el.value }), { signal });
      }
      // слайдери не повинні "красти" клавіатуру в гри (стрілки рухають повзунок)
      root.addEventListener('keydown', (e) => e.stopPropagation(), { signal });
      root.addEventListener(
        'change',
        (e) => {
          const target = e.target;
          if (target instanceof HTMLElement) target.blur();
        },
        { signal },
      );

      if (timer) clearInterval(timer);
      timer = setInterval(refresh, 250);
      refresh();
    },
    unbind(): void {
      game = null;
      controller?.abort();
      if (timer) clearInterval(timer);
      timer = null;
    },
    toggle(): void {
      root.hidden = !root.hidden;
    },
  };
}
