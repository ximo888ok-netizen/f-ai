import assert from 'node:assert/strict';
import test from 'node:test';
import { agentImageRecipes } from '../../前端设计审查/image-generation/agent.js';
import { advancedRecipes, imageTypes, quickRecipes } from '../../前端设计审查/image-generation/options.js';

const settings = {
  size: '1024x1024', quantity: '1', style: '智能风格', quality: '1', platform: '拼多多',
  region: '中国', language: '简体中文', imageType: '营销图', price: 'no', notes: '保留布纹',
};

test('fast main image presets and suites preserve the product brief and requested size', () => {
  const suite = quickRecipes({ ...settings, size: 'custom', width: '480', height: '640', quantity: 'suite',
    style: '自定义', customStyle: '暖光', price: 'yes' }, true);
  assert.equal(suite.length, 5);
  for (const [index, job] of suite.entries()) {
    assert.equal(job.width, 480);
    assert.equal(job.height, 640);
    assert.equal(job.parameters.ratio, '3:4');
    assert.ok(job.parameters.prompt.includes('主图类型为「' + imageTypes[index] + '」'));
    assert.match(job.parameters.prompt, /拼多多.*中国/);
    assert.match(job.parameters.prompt, /最后一张输入图仅供参考/);
    assert.match(job.parameters.prompt, /风格为「暖光」/);
    assert.match(job.parameters.prompt, /只有在追加要求明确提供价格时才显示具体金额/);
    assert.match(job.parameters.prompt, /追加要求：保留布纹/);
  }

  const [first] = quickRecipes({ ...settings, size: '1024x1536', quantity: '2' }, false);
  assert.equal(first.width, 1024);
  assert.equal(first.height, 1536);
  assert.match(first.parameters.prompt, /不包含价格/);
  assert.doesNotMatch(first.parameters.prompt, /最后一张输入图/);
});

test('fast main image choices reject invalid dimensions and quantity', () => {
  assert.throws(() => quickRecipes({ ...settings, size: 'custom', width: '1601', height: '800' }, false), /32–1600/);
  assert.throws(() => quickRecipes({ ...settings, quantity: '20' }, false), /请选择生成数量/);
});

test('advanced image mode keeps the complete prompt and separates supported model quality', () => {
  const prompt = '  白色台面，陶瓷杯。\n保留自然阴影。  ';
  const values = { ...settings, size: 'custom', width: '480', height: '640', quantity: '2', quality: '2', prompt };
  const jobs = advancedRecipes(values, { id: 'openai-image', imageQuality: true });
  assert.equal(jobs.length, 2);
  for (const job of jobs) {
    assert.deepEqual(job.parameters, { prompt, ratio: '3:4' });
    assert.equal(job.imageQuality, 'high');
    assert.equal(job.modelId, 'openai-image');
  }
  const [defaultJob] = advancedRecipes(values);
  assert.equal(defaultJob.imageQuality, undefined);
  assert.equal(defaultJob.parameters.prompt, prompt);
  assert.throws(() => advancedRecipes({ ...values, prompt: ' ' }), /1–1200/);
  assert.throws(() => advancedRecipes({ ...values, prompt: '字'.repeat(1201) }), /1–1200/);
  assert.throws(() => advancedRecipes({ ...values, quantity: 'suite' }), /生成数量/);
});

test('agent image mode keeps the selected brief and assigns a separate direction to each image', () => {
  const base = quickRecipes({ ...settings, quantity: '2' }, false);
  const images = [
    { title: '柔光主图', direction: '低视角，柔和侧光与干净台面。' },
    { title: '卖点细节', direction: '商品局部特写，右侧留卖点文字空间。' },
  ];
  const recipes = agentImageRecipes(JSON.stringify({ images }), base);
  assert.deepEqual(recipes.map(recipe => recipe.direction), images.map(image => image.direction));
  assert.equal(recipes[0].width, 1024);
  assert.equal(recipes[0].parameters.ratio, '1:1');
  assert.match(recipes[0].parameters.prompt, /拼多多/);
  assert.match(recipes[0].parameters.prompt, /柔和侧光/);
  assert.doesNotMatch(recipes[1].parameters.prompt, /柔和侧光/);
  assert.throws(() => agentImageRecipes(JSON.stringify({ images: images.slice(0, 1) }), base), /格式有误/);
  assert.throws(() => agentImageRecipes(JSON.stringify({ images: [images[0], images[0]] }), base), /格式有误/);
});
