import { Match } from './match.ts';
import type { MatchOptions, MatchStats } from './match.ts';
import type { Room, RoomManager } from './rooms.ts';
import type { Logger } from './types.ts';

export interface Matches {
  readonly active: ReadonlyMap<string, Match>;
  stats(): MatchStats[];
  stopAll(): void;
}

export interface AttachMatchesOptions {
  readonly logger?: Logger;
  readonly matchOptions?: Partial<Pick<MatchOptions, 'now' | 'onTick'>>;
}

/**
 * Прив'язує матчі до кімнат: перший гравець → Match.start(), останній вийшов → stop().
 * Кімната про симуляцію не знає, Match — про сокети.
 */
export function attachMatches(manager: RoomManager, { logger = console, matchOptions = {} }: AttachMatchesOptions = {}): Matches {
  const active = new Map<string, Match>();

  const watch = (room: Room): void => {
    room.on('open', () => {
      const match = new Match({ room, seed: room.seed, logger, ...matchOptions });
      room.match = match;
      active.set(room.id, match);
      match.start();
      logger.info(`[match ${room.id}] старт, seed=${room.seed}`);
    });
    room.on('join', (player) => room.match?.addPlayer(player));
    room.on('leave', (player) => room.match?.removePlayer(player));
    room.on('empty', () => {
      const match = active.get(room.id);
      if (!match) return;
      match.stop();
      active.delete(room.id);
      room.match = null;
      logger.info(`[match ${room.id}] зупинено на тіку ${match.tick}`);
    });
  };

  manager.on('created', watch);
  for (const room of manager) watch(room);

  return {
    get active(): ReadonlyMap<string, Match> {
      return active;
    },
    stats: () => [...active.values()].map((match) => match.stats()),
    stopAll(): void {
      for (const match of active.values()) match.stop();
      active.clear();
    },
  };
}
