const MAX_SPEED = 220;
const ACCELERATION = 650;
const REVERSE_ACCELERATION = 450;
const FRICTION = 0.88;
const TURN_SPEED = Math.PI * 1.5;
const TURRET_TURN_SPEED = Math.PI * 2;

export function createTank(x, y) {
  return {
    x,
    y,
    previousX: x,
    previousY: y,
    angle: 0,
    previousAngle: 0,
    turretAngle: 0,
    previousTurretAngle: 0,
    vx: 0,
    vy: 0,
  };
}

export function integrateTank(tank, input, dt, width, height) {
  tank.previousX = tank.x;
  tank.previousY = tank.y;
  tank.previousAngle = tank.angle;
  tank.previousTurretAngle = tank.turretAngle;

  let throttle = 0;
  if (input.isDown('KeyW')) throttle += 1;
  if (input.isDown('KeyS')) throttle -= 1;

  if (input.isDown('KeyA')) {
    tank.angle -= TURN_SPEED * dt;
  }

  if (input.isDown('KeyD')) {
    tank.angle += TURN_SPEED * dt;
  }

  if (input.isDown('KeyQ')) {
    tank.turretAngle -= TURRET_TURN_SPEED * dt;
  }

  if (input.isDown('KeyE')) {
    tank.turretAngle += TURRET_TURN_SPEED * dt;
  }

  const acceleration =
    throttle >= 0 ? ACCELERATION : REVERSE_ACCELERATION;

  if (throttle !== 0) {
    const targetVx = Math.cos(tank.angle) * MAX_SPEED * throttle;
    const targetVy = Math.sin(tank.angle) * MAX_SPEED * throttle;

    tank.vx += (targetVx - tank.vx) * Math.min(1, acceleration * dt / MAX_SPEED);
    tank.vy += (targetVy - tank.vy) * Math.min(1, acceleration * dt / MAX_SPEED);
  } else {
    tank.vx *= Math.pow(FRICTION, dt * 60);
    tank.vy *= Math.pow(FRICTION, dt * 60);
  }

  tank.x += tank.vx * dt;
  tank.y += tank.vy * dt;

  tank.x = wrap(tank.x, width);
  tank.y = wrap(tank.y, height);
}

function wrap(value, size) {
  if (value < 0) return value + size;
  if (value >= size) return value - size;
  return value;
}
