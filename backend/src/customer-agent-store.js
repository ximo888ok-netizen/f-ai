import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { ApiError } from './http.js';

function read(file, query) {
  let db;
  try {
    db = new DatabaseSync(file, { readOnly: true });
    db.exec('PRAGMA query_only=ON; PRAGMA trusted_schema=OFF;');
    return query(db);
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(503, 'CUSTOMER_STORE_UNAVAILABLE', '无法读取 Customer-Agent 数据库，请核对路径、权限和数据库版本。');
  } finally { db?.close(); }
}

export function shopEvidence(binding, term) {
  return read(binding.database, db => {
    const shop = db.prepare('SELECT s.id FROM shops s JOIN channels c ON s.channel_id=c.id WHERE s.shop_id=? AND c.channel_name=?').get(binding.shopId, binding.platform);
    if (!shop) throw new ApiError(404, 'SHOP_NOT_SYNCED', 'Customer-Agent 中没有同步此渠道的指定店铺。');
    const items = db.prepare(`SELECT title, substr(content,1,2000) AS content FROM customer_service_knowledge
      WHERE shop_id=? AND enabled=1 AND (instr(title,?)>0 OR instr(content,?)>0) ORDER BY updated_at DESC,id DESC LIMIT 10`)
      .all(shop.id, term, term).map(r => ({ kind:'客服知识', ...r }));
    const products = db.prepare(`SELECT goods_name AS title, substr(coalesce(extracted_content,specifications,''),1,2000) AS content
      FROM product_knowledge WHERE shop_id=? AND (instr(goods_name,?)>0 OR cast(goods_id AS text)=?)
      ORDER BY updated_at DESC,id DESC LIMIT 10`).all(shop.id, term, term);
    return { items: [...items, ...products.map(r => ({ kind:'商品知识', ...r }))] };
  });
}

export function shopHistory(binding, buyer) {
  const scope = [binding.platform,binding.shopId,binding.accountId,'customer',buyer].join('|');
  const key = 'conversation_' + createHash('sha256').update(scope).digest('hex');
  return read(binding.historyDatabase, db => {
    const turns = db.prepare(`SELECT role, substr(content,1,8000) AS content, timestamp FROM agent_messages
      WHERE session_id=? AND role IN ('assistant','user') AND content IS NOT NULL ORDER BY id DESC LIMIT 50`).all(key);
    return { items: turns.reverse().map(turn => {
      let content = turn.content;
      // Customer-Agent stores image turns in a JSON envelope. Return only their text.
      if (content.trimStart().startsWith('{')) {
        try {
          const parts = JSON.parse(content).__multimodal__;
          if (parts && typeof parts.text === 'string') content = parts.text || '【多媒体消息】';
        } catch {
          if (content.includes('"__multimodal__"')) content = '【多媒体消息】';
        }
      }
      return { ...turn, content: content.replace(/data:image\/[^\s"]+/gi, '【图片】').slice(0,4000) };
    }) };
  });
}

export function activeHandoffs(binding) {
  const prefix=binding.platform+'|'+binding.shopId+'|';
  return read(binding.database,db=>({items:db.prepare(`SELECT substr(session_key,length(?)+1) AS buyerId, expiry
    FROM handoff_markers WHERE substr(session_key,1,length(?))=? AND expiry>unixepoch()
    ORDER BY expiry DESC LIMIT 100`).all(prefix,prefix,prefix)}));
}

export function pauseNativeReplies(binding,buyer) {
  if(!binding.allowHandoff || binding.platform!=='douyin') throw new ApiError(409,'HANDOFF_UNAVAILABLE','此店铺未开启原客户端的接管写入。');
  if(!buyer.trim() || buyer.includes('|')) throw new ApiError(400,'INVALID_INPUT','买家标识无效。');
  const matches=read(binding.database,db=>db.prepare('SELECT 1 FROM shops s JOIN channels c ON c.id=s.channel_id WHERE s.shop_id=? AND c.channel_name=?').get(binding.shopId,binding.platform));
  if(!matches) throw new ApiError(404,'SHOP_NOT_SYNCED','指定资料库没有该渠道店铺。');
  if(!shopHistory(binding,buyer).items.length) throw new ApiError(404,'NOT_FOUND','该客服账号下没有这个买家的会话记录。');
  const key=[binding.platform,binding.shopId,buyer].join('|');
  let db;
  try {
    db=new DatabaseSync(binding.database,{allowExtension:false});
    db.exec('PRAGMA trusted_schema=OFF; PRAGMA busy_timeout=1000');
    // Preserve an existing active marker. The native process caches its expiry.
    return db.prepare(`INSERT INTO handoff_markers(session_key,expiry) VALUES(?,unixepoch()+3600)
      ON CONFLICT(session_key) DO UPDATE SET expiry=CASE WHEN handoff_markers.expiry>unixepoch()
      THEN handoff_markers.expiry ELSE excluded.expiry END RETURNING expiry`).get(key);
  } catch { throw new ApiError(503,'HANDOFF_WRITE_FAILED','未能保存接管标记，请检查原客户端数据库写入权限。'); }
  finally { db?.close(); }
}
