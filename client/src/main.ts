import './style.css';
import { createAudio } from './audio.ts';
import { loadAll, loadJson, validateManifest } from './assets/loader.ts';
import type { LoadProgress, RetryInfo } from './assets/loader.ts';
import { createChaosFetch } from './dev/chaos.ts';
import { describeError } from './describe-error.ts';
import { createChatUi } from './chat-ui.ts';
import { createHud } from './hud.ts';
import { createInput, isTyping } from './input.ts';
import { Lobby } from './lobby.ts';
import type { JoinedDetail } from './lobby.ts';
import { createLobbyUi } from './lobby-ui.ts';
import { createLoadingScreen } from './loading-screen.ts';
import { createLoop } from './loop.ts';
import { createNetGame } from './net/net-game.ts';
import type { NetGame } from './net/net-game.ts';
import { createNetgraph } from './netgraph.ts';
import { createRenderer } from './render.ts';
import type { Atlas } from './render.ts';
import type { Intent } from '@tank/shared/sim/controllers.ts';

declare global {
  interface Window {
    __net?: NetGame;
  }
}

const MANIFEST_URL = '/assets/manifest.json';

function required<T extends Element>(selector: string): T {
  const el = document.querySelector<T>(selector);
  if (!el) throw new Error(`main: не знайдено ${selector}`);
  return el;
}

const canvas = required<HTMLCanvasElement>('#gameCanvas');

const renderer = createRenderer(canvas);
const input = createInput(window);
const hud = createHud(document);
const audio = createAudio();
const chat = createChatUi(document);
const netgraph = createNetgraph(required<HTMLElement>('#netgraph'));

// Експеримент з детермінізмом (див. dev/determinism-break.ts)
if (new URLSearchParams(location.search).get('break') === 'random') {
  void import('./dev/determinism-break.ts').then((m) => m.installRandomBreak());
}

/** Клавіші → намір гравця (те, що йде на сервер): газ, поворот, башта, вогонь. */
function readIntent(): Intent {
  const axis = (positive: string, negative: string): number => (input.isDown(positive) ? 1 : 0) - (input.isDown(negative) ? 1 : 0);
  return {
    throttle: axis('ArrowUp', 'ArrowDown'),
    turn: axis('ArrowRight', 'ArrowLeft'),
    turretTurn: axis('KeyX', 'KeyZ'),
    fire: input.isDown('Space'),
  };
}

// AudioContext створений у стані "suspended"; перший клік/клавіша розблокує його.
audio.unlockOnGesture(window);

// ?chaos=slow,sprite404,… підміняє fetch для демонстрації збоїв (див. dev/chaos.ts)
const chaos = new URLSearchParams(location.search).get('chaos');
const net: { fetch?: typeof fetch } = chaos ? { fetch: createChaosFetch(chaos) } : {};

const loadingScreen = createLoadingScreen({ renderer, actions: required<HTMLElement>('#loading-actions') });
const lobby = new Lobby(net);
const lobbyUi = createLobbyUi(required<HTMLElement>('#lobby'), lobby);

/** Фаза застосунку: 'loading' → 'lobby' → 'game' (CSS ховає зайві панелі). */
const setPhase = (phase: string): void => {
  document.body.dataset['phase'] = phase;
};

interface Session {
  room: JoinedDetail['room'];
  name: string;
  controller: AbortController;
  net: NetGame;
}

let session: Session | null = null;

const loop = createLoop({
  // 30 Гц, як у сервера: один крок = один ввід із номером seq
  step(): void {
    if (!session) return;
    session.net.step(readIntent());
    hud.recordStep();
  },

  render(alpha: number, frameTime: number): void {
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

function describeSound(): string {
  if (audio.loaded === 0) return 'файли не завантажено — гра без звуку';
  if (audio.muted) return 'вимкнено (M)';
  if (audio.state !== 'running') return 'клікніть, щоб увімкнути';
  return 'увімкнено (M — вимкнути)';
}

/*
 * Постріл тепер — частина ВВОДУ (fire = Space затиснуто): клієнт не стріляє сам,
 * а повідомляє серверу намір.
 */
window.addEventListener('keydown', (event) => {
  // У полі вводу (чат, ім'я) клавіші належать полю, а не грі. Виняток — Esc.
  if (isTyping(event)) {
    if (event.code === 'Escape' && event.target === chat.input) chat.input.blur();
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

async function loadAssets(): ReturnType<typeof loadAll> {
  setPhase('loading');

  for (;;) {
    const controller = new AbortController();
    loadingScreen.show({ onCancel: () => controller.abort() });
    const startedAt = performance.now();

    try {
      const manifest = validateManifest(await loadJson(MANIFEST_URL, { ...net, signal: controller.signal }));

      const assets = await loadAll(manifest, {
        ...net,
        audioContext: audio.context,
        signal: controller.signal,
        onProgress(fraction: number, { entry, ok }: LoadProgress) {
          loadingScreen.setProgress(fraction, `${entry.key} ${ok ? '✓' : '— пропущено'}`);
        },
        onRetry(entry, { attempt, delayMs, error }: RetryInfo) {
          const { title } = describeError(error);
          console.info(`[assets] повтор ${entry.key}: спроба ${attempt + 1} через ${Math.round(delayMs)} мс (${title})`);
          loadingScreen.setNote(`${entry.key}: ${title}. Повтор ${attempt + 1} через ${Math.round(delayMs)} мс`);
        },
      });

      // as: atlas — це довільний JSON ассет; після перевірки нижче працюємо з Atlas
      const atlas = assets.json['atlas'] as Atlas | undefined;
      if (!assets.images['sprites'] || !atlas?.frames) {
        throw new Error('У маніфесті немає спрайтшиту (sprites) або атласу (atlas)');
      }

      const ms = Math.round(performance.now() - startedAt);
      console.info(`[assets] ${manifest.assets.length} файлів завантажено за ${ms} мс`);
      for (const { entry, error } of assets.failed) {
        console.warn(`[assets] пропущено ${entry.key}:`, error instanceof Error ? error.message : error);
      }

      await loadingScreen.complete();
      return assets;
    } catch (error: unknown) {
      console.warn('[assets] завантаження не вдалось:', error);
      await loadingScreen.showError(error);
    }
  }
}

// ------------------------------------------------------------ лобі та гра

lobby.addEventListener('joined', (event) => startGame(event.detail));

function startGame({ room, name }: JoinedDetail): void {
  lobbyUi.hide(); // зняти слухачі лобі; мережа вже зупинена в lobby.join()

  const controller = new AbortController();
  hud.setPilot(`${name} · ${room.name}`);
  chat.reset();

  const game = createNetGame({
    roomId: room.id,
    name,
    ui: chat,
    onEvent: (event) => audio.playEvent(event),
    onRejected: ({ reason }) => {
      leaveGame({ notice: `Не вдалося увійти в «${room.name}»: ${reason}` });
    },
  });
  chat.onSubmit((text) => game.sendChat(text), { signal: controller.signal });
  netgraph.bind(game);
  window.__net = game; // для налагодження в консолі: __net.lag.configure({ lag: 100 })

  session = { room, name, controller, net: game };
  setPhase('game');
}

function leaveGame({ notice }: { notice?: string | null } = {}): void {
  session?.controller.abort();
  session?.net.leave(); // 'leave' серверу, закрити сокет, зупинити reconnect
  netgraph.unbind();
  session = null;

  if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  hud.setPilot('—');
  setPhase('lobby');
  lobbyUi.show({ notice });
}

// -------------------------------------------------------------------- старт

async function boot(): Promise<void> {
  const assets = await loadAssets();

  const sprites = assets.images['sprites'];
  const atlas = assets.json['atlas'] as Atlas | undefined;
  if (sprites && atlas) renderer.setSprites({ image: sprites, atlas });
  audio.setBuffers(assets.audio);

  if (assets.failed.length > 0) console.warn('[assets] гра стартує з пропущеними ассетами');

  loop.start();
  setPhase('lobby');
  lobbyUi.show();
}

void boot();
