import { h, link } from './live-ui.js';
import { factGroups } from './live-video-director-plan.js';
import { videoCreationForm, videoCreationFrame, videoCreationProgress } from './live-video-quick-view.js';

export const directorSteps = [
  ['setup', '准备素材'], ['insights', '挖掘信息'], ['facts', '筛选信息'], ['directions', '生成方向'],
  ['direction', '选择方向'], ['script', '确认脚本'], ['video', '生成视频'],
];

function factsEditor(run) {
  return '<h4 tabindex="-1">筛选商品信息</h4><p class="live-muted">选择希望在视频中呈现的内容。</p><div class="director-fact-grid">' +
    factGroups.map(([, label]) => {
      const options = run.facts.map((fact, index) => fact.label === label ?
        '<label class="director-option"><input type="checkbox" name="director-fact" value="' + index + '"' +
        (run.selectedFacts.has(index) ? ' checked' : '') + '><span>' + h(fact.value) + '</span></label>' : '').join('');
      return options ? '<fieldset><legend>' + label + '</legend>' + options + '</fieldset>' : '';
    }).join('') + '</div>';
}

function directionEditor(run) {
  return '<h4 tabindex="-1">选择创作方向</h4><div class="director-direction-list">' + run.directions.map((direction, index) =>
    '<label class="director-option"><input type="radio" name="director-direction" value="' + index + '"' +
    (run.selectedDirection === index ? ' checked' : '') + '><span><strong>' + h(direction.title) + '</strong><small>' +
    h(direction.detail) + '</small></span></label>').join('') + '</div>';
}

export function directorStage(phase, run, maxLength) {
  if (phase === 'facts') return factsEditor(run);
  if (phase === 'direction') return directionEditor(run);
  if (phase === 'script' && run.script !== undefined) return '<h4 tabindex="-1">确认成片脚本</h4><label class="director-script">成片脚本' +
    '<textarea rows="7" maxlength="' + maxLength + '" data-director-script>' + h(run.script) + '</textarea></label>' +
    '<p class="live-muted">确认后将用这份脚本和指定的首帧生成视频。</p>';
  if (phase === 'video' && run.reviseScript) return directorStage('script', run, maxLength);
  const labels = { insights: '挖掘商品信息', directions: '生成创作方向', script: '生成成片脚本', video: '生成成片' };
  return labels[phase] ? '<h4 tabindex="-1">' + labels[phase] + '</h4>' : '';
}

export function videoDirectorView(models, available, storyboardRoute) {
  const description = '<fieldset><legend>商品信息</legend><label>商品名称、卖点或使用场景' +
    '<textarea name="notes" rows="3" maxlength="400" required placeholder="例如：可折叠收纳的水杯，适合通勤或户外。"></textarea></label>' +
    '<p class="live-muted video-quick-help">模型从文字提炼信息，成片使用选定首帧。</p></fieldset>';
  return '<div class="quick-image-layout video-quick-layout video-director-layout" data-video-director>' +
    videoCreationForm(models, available, { title: '智能导演', description, submit: '挖掘商品信息' }) +
    '<section class="card video-quick-stage director-stage" aria-label="导演工作区"><header><h3>导演工作区</h3>' +
    '<div class="director-stage-links">' + link('商品分镜技能','desk/video/skills/video.skill-product-storyboard')+link('参考广告改编','desk/video/skills/video.skill-ad-rewrite')+link('实拍剪辑','desk/video/skills/video.skill-openstoryline')+link('分镜编辑', storyboardRoute) + link('任务记录', 'tasks') + '</div></header>' +
    videoCreationProgress(directorSteps.map(([, label]) => label)) +
    videoCreationFrame('从商品资料到拍摄方案', '添加商品图并填写已知信息。你可以逐步筛选信息、选择创作方向，再编辑脚本。') +
    '<section class="director-stage-content" data-director-stage hidden></section><div class="director-task-links" data-director-tasks hidden></div>' +
    '<section class="video-quick-result" data-director-result hidden aria-label="视频结果"></section>' +
    '<div class="director-stage-actions" data-director-actions hidden><p role="status" class="live-muted" data-director-status></p>' +
    '<div class="live-row"><button type="button" class="smallbtn" data-director-reset>修改素材或参数</button>' +
    '<button type="button" class="primary" data-director-next></button></div></div></section></div>';
}
