// Експеримент: ланцюжок прототипів і те, як знаходиться метод.
// Запуск: npm run exp:proto   (або node experiments/prototype-chain.js)

import { Ship } from '../src/sim/ship.js';
import { Bullet } from '../src/sim/bullet.js';
import { Vector2 } from '../src/sim/vector.js';

const ship = new Ship({ pos: new Vector2(), team: 'player' });
const owner = ship;
const bulletA = new Bullet({
  pos: new Vector2(),
  vel: new Vector2(1, 0),
  owner,
});
const bulletB = new Bullet({
  pos: new Vector2(),
  vel: new Vector2(0, 1),
  owner,
});

// 1. Увесь ланцюжок від екземпляра до кінця.
const chain = ['ship'];
for (
  let proto = Object.getPrototypeOf(ship);
  proto;
  proto = Object.getPrototypeOf(proto)
) {
  chain.push(`${proto.constructor.name}.prototype`);
}
chain.push('null');
console.log('ланцюжок:', chain.join('  ->  '));

// 2. Де саме знайшовся кожен метод (кроки пошуку: власні властивості, потім вгору).
function whereIs(object, property) {
  const steps = [];
  for (
    let current = object;
    current;
    current = Object.getPrototypeOf(current)
  ) {
    const owner =
      current === object
        ? 'власні властивості екземпляра'
        : `${current.constructor.name}.prototype`;
    if (Object.hasOwn(current, property)) {
      steps.push(`${owner}: ЗНАЙДЕНО`);
      return steps;
    }
    steps.push(`${owner}: немає`);
  }
  steps.push('кінець ланцюжка: undefined');
  return steps;
}

for (const property of ['fire', 'update', 'kill', 'toString']) {
  console.log(`\nship.${property}:`);
  for (const step of whereIs(ship, property)) console.log(`   ${step}`);
}

// 3. Поведінка ділиться пошуком, а не копіюванням.
console.log(
  '\nbulletA.update === bulletB.update:',
  bulletA.update === bulletB.update,
);
console.log('власний update у кулі?', Object.hasOwn(bulletA, 'update'));
console.log(
  'власні поля кулі (дані, а не методи):',
  Object.keys(bulletA).join(', '),
);
