import assert from 'node:assert/strict';
import test from 'node:test';
import { createStudioFixture } from '../test-support/ui-actions.js';

test('generation desks keep their creation controls without the shared activity footer', {
  skip: !process.env.FAI_TEST_PLAYWRIGHT_PATH, timeout: 100000,
}, async t => {
  const { page, open } = await createStudioFixture(t);
  for (const mode of ['quick', 'advanced', 'agent']) {
    await open('desk/image/' + mode, '[data-image-mode="' + mode + '"]');
    assert.equal(await page.locator('.live-desk-lower').count(), 0, '图片生成 · ' + mode);
    assert.equal(await page.getByText('更多图片工具', { exact: true }).count(), 1);
  }
  await open('desk/video', '[data-form="video-prompt"]');
  assert.equal(await page.locator('.live-desk-lower').count(), 0);
  assert.equal(await page.getByText('更多视频工具', { exact: true }).count(), 0);
  assert.equal(await page.getByRole('link', { name: '查看任务记录' }).count(), 1);
  await open('desk/operations', '.live-desk-lower');
  assert.equal(await page.getByText('近期AI运营任务', { exact: true }).count(), 1);
});
