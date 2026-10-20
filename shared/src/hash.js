/**
 * Хеш стану гри — "відбиток пальця" для перевірки детермінізму: двічі
 * прогнали ту саму послідовність вводів → хеші мусять збігтися біт у біт,
 * у Node так само, як у Chrome.
 *
 * FNV-1a по байтах, числа записуються через DataView з ЯВНИМ порядком байтів
 * (little-endian), тож хеш не залежить від архітектури процесора.
 */
const view = new DataView(new ArrayBuffer(8));

export function createHasher() {
  let hash = 0x811c9dc5;

  const byte = (b) => {
    hash ^= b;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  };

  return {
    /** Точне подання double: два різні числа не дають однакових байтів. */
    number(value) {
      view.setFloat64(0, value, true);
      for (let i = 0; i < 8; i++) byte(view.getUint8(i));
    },
    string(text) {
      for (let i = 0; i < text.length; i++) {
        const code = text.charCodeAt(i);
        byte(code & 0xff);
        byte(code >>> 8);
      }
    },
    digest() {
      return hash.toString(16).padStart(8, '0');
    },
  };
}

/** Хеш усього спостережуваного стану Game: сутності в порядку світу + гравці. */
export function hashGame(game) {
  const h = createHasher();
  h.number(game.tick);

  for (const entity of game.world) {
    h.number(entity.id);
    h.string(entity.kind);
    h.number(entity.pos.x);
    h.number(entity.pos.y);
    h.number(entity.vel.x);
    h.number(entity.vel.y);
    h.number(entity.angle);

    if (entity.kind === 'ship') {
      h.number(entity.turretAngle);
      h.number(entity.hp);
      h.number(entity.cooldown);
    }
  }

  for (const [slot, record] of game.players) {
    h.number(slot);
    h.number(record.score);
    h.number(record.seq);
  }
  return h.digest();
}
