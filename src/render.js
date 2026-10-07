const TAU = Math.PI * 2;

// Шари: що малюється раніше, те лежить нижче.
const DRAW_ORDER = ['pickup', 'asteroid', 'ship', 'bullet', 'explosion'];

// Спрайт астероїда трохи більший за його коло зіткнень: скеля неправильної
// форми, а коло зіткнень — вписане. 96 = половина кадру в пікселях атласу.
const ASTEROID_SPRITE_FIT = 1.22;
const ASTEROID_SPRITE_HALF = 96;
const ASTEROID_VARIANTS = 3;

const PICKUP_STYLES = {
  shield: { color: '#3fd0ff', label: 'S' },
  rapidFire: { color: '#ffd23f', label: 'R' },
  homingShots: { color: '#ff5fd2', label: 'H' },
};

export function createRenderer(canvas) {
  const ctx = canvas.getContext('2d');

  let width = 0;
  let height = 0;

  // { image, frames, scale } — з'являється після завантаження ассетів
  let sprites = null;

  const drawers = {
    pickup: drawPickup,
    asteroid: drawAsteroid,
    ship: drawShip,
    bullet: drawBullet,
    explosion: drawExplosion,
  };

  function resize() {
    const dpr = window.devicePixelRatio || 1;

    width = window.innerWidth;
    height = window.innerHeight;

    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  /** Підключити спрайтшит: `image` — ImageBitmap, `atlas` — sprites.json. */
  function setSprites({ image, atlas }) {
    sprites = { image, frames: atlas.frames, scale: atlas.scale ?? 1 };
  }

  function draw(world, alpha) {
    ctx.clearRect(0, 0, width, height);

    drawArena();
    if (!sprites || !world) return; // у лобі гри ще немає — лише фон

    for (const kind of DRAW_ORDER) {
      for (const entity of world.ofKind(kind)) {
        drawers[kind](entity, alpha);
      }
    }
  }

  function drawArena() {
    ctx.fillStyle = '#182018';
    ctx.fillRect(0, 0, width, height);

    ctx.strokeStyle = 'rgba(255, 255, 255, 0.06)';
    ctx.lineWidth = 1;

    const grid = 50;

    for (let x = 0; x <= width; x += grid) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, height);
      ctx.stroke();
    }

    for (let y = 0; y <= height; y += grid) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(width, y);
      ctx.stroke();
    }
  }

  /**
   * Один кадр із спрайтшиту: `drawImage(image, sx, sy, sw, sh, dx, dy, dw, dh)`.
   * Джерело — прямокутник атласу, ціль — той самий розмір, помножений на
   * `k` (скільки логічних одиниць гри в одному пікселі спрайта) і зсунутий
   * так, щоб точка обертання кадру (ax, ay) опинилась в (x, y).
   */
  function drawFrame(name, x, y, rotation, k = 1 / sprites.scale) {
    const frame = sprites.frames[name];
    if (!frame) return;

    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(rotation);
    ctx.drawImage(
      sprites.image,
      frame.x,
      frame.y,
      frame.w,
      frame.h,
      -frame.ax * k,
      -frame.ay * k,
      frame.w * k,
      frame.h * k,
    );
    ctx.restore();
  }

  function drawShip(ship, alpha) {
    const { x, y } = interpolatedPos(ship, alpha);
    const angle = lerpAngle(ship.prevAngle, ship.angle, alpha);
    const turretAngle = lerpAngle(
      ship.prevTurretAngle,
      ship.turretAngle,
      alpha,
    );
    const team = ship.team === 'player' ? 'player' : 'enemy';

    // Корпус і башта — окремі кадри: башта обертається незалежно від корпусу.
    drawFrame(`hull_${team}`, x, y, angle);
    drawFrame(`turret_${team}`, x, y, turretAngle);

    drawShieldRing(ship, x, y);
    drawHealthBar(ship, x, y);
  }

  function drawShieldRing(ship, x, y) {
    const shield = ship.getComponent('shield');
    if (!shield) return;

    // Блимає, коли щит на межі зникнення.
    if (
      shield.remaining < 1.5 &&
      Math.floor(performance.now() / 120) % 2 === 0
    ) {
      return;
    }

    ctx.save();
    ctx.strokeStyle = 'rgba(63, 208, 255, 0.9)';
    ctx.fillStyle = 'rgba(63, 208, 255, 0.12)';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(x, y, ship.radius + 8, 0, TAU);
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }

  function drawHealthBar(ship, x, y) {
    const barWidth = 56;
    const ratio = Math.max(0, ship.hp / ship.maxHp);
    const left = x - barWidth / 2;
    const top = y - ship.radius - 18;

    ctx.fillStyle = 'rgba(0, 0, 0, 0.55)';
    ctx.fillRect(left, top, barWidth, 6);

    ctx.fillStyle =
      ratio > 0.5 ? '#6fd36a' : ratio > 0.25 ? '#ffd23f' : '#ff5a4a';
    ctx.fillRect(left, top, barWidth * ratio, 6);
  }

  function drawAsteroid(asteroid, alpha) {
    const { x, y } = interpolatedPos(asteroid, alpha);
    const angle = lerpAngle(asteroid.prevAngle, asteroid.angle, alpha);

    const name = asteroid.has('homing')
      ? 'asteroid_seeker'
      : `asteroid_${asteroid.id % ASTEROID_VARIANTS}`;

    // розмір підганяємо під коло зіткнень, а не під фіксований масштаб атласу
    const k = (asteroid.radius * ASTEROID_SPRITE_FIT) / ASTEROID_SPRITE_HALF;
    drawFrame(name, x, y, angle, k);
  }

  function drawBullet(bullet, alpha) {
    const { x, y } = interpolatedPos(bullet, alpha);

    const name = bullet.has('homing')
      ? 'bullet_homing'
      : bullet.team === 'player'
        ? 'bullet_player'
        : 'bullet_enemy';

    drawFrame(name, x, y, bullet.vel.angle());
  }

  function drawPickup(pickup, alpha) {
    // Блимає, коли ось-ось зникне.
    if (pickup.ttl < 3 && Math.floor(performance.now() / 150) % 2 === 0) return;

    const { x, y } = interpolatedPos(pickup, alpha);
    const style = PICKUP_STYLES[pickup.type];
    const pulse = 1 + 0.1 * Math.sin(performance.now() / 180);

    ctx.save();
    ctx.translate(x, y);

    ctx.fillStyle = 'rgba(0, 0, 0, 0.45)';
    ctx.strokeStyle = style.color;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(0, 0, pickup.radius * pulse, 0, TAU);
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = style.color;
    ctx.font = 'bold 16px Arial, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(style.label, 0, 1);

    ctx.restore();
  }

  function drawExplosion(explosion) {
    const fade = Math.max(0, explosion.ttl / explosion.lifetime);

    ctx.save();
    ctx.globalAlpha = fade;

    for (const particle of explosion.particles) {
      ctx.fillStyle = fade > 0.55 ? '#ffd23f' : '#ff7a2f';
      ctx.beginPath();
      ctx.arc(
        particle.pos.x,
        particle.pos.y,
        particle.size * (0.4 + fade * 0.6),
        0,
        TAU,
      );
      ctx.fill();
    }

    ctx.restore();
  }

  /**
   * Позиція для малювання: інтерполяція між попереднім і поточним кроком.
   * Якщо сутність щойно "загорнулась" через край арени, стрибок великий —
   * тоді інтерполювати не можна (інакше вона на кадр проїде через весь екран).
   */
  function interpolatedPos(entity, alpha) {
    const jump = entity.prevPos.distanceSqTo(entity.pos);
    return jump > 100 * 100
      ? entity.pos
      : entity.prevPos.lerp(entity.pos, alpha);
  }

  function lerpAngle(a, b, t) {
    let difference = b - a;

    while (difference > Math.PI) difference -= TAU;
    while (difference < -Math.PI) difference += TAU;

    return a + difference * t;
  }

  window.addEventListener('resize', resize);
  resize();

  return {
    ctx,
    get width() {
      return width;
    },
    get height() {
      return height;
    },
    setSprites,
    draw,
  };
}
