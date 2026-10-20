import './style.css';
import { createAudio } from './audio.js';
import { loadAll, loadJson, validateManifest } from './assets/loader.js';
import { createChaosFetch } from './dev/chaos.js';
import { describeError } from './describe-error.js';
import { createChatUi } from './chat-ui.js';
import { createHud } from './hud.js';
import { createInput, isTyping } from './input.js';
import { Lobby } from './lobby.js';
import { createLobbyUi } from './lobby-ui.js';
import { createLoadingScreen } from './loading-screen.js';
import { createLoop } from './loop.js';
import { createNetGame } from './net/net-game.js';
import { createNetgraph } from './netgraph.js';
import { createRenderer } from './render.js';

const MANIFEST_URL = '/assets/manifest.json';

const canvas = document.querySelector('#gameCanvas');

const renderer = createRenderer(canvas);
const input = createInput(window);
const hud = createHud(document);
const audio = createAudio();
const chat = createChatUi(document);
const netgraph = createNetgraph(document.querySelector('#netgraph'));

// Експеримент з детермінізмом (див. dev/determinism-break.js)
if (new URLSearchParams(location.search).get('break') === 'random') {
  import('./dev/determinism-break.js').then((m) => m.installRandomBreak());
}

/** Клавіші → намір гравця (те, що йде на сервер): газ, поворот, башта, вогонь. */
function readIntent() {
  const axis = (positive, negative) =>
    (input.isDown(positive) ? 1 : 0) - (input.isDown(negative) ? 1 : 0);
  return {
    throttle: axis('ArrowUp', 'ArrowDown'),
    turn: axis('ArrowRight', 'ArrowLeft'),
    turretTurn: axis('KeyX', 'KeyZ'),
    fire: input.isDown('Space'),
  };
}

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

/** Поточна гра: { room, name, controller, net } або null (loading / лобі). */
let session = null;

const loop = createLoop({
  // 30 Гц, як у сервера: один крок = один ввід із номером seq
  step() {
    if (!session) return;
    session.net.step(readIntent());
    hud.recordStep();
  },

  render(alpha, frameTime) {
    const scene = session?.net.frame(alpha, frameTime / 1000) ?? null;
    renderer.draw(scene);

    if (scene) {
      hud.update(scene.me);
      hud.setScore(scene.me.score);
    }
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
 * Постріл тепер — частина ВВОДУ (fire = Space затиснуто): клієнт не стріляє сам,
 * а повідомляє серверу намір. Стара історія з `this` (Лаб 2) лишилась у docs/lab-02.md.
 */
window.addEventListener('keydown', (event) => {
  // У полі вводу (чат, ім'я) клавіші належать полю, а не грі. Виняток — Esc:
  // він повертає фокус із чату в гру.
  if (isTyping(event)) {
    if (event.code === 'Escape' && event.target === chat.input)
      chat.input.blur();
    return;
  }

  if (event.code === 'KeyM') {
    audio.toggleMute();
    return;
  }

  if (!session) return; // у лобі Space/Esc належать формі, а не грі

  if (event.code === 'Enter') {
    event.preventDefault();
    input.clear(); // клавіші, затиснуті до переходу в чат, не повинні "залипнути"
    chat.focus();
  } else if (event.code === 'Space') {
    event.preventDefault(); // пробіл не повинен гортати сторінку чи натискати кнопки
  } else if (event.code === 'KeyN') {
    netgraph.toggle();
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

function startGame({ room, name }) {
  lobbyUi.hide(); // зняти слухачі лобі; мережа вже зупинена в lobby.join()

  const controller = new AbortController();
  hud.setPilot(`${name} · ${room.name}`);
  chat.reset();

  // Гра — на сервері. Клієнт шле ввід, отримує знімки; кімната, склад
  // гравців і чат ідуть тим самим WebSocket.
  const net = createNetGame({
    roomId: room.id,
    name,
    ui: chat,
    onEvent: (event) => audio.playEvent(event),
    onRejected: ({ reason }) => {
      // сервер не пустив (заповнена/не існує) або з'єднання безнадійне: назад у лобі
      leaveGame({ notice: `Не вдалося увійти в «${room.name}»: ${reason}` });
    },
  });
  chat.onSubmit((text) => net.sendChat(text), { signal: controller.signal });
  netgraph.bind(net);
  window.__net = net; // для налагодження в консолі: __net.lag.configure({ lag: 100 })

  session = { room, name, controller, net };
  setPhase('game');
}

function leaveGame({ notice } = {}) {
  session?.controller.abort();
  session?.net.leave(); // 'leave' серверу, закрити сокет, зупинити reconnect
  netgraph.unbind();
  session = null;

  document.activeElement?.blur();
  hud.setPilot('—');
  setPhase('lobby');
  lobbyUi.show({ notice });
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
