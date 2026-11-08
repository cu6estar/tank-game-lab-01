// Воркер: отримує масив бінарних кадрів, декодує їх і повертає декодовані
// знімки назад (саме так виглядав би офлоад декодування з головного потоку).
import { parentPort } from 'node:worker_threads';
import { binaryCodec } from '../src/codec/index.ts';

parentPort?.on('message', (frames: Uint8Array[]) => {
  const snapshots = frames.map((f) => binaryCodec.decodeSnapshot(f));
  parentPort?.postMessage(snapshots); // structured clone назад — головна ціна
});
