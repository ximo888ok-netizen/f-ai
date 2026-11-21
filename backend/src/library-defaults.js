const skill = (id, name, description, instructions) =>
  ({ id, kind: 'skill', name, description, instructions, relatedIds: [] });
const expert = (id, name, description, instructions, relatedIds) =>
  ({ id, kind: 'expert', name, description, instructions, relatedIds });

export const builtinEntries = [
  skill('4bc86198-55a6-4240-bd99-5b88ada7e901', '商品参数核对', '检查商品资料和规格的完整性。',
    '按规格核对名称、商家 SKU、售价和库存。列出缺项、冲突以及需要人工核对的数据。'),
  skill('4bc86198-55a6-4240-bd99-5b88ada7e902', '文案审阅', '审查商品卖点和文案中的事实声明。',
    '逐条找出文案中的无法验证或容易误解的声明，为每一条给出可核实的改写。'),
  skill('4bc86198-55a6-4240-bd99-5b88ada7e903', '售后问题梳理', '从给定资料识别售后诉求并列出待核实事项。',
    '输出客户诉求、已知事实、待核实事项和建议回复。给出退款或补偿建议时，以用户提供的规则为依据。'),
  expert('4bc86198-55a6-4240-bd99-5b88ada7e904', '商品运营专家', '协助整理商品上架资料与规格。',
    '优先核对产品参数和商家可履行的承诺，使用给定事实并标记未知项。', ['4bc86198-55a6-4240-bd99-5b88ada7e901']),
  expert('4bc86198-55a6-4240-bd99-5b88ada7e905', '电商文案专家', '协助撰写标题、主图文案和详情页卖点。',
    '以简明中文输出商品标题、核心卖点和详情段落。对夸大或无证据的表述提供修改。', ['4bc86198-55a6-4240-bd99-5b88ada7e902']),
  expert('4bc86198-55a6-4240-bd99-5b88ada7e906', '客服售后专家', '协助生成可供人工审阅的客服答复。',
    '根据所给政策回答。遇到缺失订单事实或金额时，提出待确认项，避免承诺未授权的处理。', ['4bc86198-55a6-4240-bd99-5b88ada7e903']),
  { id: '4bc86198-55a6-4240-bd99-5b88ada7e907', kind: 'team', name: '商品上线审阅团', description: '汇总商品运营和文案审阅意见。',
    instructions: '分别列出商品资料和文案问题，最后按优先级给出一份可执行清单。',
    relatedIds: ['4bc86198-55a6-4240-bd99-5b88ada7e904','4bc86198-55a6-4240-bd99-5b88ada7e905'] },
];
