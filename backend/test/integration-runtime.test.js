import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { loadIntegrations, commercePlatforms } from '../src/integration-config.js';
import { runIntegration } from '../src/integration-runner.js';

// Opt in with the deployment's Python paths. All model traffic goes to this test's loopback server.
test('installed upstream runtimes, deterministic commerce reports and structured content transport', {
  skip: !process.env.FAI_TEST_INTEGRATIONS_FILE,
}, async () => {
  const { customer, commerce, content } = loadIntegrations({ FAI_PLUGIN_INTEGRATIONS_FILE: process.env.FAI_TEST_INTEGRATIONS_FILE });
  const [ca, ops] = await Promise.all([runIntegration(customer,'customer','probe'), runIntegration(commerce,'commerce','probe',{ platforms:commercePlatforms })]);
  assert.equal(ca.engine, 'Customer-Agent');
  assert.ok(ops.taobao.includes('get_order_list'));
  assert.deepEqual(ops.pinduoduo, []);
  const date = '2026-01-10';
  const shop = { platform:'taobao',shop_id:'fixture',orders:[],refunds:[],coverage:{[date]:{orders:true,refunds:true}} };
  const report = shops => runIntegration(commerce,'commerce','report',{date,shops});
  assert.equal((await report([shop])).total_summary.gmv, 0);
  assert.equal((await report([{...shop,coverage:{}}])).total_summary.gmv, null);

  const result = { selling_points:['500 mL'],target_audience:'通勤人群', optimized_title:'500 mL 水杯',
    description:'不锈钢杯身', social_copy:'通勤带上水杯', seo_keywords:['水杯'],is_compliant:true,violations:[],risk_level:'low' };
  for (const field of ['accuracy','attractiveness','compliance','seo']) result[field] = { score:5,reason:'测试' };
  const requests = [];
  let truncate = false;
  const server = createServer(async (req,res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    requests.push({ path:req.url, format:body.response_format });
    res.writeHead(200,{'content-type':'application/json'});
    res.end(JSON.stringify({id:'fixture',object:'chat.completion',created:1,model:'fixture',
      choices:[{index:0,finish_reason:truncate?'length':'stop',message:{role:'assistant',content:JSON.stringify(result)}}]}));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try {
    const model = { name:'fixture',key:'test-only', baseUrl:'http://127.0.0.1:'+server.address().port+'/v1' };
    const generate = () => runIntegration(content,'content','generate',{ model, parameters:{
      platform:'taobao',title:'水杯',facts:'容量 500 mL，不锈钢杯身。',category:'杯具',
    } });
    const output = await generate();
    assert.equal(output.optimized_title,result.optimized_title);
    assert.deepEqual(output.selling_points,result.selling_points);
    assert.ok(requests.length >= 5);
    assert.ok(requests.every(r => r.path === '/v1/chat/completions' && r.format.type === 'json_object'));
    truncate = true;
    await assert.rejects(generate(), {code:'INVALID_PROVIDER_RESULT'});
  } finally { await new Promise(resolve=>server.close(resolve)); }
});
