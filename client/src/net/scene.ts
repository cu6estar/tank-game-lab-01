import type { SnapshotAsteroid, SnapshotPickup, SnapshotShip } from '@tank/shared/protocol/types.ts';
import type { Explosion } from '../fx.ts';

/**
 * Режими показу (кожен наступний додає один прийом):
 *   dumb    — M1: малюємо лише останній знімок, навіть власний корабель
 *   predict — M2: власний корабель рухається одразу (передбачення + звірка)
 *   full    — M3: + чужі об'єкти інтерполюються між двома знімками в минулому
 */
export const MODES = ['dumb', 'predict', 'full'] as const;
export type Mode = (typeof MODES)[number];
export const isMode = (value: unknown): value is Mode =>
  typeof value === 'string' && (MODES as readonly string[]).includes(value);

export interface SceneShip extends SnapshotShip {
  isMe: boolean;
  maxHp: number;
}

export interface SceneBullet {
  id: number | string;
  x: number;
  y: number;
  angle: number;
  homing: boolean;
  mine: boolean;
  owner?: number;
}

export interface SceneMe {
  hp?: number;
  maxHp?: number;
  score: number;
  dead?: boolean;
  shield?: number;
  rapid?: number;
  homing?: number;
}

/** Готова сцена одного кадру (те, що малює render.ts). */
export interface Scene {
  tick: number;
  ships: SceneShip[];
  bullets: SceneBullet[];
  asteroids: readonly SnapshotAsteroid[];
  pickups: readonly SnapshotPickup[];
  explosions: readonly Explosion[];
  me: SceneMe;
}

/** Подія кроку для звуку/ефектів (SnapshotEvent + прапорець локального передбачення). */
export interface SceneEvent {
  type: number;
  a: number;
  b: number;
  x: number;
  y: number;
  local?: boolean;
}
