const TAU = Math.PI * 2;

// Шари: що малюється раніше, те лежить нижче.
const DRAW_ORDER = ['pickup', 'asteroid', 'ship', 'bullet', 'explosion'];

const SHIP_PALETTES = {
  player: {
    hull: '#4f7f45',
    deck: '#6f9c5e',
    turret: '#3d6337',
    barrel: '#293f25',
  },
  enemy: {
    hull: '#8a4a3a',
    deck: '#b0665a',
    turret: '#6b3329',
    barrel: '#43201a',
  },
};

const PICKUP_STYLES = {
  shield: { color: '#3fd0ff', label: 'S' },
  rapidFire: { color: '#ffd23f', label: 'R' },
  homingShots: { color: '#ff5fd2', label: 'H' },
};

export function createRenderer(canvas) {
  const ctx = canvas.getContext('2d');

  let width = 0;
  let height = 0;

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

  function draw(world, alpha) {
    ctx.clearRect(0, 0, width, height);

    drawArena();

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

  function drawShip(ship, alpha) {
    const { x, y } = interpolatedPos(ship, alpha);
    const angle = lerpAngle(ship.prevAngle, ship.angle, alpha);
    const turretAngle = lerpAngle(
      ship.prevTurretAngle,
      ship.turretAngle,
      alpha,
    );
    const palette = SHIP_PALETTES[ship.team] ?? SHIP_PALETTES.enemy;

    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(angle);

    // Гусениці
    ctx.fillStyle = '#111';
    ctx.fillRect(-28, -25, 56, 12);
    ctx.fillRect(-28, 13, 56, 12);

    // Корпус
    ctx.fillStyle = palette.hull;
    ctx.fillRect(-24, -18, 48, 36);

    ctx.fillStyle = palette.deck;
    ctx.fillRect(-15, -13, 30, 26);

    ctx.restore();

    // Башта обертається незалежно від корпусу
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(turretAngle);

    ctx.fillStyle = palette.turret;
    ctx.beginPath();
    ctx.arc(0, 0, 15, 0, TAU);
    ctx.fill();

    ctx.fillStyle = palette.barrel;
    ctx.fillRect(0, -4, 38, 8);

    ctx.restore();

    drawShieldRing(ship, x, y);
    drawHealthBar(ship, x, y);
  }

  function drawShieldRing(ship, x, y) {
    const shield = ship.getComponent('shield');
    if (!shield) return;

    // Блимає, коли щит на межі зникнення.
    if (shield.remaining < 1.5 && Math.floor(performance.now() / 120) % 2 === 0)
      return;

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
    const seeker = asteroid.has('homing');

    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(angle);

    ctx.beginPath();
    asteroid.shape.forEach((vertex, i) => {
      if (i === 0) ctx.moveTo(vertex.x, vertex.y);
      else ctx.lineTo(vertex.x, vertex.y);
    });
    ctx.closePath();

    ctx.fillStyle = seeker ? '#6b3030' : '#5a5148';
    ctx.strokeStyle = seeker ? '#ff6a5a' : '#8d8274';
    ctx.lineWidth = seeker ? 3 : 2;
    ctx.fill();
    ctx.stroke();

    ctx.restore();
  }

  function drawBullet(bullet, alpha) {
    const { x, y } = interpolatedPos(bullet, alpha);
    const heading = bullet.vel.angle();
    const homing = bullet.has('homing');
    const color = homing
      ? '#ff5fd2'
      : bullet.team === 'player'
        ? '#ffe56a'
        : '#ff7a5a';

    ctx.strokeStyle = color;
    ctx.lineWidth = 3;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(x - Math.cos(heading) * 12, y - Math.sin(heading) * 12);
    ctx.lineTo(x, y);
    ctx.stroke();

    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(x, y, bullet.radius, 0, TAU);
    ctx.fill();
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
    get width() {
      return width;
    },
    get height() {
      return height;
    },
    draw,
  };
}
