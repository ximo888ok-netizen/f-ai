import test from 'node:test';
import assert from 'node:assert/strict';
import { groupOrders } from '../../前端设计审查/live-commerce-report.js';
import { revisedCopy } from '../../前端设计审查/live-copy-suggestions.js';
import { detectTerms } from '../src/catalog.js';

test('weekly and monthly reports keep missing amounts distinct from zero and preserve cents',()=>{
  const input=[
    {day:'2026-01-04',orders:1,withAmount:0,units:'1',paidMinor:null},
    {day:'2026-01-05',orders:2,withAmount:1,units:'3',paidMinor:'9007199254740994'},
    {day:'2026-01-11',orders:1,withAmount:1,units:'1',paidMinor:'1'},
  ];
  const [week,prev]=groupOrders(input,'week');
  assert.deepEqual(week,{period:'2026-01-05',orders:3,known:2,units:4n,paid:9007199254740995n});
  assert.equal(prev.period,'2025-12-29');assert.equal(prev.known,0);
  assert.equal(groupOrders(input,'month')[0].orders,4);
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
