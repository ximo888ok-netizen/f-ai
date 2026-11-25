import { date, h, link, notice, path } from './live-ui.js';
import { videoInputs, videoRatios, videoSkills, videoTemplates } from './live-video-prompt-options.js';

function popover(id, label, body, attrs = '') {
  return '<button type="button" class="smallbtn video-control" popovertarget="video-' + id + '" ' + attrs + '>' + h(label) +
    '</button><div id="video-' + id + '" class="video-popover" popover aria-label="' + h(label) + '">' + body + '</div>';
}

function option(group, value, label, description = '') {
  return '<label class="video-option"><input type="radio" name="' + group + '" value="' + h(value) + '"><span><strong>' +
    h(label) + '</strong>' + (description ? '<small>' + h(description) + '</small>' : '') + '</span></label>';
}

function toolbar() {
  return '<div class="video-toolbar" aria-label="视频设置">' +
    popover('skill', '编导技能', videoSkills.map(([id, name, description]) => option('skill', id, name, description)).join(''), 'hidden') +
    popover('media', '添加素材', '<button type="button" class="plain" data-video-upload>本地上传</button>' +
      '<div data-video-library></div>' + link('打开素材库', 'assets')) +
    popover('input', '文字生成视频', Object.entries(videoInputs).map(([id, item]) => option('inputType', id, item.label)).join('') +
      link('视频编辑与导出', 'media/video')) +
    popover('model', '视频模型', '<div data-video-models></div>') +
    popover('ratio', '画幅与清晰度', '<fieldset><legend>画幅比例</legend><div class="video-ratios">' +
      videoRatios.map(([id, name]) => option('ratio', id, name)).join('') + '</div></fieldset>' +
      '<p class="live-muted">清晰度由所选模型决定。</p>') +
    popover('length', '视频时长', '<label class="video-duration-auto"><input type="checkbox" name="defaultDuration" checked>使用模型默认时长</label>' +
      '<div class="video-duration"><label for="video-duration-range">时长（秒）</label><output for="video-duration-range" data-video-duration></output>' +
      '<input id="video-duration-range" type="range" name="duration" step="1" min="1" max="10" value="5"></div>') +
    popover('audio', '声音', notice('音轨由生成模型决定。可在视频导出中选择保留音轨或静音。') + link('视频导出', 'media/video')) + '</div>';
}

export function videoModelOptions(models, available) {
  if (!models.length) return notice(available ? '使用工作区配置的视频网关。' : '当前输入类型没有可用的视频模型。');
  return models.map(model => option('videoModel', model.id, model.id, model.model === model.id ? '' : model.model)).join('');
}

function references(tasks, states) {
  const recent = tasks.filter(task => task.capabilityId.startsWith('video.')).slice(0, 3);
  return '<aside class="video-side" aria-label="模板与历史"><section class="video-templates"><h3>视频模板</h3>' +
    videoTemplates.map(([label, detail], i) => '<button type="button" class="video-template" data-video-template="' + i + '"><strong>' + h(label) +
      '</strong><small>' + h(detail) + '</small></button>').join('') + '</section><section><h3>最近视频任务</h3>' +
    (recent.length ? '<ul>' + recent.map(task => '<li>' + link((states[task.state] ?? task.state) + ' · ' + date(task.createdAt),
      'tasks/' + path(task.id)) + '</li>').join('') + '</ul>' :
      notice('暂无视频任务。')) + link('查看任务记录', 'tasks') + '</section></aside>';
}

export function videoPromptView(tasks, states) {
  return '<div class="video-prompt" data-video-prompt><div class="video-prompt-heading"><h3>描述你想拍的视频</h3>' +
    '<div class="video-mode" role="group" aria-label="成片方式">' +
    '<button type="button" class="smallbtn" data-video-mode="direct" aria-pressed="true">直接生成</button>' +
    '<button type="button" class="smallbtn" data-video-mode="plan" aria-pressed="false">智能编导</button></div></div>' +
    '<div class="video-prompt-grid"><form class="video-composer" data-form="video-prompt">' +
    '<label class="video-prompt-input">创作提示词<textarea name="prompt" rows="5" maxlength="4000" required ' +
    'placeholder="写下场景、主体和镜头动作。例如：从窗边的晨光移向桌上的杯子，慢慢推近杯口。"></textarea></label>' +
    '<div class="video-prompt-meta"><div data-video-asset></div><span class="live-muted" data-video-count></span></div>' +
    '<input type="file" data-video-file accept=".png,.jpg,.jpeg" hidden>' + toolbar() +
    '<section class="video-plan" data-video-plan hidden><label>成片方案<textarea rows="5" data-video-plan-text></textarea></label>' +
    '<div data-video-plan-task></div></section>' +
    '<footer class="video-prompt-footer"><div><p data-video-cost class="live-muted"></p><p role="status" data-video-status></p></div>' +
    '<button type="submit" class="primary" disabled>生成视频</button></footer></form>' + references(tasks, states) + '</div></div>';
}
