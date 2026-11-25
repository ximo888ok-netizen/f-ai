import { h, link, select } from './live-ui.js';
import { videoRatios } from './live-video-prompt-options.js';

export const quickVideoLimit = 9;
export const quickVideoSteps = ['准备素材', '生成脚本', '确认脚本', '生成视频'];

function sourceButton(label, key) {
  return '<button type="button" class="smallbtn" popovertarget="video-quick-' + key + '">' + label + '</button>' +
    '<div id="video-quick-' + key + '" class="video-popover video-quick-library" popover aria-label="' + label + '"></div>';
}

function sources() {
  return '<fieldset><legend>商品图 <span class="live-muted" data-video-quick-count>0 / ' + quickVideoLimit + '</span></legend>' +
    '<div class="video-quick-drop" data-video-quick-drop><strong>添加商品图</strong>' +
    '<p class="live-muted">拖放或粘贴 PNG、JPEG，每张最多 10 MiB。</p>' +
    '<input type="file" accept=".png,.jpg,.jpeg" multiple hidden data-video-quick-file>' +
    '<div class="video-quick-source-actions"><button type="button" class="smallbtn" data-video-quick-upload>本地上传</button>' +
    sourceButton('素材库', 'library') + sourceButton('最近生成', 'recent') + '</div></div>' +
    '<p class="live-muted video-quick-help">可添加多张备选图，生成时使用指定的首帧。</p>' +
    '<ul class="video-quick-photos" aria-label="已选商品图" data-video-quick-photos></ul></fieldset>';
}

function outputSettings() {
  return '<fieldset><legend>视频时长</legend><div class="video-duration">' +
    '<label for="video-quick-duration">时长（秒）</label><output for="video-quick-duration" data-video-quick-seconds></output>' +
    '<input id="video-quick-duration" name="duration" type="range" min="1" max="10" step="1" value="5"></div>' +
    '<div class="video-quick-range-labels" aria-hidden="true"><span data-video-quick-min></span><span data-video-quick-max></span></div></fieldset>' +
    '<fieldset><legend>视频比例</legend><div class="video-quick-ratios">' + videoRatios.map(([value, label]) =>
      '<label class="video-option"><input type="radio" name="ratio" value="' + h(value) + '"' + (value ? '' : ' checked') +
      '><span>' + h(label) + '</span></label>').join('') + '</div></fieldset>' +
    '<fieldset><legend>清晰度</legend><p class="live-muted">跟随所选模型的默认设置。</p></fieldset>';
}

export function videoCreationForm(models, available, { title, description, submit }) {
  const modelOptions = models.length ? models.map(model => [model.id, model.id === model.model ? model.id : model.id + ' · ' + model.model]) :
    [['', available ? '工作区网关' : '未配置可用模型']];
  return '<form class="card quick-image-form video-quick-form" aria-label="' + h(title) + '">' +
    '<div class="quick-image-config"><h3>' + h(title) + '</h3>' + sources() + description + outputSettings() +
    '</div><footer class="quick-image-footer"><label>视频模型' + select('modelId', modelOptions, modelOptions[0][0], models.length ? '' : 'disabled') +
    '</label><div class="video-quick-cost">' + link('积分账户', 'account') + '<span class="live-muted" data-video-quick-cost></span></div>' +
    '<p role="status" class="live-muted" data-video-quick-status></p><button class="primary" type="submit" disabled>' + h(submit) + '</button></footer></form>';
}

export function videoCreationProgress(steps) {
  return '<ol class="video-quick-progress" aria-label="创作进度">' + steps.map((label, index) =>
    '<li' + (index ? '' : ' aria-current="step"') + '><span aria-hidden="true">' + (index + 1) + '</span>' + h(label) + '</li>').join('') + '</ol>';
}

export function videoCreationFrame(title, details) {
  return '<div class="video-quick-preview" data-video-quick-preview><div data-video-quick-frame class="video-quick-frame" hidden></div>' +
    '<div data-video-quick-empty><h4>' + h(title) + '</h4><p class="live-muted">' + h(details) + '</p></div></div>';
}

export function videoQuickView(models, available) {
  const description = '<fieldset><legend>补充描述 <span class="live-muted">可选，最多 200 字</span></legend><label>场景或商品卖点' +
    '<textarea name="notes" rows="3" maxlength="200" placeholder="例如：在阳光下拍摄水杯，突出便携设计。"></textarea></label>' +
    '<p class="live-muted video-quick-help">脚本根据文字说明编排，成片时才会使用首帧。</p></fieldset>';
  return '<div class="quick-image-layout video-quick-layout" data-video-quick>' +
    videoCreationForm(models, available, { title: '智能快创', description, submit: '生成脚本' }) +
    '<section class="card video-quick-stage" aria-label="方案与成片"><header><h3>方案与成片</h3>' + link('查看任务记录', 'tasks') + '</header>' +
    videoCreationProgress(quickVideoSteps) + videoCreationFrame('从一张商品图开始', '添加商品图后即可预览首帧。填写场景或卖点，让脚本更贴合商品。') +
    '<section class="video-quick-script" data-video-quick-script hidden><label>成片脚本<textarea data-video-quick-script-text rows="7"></textarea></label>' +
    '<p class="live-muted">可编辑镜头、动作和节奏。确认后，脚本会与选定首帧一起用于生成。</p></section>' +
    '<div data-video-quick-plan-task hidden></div><section class="video-quick-result" data-video-quick-result hidden aria-label="视频结果"></section></section></div>';
}
