import fc from 'fast-check';

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/** Explicit depth, width and string bounds; replay costs cannot grow with a random seed. */
export function boundedJson(depth: number): fc.Arbitrary<Json> {
  const primitive: fc.Arbitrary<Json> = fc.oneof(
    fc.constant(null), fc.boolean(), fc.integer(),
    fc.double({ noNaN: true, noDefaultInfinity: true }),
    fc.string({ maxLength: 32 }), fc.constantFrom('é😀', 'e\u0301', '__proto__'),
  );
  let value = primitive;
  for (let level = 0; level < depth; level++) value = fc.oneof(
    primitive, fc.array(value, { maxLength: 4 }),
    fc.dictionary(fc.string({ maxLength: 16 }), value, { maxKeys: 4 }),
  );
  return value;
}
