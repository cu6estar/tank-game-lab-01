import { Vector2 } from './vector.js';
import { resolveCollisions } from './collision.js';

function wrapCoordinate(value, size) {
  return ((value % size) + size) % size;
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
 * Шина подій: World — це EventTarget. Симуляція лише повідомляє, що сталося
 * (`emit('fired' | 'hit' | 'exploded' | 'pickup', detail)`), а звук, HUD та
 * правила гри підписуються ззовні. Модулі sim НЕ імпортують audio.js / hud.js
 * (це перевіряє ESLint і тест), залежність спрямована лише в один бік.
 *
 * Події синхронні: слухач виконується всередині dispatchEvent, посеред кроку.
 * Тому слухачі мають бути швидкими й не чіпати World.
 */
export class World extends EventTarget {
  #entities = new Map();

  constructor({
    width = 800,
    height = 600,
    collisionSystem = resolveCollisions,
  } = {}) {
    super();
    this.width = width;
    this.height = height;
    // Колізії — окрема система, яку можна підмінити (напр. на сітку замість O(n²)).
    this.collisionSystem = collisionSystem;
    this.inputs = null; // вводи поточного кроку, їх читають контролери
    this.time = 0;
  }

  get size() {
    return this.#entities.size;
  }

  resize(width, height) {
    this.width = width;
    this.height = height;
  }

  spawn(entity) {
    entity.world = this;
    this.#entities.set(entity.id, entity);
    return entity;
  }

  /** Відкладене видалення: позначити мертвим, прибере sweep. */
  despawn(id) {
    const entity = this.#entities.get(id);
    if (entity) entity.kill();
  }

  get(id) {
    return this.#entities.get(id);
  }

  /** Повідомити світу: `world.emit('fired', { team, pos })`. */
  emit(type, detail = {}) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  /** Ітерація по ЖИВИХ сутностях (позначені мертвими пропускаються). */
  *[Symbol.iterator]() {
    for (const entity of this.#entities.values()) {
      if (entity.alive) yield entity;
    }
  }

  *ofKind(kind) {
    for (const entity of this) {
      if (entity.kind === kind) yield entity;
    }
  }

  /**
   * Один фіксований крок: оновити всіх -> колізії -> прибрати мертвих.
   * Сутності, заспавнені під час кроку (кулі від fire()), потрапляють у цю ж
   * ітерацію — Map показує елементи, додані під час обходу.
   */
  step(dt, inputs = null) {
    this.inputs = inputs;
    this.time += dt;

    for (const entity of this) {
      entity.update(dt, this);
      this.#wrap(entity);
    }

    this.collisionSystem(this);
    this.#sweep();
  }

  #wrap(entity) {
    if (!entity.wraps) return;

    const x = wrapCoordinate(entity.pos.x, this.width);
    const y = wrapCoordinate(entity.pos.y, this.height);
    if (x !== entity.pos.x || y !== entity.pos.y)
      entity.pos = new Vector2(x, y);
  }

  #sweep() {
    for (const [id, entity] of this.#entities) {
      if (entity.alive) continue;
      entity.world = null;
      this.#entities.delete(id);
    }
  }
}
