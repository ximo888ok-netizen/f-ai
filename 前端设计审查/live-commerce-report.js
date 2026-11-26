import { downloadFile } from './live-files.js';
import { action, field, form, h, heading, input, item, link, list, notice, panel, path, select } from './live-ui.js';

const periods = { day: '日', week: '周', month: '月' };
const day = value => new Intl.DateTimeFormat('en-CA', {
  year: 'numeric', month: '2-digit', day: '2-digit', timeZone: 'Asia/Shanghai',
}).format(value);
const datePattern = /^\d{4}-\d{2}-\d{2}$/;
const count = value => value ?? '暂无';
function currency(minor) {
  if (minor === null) return '暂无';
  const value = BigInt(minor);
  return '¥' + (value / 100n) + '.' + (value % 100n).toString().padStart(2, '0');
}

export async function commerceReport(ctx, book, queryText) {
  const values = new URLSearchParams(queryText ? decodeURIComponent(queryText) : '');
  const period = Object.hasOwn(periods, values.get('period')) ? values.get('period') : 'week';
  const now = new Date();
  const fallbackFrom = day(new Date(now.getTime() - 29 * 86400000));
  const from = datePattern.test(values.get('from')) ? values.get('from') : fallbackFrom;
  const to = datePattern.test(values.get('to')) ? values.get('to') : day(now);
  const range = new URLSearchParams({ from, to, period });
  const endpoint = '/v1/studio/pinduoduo/books/' + path(book.id) + '/report';
  const { items } = await ctx.api(endpoint + '?' + range);
  const base = 'commerce/' + path(book.id);
  const tip = '统计范围为本台账所选日期内的记录。' + (period === 'week' ? '周从周一开始。' : '');
  ctx.html(heading('台账经营报表', book.name + ' · 北京时间') + link('返回运营总览', base) +
    panel('统计范围', form('report-range', field('汇总周期', select('period', Object.entries(periods), period)) +
      field('开始日期', input('from', 'type="date" required value="' + h(from) + '"')) +
      field('结束日期', input('to', 'type="date" required value="' + h(to) + '"')), '查询')) +
    panel('按' + periods[period] + '汇总', notice(tip) + list(items, row => item(row.start,
      '有效订单 ' + count(row.orders) + ' · 件数 ' + count(row.units) + ' · 已填实付订单 ' + count(row.paidOrders) +
      ' · 实付合计 ' + currency(row.paidMinor),
      '<p>SKU 浏览 ' + h(count(row.views)) + ' · 访客 ' + h(count(row.visitors)) +
      ' · 买家 ' + h(count(row.buyers)) + ' · 成交 ' + h(currency(row.salesMinor)) +
      ' · 转化率 ' + h(row.conversionPercent === null ? '暂无' : row.conversionPercent + '%') + '</p><p>渠道浏览 ' +
      Object.entries(row.traffic).map(([label, value]) => h(label) + ' ' + h(count(value))).join(' · ') + '</p>'),
    '这个范围内暂无经营记录。') + (items.length ? action('导出当前报表 CSV', 'report-csv') : '')));
  ctx.submit('report-range', async data => {
    const span = (Date.parse(data.get('to')) - Date.parse(data.get('from'))) / 86400000;
    if (span < 0 || span > 365) throw new Error('请选择 1 至 366 个日历日。');
    ctx.go(base + '/report/' + path(new URLSearchParams(data).toString()));
  });
  ctx.click('report-csv', () => downloadFile(ctx, endpoint + '/export?' + range, '经营' + periods[period] + '报.csv'));
}
