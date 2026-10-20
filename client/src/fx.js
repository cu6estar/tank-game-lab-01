/**
 * Вибухи — суто косметичні й живуть лише на клієнті. Тут Math.random() доречний:
 * він не впливає на стан гри (того, що рахує сервер), лише на розліт іскор.
 * Саме тому цей файл НЕ в shared/ — там Math.random заборонений ESLint-ом.
 */
export function createEffects() {
  let explosions = [];

  return {
    get explosions() {
      return explosions;
    },
    explode(x, y, radius = 20) {
      const count = Math.max(8, Math.round(radius / 2.5));
      const particles = Array.from({ length: count }, () => {
        const angle = Math.random() * Math.PI * 2;
        const speed = 40 + Math.random() * 160;
        return {
          x: 0,
          y: 0,
          vx: Math.cos(angle) * speed,
          vy: Math.sin(angle) * speed,
          size: 2 + Math.random() * 4,
        };
      });
      explosions.push({ x, y, particles, age: 0, lifetime: 0.6 });
    },
    update(dt) {
      for (const e of explosions) {
        e.age += dt;
        for (const p of e.particles) {
          p.x += p.vx * dt;
          p.y += p.vy * dt;
        }
      }
      explosions = explosions.filter((e) => e.age < e.lifetime);
    },
    clear() {
      explosions = [];
    },
  };
}
