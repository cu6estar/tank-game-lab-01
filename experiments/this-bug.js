// Експеримент: що буде з `this`, якщо передати ship.fire у слухач події.
// Запуск: npm run exp:this   (або node experiments/this-bug.js)

import { World } from '../src/sim/world.js';
import { Ship } from '../src/sim/ship.js';
import { Vector2 } from '../src/sim/vector.js';

// Те, що робить браузер, коли викликає слухача: listener.call(currentTarget, event).
// Тобто `this` усередині слухача — це елемент/вікно, на якому висить слухач.
const fakeWindow = { name: 'window' };
const dispatch = (listener) => listener.call(fakeWindow, { code: 'Space' });

function createShip(ShipClass = Ship) {
  const world = new World({ width: 800, height: 600 });
  const ship = world.spawn(
    new ShipClass({ pos: new Vector2(400, 300), team: 'player' }),
  );
  return { world, ship };
}

const bulletsIn = (world) => [...world.ofKind('bullet')].length;

function attempt(label, makeListener, ShipClass) {
  const { world, ship } = createShip(ShipClass);

  try {
    dispatch(makeListener(ship));
    console.log(`${label}: куль у світі = ${bulletsIn(world)}`);
  } catch (error) {
    console.log(`${label}: ${error.name}: ${error.message}`);
  }
}

// 0. Баг: метод відірвано від об'єкта, this = fakeWindow.
attempt('0. ship.fire напряму   ', (ship) => ship.fire);

// 1. Стрілка-обгортка: усередині виклик ship.fire() — implicit binding.
attempt('1. () => ship.fire()   ', (ship) => () => ship.fire());

// 2. bind: створює нову функцію з жорстко прив'язаним this (explicit binding).
attempt('2. ship.fire.bind(ship)', (ship) => ship.fire.bind(ship));

// 3. Поле-стрілка: кожен екземпляр має власну fire з лексичним this.
class FieldShip extends Ship {
  fire = () => super.fire();
}
attempt('3. поле-стрілка        ', (ship) => ship.fire, FieldShip);

// Ціна поля-стрілки: метод уже не живе на прототипі, а копіюється в кожен екземпляр.
const a = new FieldShip({ pos: new Vector2(), team: 'player' });
const b = new FieldShip({ pos: new Vector2(), team: 'player' });
const c = new Ship({ pos: new Vector2(), team: 'player' });
const d = new Ship({ pos: new Vector2(), team: 'player' });
console.log(
  '\nспільна fire у двох звичайних Ship (з прототипа):',
  c.fire === d.fire,
);
console.log(
  'спільна fire у двох FieldShip (власні копії):     ',
  a.fire === b.fire,
);
