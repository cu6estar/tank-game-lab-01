import { Match } from './match.js';

/**
 * Прив'язує матчі до кімнат: перший гравець → Match.start(), останній вийшов → stop().
 * Кімната про симуляцію не знає, Match — про сокети.
 */
export function attachMatches(
  manager,
  { logger = console, matchOptions = {} } = {},
) {
  const active = new Map(); // roomId → Match

  const watch = (room) => {
    room.on('open', () => {
      const match = new Match({
        room,
        seed: room.seed,
        logger,
        ...matchOptions,
      });
      room.match = match;
      active.set(room.id, match);
      match.start();
      logger.info?.(`[match ${room.id}] старт, seed=${room.seed}`);
    });
    room.on('join', (player) => room.match?.addPlayer(player));
    room.on('leave', (player) => room.match?.removePlayer(player));
    room.on('empty', () => {
      const match = active.get(room.id);
      if (!match) return;
      match.stop();
      active.delete(room.id);
      room.match = null;
      logger.info?.(`[match ${room.id}] зупинено на тіку ${match.tick}`);
    });
  };

  manager.on('created', watch);
  for (const room of manager) watch(room);

  return {
    get active() {
      return active;
    },
    stats: () => [...active.values()].map((match) => match.stats()),
    stopAll() {
      for (const match of active.values()) match.stop();
      active.clear();
    },
  };
}
