function picture(kind) {
  const base = '/studio/assets/login-cup-' + kind + '-';
  return '<picture class="entry-scene-' + kind + '">' +
    '<source media="(max-width:899px)" srcset="' + base + 'compact.webp">' +
    '<img alt="" width="1440" height="1328" draggable="false" src="' + base + 'large.webp"></picture>';
}

export function loginScene(merchant) {
  return '<section class="entry-scene" data-entry-scene aria-label="陶瓷杯原图和精修效果对比">' +
    picture('raw') + picture('refined') +
    '<span class="entry-scene-brand">寰球 AI · ' + (merchant ? '商家工作空间' : '电商工作台') + '</span>' +
    '<div class="entry-scene-tools"><span class="entry-scene-hint">轻移鼠标，查看精修效果</span>' +
    '<button type="button" class="smallbtn" data-scene-compare aria-label="精修对比" aria-pressed="false">查看精修</button></div></section>';
}

export function bindLoginScene(stage, signal) {
  const button = stage.querySelector('[data-scene-compare]');
  let x = 0, y = 0, targetX = 0, targetY = 0, frame = 0;
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  const clear = () => {
    cancelAnimationFrame(frame);
    frame = 0;
    stage.removeAttribute('data-spot');
  };
  function paint() {
    const speed = reduced.matches ? 1 : 0.34;
    x += (targetX - x) * speed;
    y += (targetY - y) * speed;
    stage.style.setProperty('--entry-x', x + 'px');
    stage.style.setProperty('--entry-y', y + 'px');
    frame = Math.abs(x - targetX) + Math.abs(y - targetY) > 0.8 ? requestAnimationFrame(paint) : 0;
  }
  stage.addEventListener('pointermove', event => {
    if (event.pointerType === 'touch' || stage.hasAttribute('data-refined') || event.target.closest('button')) return;
    const rect = stage.getBoundingClientRect();
    targetX = event.clientX - rect.left;
    targetY = event.clientY - rect.top;
    if (!stage.hasAttribute('data-spot')) {
      x = targetX;
      y = targetY;
      stage.setAttribute('data-spot','');
    }
    if (!frame) paint();
  }, {signal});
  stage.addEventListener('pointerleave', clear, {signal});
  button.addEventListener('click', () => {
    clear();
    const show = stage.toggleAttribute('data-refined');
    button.setAttribute('aria-pressed', String(show));
    button.textContent = show ? '查看原图' : '查看精修';
  }, {signal});
  signal.addEventListener('abort', clear, {once:true});
}
