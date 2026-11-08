/**
 * Експеримент Web Worker (модель на worker_threads — той самий механізм
 * передачі повідомлень, що й у браузері).
 *
 * Питання лаби: винести частину роботи в окремий потік і лишити ТІЛЬКИ якщо
 * головний потік став швидшим. Кандидат — декодування бінарних знімків.
 *
 * Міряємо три речі:
 *   inline        — декодувати N кадрів прямо в головному потоці;
 *   clone back     — structured-clone тих самих декодованих знімків (саме це
 *                    воркер мусить переслати назад — і це НЕ transferable);
 *   worker RT      — повний оберт: кадри у воркер, декодовані знімки назад.
 *
 *   node shared/experiments/worker-offload.ts
 */
import { performance } from 'node:perf_hooks';
import { Worker } from 'node:worker_threads';
import { binaryCodec } from '../src/codec/index.ts';
import { buildSnapshot } from '../src/protocol/snapshot.ts';
import { runScenario } from '../src/scenario.ts';

const N = 2000;

const { game } = runScenario({ steps: 300, players: 8 });
const frame = binaryCodec.encodeSnapshot(buildSnapshot(game, []));
const frames = Array.from({ length: N }, () => frame.slice());

// 1) inline — скільки роботи ми взагалі можемо зняти з головного потоку
let t = performance.now();
const decoded = frames.map((f) => binaryCodec.decodeSnapshot(f));
const inlineMs = performance.now() - t;

// 2) ціна повернення результату з воркера (structured clone, не transferable)
t = performance.now();
for (const snap of decoded) structuredClone(snap);
const cloneMs = performance.now() - t;

// 3) реальний оберт через воркер
const worker = new Worker(new URL('./decode-worker.ts', import.meta.url));
const started = performance.now();
worker.once('message', (returned: unknown[]) => {
  const workerMs = performance.now() - started;
  console.table([
    {
      frames: N,
      'inline decode (ms)': +inlineMs.toFixed(2),
      'clone results back (ms)': +cloneMs.toFixed(2),
      'worker round-trip (ms)': +workerMs.toFixed(2),
      returned: returned.length,
    },
  ]);
  const verdict =
    workerMs < inlineMs
      ? 'Воркер ШВИДШИЙ — варто лишити.'
      : 'Воркер ПОВІЛЬНІШИЙ: передача повідомлень коштує більше, ніж сама робота. Лишаємо в головному потоці.';
  console.log('Висновок:', verdict);
  worker.terminate();
});
worker.postMessage(frames);
