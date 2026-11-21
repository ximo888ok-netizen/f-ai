export function parseValue(field, raw) {
  const value = String(raw ?? '').trim();
  if (!value) {
    if (field.optional) return undefined;
    throw new Error('请填写' + field.label);
  }
  if (field.type === 'money' || field.type === 'integer') {
    const valid = field.type === 'money' ? /^\d+(?:\.\d{1,2})?$/ : /^\d+$/;
    if (!valid.test(value)) throw new Error(field.label + '格式有误');
    const [whole, fraction = ''] = value.split('.');
    const number = field.type === 'money' ? Number(whole) * 100 + Number(fraction.padEnd(2,'0')) : Number(whole);
    if (!Number.isSafeInteger(number) || number < field.min || number > field.max) throw new Error(field.label + '超出范围');
    return number;
  }
  return value;
}

// Handles spreadsheet CSV including doubled quotes, embedded line breaks and a UTF-8 BOM.
function csvRows(source) {
  const rows = [];
  let current = [], value = '', quoted = false, endedQuote = false;
  const data = source.replace(/^\uFEFF/, '');
  for (let i=0; i<data.length; i++) {
    const ch = data[i];
    if (quoted) {
      if (ch !== '"') value += ch;
      else if (data[i+1] === '"') { value += '"'; i++; }
      else { quoted = false; endedQuote = true; }
    } else if (ch === ',') {
      current.push(value); value = ''; endedQuote = false;
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && data[i+1] === '\n') i++;
      current.push(value);
      if (current.some(col => col.trim())) rows.push(current);
      current = []; value = ''; endedQuote = false;
    } else if (ch === '"' && !value && !endedQuote) quoted = true;
    else if (ch === '"' || endedQuote) throw new Error('CSV 引号格式有误');
    else value += ch;
    if (rows.length > 501) throw new Error('每次最多导入 500 条记录');
  }
  if (quoted) throw new Error('CSV 引号未闭合');
  current.push(value);
  if (current.some(col => col.trim())) rows.push(current);
  return rows;
}

export function template(form) {
  return '\uFEFF' + [form.keyLabel,...Object.values(form.fields).map(f => f.label)].join(',') + '\r\n';
}

export function readOperationsCsv(source, form) {
  const [headers,...rows] = csvRows(source);
  if (!headers || !rows.length || rows.length > 500) throw new Error('文件需包含表头和 1–500 条业务记录');
  const columns = new Map([[form.keyLabel,'reference'], ...Object.entries(form.fields).map(([key,f]) => [f.label,key])]);
  const keys = headers.map(label => columns.get(label.trim()));
  const required = ['reference', ...Object.keys(form.fields).filter(key => !form.fields[key].optional)];
  if (keys.includes(undefined) || new Set(keys).size !== keys.length || required.some(key => !keys.includes(key))) {
    throw new Error('表头与当前业务模板不符，请使用本页 CSV 模板');
  }
  return rows.map((cols,i) => {
    if (cols.length !== keys.length) throw new Error('第 ' + (i+2) + ' 行的列数有误');
    const record = {reference:'', details:{}};
    for (const [j,key] of keys.entries()) {
      if (key === 'reference') record.reference = cols[j].trim();
      else {
        const value = parseValue(form.fields[key], cols[j]);
        if (value !== undefined) record.details[key] = value;
      }
    }
    return record;
  });
}
