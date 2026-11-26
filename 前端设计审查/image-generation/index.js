import { quickUploadField, bindQuickFiles } from './files.js';
import { bindQuickResults } from './results.js';
import { bindImagePlanner } from './agent.js';
import { advancedPromptField, bindPromptFavorites } from './prompt-favorites.js';
import { advancedRecipes, imageStyles, imageTypes, languages, mainImageCapabilityId, platforms, quickChoices, quickPrompt, quickRecipes, regions, sizePresets } from './options.js';
import { describeError } from '../studio-errors.js';
import { field, generationModeTabs, h, select } from '../live-ui.js';

const options = values => values.map(value => [value, value]);
const group = (label, contents) => '<fieldset><legend>' + h(label) + '</legend>' + contents + '</fieldset>';
const qualityLabels = ['日常', '标准', '精修'];

function quickTargets(agent) {
  const reference = agent ? '' : group('风格参考（选填）',
    '<label class="quick-check"><input type="checkbox" name="useReference">添加构图与风格参考</label>' +
    '<div data-quick-reference hidden>' + quickUploadField('reference') + '</div>');
  return reference + group('目标平台', quickChoices('platform', platforms)) +
    '<div class="quick-fields">' + field('目标国家', select('region', options(regions), regions[0])) +
    field('文案语言', select('language', options(languages), languages[0])) + '</div>';
}

function quickStyles(agent) {
  const notes = '<label>补充要求（选填，最多 400 字）<textarea name="notes" maxlength="400" rows="3" ' +
    'placeholder="例如补充使用场景、背景材质或准确的商品价格"></textarea></label>';
  const prompt = '<label>随参数更新的系统提示词<textarea data-quick-prompt readonly rows="7"></textarea></label>';
  return (agent ? '' : '<p class="live-muted" data-quick-suite hidden>套图包含营销图、白底图、场景图、细节图和买家秀各 1 张。</p>') +
    '<div data-quick-type>' + group('主图类型', quickChoices('imageType', imageTypes)) + '</div>' +
    group('是否包含价格', quickChoices('price', [['no', '不包含'], ['yes', '包含']])) +
    group('主图风格', quickChoices('style', imageStyles) +
      '<div data-quick-style hidden>' + field('自定义风格', '<input name="customStyle" maxlength="80">') + '</div>') +
    (agent ? group('策划要求', notes) : group('创意提示词', prompt + notes));
}

export function imageGenerationTabs(mode) {
  return generationModeTabs('图片生成模式', [
    ['quick', 'desk/image', '快速模式'], ['advanced', 'desk/image/advanced', '高级模式'],
    ['agent', 'desk/image/agent', 'Agent 生图'], ['plans', 'image-plans', '商品组图方案'],
    ['skills', 'desk/image/skills', '平台图片技能'],
  ], mode);
}

export function imageGenerationForm(wallet, capability, mode, planning) {
  const advanced = mode === 'advanced';
  const agent = mode === 'agent';
  const modes = imageGenerationTabs(mode);
  const custom = '<div class="quick-fields" data-quick-custom hidden>' +
    field('宽度', '<input type="number" name="width" min="32" max="1600" step="1" value="1024">') +
    field('高度', '<input type="number" name="height" min="32" max="1600" step="1" value="1024">') + '</div>';
  const quality = '<input type="range" name="quality" aria-label="画质要求" min="0" max="2" step="1" value="0"' +
    (advanced ? ' disabled' : '') + '>' +
    '<div class="quick-scale" aria-hidden="true"><span>日常</span><span>标准</span><span>精修</span></div>' +
    '<p class="live-muted"><output data-quick-quality></output></p>';
  const quantities = [['1', '1 张'], ['2', '2 张'], ['3', '3 张'], ['4', '4 张']];
  if (mode === 'quick') quantities.push(['suite', '套图']);
  const status = !capability?.available ? '当前工作区未配置可用的商品主图生成服务。'
    : agent && !planning?.available ? '当前工作区未配置可用的 Agent 策划模型。'
      : advanced ? '请输入完整提示词。' : '请选择至少一张商品图。';

  return '<div class="quick-image-layout"><form class="card quick-image-form" data-image-mode="' + h(mode) +
    '" aria-label="' + (agent ? 'Agent 生图' : advanced ? '高级模式' : '快速生成主图') + '">' +
    '<div class="quick-image-config">' + group('生成模式', modes) +
    group(advanced ? '商品图（选填）' : '商品图', quickUploadField('products')) +
    (advanced ? advancedPromptField() : quickTargets(agent)) + group('图片尺寸', quickChoices('size', sizePresets) + custom) +
    group('生图质量', quality) + group('生成数量', quickChoices('quantity', quantities)) + (advanced ? '' : quickStyles(agent)) + '</div>' +
    '<footer class="quick-image-footer"><div class="live-row"><a href="#account" class="smallbtn" data-quick-wallet>可用 ' +
    h(wallet.available) + ' 积分</a><span class="live-muted" data-quick-cost></span></div>' +
    '<p class="live-muted" data-quick-status role="status">' + h(status) + '</p>' +
    '<button class="primary" type="submit" disabled>' + (agent ? '开始逐张策划' : advanced ? '按提示词生成' : '生成主图') + '</button></footer></form>' +
    '<section class="card quick-image-stage" aria-label="图片生成结果"><div class="quick-image-empty">' +
    '<img data-quick-source alt="商品原图" hidden><h3>成品预览</h3><p class="live-muted">' +
    (agent ? '在这里确认每张图的策划，再生成成品。' : '提交后可在这里查看生成进度和成品。') + '</p></div>' +
    (agent ? '<div class="quick-agent-plan" hidden></div>' : '') +
    '<div class="quick-image-results"></div></section></div>';
}

export function bindImageGeneration(ctx, capability, wallet, planning) {
  const form = document.querySelector('.quick-image-form');
  const stage = document.querySelector('.quick-image-stage');
  const status = form.querySelector('[data-quick-status]');
  const cost = form.querySelector('[data-quick-cost]');
  const button = form.querySelector('[type="submit"]');
  const advanced = form.dataset.imageMode === 'advanced';
  const agent = form.dataset.imageMode === 'agent';
  const planBox = stage.querySelector('.quick-agent-plan');
  const empty = stage.querySelector('.quick-image-empty');
  const results = stage.querySelector('.quick-image-results');
  const planner = agent ? bindImagePlanner(ctx, planBox) : null;
  const quality = form.elements.quality;
  let available = wallet.available;
  let remaining = null;
  let resultsCurrent = false;
  let model;
  let busy = false;
  const files = bindQuickFiles(ctx, form, () => {
    const preview = stage.querySelector('[data-quick-source]');
    const url = files.firstPreview();
    preview.hidden = !url;
    if (url) preview.src = url;
    else preview.removeAttribute('src');
    if (capability?.available && (!agent || planning?.available)) status.textContent = '';
    edited();
  }, error => { status.textContent = error; });

  async function updateWallet() {
    try {
      const wallet = await ctx.api('/v1/credits/wallet');
      if (ctx.active()) {
        available = wallet.available;
        form.querySelector('[data-quick-wallet]').textContent = '可用 ' + available + ' 积分';
        sync();
      }
    } catch { /* The account page remains available if this balance read fails. */ }
  }

  const submit = bindQuickResults(ctx, results, ({ completed, total, unconfirmed }) => {
    if (!agent || resultsCurrent) {
      status.textContent = '已完成 ' + completed + ' / ' + total + ' 张目标尺寸成品。' + (unconfirmed
        ? '参数保持不变时，可再次点击生成以重试未确认的任务。' : completed < total ? '其余结果见成品预览。' : '');
    }
    void updateWallet();
  });

  function sync() {
    const values = Object.fromEntries(new FormData(form));
    const show = (name, visible) => { form.querySelector('[data-quick-' + name + ']').hidden = !visible; };
    const custom = values.size === 'custom';
    const suite = values.quantity === 'suite';
    show('custom', custom);
    form.elements.width.required = form.elements.height.required = custom;
    form.elements.width.disabled = form.elements.height.disabled = !custom;
    let qualityLabel = qualityLabels[Number(quality.value)] + ' · 画质要求随提示词提交';
    if (advanced) {
      quality.disabled = !model?.imageQuality;
      qualityLabel = model?.imageQuality ? qualityLabels[Number(quality.value)] + ' · 由 ' + model.id + ' 执行'
        : '使用模型默认画质';
      form.querySelector('[data-advanced-length]').textContent = form.elements.prompt.value.length;
    } else {
      const customStyle = values.style === '自定义';
      show('style', customStyle);
      show('type', !suite);
      form.elements.customStyle.required = customStyle;
      if (!agent) {
        show('reference', form.elements.useReference.checked);
        show('suite', suite);
        form.querySelector('[data-quick-prompt]').value =
          quickPrompt(values, form.elements.useReference.checked && files.count('reference') > 0, suite ? imageTypes[0] : values.imageType);
      }
    }
    form.querySelector('[data-quick-quality]').textContent = qualityLabel;
    const count = suite ? imageTypes.length : Number(values.quantity);
    const generationCost = (remaining ?? count) * (capability?.cost ?? 0);
    const planCost = agent && !planner.hasTask() ? (planning?.cost ?? 0) : 0;
    const resuming = agent && planner.hasAttempt() && !planner.recipes();
    const insufficient = agent && !resuming && capability?.available && planning?.available && available < generationCost + planCost;
    cost.textContent = capability ? (planCost ? '策划 ' + planCost + ' + 出图 ' + generationCost + ' · 共 ' + (planCost + generationCost) + ' 积分'
      : (remaining ?? count) + ' 张 · ' + generationCost + ' 积分') : '';
    if (agent) button.textContent = insufficient ? '积分不足' : planner.recipes() ? '确认方案并生成' :
      resuming ? '继续查看策划' : '开始逐张策划';
    button.disabled = busy || !capability?.available || (agent && (!planning?.available || insufficient)) ||
      (advanced ? !form.elements.prompt.value.trim() : !files.count('products'));
  }

  function edited() {
    if (agent && !busy) {
      if (planner.hasAttempt()) status.textContent = '设置已更新，请重新策划。';
      planner.reset();
      remaining = null;
      empty.hidden = results.childElementCount > 0;
    }
    sync();
  }

  form.addEventListener('input', edited);
  form.addEventListener('change', edited);
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (button.disabled) return;
    const useReference = form.elements.useReference?.checked === true;
    if (useReference && !files.count('reference')) {
      status.textContent = '请添加一张参考图，或关闭风格参考。';
      return;
    }
    const values = Object.fromEntries(new FormData(form));
    if (advanced) values.prompt = form.elements.prompt.value;
    busy = true;
    files.setLocked(true);
    form.querySelector('.quick-image-config').inert = true;
    sync();
    try {
      if (agent && !planner.recipes()) {
        resultsCurrent = false;
        empty.hidden = true;
        status.textContent = 'Agent 正在逐张策划…';
        await planner.prepare(values);
        if (ctx.active()) status.textContent = '请查看右侧方案，确认后生成。';
        return;
      }
      const recipes = agent ? planner.recipes() : advanced ? advancedRecipes(values, model) : quickRecipes(values, useReference);
      status.textContent = files.count('products') ? '正在上传图片并提交任务…' : '正在提交任务…';
      const assetIds = await files.upload(useReference);
      if (!ctx.active()) return;
      empty.hidden = true;
      resultsCurrent = true;
      const accepted = await submit(recipes, assetIds);
      if (!ctx.active()) return;
      if (agent) {
        remaining = accepted === recipes.length ? null : recipes.length - accepted;
        if (remaining === null) planner.complete();
      }
      status.textContent = accepted === recipes.length ? '已提交 ' + accepted + ' 张，等待生成。'
        : '已确认 ' + accepted + ' / ' + recipes.length + ' 张。参数保持不变时，可再次点击生成以重试未确认的任务。';
    } catch (error) {
      if (ctx.active()) status.textContent = describeError(error);
    } finally {
      if (ctx.active()) {
        busy = false;
        files.setLocked(false);
        form.querySelector('.quick-image-config').inert = false;
        if (agent) empty.hidden = !planBox.hidden || results.childElementCount > 0;
        sync();
        void updateWallet();
      }
    }
  });
  if (advanced) {
    bindPromptFavorites(ctx, form);
    ctx.api('/v1/models?capabilityId=' + mainImageCapabilityId).then(({ items }) => {
      if (!ctx.active()) return;
      model = items[0];
      sync();
    }).catch(() => { /* Generation can use the default model quality. */ });
  }
  sync();
}
