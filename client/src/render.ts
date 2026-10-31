import { ARENA_HEIGHT, ARENA_WIDTH } from '@tank/shared/constants.ts';
import { NO_SLOT, PICKUP_TYPES } from '@tank/shared/protocol/constants.ts';
import type { PickupType } from '@tank/shared/sim/components.ts';
import type { SnapshotAsteroid, SnapshotPickup } from '@tank/shared/protocol/types.ts';
import type { Explosion } from './fx.ts';
import type { Scene, SceneBullet, SceneShip } from './net/scene.ts';

const TAU = Math.PI * 2;

const ASTEROID_SPRITE_FIT = 1.22;
const ASTEROID_SPRITE_HALF = 96;
const ASTEROID_VARIANTS = 3;

const PICKUP_STYLES: Record<PickupType, { color: string; label: string }> = {
  shield: { color: '#3fd0ff', label: 'S' },
  rapidFire: { color: '#ffd23f', label: 'R' },
  homingShots: { color: '#ff5fd2', label: 'H' },
};

export interface Frame {
  x: number;
  y: number;
  w: number;
  h: number;
  ax: number;
  ay: number;
}

export interface Atlas {
  frames: Record<string, Frame | undefined>;
  scale?: number;
}

interface Sprites {
  image: CanvasImageSource;
  frames: Record<string, Frame | undefined>;
  scale: number;
}

export interface Renderer {
  readonly ctx: CanvasRenderingContext2D;
  readonly width: number;
  readonly height: number;
  setSprites(sprites: { image: CanvasImageSource; atlas: Atlas }): void;
  draw(scene: Scene | null): void;
}

export function createRenderer(canvas: HTMLCanvasElement): Renderer {
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Canvas 2D context недоступний');
  const ctx: CanvasRenderingContext2D = context;

  let width = 0;
  let height = 0;
  let sprites: Sprites | null = null;

  // Арена фіксована (1280×720), вікно довільне: вписуємо арену зі збереженням пропорцій.
  const view = { scale: 1, x: 0, y: 0 };

  function updateView(): void {
    view.scale = Math.min(width / ARENA_WIDTH, height / ARENA_HEIGHT);
    view.x = (width - ARENA_WIDTH * view.scale) / 2;
    view.y = (height - ARENA_HEIGHT * view.scale) / 2;
  }

  function resize(): void {
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

  function setSprites({ image, atlas }: { image: CanvasImageSource; atlas: Atlas }): void {
    sprites = { image, frames: atlas.frames, scale: atlas.scale ?? 1 };
  }

  /** Малює сцену (див. net-game.frame). Без сцени (лобі) — лише тло. */
  function draw(scene: Scene | null): void {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#0c110c';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(dpr * view.scale, 0, 0, dpr * view.scale, dpr * view.x, dpr * view.y);

    drawArena();
    if (!sprites || !scene) return;

    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, ARENA_WIDTH, ARENA_HEIGHT);
    ctx.clip();
    // порядок шарів: pickups → asteroids → ships → bullets → explosions
    for (const pickup of scene.pickups) drawPickup(pickup);
    for (const asteroid of scene.asteroids) drawAsteroid(asteroid);
    for (const ship of scene.ships) drawShip(ship);
    for (const bullet of scene.bullets) drawBullet(bullet);
    for (const explosion of scene.explosions) drawExplosion(explosion);
    ctx.restore();
  }

  function drawArena(): void {
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

  /** Один кадр із спрайтшиту (drawImage src-rect → dest-rect з точкою обертання ax/ay). */
  function drawFrame(name: string, x: number, y: number, rotation: number, k?: number): void {
    if (!sprites) return;
    const frame = sprites.frames[name];
    if (!frame) return;
    const scale = k ?? 1 / sprites.scale;

    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(rotation);
    ctx.drawImage(
      sprites.image,
      frame.x,
      frame.y,
      frame.w,
      frame.h,
      -frame.ax * scale,
      -frame.ay * scale,
      frame.w * scale,
      frame.h * scale,
    );
    ctx.restore();
  }

  function drawShip(ship: SceneShip): void {
    const { x, y } = ship;
    const enemy = ship.slot === NO_SLOT;

    const team = enemy ? 'enemy' : 'player';
    drawFrame(`hull_${team}`, x, y, ship.angle);
    drawFrame(`turret_${team}`, x, y, ship.turret);

    if (!enemy) drawPlayerMarker(ship, x, y);
    drawShieldRing(ship, x, y);
    drawHealthBar(ship, x, y);
  }

  function drawPlayerMarker(ship: SceneShip, x: number, y: number): void {
    ctx.save();
    ctx.strokeStyle = ship.isMe ? 'rgba(111, 211, 106, 0.9)' : 'rgba(255, 170, 60, 0.9)';
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

  function drawShieldRing(ship: SceneShip, x: number, y: number): void {
    if (!(ship.shield > 0)) return;
    if (ship.shield < 1.5 && Math.floor(performance.now() / 120) % 2 === 0) return;

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

  function drawHealthBar(ship: SceneShip, x: number, y: number): void {
    const barWidth = 56;
    const ratio = Math.max(0, Math.min(1, ship.hp / ship.maxHp));
    const left = x - barWidth / 2;
    const top = y - 28 - 18;

    ctx.fillStyle = 'rgba(0, 0, 0, 0.55)';
    ctx.fillRect(left, top, barWidth, 6);

    ctx.fillStyle = ratio > 0.5 ? '#6fd36a' : ratio > 0.25 ? '#ffd23f' : '#ff5a4a';
    ctx.fillRect(left, top, barWidth * ratio, 6);
  }

  function drawAsteroid(asteroid: SnapshotAsteroid): void {
    const name = asteroid.homing ? 'asteroid_seeker' : `asteroid_${asteroid.seed % ASTEROID_VARIANTS}`;
    const k = (asteroid.radius * ASTEROID_SPRITE_FIT) / ASTEROID_SPRITE_HALF;
    drawFrame(name, asteroid.x, asteroid.y, asteroid.angle, k);
  }

  function drawBullet(bullet: SceneBullet): void {
    const name = bullet.homing
      ? 'bullet_homing'
      : bullet.mine || (bullet.owner !== undefined && bullet.owner !== NO_SLOT)
        ? 'bullet_player'
        : 'bullet_enemy';
    drawFrame(name, bullet.x, bullet.y, bullet.angle);
  }

  function drawPickup(pickup: SnapshotPickup): void {
    const type = PICKUP_TYPES[pickup.type];
    const style = type ? PICKUP_STYLES[type] : undefined;
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

  function drawExplosion(explosion: Explosion): void {
    const fade = Math.max(0, 1 - explosion.age / explosion.lifetime);

    ctx.save();
    ctx.globalAlpha = fade;

    for (const particle of explosion.particles) {
      ctx.fillStyle = fade > 0.55 ? '#ffd23f' : '#ff7a2f';
      ctx.beginPath();
      ctx.arc(explosion.x + particle.x, explosion.y + particle.y, particle.size * (0.4 + fade * 0.6), 0, TAU);
      ctx.fill();
    }

    ctx.restore();
  }

  window.addEventListener('resize', resize);
  resize();

  return {
    ctx,
    get width(): number {
      return width;
    },
    get height(): number {
      return height;
    },
    setSprites,
    draw,
  };
}
