import { toSeq } from './brand.ts';
import { DT } from './constants.ts';
import { hashGame } from './hash.ts';
import { Game } from './sim/game.ts';
import type { RawArena } from './sim/game.ts';

/**
 * Детермінований сценарій для перевірки: два гравці, "скриптовані" вводи
 * (лише цілочисельна арифметика від номера кроку, жодної випадковості).
 * Один і той самий код запускається в Node-тесті й у Chrome — хеші порівнюємо.
 */
export interface ScriptedInput {
  readonly throttle: number;
  readonly turn: number;
  readonly turretTurn: number;
  readonly fire: boolean;
}

export function scriptedInput(slot: number, step: number): ScriptedInput {
  const phase = (step >> 4) + slot * 3;
  return {
    throttle: (phase % 3) - 1,
    turn: ((step >> 3) * (slot + 1)) % 3 === 0 ? 1 : (step >> 5) % 2 === 0 ? -1 : 0,
    turretTurn: slot === 0 ? 1 : -1,
    fire: step % 11 === slot,
  };
}

export interface RunScenarioOptions {
  readonly seed?: number;
  readonly steps?: number;
  readonly players?: number;
  readonly arena?: RawArena;
}

export interface ScenarioResult {
  readonly game: Game;
  readonly hashes: string[];
  readonly final: string;
}

export function runScenario({
  seed = 20260,
  steps = 1000,
  players = 2,
  arena,
}: RunScenarioOptions = {}): ScenarioResult {
  const game = new Game({ width: 1280, height: 720, seed, arena });
  game.start();
  for (let slot = 0; slot < players; slot++) game.addPlayer(slot, { name: `p${slot}` });

  const hashes: string[] = [];
  for (let step = 1; step <= steps; step++) {
    for (let slot = 0; slot < players; slot++) {
      game.setInput(slot, toSeq(step), scriptedInput(slot, step));
    }
    game.step(DT);
    if (step % 250 === 0) hashes.push(hashGame(game));
  }
  return { game, hashes, final: hashGame(game) };
}
