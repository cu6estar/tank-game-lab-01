import { describeError } from './describe-error.js';

const BAR_MAX_WIDTH = 520;
const BAR_HEIGHT = 22;

/**
 * Екран завантаження на канвасі. Прогрес-бар справжній: його довжина — це
 * частка вже завантажених файлів із `loadAll`, а не анімація "крутиться".
 * Плавність дає лише згладжування (shown наздоганяє target), але ніколи
 * не випереджає реальний прогрес.
 *
 * Кнопки "Скасувати" / "Повторити" — звичайний DOM поверх канваса.
 *
 *   screen.show({ onCancel })       показати й запустити анімацію
 *   screen.setProgress(f, label)    f у 0…1
 *   screen.setNote(text)            рядок про ретраї
 *   await screen.showError(error)   намалювати помилку; resolve — після "Повторити"
 *   await screen.complete()         довести бар до 100% і сховати екран
 */
export function createLoadingScreen({ renderer, actions }) {
  const cancelButton = actions.querySelector('[data-action="cancel"]');
  const retryButton = actions.querySelector('[data-action="retry"]');

  let animationId = 0;
  let target = 0;
  let shown = 0;
  let label = '';
  let note = '';
  let failure = null;
  let tick = 0;
  let cancelHandler = null;
  let retryResolver = null;

  cancelButton.addEventListener('click', () => cancelHandler?.());
  retryButton.addEventListener('click', () => {
    retryResolver?.();
  });

  function setButtons({ cancel, retry }) {
    actions.hidden = !cancel && !retry;
    cancelButton.hidden = !cancel;
    retryButton.hidden = !retry;
  }

  function show({ onCancel } = {}) {
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

  function hide() {
    cancelAnimationFrame(animationId);
    animationId = 0;
    cancelHandler = null;
    setButtons({ cancel: false, retry: false });
  }

  function frame() {
    tick += 1;
    shown += (target - shown) * 0.2;
    if (Math.abs(target - shown) < 0.001) shown = target;

    draw();
    animationId = requestAnimationFrame(frame);
  }

  function draw() {
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
    ctx.fillText(
      failure ? 'Не вдалося завантажити' : 'Завантаження…',
      cx,
      cy - 24,
    );

    // трек
    ctx.fillStyle = 'rgba(255, 255, 255, 0.08)';
    ctx.fillRect(left, barTop, barWidth, BAR_HEIGHT);

    // заповнення = реальна частка завантажених файлів
    const fillWidth = barWidth * shown;
    ctx.fillStyle = failure ? '#a8473b' : '#6fd36a';
    ctx.fillRect(left, barTop, fillWidth, BAR_HEIGHT);

    if (!failure && fillWidth > 0) {
      // рухомі смужки на заповненій частині — показують, що екран живий
      ctx.save();
      ctx.beginPath();
      ctx.rect(left, barTop, fillWidth, BAR_HEIGHT);
      ctx.clip();
      ctx.fillStyle = 'rgba(255, 255, 255, 0.16)';
      for (
        let x = left - 40 + ((tick * 1.2) % 40);
        x < left + fillWidth;
        x += 40
      ) {
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

    setProgress(fraction, text) {
      target = Math.max(target, Math.min(1, fraction)); // бар не відкочується
      if (text) label = text;
    },

    setNote(text) {
      note = text;
    },

    /** Показати помилку й чекати, поки гравець натисне "Повторити". */
    showError(error) {
      failure = describeError(error);
      note = '';
      cancelHandler = null;
      setButtons({ cancel: false, retry: true });
      retryButton.focus();

      return new Promise((resolve) => {
        retryResolver = () => {
          retryResolver = null;
          resolve();
        };
      });
    },

    /** Довести бар до 100%, дати оку це побачити, сховати екран. */
    async complete() {
      target = 1;
      label = 'Готово';
      note = '';
      setButtons({ cancel: false, retry: false });

      const startedAt = performance.now();
      while (shown < 0.995 && performance.now() - startedAt < 600) {
        await new Promise((resolve) => requestAnimationFrame(resolve));
      }
      hide();
    },
  };
}
