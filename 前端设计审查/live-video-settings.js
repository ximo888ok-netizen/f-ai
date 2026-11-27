import { h } from './live-ui.js';

export function videoSettingsMarkup() {
  return {
    ratio: '<fieldset><legend>画幅比例</legend><div class="video-ratios" data-video-ratios></div></fieldset>' +
      '<fieldset><legend>清晰度</legend><div class="video-ratios" data-video-resolutions></div></fieldset>',
    length: '<label class="video-duration-auto"><input type="checkbox" name="defaultDuration" checked>使用模型默认时长</label>' +
      '<div class="video-duration"><label for="video-duration-range">时长（秒）</label><output data-video-duration></output>' +
      '<input id="video-duration-range" type="range" name="duration" step="1">' +
      '<select name="durationChoice" aria-label="可用时长"></select></div>',
    audio: '<fieldset><legend>生成音轨</legend><div class="video-ratios" data-video-audio></div></fieldset>',
  };
}

function choices(root, key, name, values, fallback) {
  const box = root.querySelector('[data-video-' + key + ']');
  const signature = JSON.stringify(values);
  if (box.dataset.options === signature) return;
  const previous = box.querySelector('input:checked')?.value;
  box.dataset.options = signature;
  const items = [['', '模型默认'], ...values];
  const selected = items.some(([value]) => value === previous) ? previous : '';
  box.innerHTML = values.length ? items.map(([value, label]) =>
    '<label class="video-option"><input type="radio" name="' + name + '" value="' + h(value) + '"' +
    (value === selected ? ' checked' : '') + '><span>' + h(label) + '</span></label>').join('') :
    '<span class="live-muted">' + fallback + '</span>';
}

export function updateVideoSettings(root, fields, spec) {
  const entries = values => values.map(value => [value, value]);
  choices(root, 'ratios', 'ratio', entries(spec.ratios), '画幅由模型决定');
  choices(root, 'resolutions', 'resolution', entries(spec.resolutions), '使用模型默认清晰度');
  choices(root, 'audio', 'generateAudio', spec.audio ? [['true', '有声'], ['false', '无声']] : [], '模型未提供声音切换');
  const { durations, min, max } = spec;
  const range = fields.duration, select = fields.durationChoice, automatic = fields.defaultDuration;
  const sparse = durations.length > 0 && max - min + 1 !== durations.length;
  const signature = JSON.stringify(durations);
  if (range.dataset.options !== signature) {
    const previous = Number(select.hidden ? range.value : select.value);
    range.dataset.options = signature;
    if (range.dataset.initialized && !durations.includes(previous)) automatic.checked = true;
    range.dataset.initialized = '1';
    range.min = min ?? 0;
    range.max = max ?? 0;
    select.innerHTML = sparse ? durations.map(value => '<option value="' + value + '">' + value + ' 秒</option>').join('') : '';
    const selected = durations.includes(previous) ? previous : durations.includes(5) ? 5 : min;
    if (selected !== undefined) { range.value = selected; select.value = selected; }
  }
  if (!durations.length) automatic.checked = true;
  automatic.disabled = !durations.length;
  range.hidden = !durations.length || sparse;
  select.hidden = !sparse;
  range.disabled = range.hidden || automatic.checked;
  select.disabled = select.hidden || automatic.checked;
  const duration = Number(sparse ? select.value : range.value);
  root.querySelector('[data-video-duration]').textContent = !durations.length ? '由模型决定' :
    (automatic.checked ? '模型默认' : duration + ' 秒') + ' · 最长 ' + max + ' 秒';
}

export function readVideoSettings(fields) {
  const sound = fields.generateAudio?.value;
  return { ratio: fields.ratio?.value || undefined, resolution: fields.resolution?.value || undefined,
    audio: sound === 'true' ? true : sound === 'false' ? false : undefined,
    duration: fields.defaultDuration.checked ? undefined : Number(fields.durationChoice.hidden ? fields.duration.value : fields.durationChoice.value) };
}
