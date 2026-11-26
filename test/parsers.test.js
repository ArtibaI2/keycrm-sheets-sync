import test from "node:test";
import assert from "node:assert/strict";
import { parseSizeQuantities, buildVariantSku } from "../src/parsers/sizeQuantityParser.js";
import { parseCsvMatrix, matrixToObjects } from "../src/parsers/csvParser.js";

test("parseSizeQuantities parses combined '1XS 1S' format", () => {
  const res = parseSizeQuantities("1XS 1S");
  assert.deepEqual(res.errors, []);
  assert.deepEqual(res.entries, [
    { size: "XS", quantity: 1 },
    { size: "S", quantity: 1 },
  ]);
});

test("parseSizeQuantities parses hyphens, Cyrillic lookalikes, commas, spaces, multipliers, colons", () => {
  assert.deepEqual(parseSizeQuantities("4-XS 3-S 4-M").entries, [
    { size: "XS", quantity: 4 },
    { size: "S", quantity: 3 },
    { size: "M", quantity: 4 },
  ]);

  // Cyrillic "М" in "3М" must normalize to Latin "M"
  assert.deepEqual(parseSizeQuantities("1XS 1S 3М").entries, [
    { size: "XS", quantity: 1 },
    { size: "S", quantity: 1 },
    { size: "M", quantity: 3 },
  ]);

  // Standalone number before "1M" must NOT become size "1M"
  assert.deepEqual(parseSizeQuantities("3 1M").entries, [
    { size: null, quantity: 3 },
    { size: "M", quantity: 1 },
  ]);

  assert.deepEqual(parseSizeQuantities("2M, 3L").entries, [
    { size: "M", quantity: 2 },
    { size: "L", quantity: 3 },
  ]);

  assert.deepEqual(parseSizeQuantities("1 2XL 2 S").entries, [
    { size: "2XL", quantity: 1 },
    { size: "S", quantity: 2 },
  ]);

  assert.deepEqual(parseSizeQuantities("xs:1 s=2 1xM").entries, [
    { size: "XS", quantity: 1 },
    { size: "S", quantity: 2 },
    { size: "M", quantity: 1 },
  ]);

  assert.deepEqual(parseSizeQuantities("1XS 2XS").entries, [
    { size: "XS", quantity: 3 },
  ]);

  assert.deepEqual(parseSizeQuantities("1XS 2S-").entries, [
    { size: "XS", quantity: 1 },
    { size: "S", quantity: 2 },
  ]);
});

test("parseSizeQuantities handles plain numeric stock and empty markers", () => {
  assert.deepEqual(parseSizeQuantities("5").entries, [{ size: null, quantity: 5 }]);
  assert.deepEqual(parseSizeQuantities("-").entries, []);
  assert.deepEqual(parseSizeQuantities("").entries, []);
});

test("parseSizeQuantities reports invalid tokens without crashing", () => {
  const res = parseSizeQuantities("1XS ???");
  assert.equal(res.entries.length, 1);
  assert.equal(res.errors.length, 1);
});

test("buildVariantSku builds SKU with and without size", () => {
  assert.equal(buildVariantSku("EZRA", "XS", "{baseSku}-{size}"), "EZRA-XS");
  assert.equal(buildVariantSku("CAP-01", null, "{baseSku}-{size}"), "CAP-01");
});

test("parseCsvMatrix + matrixToObjects preserves unnamed col0, UTF-8 BOM, quotes, and semicolons", () => {
  const csv = '\uFEFF;АРТИКУЛ;Киів\n"LEA BLACK";"SS1007";"4OS"\n';
  const rows = matrixToObjects(parseCsvMatrix(csv));
  assert.equal(rows.length, 1);
  assert.equal(rows[0]["__col0"], "LEA BLACK");
  assert.equal(rows[0]["АРТИКУЛ"], "SS1007");
  assert.equal(rows[0]["Киів"], "4OS");
});
