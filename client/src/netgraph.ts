import { MODES } from './net/net-game.ts';

const HISTORY = 120; // точок на графіку (≈30 с при оновленні 4 рази/с)
const MODE_LABELS = {
  dumb: 'M1 тупий клієнт',
  predict: 'M2 передбачення',
  full: 'M3 передбачення + інтерполяція',
};

const fmt = (value, digits = 0, unit = '') =>
  value === null || value === undefined || Number.isNaN(value)
    ? '—'
    : `${value.toFixed(digits)}${unit}`;

/**
 * Netgraph: живі цифри мережі + керування умовами. Показує те, без чого
 * налагоджувати netcode неможливо: RTT, вік знімка, трафік, чергу вводів і
 * розмір корекції передбачення. Нижче — елементи керування: режим клієнта,
 * затримка інтерполяції та інжектор лагу (lag/jitter/drop).
 */
export function createNetgraph(root) {
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

  const text = root.querySelector('#ng-text');
  const canvas = root.querySelector('canvas');
  const ctx = canvas.getContext('2d');
  const history = { rtt: [], correction: [], interval: [] };
  let game = null;
  let timer = null;
  let controller = null;

  const control = (name) => root.querySelector(`[data-ng="${name}"]`);
  const out = (name) => root.querySelector(`[data-out="${name}"]`);

  function push(list, value) {
    list.push(value ?? 0);
    if (list.length > HISTORY) list.shift();
  }

  function plot() {
    const { width, height } = canvas;
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = 'rgba(255,255,255,0.04)';
    ctx.fillRect(0, 0, width, height);

    const series = [
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

  function refresh() {
    if (!game) return;
    const s = game.stats();
    push(history.rtt, s.rtt);
    push(history.correction, s.correction);
    push(history.interval, s.snapshotInterval);

    text.textContent = [
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

    out('delay').textContent = `${s.delaySetting} мс`;
    out('lag').textContent = `${s.lag.lag} мс`;
    out('jitter').textContent = `±${s.lag.jitter} мс`;
    out('drop').textContent = `${s.lag.drop}%`;
    plot();
  }

  return {
    /** Прив'язати до гри; повертає функцію відв'язки. */
    bind(netGame) {
      game = netGame;
      controller?.abort();
      controller = new AbortController();
      const { signal } = controller;

      control('mode').value = game.mode;
      control('delay').value = game.delayMs;
      control('lag').value = game.lag.config.lag;
      control('jitter').value = game.lag.config.jitter;
      control('drop').value = game.lag.config.drop;

      control('mode').addEventListener(
        'change',
        (e) => game.setMode(e.target.value),
        { signal },
      );
      control('delay').addEventListener(
        'input',
        (e) => game.setDelay(e.target.value),
        { signal },
      );
      for (const key of ['lag', 'jitter', 'drop']) {
        control(key).addEventListener(
          'input',
          (e) => game.lag.configure({ [key]: e.target.value }),
          { signal },
        );
      }
      // слайдери не повинні "красти" клавіатуру в гри (стрілки рухають повзунок)
      root.addEventListener('keydown', (e) => e.stopPropagation(), { signal });
      root.addEventListener('change', (e) => e.target.blur?.(), { signal });

      clearInterval(timer);
      timer = setInterval(refresh, 250);
      refresh();
    },
    unbind() {
      game = null;
      controller?.abort();
      clearInterval(timer);
      timer = null;
    },
    toggle() {
      root.hidden = !root.hidden;
    },
  };
}
