import type { CodecName } from '@tank/shared/protocol/types.ts';

/** Будь-яке повідомлення сервера: має поле type, решта залежить від type. */
export interface IncomingMessage {
  readonly type: string;
  readonly [key: string]: unknown;
}

export interface PlayerRef {
  readonly id: string;
  readonly name: string;
}

export interface WelcomeMessage extends IncomingMessage {
  readonly type: 'welcome';
  readonly v: number;
  readonly you: PlayerRef;
  readonly room: { id: string; name: string };
  readonly match: { seed: number; tickRate: number; codec: CodecName } | null;
}

export interface RosterMessage extends IncomingMessage {
  readonly type: 'roster';
  readonly players: { id: string; name: string; slot: number }[];
}

export interface ChatMessage extends IncomingMessage {
  readonly type: 'chat';
  readonly from: PlayerRef;
  readonly text: string;
  readonly t: number;
}

export interface ErrorMessage extends IncomingMessage {
  readonly type: 'error';
  readonly code: number;
  readonly message: string;
}

export interface SnapshotMessage extends IncomingMessage {
  readonly type: 'snapshot';
}

export interface PongMessage extends IncomingMessage {
  readonly type: 'pong';
  readonly t: number;
  readonly tick: number;
}
