import test from 'node:test';
import assert from 'node:assert/strict';
import { commerceReport } from '../../前端设计审查/live-commerce-report.js';
import { revisedCopy } from '../../前端设计审查/live-copy-suggestions.js';
import { detectTerms } from '../src/catalog.js';

test('ledger reporting queries the selected period and displays exact cents and missing amounts', async () => {
  let markup;
  const ctx = {
    api: async url => {
      assert.equal(url, '/v1/studio/pinduoduo/books/book/report?from=2026-01-04&to=2026-01-11&period=week');
      const fields = { orders: '1', units: '1', views: null, visitors: null,
        buyers: null, salesMinor: null, conversionPercent: null, traffic: { '搜索': '0' } };
      return { items: [
        { ...fields, start: '2025-12-29', paidOrders: '0', paidMinor: null },
        { ...fields, start: '2026-01-05', paidOrders: '1', paidMinor: '9007199254740995' },
      ] };
    },
    html: value => { markup = value; },
    submit() {},
    click() {},
  };
  await commerceReport(ctx, { id: 'book', name: '测试台账' }, 'from=2026-01-04&to=2026-01-11&period=week');
  assert.match(markup, /实付合计 暂无/);
  assert.match(markup, /¥90071992547409\.95/);
  assert.match(markup, /搜索 0/);
});
test('apply review edits by UTF-16 offset and keep markup, repeated terms and unrelated lines intact',()=>{
  const title='  📦最 <b>第一</b> 最';
  const points=['未改动','100%'];
  const issues=[...detectTerms({content:title}).matches.map(m=>({...m,code:'REVIEW_TERM',field:'title'})),
    ...detectTerms({content:points[1]}).matches.map(m=>({...m,code:'REVIEW_TERM',field:'sellingPoints',position:1}))];
  const out=revisedCopy({title,sellingPoints:points},issues);
  assert.equal(out.title,'  📦较 <b>表现突出</b> 较');
  assert.deepEqual(out.sellingPoints,['未改动','较高比例']);
  assert.match(out.marked,/&lt;b&gt;<mark>第一<\/mark>/);
});
