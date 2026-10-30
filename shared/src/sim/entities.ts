import type { Asteroid } from './asteroid.ts';
import type { Bullet } from './bullet.ts';
import type { Explosion } from './explosion.ts';
import type { Pickup } from './pickup.ts';
import type { Ship } from './ship.ts';

/**
 * Усі види сутностей світу — дискриміноване об'єднання за полем `kind`.
 * `switch (e.kind)` звужує `e` до конкретного класу, а `default: assertNever(e)`
 * робить забутий вид помилкою компіляції.
 */
export type SimEntity = Ship | Bullet | Asteroid | Pickup | Explosion;

/** Вид → клас: `SimEntityOf<'ship'>` = Ship. */
export type SimEntityOf<K extends SimEntity['kind']> = Extract<SimEntity, { readonly kind: K }>;
