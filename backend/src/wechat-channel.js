import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import sax from 'sax';
import { isUuid } from './config.js';
import { row, rows } from './db.js';
import { ApiError, choice, notFound, object, page, paginate, route } from './http.js';

const denied = () => new ApiError(401,'CHANNEL_UNVERIFIED','Unverified channel callback');
const identifier = /^[A-Za-z0-9_@.-]{1,128}$/;
const channels = ['wechat','wecom'];
const signature = parts => createHash('sha1').update([...parts].sort().join('')).digest('hex');
const escape = value => value.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');

function fields(xml) {
  const values = Object.create(null);
  const parser = sax.parser(true,{strictEntities:true});
  let depth=0, name, roots=0;
  parser.ondoctype = parser.onsgmldeclaration = () => { throw denied(); };
  parser.onopentag = tag => {
    depth++;
    if (depth>12 || (depth===1 && (tag.name!=='xml' || roots++))) throw denied();
    if (depth===2) {
      if (Object.hasOwn(values,tag.name)) throw denied();
      name=tag.name;
      values[name]='';
    }
    if (depth===3) values[name]=null;
  };
  parser.ontext=parser.oncdata=value=>{ if (depth===2 && values[name]!==null) values[name]+=value; };
  parser.onclosetag=()=>{depth--;};
  try { parser.write(xml).close(); } catch {throw denied();}
  if (roots!==1) throw denied();
  return values;
}

function checkSignature(binding, query, encrypted) {
  const {nonce,timestamp}=query;
  const digest=encrypted===undefined ? query.signature : query.msg_signature;
  if (typeof nonce!=='string' || !/^[A-Za-z0-9_-]{1,128}$/.test(nonce) || !/^\d{10}$/.test(timestamp) ||
      Math.abs(Date.now()/1000-Number(timestamp))>300 || typeof digest!=='string' || !/^[a-f0-9]{40}$/.test(digest)) throw denied();
  const parts=[binding.token,timestamp,nonce];
  if (encrypted!==undefined) parts.push(encrypted);
  if (!timingSafeEqual(Buffer.from(signature(parts)),Buffer.from(digest))) throw denied();
}

function unpack(binding, encrypted) {
  try {
    const bytes=Buffer.from(encrypted,'base64');
    if (!bytes.length || bytes.length%32 || bytes.toString('base64')!==encrypted) throw denied();
    const cipher=createDecipheriv('aes-256-cbc',binding.key,binding.key.subarray(0,16)).setAutoPadding(false);
    const buf=Buffer.concat([cipher.update(bytes),cipher.final()]);
    const pad=buf.at(-1);
    if (pad<1 || pad>32 || !buf.subarray(-pad).equals(Buffer.alloc(pad,pad))) throw denied();
    const end=20+buf.readUInt32BE(16);
    if (end>buf.length-pad || !buf.subarray(end,buf.length-pad).equals(Buffer.from(binding.receiver))) throw denied();
    return new TextDecoder('utf-8',{fatal:true}).decode(buf.subarray(20,end));
  } catch {throw denied();}
}

function pack(binding, xml) {
  const data=Buffer.from(xml), prefix=randomBytes(20);
  prefix.writeUInt32BE(data.length,16);
  const buf=Buffer.concat([prefix,data,Buffer.from(binding.receiver)]);
  const pad=32-buf.length%32;
  const cipher=createCipheriv('aes-256-cbc',binding.key,binding.key.subarray(0,16)).setAutoPadding(false);
  const encrypted=Buffer.concat([cipher.update(Buffer.concat([buf,Buffer.alloc(pad,pad)])),cipher.final()]).toString('base64');
  const timestamp=String(Math.floor(Date.now()/1000)), nonce=randomBytes(12).toString('hex');
  return '<xml><Encrypt>'+encrypted+'</Encrypt><TimeStamp>'+timestamp+'</TimeStamp><Nonce>'+nonce+'</Nonce><MsgSignature>'+
    signature([binding.token,timestamp,nonce,encrypted])+'</MsgSignature></xml>';
}

export function createWechatBindings(env=process.env) {
  try {
    const result=new Map(), targets=new Set();
    const entries=JSON.parse(env.WECHAT_BINDINGS_JSON || '[]');
    if (!Array.isArray(entries)) throw denied();
    for (const item of entries) {
      const {channel,id,workspaceId,receiver,recipient,agentId,replyText}=item;
      if (!channels.includes(channel) || typeof id!=='string' || !/^[a-z][a-z0-9_-]{0,39}$/.test(id) || !isUuid(workspaceId) ||
          typeof receiver!=='string' || !identifier.test(receiver) || typeof recipient!=='string' || !identifier.test(recipient) ||
          (channel==='wecom' && (!/^\d{1,16}$/.test(agentId) || recipient!==receiver)) ||
          typeof replyText!=='string' || !replyText.trim() || Buffer.byteLength(replyText)>2048 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(replyText)) throw denied();
      const secret=name=>typeof name==='string' && /^[A-Z][A-Z0-9_]{0,127}$/.test(name) && env[name];
      const token=secret(item.tokenEnv), encoded=secret(item.keyEnv);
      if (typeof token!=='string' || !/^[A-Za-z0-9]{3,32}$/.test(token) || typeof encoded!=='string' || !/^[A-Za-z0-9+/]{43}$/.test(encoded)) throw denied();
      const key=Buffer.from(encoded+'=','base64');
      const name=channel+'/'+id, target=JSON.stringify([channel,receiver,channel==='wecom'?String(agentId):recipient]);
      if (key.toString('base64')!==encoded+'=' || result.has(name) || targets.has(target)) throw denied();
      targets.add(target);
      result.set(name,{channel,id,workspaceId:workspaceId.toLowerCase(),receiver,recipient,agentId:String(agentId),token,key,replyText});
    }
    return result;
  } catch {throw new Error('Invalid WeChat channel configuration');}
}

export function registerWechatChannels(app, db, bindings) {
  app.register(async callbacks=>{
    callbacks.addContentTypeParser(['text/xml','application/xml'],{parseAs:'string'},(_req,body,done)=>done(null,body));
    const path='/v1/channels/:channel/:connector/callback';
    function bindingFor(request) {
      const binding=bindings.get(request.params.channel+'/'+request.params.connector);
      if (!binding) throw notFound('Channel');
      return binding;
    }
    callbacks.get(path,{schema:{hide:true}},async (request,reply)=>{
      const binding=bindingFor(request);
      const echo=request.query.echostr;
      if (typeof echo!=='string' || !echo.length || echo.length>2048) throw denied();
      const encrypted=binding.channel==='wecom' || request.query.msg_signature!==undefined;
      checkSignature(binding,request.query,encrypted?echo:undefined);
      return reply.type('text/plain').send(encrypted?unpack(binding,echo):echo);
    });
    callbacks.post(path,{bodyLimit:65536,schema:{hide:true}},async (request,reply)=>{
      const binding=bindingFor(request);
      if (typeof request.body!=='string') throw denied();
      const encrypted=fields(request.body).Encrypt;
      if (typeof encrypted!=='string' || !encrypted) throw denied();
      checkSignature(binding,request.query,encrypted);
      const message=fields(unpack(binding,encrypted));
      if (message.ToUserName!==binding.recipient || (binding.channel==='wecom' && message.AgentID!==binding.agentId)) throw denied();
      if (message.MsgType!=='text') return reply.type('text/plain').send('success');
      if (typeof message.FromUserName!=='string' || !identifier.test(message.FromUserName) || !/^\d{1,24}$/.test(message.MsgId) ||
          typeof message.Content!=='string' || !message.Content.trim() || [...message.Content].length>4000) throw denied();
      const target=await app.workspaceDatabaseRouter.forWorkspace(binding.workspaceId);
      const identity=[binding.workspaceId,binding.channel,binding.id,binding.receiver,message.MsgId];
      const record=await target.transaction(async tx=>{
        const inserted=await row(tx,'INSERT INTO wechat_messages(workspace_id,channel,connector,receiver,message_id,sender,content,reply_text) '+
          'VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING RETURNING sender,content,reply_text',
          [...identity,message.FromUserName,message.Content,binding.replyText]);
        return inserted ?? row(tx,'SELECT sender,content,reply_text FROM wechat_messages WHERE workspace_id=$1 AND channel=$2 AND connector=$3 AND receiver=$4 AND message_id=$5',identity);
      });
      if (record.sender!==message.FromUserName || record.content!==message.Content) throw denied();
      const answer='<xml><ToUserName>'+record.sender+'</ToUserName><FromUserName>'+binding.recipient+'</FromUserName><CreateTime>'+
        Math.floor(Date.now()/1000)+'</CreateTime><MsgType>text</MsgType><Content>'+escape(record.reply_text)+'</Content></xml>';
      return reply.type('application/xml').send(pack(binding,answer));
    });
  });
  route(app,'GET','/v1/channels/:channel/inbox',{tags:['Channels'],manager:true,params:object({channel:choice(...channels)}),
    querystring:page,summary:'List received text and its passive reply for this workspace',
    response:{200:object({available:{type:'boolean'},items:{type:'array',items:object(Object.fromEntries(
      ['connector','messageId','sender','content','reply','createdAt'].map(key=>[key,{type:'string',...(key==='createdAt' && {format:'date-time'})}])) )}})}},
    async request=>{
      const {workspaceId}=request.context, {channel}=request.params;
      return {available:[...bindings.values()].some(b=>b.workspaceId===workspaceId && b.channel===channel),
        items:await rows(db,'SELECT connector,message_id AS "messageId",sender,content,reply_text AS reply,created_at AS "createdAt" FROM wechat_messages '+
          'WHERE workspace_id=$1 AND channel=$2 ORDER BY created_at DESC,connector,receiver,message_id LIMIT $3 OFFSET $4',[workspaceId,channel,...paginate(request.query)])};
    });
}
