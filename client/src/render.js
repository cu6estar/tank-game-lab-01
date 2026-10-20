import { ARENA_HEIGHT, ARENA_WIDTH } from '@tank/shared/constants.js';
import { NO_SLOT, PICKUP_TYPES } from '@tank/shared/protocol/constants.js';

const TAU = Math.PI * 2;

// Шари: що малюється раніше, те лежить нижче.
const DRAW_ORDER = ['pickups', 'asteroids', 'ships', 'bullets', 'explosions'];

// Спрайт астероїда трохи більший за його коло зіткнень: скеля неправильної
// форми, а коло зіткнень — вписане. 96 = половина кадру в пікселях атласу.
const ASTEROID_SPRITE_FIT = 1.22;
const ASTEROID_SPRITE_HALF = 96;
const ASTEROID_VARIANTS = 3;

const PICKUP_STYLES = {
  shield: { color: '#3fd0ff', label: 'S' },
  rapidFire: { color: '#ffd23f', label: 'R' },
  homingShots: { color: '#ff5fd2', label: 'H' },
};

export function createRenderer(canvas) {
  const ctx = canvas.getContext('2d');

  let width = 0;
  let height = 0;

  // { image, frames, scale } — з'являється після завантаження ассетів
  let sprites = null;

  const drawers = {
    pickups: drawPickup,
    asteroids: drawAsteroid,
    ships: drawShip,
    bullets: drawBullet,
    explosions: drawExplosion,
  };

  // Арена фіксована (1280×720 — вона частина симуляції на сервері), а вікно
  // довільне: вписуємо арену у вікно зі збереженням пропорцій.
  const view = { scale: 1, x: 0, y: 0 };

  function updateView() {
    view.scale = Math.min(width / ARENA_WIDTH, height / ARENA_HEIGHT);
    view.x = (width - ARENA_WIDTH * view.scale) / 2;
    view.y = (height - ARENA_HEIGHT * view.scale) / 2;
  }

  function resize() {
    const dpr = window.devicePixelRatio || 1;

    width = window.innerWidth;
    height = window.innerHeight;

    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    updateView();
  }

  /** Підключити спрайтшит: `image` — ImageBitmap, `atlas` — sprites.json. */
  function setSprites({ image, atlas }) {
    sprites = { image, frames: atlas.frames, scale: atlas.scale ?? 1 };
  }

  /** Малює сцену (див. net-game.frame). Без сцени (лобі) — лише тло. */
  function draw(scene) {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#0c110c';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(
      dpr * view.scale,
      0,
      0,
      dpr * view.scale,
      dpr * view.x,
      dpr * view.y,
    );

    drawArena();
    if (!sprites || !scene) return;

    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, ARENA_WIDTH, ARENA_HEIGHT);
    ctx.clip();
    for (const layer of DRAW_ORDER) {
      for (const item of scene[layer] ?? []) drawers[layer](item);
    }
    ctx.restore();
  }

  function drawArena() {
    ctx.fillStyle = '#182018';
    ctx.fillRect(0, 0, ARENA_WIDTH, ARENA_HEIGHT);

    ctx.strokeStyle = 'rgba(255, 255, 255, 0.06)';
    ctx.lineWidth = 1;
    const grid = 50;

    for (let x = 0; x <= ARENA_WIDTH; x += grid) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, ARENA_HEIGHT);
      ctx.stroke();
    }
    for (let y = 0; y <= ARENA_HEIGHT; y += grid) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(ARENA_WIDTH, y);
      ctx.stroke();
    }

    ctx.strokeStyle = 'rgba(255, 255, 255, 0.25)';
    ctx.lineWidth = 2;
    ctx.strokeRect(0, 0, ARENA_WIDTH, ARENA_HEIGHT);
  }

  /**
   * Один кадр із спрайтшиту: `drawImage(image, sx, sy, sw, sh, dx, dy, dw, dh)`.
   * Джерело — прямокутник атласу, ціль — той самий розмір, помножений на
   * `k` (скільки логічних одиниць гри в одному пікселі спрайта) і зсунутий
   * так, щоб точка обертання кадру (ax, ay) опинилась в (x, y).
   */
  function drawFrame(name, x, y, rotation, k = 1 / sprites.scale) {
    const frame = sprites.frames[name];
    if (!frame) return;

    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(rotation);
    ctx.drawImage(
      sprites.image,
      frame.x,
      frame.y,
      frame.w,
      frame.h,
      -frame.ax * k,
      -frame.ay * k,
      frame.w * k,
      frame.h * k,
    );
    ctx.restore();
  }

  function drawShip(ship) {
    const { x, y } = ship;
    const enemy = ship.slot === NO_SLOT;

    // Корпус і башта — окремі кадри: башта обертається незалежно від корпусу.
    const team = enemy ? 'enemy' : 'player';
    drawFrame(`hull_${team}`, x, y, ship.angle);
    drawFrame(`turret_${team}`, x, y, ship.turret);

    if (!enemy) drawPlayerMarker(ship, x, y);
    drawShieldRing(ship, x, y);
    drawHealthBar(ship, x, y);
  }

  /** Кільце під кораблем гравця: зелене — ми, помаранчеве — інші пілоти. */
  function drawPlayerMarker(ship, x, y) {
    ctx.save();
    ctx.strokeStyle = ship.isMe
      ? 'rgba(111, 211, 106, 0.9)'
      : 'rgba(255, 170, 60, 0.9)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(x, y, 34, 0, TAU);
    ctx.stroke();
    ctx.fillStyle = ctx.strokeStyle;
    ctx.font = 'bold 13px Arial, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(ship.isMe ? 'ВИ' : `P${ship.slot + 1}`, x, y + 52);
    ctx.restore();
  }

  function drawShieldRing(ship, x, y) {
    if (!(ship.shield > 0)) return;

    // Блимає, коли щит на межі зникнення.
    if (ship.shield < 1.5 && Math.floor(performance.now() / 120) % 2 === 0)
      return;

    ctx.save();
    ctx.strokeStyle = 'rgba(63, 208, 255, 0.9)';
    ctx.fillStyle = 'rgba(63, 208, 255, 0.12)';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(x, y, 36, 0, TAU);
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }

  function drawHealthBar(ship, x, y) {
    const barWidth = 56;
    const ratio = Math.max(0, Math.min(1, ship.hp / ship.maxHp));
    const left = x - barWidth / 2;
    const top = y - 28 - 18;

    ctx.fillStyle = 'rgba(0, 0, 0, 0.55)';
    ctx.fillRect(left, top, barWidth, 6);

    ctx.fillStyle =
      ratio > 0.5 ? '#6fd36a' : ratio > 0.25 ? '#ffd23f' : '#ff5a4a';
    ctx.fillRect(left, top, barWidth * ratio, 6);
  }

  function drawAsteroid(asteroid) {
    const name = asteroid.homing
      ? 'asteroid_seeker'
      : `asteroid_${asteroid.seed % ASTEROID_VARIANTS}`;

    // розмір підганяємо під коло зіткнень, а не під фіксований масштаб атласу
    const k = (asteroid.radius * ASTEROID_SPRITE_FIT) / ASTEROID_SPRITE_HALF;
    drawFrame(name, asteroid.x, asteroid.y, asteroid.angle, k);
  }

  function drawBullet(bullet) {
    const name = bullet.homing
      ? 'bullet_homing'
      : bullet.mine || (bullet.owner !== undefined && bullet.owner !== NO_SLOT)
        ? 'bullet_player'
        : 'bullet_enemy';

    drawFrame(name, bullet.x, bullet.y, bullet.angle);
  }

  function drawPickup(pickup) {
    const style = PICKUP_STYLES[PICKUP_TYPES[pickup.type]];
    if (!style) return;
    const pulse = 1 + 0.1 * Math.sin(performance.now() / 180);

    ctx.save();
    ctx.translate(pickup.x, pickup.y);

    ctx.fillStyle = 'rgba(0, 0, 0, 0.45)';
    ctx.strokeStyle = style.color;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(0, 0, 16 * pulse, 0, TAU);
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = style.color;
    ctx.font = 'bold 16px Arial, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(style.label, 0, 1);

    ctx.restore();
  }

  function drawExplosion(explosion) {
    const fade = Math.max(0, 1 - explosion.age / explosion.lifetime);

    ctx.save();
    ctx.globalAlpha = fade;

    for (const particle of explosion.particles) {
      ctx.fillStyle = fade > 0.55 ? '#ffd23f' : '#ff7a2f';
      ctx.beginPath();
      ctx.arc(
        explosion.x + particle.x,
        explosion.y + particle.y,
        particle.size * (0.4 + fade * 0.6),
        0,
        TAU,
      );
      ctx.fill();
    }

    ctx.restore();
  }

  window.addEventListener('resize', resize);
  resize();

  return {
    ctx,
    get width() {
      return width;
    },
    get height() {
      return height;
    },
    setSprites,
    draw,
  };
}
