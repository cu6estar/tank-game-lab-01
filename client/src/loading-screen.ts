import { describeError } from './describe-error.ts';
import type { ErrorDescription } from './describe-error.ts';
import type { Renderer } from './render.ts';

const BAR_MAX_WIDTH = 520;
const BAR_HEIGHT = 22;

export interface LoadingScreen {
  show(options?: { onCancel?: () => void }): void;
  hide(): void;
  setProgress(fraction: number, text?: string): void;
  setNote(text: string): void;
  showError(error: unknown): Promise<void>;
  complete(): Promise<void>;
}

function requireButton(root: ParentNode, action: string): HTMLButtonElement {
  const el = root.querySelector<HTMLButtonElement>(`[data-action="${action}"]`);
  if (!el) throw new Error(`loading-screen: кнопки [data-action="${action}"] немає`);
  return el;
}

/**
 * Екран завантаження на канвасі. Прогрес-бар справжній: його довжина — частка
 * вже завантажених файлів із `loadAll`, а не анімація "крутиться".
 */
export function createLoadingScreen({ renderer, actions }: { renderer: Renderer; actions: HTMLElement }): LoadingScreen {
  const cancelButton = requireButton(actions, 'cancel');
  const retryButton = requireButton(actions, 'retry');

  let animationId = 0;
  let target = 0;
  let shown = 0;
  let label = '';
  let note = '';
  let failure: ErrorDescription | null = null;
  let tick = 0;
  let cancelHandler: (() => void) | null = null;
  let retryResolver: (() => void) | null = null;

  cancelButton.addEventListener('click', () => cancelHandler?.());
  retryButton.addEventListener('click', () => retryResolver?.());

  function setButtons({ cancel, retry }: { cancel: boolean; retry: boolean }): void {
    actions.hidden = !cancel && !retry;
    cancelButton.hidden = !cancel;
    retryButton.hidden = !retry;
  }

  function show({ onCancel }: { onCancel?: () => void } = {}): void {
    cancelHandler = onCancel ?? null;
    target = 0;
    shown = 0;
    label = 'Підготовка…';
    note = '';
    failure = null;
    setButtons({ cancel: Boolean(onCancel), retry: false });

    cancelAnimationFrame(animationId);
    animationId = requestAnimationFrame(frame);
  }

  function hide(): void {
    cancelAnimationFrame(animationId);
    animationId = 0;
    cancelHandler = null;
    setButtons({ cancel: false, retry: false });
  }

  function frame(): void {
    tick += 1;
    shown += (target - shown) * 0.2;
    if (Math.abs(target - shown) < 0.001) shown = target;

    draw();
    animationId = requestAnimationFrame(frame);
  }

  function draw(): void {
    const { ctx, width, height } = renderer;
    const cx = width / 2;
    const cy = height / 2;
    const barWidth = Math.min(BAR_MAX_WIDTH, width * 0.8);
    const left = cx - barWidth / 2;
    const barTop = cy + 10;

    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = '#101810';
    ctx.fillRect(0, 0, width, height);

    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';

    ctx.fillStyle = '#e9f5e5';
    ctx.font = 'bold 44px Consolas, monospace';
    ctx.fillText('TANK ARENA', cx, cy - 56);

    ctx.fillStyle = failure ? '#ff8a7a' : 'rgba(233, 245, 229, 0.55)';
    ctx.font = '16px Consolas, monospace';
    ctx.fillText(failure ? 'Не вдалося завантажити' : 'Завантаження…', cx, cy - 24);

    ctx.fillStyle = 'rgba(255, 255, 255, 0.08)';
    ctx.fillRect(left, barTop, barWidth, BAR_HEIGHT);

    const fillWidth = barWidth * shown;
    ctx.fillStyle = failure ? '#a8473b' : '#6fd36a';
    ctx.fillRect(left, barTop, fillWidth, BAR_HEIGHT);

    if (!failure && fillWidth > 0) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(left, barTop, fillWidth, BAR_HEIGHT);
      ctx.clip();
      ctx.fillStyle = 'rgba(255, 255, 255, 0.16)';
      for (let x = left - 40 + ((tick * 1.2) % 40); x < left + fillWidth; x += 40) {
        ctx.beginPath();
        ctx.moveTo(x, barTop + BAR_HEIGHT);
        ctx.lineTo(x + 14, barTop + BAR_HEIGHT);
        ctx.lineTo(x + 28, barTop);
        ctx.lineTo(x + 14, barTop);
        ctx.closePath();
        ctx.fill();
      }
      ctx.restore();
    }

    ctx.strokeStyle = 'rgba(233, 245, 229, 0.35)';
    ctx.lineWidth = 1;
    ctx.strokeRect(left + 0.5, barTop + 0.5, barWidth - 1, BAR_HEIGHT - 1);

    ctx.fillStyle = '#e9f5e5';
    ctx.font = '15px Consolas, monospace';
    ctx.fillText(`${Math.round(shown * 100)}%`, cx, barTop + BAR_HEIGHT + 26);

    if (failure) {
      ctx.fillStyle = '#ff8a7a';
      ctx.font = 'bold 17px Consolas, monospace';
      ctx.fillText(failure.title, cx, barTop + BAR_HEIGHT + 62);

      ctx.fillStyle = 'rgba(233, 245, 229, 0.7)';
      ctx.font = '14px Consolas, monospace';
      ctx.fillText(failure.detail, cx, barTop + BAR_HEIGHT + 86);
      return;
    }

    ctx.fillStyle = 'rgba(233, 245, 229, 0.6)';
    ctx.font = '14px Consolas, monospace';
    ctx.fillText(label, cx, barTop + BAR_HEIGHT + 56);

    if (note) {
      ctx.fillStyle = '#ffd23f';
      ctx.fillText(note, cx, barTop + BAR_HEIGHT + 82);
    }
  }

  return {
    show,
    hide,

    setProgress(fraction: number, text?: string): void {
      target = Math.max(target, Math.min(1, fraction)); // бар не відкочується
      if (text) label = text;
    },

    setNote(text: string): void {
      note = text;
    },

    showError(error: unknown): Promise<void> {
      failure = describeError(error);
      note = '';
      cancelHandler = null;
      setButtons({ cancel: false, retry: true });
      retryButton.focus();

      return new Promise<void>((resolve) => {
        retryResolver = (): void => {
          retryResolver = null;
          resolve();
        };
      });
    },

    async complete(): Promise<void> {
      target = 1;
      label = 'Готово';
      note = '';
      setButtons({ cancel: false, retry: false });

      const startedAt = performance.now();
      while (shown < 0.995 && performance.now() - startedAt < 600) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      }
      hide();
    },
  };
}
