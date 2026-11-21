import assert from 'node:assert/strict';
import test from 'node:test';
import { operationForms } from '../src/operation-forms.js';
import { readOperationsCsv, template } from '../../前端设计审查/operations-file.js';

test('business CSV preserves quoted text, exact minor units, missing amounts and reference strings', () => {
  const model = operationForms.orders;
  const csv = template(model) + '0001,"Cup, ""small""\r\nblue",2026-01-01,待发货,1,0.01,\r\n' +
    '0002,Cup,2026-01-01,已完成,2,,\r\n';
  const [first,second] = readOperationsCsv(csv,model);
  assert.equal(first.reference,'0001');
  assert.equal(first.details.title,'Cup, "small"\r\nblue');
  assert.equal(first.details.paidMinor,1);
  assert.ok(!Object.hasOwn(second.details,'paidMinor'));
  assert.throws(() => readOperationsCsv(csv.replace('0.01','1.001'),model),/格式/);
  assert.throws(() => readOperationsCsv('unknown,value\n1,2',model),/表头/);
  assert.throws(() => readOperationsCsv(template(model) + '1,"open',model),/引号/);
});
