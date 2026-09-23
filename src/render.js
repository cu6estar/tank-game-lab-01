export function createRenderer(canvas) {
  const ctx = canvas.getContext('2d');

  let width = 0;
  let height = 0;

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

  function draw(tank, alpha) {
    ctx.clearRect(0, 0, width, height);

    drawArena();
    drawTank(tank, alpha);
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

  function drawTank(tank, alpha) {
    const x = lerp(tank.previousX, tank.x, alpha);
    const y = lerp(tank.previousY, tank.y, alpha);
    const angle = lerpAngle(tank.previousAngle, tank.angle, alpha);
    const turretAngle = lerpAngle(
      tank.previousTurretAngle,
      tank.turretAngle,
      alpha,
    );

    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(angle);

    // Гусениці
    ctx.fillStyle = '#111';
    ctx.fillRect(-28, -25, 56, 12);
    ctx.fillRect(-28, 13, 56, 12);

    // Корпус
    ctx.fillStyle = '#4f7f45';
    ctx.fillRect(-24, -18, 48, 36);

    ctx.fillStyle = '#6f9c5e';
    ctx.fillRect(-15, -13, 30, 26);

    ctx.restore();

    // Башта обертається незалежно від корпусу
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(turretAngle);

    ctx.fillStyle = '#3d6337';
    ctx.beginPath();
    ctx.arc(0, 0, 15, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = '#293f25';
    ctx.fillRect(0, -4, 38, 8);

    ctx.restore();
  }

  function lerp(a, b, t) {
    return a + (b - a) * t;
  }

  function lerpAngle(a, b, t) {
    let difference = b - a;

    while (difference > Math.PI) difference -= Math.PI * 2;
    while (difference < -Math.PI) difference += Math.PI * 2;

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
