const str = (label, max = 160, optional = false) => ({ label, type: 'text', max, optional });
const date = (label, optional = false) => ({ label, type: 'date', optional });
const num = (label, min = 0, max = 1000000000, optional = false) => ({ label, type: 'integer', min, max, optional });
const money = (label, optional = false) => ({ label, type: 'money', min: 0, max: 1000000000, optional });
const status = (...choices) => ({ label: '状态', type: 'choice', choices });
const note = label => str(label, 2000, true);
const order = str('关联订单号', 100);
const optionalOrder = str('关联订单号', 100, true);

export const operationForms = {
  orders: { label: '订单', keyLabel: '订单号', fields: {
    title: str('商品摘要'), day: date('下单日期'), status: status('待发货','已发货','已完成','已取消'),
    units: num('商品件数', 1), paidMinor: money('订单实付（元）', true), shipBy: date('应发货日期', true),
  } },
  shipments: { label: '发货与物流', keyLabel: '包裹记录号', fields: {
    title: str('包裹摘要'), orderRef: order, status: status('待配货','已配货','已交运','物流异常'),
    carrier: str('承运商', 100, true), tracking: str('物流单号', 100, true), note: note('异常或交运备注'),
  } },
  returns: { label: '售后', keyLabel: '售后单号', fields: {
    title: str('售后事由'), orderRef: order, status: status('待处理','处理中','已结案'),
    kind: {label:'类型',type:'choice',choices:['仅退款','退货退款','换货','其他']},
    amountMinor: money('申请金额（元）', true), note: note('处理记录'),
  } },
  tickets: { label: '工单', keyLabel: '工单编号', fields: {
    title: str('问题描述'), orderRef: optionalOrder, status: status('待处理','跟进中','已结案'),
    due: date('截止日期', true), note: note('跟进记录'),
  } },
  reviews: { label: '评价', keyLabel: '评价编号', fields: {
    title: str('商品名称'), day: date('评价日期'), content: str('评价内容', 2000), stars: num('评分', 1, 5, true),
    tags: str('评价标签（逗号分隔）',200,true),
    status: status('待拟回复','已拟回复','无需回复'), reply: note('回复草稿'),
  } },
  inventory: { label: '商品与库存', keyLabel: 'SKU 编码', fields: {
    title: str('商品名称'), productRef: str('所属商品编号',100,true), specification: str('规格组合',200,true),
    category: str('类目', 200, true), priceMinor: money('销售单价（元）', true),
    stock: num('库存数量'), threshold: num('库存预警线'), day: date('库存盘点日期'),
  } },
  performance: { label: '商品数据', keyLabel: '日记录编号', fields: {
    title: str('商品名称'), sku: str('商品 SKU',100), day: date('统计日期'),
    views: num('商品浏览次数'), visitors: num('访客数'), buyers: num('支付买家数'), salesMinor: money('成交金额（元）'),
  } },
  campaigns: { label: '营销计划', keyLabel: '计划编号', fields: {
    title: str('活动名称'), start: date('开始日期'), end: date('结束日期'), status: status('筹备中','待确认','已归档'),
    sku: str('计划商品 SKU',100,true), pricePercent: num('计划成交价占原价百分比',1,100,true), budgetMinor: money('预算（元）', true), note: note('报名准备事项'),
  } },
  attributes: { label: '商品属性模板', keyLabel: '属性模板编号', fields: {
    title: str('模板名称'), category: str('适用类目',200), properties: str('待填写属性',2000),
    dimensions: note('SKU 规格维度'), note: note('填报说明'),
  } },
  qualifications: { label: '商品资质台账', keyLabel: '资料记录号', fields: {
    title: str('资料名称'), productRef: str('适用商品编号',100), documentNo: str('凭证编号',160,true),
    expiry: date('到期日期',true), status: status('待收集','已归档','待更新'), note: note('存放位置或备注'),
  } },
  shippingTemplates: { label: '运费模板', keyLabel: '模板编号', fields: {
    title: str('模板名称'), regions: str('适用地区', 500), firstFeeMinor: money('首件运费（元）'),
    nextFeeMinor: money('续件运费（元）'), note: note('配送说明'),
  } },
  returnRules: { label: '退货规则', keyLabel: '规则编号', fields: {
    title: str('规则名称'), scope: str('适用商品或地区', 500), instructions: str('退货处理说明', 2000),
  } },
};
