import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import test from 'node:test';
import { createCanvas } from '@napi-rs/canvas';
import { catalog } from '../src/catalog.js';
import { GeneratedFile } from '../src/model-file.js';
import { createStudioFixture } from '../test-support/ui-actions.js';

test('submit each non-shop catalog task form to the real queue, worker, wallet and result store', {
  skip: !process.env.FAI_TEST_PLAYWRIGHT_PATH, timeout: 420000,
}, async t => {
  const { page, api, read, open, act, providers } = await createStudioFixture(t,{credits:1000});
  const image = createCanvas(1024,1024).toBuffer('image/png');
  const encode = async args => (await promisify(execFile)(process.env.FAI_TEST_FFMPEG_PATH,
    ['-v','error','-nostdin',...args,'pipe:1'],{encoding:'buffer',maxBuffer:4*1024*1024})).stdout;
  const video = await encode(['-f','lavfi','-i','color=c=blue:s=720x720:r=12','-t','1.3','-c:v','libx264','-pix_fmt','yuv420p','-movflags','frag_keyframe+empty_moov','-f','mp4']);
  const audio = await encode(['-f','lavfi','-i','sine=frequency=550','-t','0.4','-f','mp3']);
  const upload = (name,mediaType,data) => api('POST','/v1/assets',{ name,mediaType,dataBase64:data.toString('base64'),
    source:'合成测试',purpose:'能力表单用例',consentReference:'synthetic-fixture',consentExpiresAt:new Date(Date.now()+86400000).toISOString() });
  const images = [];
  for (let i=0;i<4;i++) {
    const {id} = await upload('sample-'+i+'.png','image/png',image);
    await api('PUT','/v1/media/images/'+id+'/preflight',{revision:0,personCount:1,occlusionPercent:0});
    images.push(id);
  }
  const movie = (await upload('sample.mp4','video/mp4',video)).id;
  await api('PUT','/v1/media/videos/'+movie+'/preflight',{revision:0,shotCount:1,personCount:1,maxFacingAngle:10});
  const speech = (await upload('sample.mp3','audio/mpeg',audio)).id;
  const tasks = [...catalog.values()].filter(c=>c.execution!=='endpoint' && c.pluginId!=='operations' && c.id!=='model.voice-turn');
  for (const c of tasks) {
    if (c.execution==='local') continue;
    const alias = c.mediaSkill?.alias ?? (c.execution.startsWith('model:') ? c.execution.slice(6) : 'action-'+c.id.replaceAll('.','-'));
    const key = 'model:'+alias;
    if (providers.has(key)) continue;
    const kind = c.mediaSkill?.output ?? ({image:'image',video:'video'}[c.pluginId] ?? 'text');
    providers.set(key,{info:{id:alias,kind,model:'Synthetic '+c.name,protocol:c.mediaSkill?'media-skill':'openai-chat',streamText:false,capabilities:[c.id]},
      supports: cap=>cap.id===c.id,run:async task=>{
        assert.equal(task.capability_id,c.id);
        if (kind==='image') return new GeneratedFile(image,'image/png',{});
        if (kind==='video') return new GeneratedFile(video,'video/mp4',{});
        if (c.id==='model.speech') return new GeneratedFile(audio,'audio/mpeg',{});
        if (c.id==='model.embed') return {type:'embedding',vectors:[[0.25,0.75]]};
        if (c.id==='model.rerank') return {type:'rerank',items:[{index:0,score:1}]};
        return {type:'text',text:'合成执行结果 '+c.id};
      }});
  }
  for (const c of tasks) await t.test(c.id,async () => {
    const form = page.locator('[data-form=task]');
    // A document navigation gives identical forms on consecutive tool routes a
    // fresh lifecycle instead of inadvertently submitting the preceding tool.
    await page.goto('about:blank');
    await open('create/'+c.pluginId+'/'+c.id,form);
    const props = c.parameters.properties ?? {};
    const control = name => page.locator('[name="'+name+'"]');
    for (const [field,schema] of Object.entries(props)) {
      if (field==='assetIds') {
        const n = c.minAssets;
        if (!n) continue;
        let files = images.slice(0,n);
        if (c.id==='model.transcribe') files=[speech];
        else if(c.mediaSkill?.needsMovie || (c.pluginId==='video' && ['video.try-on','video.replace-product','video.reference','video.replace-person','video.reframe','video.export'].includes(c.id))) {
          files=[movie,...images.slice(0,n-1)];
        }
        await control('params.assetIds').selectOption(files);
      } else if (field==='messages') {
        await control('conversation.user').fill('检查商品内容');
      } else if (field==='prompt' || c.parameters.required?.includes(field)) {
        const target=control('params.'+field);
        if (schema.enum) await target.selectOption(String(schema.enum[0]));
        else if (schema.type==='string') await target.fill('合成商品资料');
        else if (schema.type==='array') await target.fill('参照样本');
      }
    }
    if(c.id==='image.main-image') {
      for(const chip of await page.locator('[data-brief-chip]').all()) {
        await chip.click();
        assert.ok((await control('params.prompt').inputValue()).includes(await chip.getAttribute('data-brief-chip')));
      }
    }
    const submit = form.locator('button[type=submit], button:not([type])').last();
    assert.equal(await submit.isEnabled(),true,c.id+' should be available with its synthetic adapter');
    const response = await act('能力表单 '+c.id,submit,{method:'POST',path:'/v1/tasks',status:202});
    const task = await response.json(), endpoint='/v1/tasks/'+task.id;
    assert.equal(task.capabilityId,c.id);
    await page.waitForURL(url=>url.hash==='#tasks/'+task.id);
    let state = (await read(endpoint)).state;
    for(let i=0;i<60 && ['queued','running'].includes(state);i++){
      await new Promise(resolve=>setTimeout(resolve,100));
      state=(await read(endpoint)).state;
    }
    assert.equal(state,'succeeded',JSON.stringify(await read(endpoint)));
    const stored = await read(endpoint+'/inputs');
    const submitted = response.request().postDataJSON();
    assert.equal(stored.mode,submitted.mode);
    for (const [name,value] of Object.entries(submitted.parameters)) {
      assert.deepEqual(stored.parameters[name],value,c.id+' '+name);
    }
  });
  assert.equal((await read('/v1/credits/wallet')).reserved,0);
});

