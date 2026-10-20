import { DT } from './constants.js';
import { hashGame } from './hash.js';
import { Game } from './sim/game.js';

/**
 * Детермінований сценарій для перевірки: два гравці, "скриптовані" вводи
 * (лише цілочисельна арифметика від номера кроку, жодної випадковості).
 * Один і той самий код запускається в Node-тесті й у Chrome — хеші порівнюємо.
 */
export function scriptedInput(slot, step) {
  const phase = (step >> 4) + slot * 3;
  return {
    throttle: (phase % 3) - 1,
    turn:
      ((step >> 3) * (slot + 1)) % 3 === 0 ? 1 : (step >> 5) % 2 === 0 ? -1 : 0,
    turretTurn: slot === 0 ? 1 : -1,
    fire: step % 11 === slot,
  };
}

export function runScenario({
  seed = 20260,
  steps = 1000,
  players = 2,
  arena,
} = {}) {
  const game = new Game({ width: 1280, height: 720, seed, arena });
  game.start();
  for (let slot = 0; slot < players; slot++)
    game.addPlayer(slot, { name: `p${slot}` });

  const hashes = [];
  for (let step = 1; step <= steps; step++) {
    for (let slot = 0; slot < players; slot++) {
      game.setInput(slot, step, scriptedInput(slot, step));
    }
    game.step(DT);
    if (step % 250 === 0) hashes.push(hashGame(game));
  }
  return { game, hashes, final: hashGame(game) };
}
