import { buildAuthTestApp as buildApp, registrationPayload } from '../test-support/identity-fixture.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';

import { migrate, migrationFiles, postgres } from '../src/db.js';

test('knowledge category changes retain authorization, rebuild indexes and support legacy uploads', async t => {
  const db = process.env.FAI_TEST_DATABASE_URL ? postgres(process.env.FAI_TEST_DATABASE_URL) : new PGlite();
  t.after(()=>db.close());
  await migrate(db);
  const app = await buildApp({db});
  t.after(()=>app.close());
  const api = async (method,url,status,account,payload) => {
    const headers = account ? { authorization:'Bearer '+account.token, 'x-workspace-id':account.workspace } : {};
    const response = await app.inject({method,url,payload,headers});
    assert.equal(response.statusCode,status,response.body);
    return status===204 ? undefined : response.json();
  };
  const signUp = async email => {
    const account = await api('POST','/v1/auth/register',201,undefined,await registrationPayload(app, {
      email,password:'reference-knowledge-editor',displayName:'QA user',type:'enterprise',workspaceName:'QA knowledge',
    }));
    return {...account,workspace:account.workspaces[0].id};
  };
  const owner = await signUp('category-editor@example.test');
  const outsider = await signUp('category-viewer@example.test');
  const invite = await api('POST','/v1/invitations',201,owner,{email:outsider.account.email,role:'member'});
  await api('POST','/v1/invitations/accept',200,outsider,{token:invite.token});
  const member = {...outsider,workspace:owner.workspace};
  const root = '/v1/knowledge/bases';
  const base1 = await api('POST',root,201,owner,{name:'A'});
  const base2 = await api('POST',root,201,owner,{name:'B'});
  const path = root+'/'+base1.id;
  const documents = path+'/documents';
  const categories = path+'/categories';
  const doc = await api('POST',documents,201,owner,{name:'Reference',category:'Operations',content:'old_marker'});
  const existing = (await api('GET',categories,200,owner)).items[0];
  assert.equal(existing.name,'Operations');
  const id = categories+'/'+existing.id;
  await api('GET',categories,404,member);
  await api('PUT',path+'/grants/'+member.account.id,204,owner);
  assert.deepEqual((await api('GET',categories,200,member)).items,[existing]);
  await api('PATCH',id,403,member,{name:'Cannot rename'});
  await api('GET',categories,404,outsider);
  await api('PATCH',root+'/'+base2.id+'/categories/'+existing.id,404,owner,{name:'Different base'});
  const second=await api('POST',categories,200,owner,{name:'Workbook'});
  assert.deepEqual(await api('POST',categories,200,owner,{name:'Workbook'}),second);
  await api('PATCH',id,409,owner,{name:'Workbook'});
  await api('DELETE',id,409,owner);
  await api('PATCH',id,200,owner,{name:'Renamed'});
  assert.equal((await api('GET',documents+'?category=Operations',200,member)).items.length,0);
  assert.equal((await api('GET',documents+'?category=Renamed',200,member)).items[0].id,doc.id);
  const search = async (query,category) => (await api('POST','/v1/knowledge/search',200,member,{query,category,baseIds:[base1.id]})).items;
  assert.equal((await search('old_marker','Renamed'))[0].documentId,doc.id);
  await api('PATCH',documents+'/'+doc.id,200,owner,{category:'Workbook',content:'new_marker'});
  assert.deepEqual(await search('old_marker','Workbook'),[]);
  assert.deepEqual(await search('new_marker','Renamed'),[]);
  assert.equal((await search('new_marker','Workbook'))[0].documentId,doc.id);
  await api('DELETE',id,204,owner);
  await api('PATCH',documents+'/'+doc.id,200,owner,{category:''});
  await api('DELETE',categories+'/'+second.id,204,owner);
  assert.equal((await search('new_marker',''))[0].category,'');
  await api('DELETE',documents+'/'+doc.id,204,owner);
  assert.deepEqual(await search('new_marker',''),[]);
});

test('knowledge category migration backfills labels without rewriting existing documents', async () => {
  const db = new PGlite();
  try {
    const [initial] = await migrationFiles();
    for (const sql of (await readFile(new URL('../migrations/'+initial,import.meta.url),'utf8')).split(';')) {
      if (sql.trim()) await db.query(sql);
    }
    const [workspace,base,doc] = [randomUUID(),randomUUID(),randomUUID()];
    await db.query("INSERT INTO workspaces(id,kind,name) VALUES($1,'personal','QA')",[workspace]);
    await db.query("INSERT INTO knowledge_bases(id,workspace_id,name) VALUES($1,$2,'Legacy')",[base,workspace]);
    await db.query("INSERT INTO documents(id,workspace_id,base_id,name,category,content) VALUES($1,$2,$3,'Doc','Existing label','Legacy text')",
      [doc,workspace,base]);
    const migration = await readFile(new URL('../migrations/011_knowledge_categories.sql',import.meta.url),'utf8');
    for (const sql of migration.split(';')) if (sql.trim()) await db.query(sql);
    const {rows} = await db.query('SELECT c.name,d.content FROM knowledge_categories c JOIN documents d ON d.base_id=c.base_id AND d.category=c.name');
    assert.deepEqual(rows,[{name:'Existing label',content:'Legacy text'}]);
  } finally { await db.close(); }
});

test('product scope migration binds only a SKU known to predate the conversation and keeps old documents unclassified',async t=>{
  const db=new PGlite();
  t.after(()=>db.close());
  const files=(await migrationFiles()).filter(file=>file<'025_');
  for (const file of files) await db.exec(await readFile(new URL('../migrations/'+file,import.meta.url),'utf8'));
  await db.exec('CREATE TABLE migrations (name text PRIMARY KEY,applied_at timestamptz NOT NULL DEFAULT now())');
  await db.query('INSERT INTO migrations(name) SELECT unnest($1::text[])',[files]);
  const workspace=randomUUID(),account=randomUUID(),product=randomUUID(),base=randomUUID(),doc=randomUUID();
  await db.query("INSERT INTO workspaces(id,kind,name) VALUES($1,'enterprise','QA')",[workspace]);
  await db.query("INSERT INTO accounts(id,email,password_hash,display_name,account_type) VALUES($1,'old@example.test','fixture','QA','enterprise')",[account]);
  await db.query("INSERT INTO memberships VALUES($1,$2,'owner',now())",[workspace,account]);
  await db.query("INSERT INTO studio_products(id,workspace_id,sku,name,updated_at) VALUES($1,$2,'SKU','Same name','2025-01-02')",[product,workspace]);
  await db.query("INSERT INTO knowledge_bases(id,workspace_id,name) VALUES($1,$2,'QA')",[base,workspace]);
  await db.query("INSERT INTO documents(id,workspace_id,base_id,name,content) VALUES($1,$2,$3,'Legacy','Unreviewed product facts')",[doc,workspace,base]);
  for (const createdAt of ['2025-01-01','2025-01-03']) {
    await db.query(`INSERT INTO service_conversations(id,workspace_id,account_id,subject,state,product_reference,created_at)
      VALUES($1,$2,$3,'QA','assistant','SKU',$4)`,[randomUUID(),workspace,account,createdAt]);
  }
  await migrate(db);
  assert.deepEqual((await db.query('SELECT product_id FROM service_conversations ORDER BY created_at')).rows.map(r=>r.product_id),[null,product]);
  assert.equal((await db.query('SELECT customer_scope FROM documents WHERE id=$1',[doc])).rows[0].customer_scope,null);
});
