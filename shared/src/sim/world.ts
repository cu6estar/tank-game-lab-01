import { toEntityId, UNASSIGNED_ID } from '../brand.ts';
import type { EntityId } from '../brand.ts';
import { Bus } from '../bus.ts';
import { createRng } from '../rng.ts';
import type { Rng } from '../rng.ts';
import { resolveCollisions } from './collision.ts';
import type { PickupType } from './components.ts';
import { Entity } from './entity.ts';
import type { EntityKind, Team } from './entity.ts';
import type { SimEntity, SimEntityOf } from './entities.ts';
import { Vector2 } from './vector.ts';

/** Type guard: перевірка `entity.kind === kind` не звужує generic K, а предикат — звужує. */
function isKind<K extends EntityKind>(entity: SimEntity, kind: K): entity is SimEntityOf<K> {
  return entity.kind === kind;
}

function wrapCoordinate(value: number, size: number): number {
  return ((value % size) + size) % size;
}

/** Події світу: назва → дані. Типи виводяться звідси і для emit, і для on. */
export interface WorldEvents {
  fired: { team: Team | null; pos: Vector2 };
  hit: {
    kind: EntityKind;
    team: Team | null;
    damage: number;
    blocked: boolean;
    pos: Vector2;
  };
  exploded: {
    entity: SimEntity;
    kind: EntityKind;
    team: Team | null;
    pos: Vector2;
    killerTeam: Team | null;
  };
  pickup: { type: PickupType; team: Team | null; pos: Vector2 };
}

export type CollisionSystem = (world: World) => void;

export interface WorldOptions {
  readonly width?: number;
  readonly height?: number;
  readonly collisionSystem?: CollisionSystem;
  readonly rand?: Rng;
}

/**
 * Світ: усі сутності в `Map<id, Entity>`.
 *
 * Чому Map, а не `{}`: ключі-числа не перетворюються на рядки, немає
 * успадкованих ключів ("constructor", "toString"), є `.size`, а порядок
 * вставки гарантований.
 *
 * Видалення відкладене: despawn() лише ПОЗНАЧАЄ сутність мертвою, а фізично
 * вона видаляється в sweep() наприкінці кроку. Так ми ніколи не ламаємо
 * ітерацію, яка зараз іде по цій самій Map.
 *
 * Шина подій: World — це типізована Bus<WorldEvents>. Симуляція лише повідомляє, що сталося
 * (`emit('fired' | 'hit' | 'exploded' | 'pickup', дані)`), а звук, HUD та
 * правила гри підписуються ззовні. Модулі sim НЕ імпортують audio.ts / hud.ts
 * (це перевіряє ESLint і тест), залежність спрямована лише в один бік.
 *
 * Події синхронні: обробник виконується всередині emit, посеред кроку.
 * Тому слухачі мають бути швидкими й не чіпати World.
 */
export class World extends Bus<WorldEvents> {
  #entities = new Map<EntityId, SimEntity>();
  #lastId = 0;

  width: number;
  height: number;
  // Колізії — окрема система, яку можна підмінити (напр. на сітку замість O(n²)).
  collisionSystem: CollisionSystem;
  time = 0;
  // Єдине джерело випадковості симуляції: засіяний генератор (див. rng.ts).
  // Math.random() у sim заборонено — інакше клієнт і сервер розійдуться.
  readonly rand: Rng;

  constructor({
    width = 800,
    height = 600,
    collisionSystem = resolveCollisions,
    rand = createRng(1),
  }: WorldOptions = {}) {
    super();
    this.width = width;
    this.height = height;
    this.collisionSystem = collisionSystem;
    this.rand = rand;
  }

  get size(): number {
    return this.#entities.size;
  }

  resize(width: number, height: number): void {
    this.width = width;
    this.height = height;
  }

  /**
   * id — послідовні числа 1, 2, 3… і вміщаються в u16 (бінарний протокол).
   * Після 65535 лічильник обертається, пропускаючи ще живі id.
   */
  #allocateId(): EntityId {
    let id: EntityId;
    do {
      this.#lastId = (this.#lastId % 0xffff) + 1;
      id = toEntityId(this.#lastId);
    } while (this.#entities.has(id));
    return id;
  }

  spawn<E extends SimEntity>(entity: E): E {
    if (entity.id === UNASSIGNED_ID) Entity.assignId(entity, this.#allocateId());
    entity.world = this;
    this.#entities.set(entity.id, entity);
    return entity;
  }

  /** Відкладене видалення: позначити мертвим, прибере sweep. */
  despawn(id: EntityId): void {
    const entity = this.#entities.get(id);
    if (entity) entity.kill();
  }

  get(id: EntityId): SimEntity | undefined {
    return this.#entities.get(id);
  }

  /** Ітерація по ЖИВИХ сутностях (позначені мертвими пропускаються). */
  *[Symbol.iterator](): Generator<SimEntity, void, undefined> {
    for (const entity of this.#entities.values()) {
      if (entity.alive) yield entity;
    }
  }

  /** Живі сутності одного виду; тип елемента виводиться з аргументу: ofKind('ship') → Ship. */
  *ofKind<K extends EntityKind>(kind: K): Generator<SimEntityOf<K>, void, undefined> {
    for (const entity of this) {
      if (isKind(entity, kind)) yield entity;
    }
  }

  /**
   * Один фіксований крок: оновити всіх -> колізії -> прибрати мертвих.
   * Сутності, заспавнені під час кроку (кулі від fire()), потрапляють у цю ж
   * ітерацію — Map показує елементи, додані під час обходу.
   */
  step(dt: number): void {
    this.time += dt;

    for (const entity of this) {
      entity.update(dt, this);
      this.#wrap(entity);
    }

    this.collisionSystem(this);
    this.#sweep();
  }

  #wrap(entity: SimEntity): void {
    if (!entity.wraps) return;

    const x = wrapCoordinate(entity.pos.x, this.width);
    const y = wrapCoordinate(entity.pos.y, this.height);
    if (x !== entity.pos.x || y !== entity.pos.y)
      entity.pos = new Vector2(x, y);
  }

  #sweep(): void {
    for (const [id, entity] of this.#entities) {
      if (entity.alive) continue;
      entity.world = null;
      this.#entities.delete(id);
    }
  }
}
