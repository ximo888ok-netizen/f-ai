import { waitForModelTask } from '../live-agent-model.js';
import { quickRecipes } from './options.js';
import { h, link, path, uid } from '../live-ui.js';

export const agentImagePlannerId = 'model.chat';

const instructions = '你是电商商品图片策划师。按要求为每张图给出不同的构图、拍摄视角、光线、背景或文案布局。' +
  '此阶段只有文字要求，商品原图会在后续生成时提供。不要声称看过原图，不要编造商品材料、规格、认证、售价或买家评价。' +
  '只输出 JSON，格式为 {"images":[{"title":"简短标题","direction":"该图独立的画面执行方案"}]}。每项标题最多 40 字，方案最多 800 字。';

export function agentImageRecipes(text, base) {
  const failure = () => new Error('Agent 返回的逐张策划格式有误。');
  let result;
  try {
    result = JSON.parse(String(text ?? '').trim().replace(/^\x60{3}(?:json)?\s*|\s*\x60{3}$/gi, ''));
  } catch {
    throw failure();
  }
  if (!Array.isArray(result?.images) || result.images.length !== base.length) throw failure();
  const directions = new Set();
  return result.images.map((image, index) => {
    const title = typeof image?.title === 'string' ? image.title.trim() : '';
    const direction = typeof image?.direction === 'string' ? image.direction.trim() : '';
    if (!title || title.length > 40 || !direction || direction.length > 800 || directions.has(direction)) throw failure();
    directions.add(direction);
    const recipe = base[index];
    return {
      ...recipe,
      label: (index + 1) + ' · ' + title,
      direction,
      parameters: { ...recipe.parameters, prompt: recipe.parameters.prompt + '\n本张图的执行方案：\n' + direction },
    };
  });
}

export function bindImagePlanner(ctx, container) {
  let current;

  function showTask(task) {
    container.innerHTML = '<h3>逐张策划</h3><div class="live-row">' + link('查看策划任务', 'tasks/' + path(task.id)) + '</div>' +
      '<p class="live-muted" role="status">正在生成每张图片的方案…</p>';
    container.hidden = false;
  }

  function showPlan(recipes, task) {
    container.innerHTML = '<h3>逐张策划</h3><div class="live-row">' + link('查看策划任务', 'tasks/' + path(task.id)) + '</div>' +
      '<div class="quick-plan-grid">' + recipes.map(recipe => '<article class="quick-result"><h4>' + h(recipe.label) +
        '</h4><p>' + h(recipe.direction) + '</p><details class="live-fold"><summary>查看完整生图提示词</summary><p>' +
        h(recipe.parameters.prompt) + '</p></details></article>').join('') + '</div>';
  }

  return {
    hasAttempt: () => Boolean(current),
    hasTask: () => Boolean(current?.task),
    recipes: () => current?.recipes,
    complete() { current = undefined; },
    reset() {
      current = undefined;
      container.hidden = true;
      container.replaceChildren();
    },
    async prepare(values) {
      if (values.quantity === 'suite') throw new Error('请选择 1–4 张图片。');
      const base = quickRecipes(values, false);
      current ??= { idempotencyKey: uid() };
      const attempt = current;
      attempt.task ??= await ctx.api('/v1/tasks', { method: 'POST', body: {
        capabilityId: agentImagePlannerId, mode: 'workflow', idempotencyKey: attempt.idempotencyKey,
        parameters: { messages: [
          { role: 'system', content: instructions },
          { role: 'user', content: '请给出 ' + base.length + ' 张图片的一一对应方案。要求如下：\n' + base[0].parameters.prompt },
        ] },
      } });
      if (!ctx.active()) return;
      showTask(attempt.task);
      attempt.task = await waitForModelTask(ctx, attempt.task, 90000);
      if (!ctx.active()) return;
      if (['queued', 'running'].includes(attempt.task.state)) {
        container.querySelector('[role="status"]').textContent = '策划仍在执行，可继续等待同一个任务。';
        throw new Error('策划仍在执行，再次点击可查看同一任务。');
      }
      if (attempt.task.state !== 'succeeded') {
        current = undefined;
        container.querySelector('[role="status"]').textContent = '策划未完成，可在任务记录查看原因。';
        throw new Error('策划任务未成功。');
      }
      try {
        attempt.recipes = agentImageRecipes(attempt.task.result?.text, base);
      } catch (error) {
        current = undefined;
        container.querySelector('[role="status"]').textContent = error.message;
        throw error;
      }
      showPlan(attempt.recipes, attempt.task);
    },
  };
}
