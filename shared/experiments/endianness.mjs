// "Prove it" №1 і №2: порядок байтів Float32 і чому Uint16Array не годиться для мережі.
const hex = (bytes) =>
  [...bytes].map((b) => b.toString(16).padStart(2, '0')).join(' ');

const view = new DataView(new ArrayBuffer(4));
view.setFloat32(0, 1.5, true);
console.log('Float32 1.5, little-endian :', hex(new Uint8Array(view.buffer)));
view.setFloat32(0, 1.5, false);
console.log('Float32 1.5, big-endian    :', hex(new Uint8Array(view.buffer)));

// Float32Array пише в порядку байтів ПРОЦЕСОРА (тут — як і майже всюди, LE)
const typed = new Float32Array([1.5]);
console.log('Float32Array([1.5]) байти  :', hex(new Uint8Array(typed.buffer)));

const u16 = new Uint16Array([1, 0, 0, 1]);
console.log(
  '\nUint16Array([1,0,0,1]) як байти:',
  hex(new Uint8Array(u16.buffer)),
);
console.log(
  '  → на LE-процесорі 01 00 00 00 00 00 01 00; на BE було б 00 01 00 00 00 00 00 01',
);

const bytes = new Uint8Array([1, 0, 0, 1]);
const dv = new DataView(bytes.buffer);
console.log('\nті самі 4 байти [1,0,0,1] як Uint16:');
console.log('  DataView LE :', dv.getUint16(0, true), dv.getUint16(2, true));
console.log('  DataView BE :', dv.getUint16(0, false), dv.getUint16(2, false));
console.log(
  '  (DataView без аргументу = BE: легко забути `true` і прочитати сміття)',
);

// Невирівняний доступ: Float32Array вимагає offset кратний 4, DataView — ні
try {
  new Float32Array(new ArrayBuffer(16), 1, 1);
} catch (error) {
  console.log(
    '\nFloat32Array на offset=1:',
    error.constructor.name,
    '—',
    error.message,
  );
}
console.log(
  'DataView.getFloat32(1):',
  new DataView(new ArrayBuffer(16)).getFloat32(1, true),
  '(працює)',
);
