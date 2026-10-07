import './style.css';
import { createAudio } from './audio.js';
import { loadAll, loadJson, validateManifest } from './assets/loader.js';
import { createChaosFetch } from './dev/chaos.js';
import { describeError } from './describe-error.js';
import { createHud } from './hud.js';
import { createInput } from './input.js';
import { Lobby } from './lobby.js';
import { createLobbyUi } from './lobby-ui.js';
import { createLoadingScreen } from './loading-screen.js';
import { createLoop } from './loop.js';
import { createRenderer } from './render.js';
import { Game } from './sim/game.js';

const MANIFEST_URL = '/assets/manifest.json';

const canvas = document.querySelector('#gameCanvas');

const renderer = createRenderer(canvas);
const input = createInput(window);
const hud = createHud(document);
const audio = createAudio();

// AudioContext створений у стані "suspended"; перший клік/клавіша розблокує його.
audio.unlockOnGesture(window);

// ?chaos=slow,sprite404,… підміняє fetch для демонстрації збоїв (див. dev/chaos.js)
const chaos = new URLSearchParams(location.search).get('chaos');
const net = chaos ? { fetch: createChaosFetch(chaos) } : {};

const loadingScreen = createLoadingScreen({
  renderer,
  actions: document.querySelector('#loading-actions'),
});
const lobby = new Lobby(net);
const lobbyUi = createLobbyUi(document.querySelector('#lobby'), lobby);

/** Фаза застосунку: 'loading' → 'lobby' → 'game' (CSS ховає зайві панелі). */
const setPhase = (phase) => {
  document.body.dataset.phase = phase;
};

/** Поточна гра: { game, room, name, controller } або null (loading / лобі). */
let session = null;

const loop = createLoop({
  step(dt) {
    if (!session) return;

    session.game.resize(renderer.width, renderer.height);
    session.game.step(dt, input);
    hud.recordStep();
  },

  render(alpha, frameTime) {
    renderer.draw(session?.game.world ?? null, alpha);

    if (session) hud.update(session.game);
    hud.setSound(describeSound());
    hud.recordFrame(frameTime);
  },
});

function describeSound() {
  if (audio.loaded === 0) return 'файли не завантажено — гра без звуку';
  if (audio.muted) return 'вимкнено (M)';
  if (audio.state !== 'running') return 'клікніть, щоб увімкнути';
  return 'увімкнено (M — вимкнути)';
}

/*
 * Постріл через слухач клавіатури.
 *
 * НАЇВНО (баг): window.addEventListener('keydown', ship.fire);
 *   Браузер викликає слухача з this = window, а не кораблем, тому
 *   всередині fire() `this.cooldown`, `this.getComponent`… читаються з window
 *   і все ламається (TypeError).
 *
 * ФІКС: стрілка-обгортка. Метод викликається як `session.game.player.fire()`
 * — implicit binding, this = корабель. Обгортка ще й бере ПОТОЧНОГО гравця
 * на момент натискання (після респауну це вже новий корабель).
 * Альтернативи (.bind, поле-стрілка) описані в README.
 */
window.addEventListener('keydown', (event) => {
  if (event.code === 'KeyM') {
    audio.toggleMute();
    return;
  }

  if (!session) return; // у лобі Space/Esc належать формі, а не грі

  if (event.code === 'Space') {
    event.preventDefault();
    session.game.player?.fire();
  } else if (event.code === 'Escape') {
    leaveGame();
  }
});

// ----------------------------------------------------------------- ассети

/**
 * Вантажить маніфест і всі ассети. Повертає результат лише коли все готове;
 * при помилці малює її на канвасі й чекає, поки гравець натисне "Повторити"
 * (Promise "перетворює" клік на значення — подію, що очікується раз).
 */
async function loadAssets() {
  setPhase('loading');

  for (;;) {
    const controller = new AbortController();
    loadingScreen.show({ onCancel: () => controller.abort() });
    const startedAt = performance.now();

    try {
      const manifest = validateManifest(
        await loadJson(MANIFEST_URL, { ...net, signal: controller.signal }),
      );

      const assets = await loadAll(manifest, {
        ...net,
        audioContext: audio.context,
        signal: controller.signal,
        onProgress(fraction, { entry, ok }) {
          loadingScreen.setProgress(
            fraction,
            `${entry.key} ${ok ? '✓' : '— пропущено'}`,
          );
        },
        onRetry(entry, { attempt, delayMs, error }) {
          const { title } = describeError(error);
          console.info(
            `[assets] повтор ${entry.key}: спроба ${attempt + 1} через ${Math.round(delayMs)} мс (${title})`,
          );
          loadingScreen.setNote(
            `${entry.key}: ${title}. Повтор ${attempt + 1} через ${Math.round(delayMs)} мс`,
          );
        },
      });

      if (!assets.images.sprites || !assets.json.atlas?.frames) {
        throw new Error(
          'У маніфесті немає спрайтшиту (sprites) або атласу (atlas)',
        );
      }

      const ms = Math.round(performance.now() - startedAt);
      console.info(
        `[assets] ${manifest.assets.length} файлів завантажено за ${ms} мс`,
      );
      for (const { entry, error } of assets.failed) {
        console.warn(`[assets] пропущено ${entry.key}:`, error.message);
      }

      await loadingScreen.complete();
      return assets;
    } catch (error) {
      console.warn('[assets] завантаження не вдалось:', error);
      await loadingScreen.showError(error);
    }
  }
}

// ------------------------------------------------------------ лобі та гра

lobby.addEventListener('joined', (event) => startGame(event.detail));

function startGame({ room, name, arena }) {
  lobbyUi.hide(); // зняти слухачі лобі; мережа вже зупинена в lobby.join()

  const controller = new AbortController();
  const game = new Game({
    width: renderer.width,
    height: renderer.height,
    arena,
  });

  // `signal` знімає всі слухачі цієї гри одним abort(), коли гравець іде в лобі
  audio.bind(game.world, { signal: controller.signal });
  hud.bindGame(game, { signal: controller.signal });
  hud.setPilot(`${name} · ${room.name}`);

  game.start();
  session = { game, room, name, controller };
  setPhase('game');
}

function leaveGame() {
  session?.controller.abort();
  session = null;

  hud.setPilot('—');
  setPhase('lobby');
  lobbyUi.show();
}

// -------------------------------------------------------------------- старт

async function boot() {
  const assets = await loadAssets();

  renderer.setSprites({
    image: assets.images.sprites,
    atlas: assets.json.atlas,
  });
  audio.setBuffers(assets.audio);

  if (assets.failed.length > 0) {
    console.warn('[assets] гра стартує з пропущеними ассетами');
  }

  loop.start();
  setPhase('lobby');
  lobbyUi.show();
}

boot();
