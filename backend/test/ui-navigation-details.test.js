import assert from 'node:assert/strict';
import test from 'node:test';
import { createStudioFixture } from '../test-support/ui-actions.js';
import { studioRoutes, merchantRoutes, categories } from '../test-support/studio-routes.js';

test('open and close every native disclosure on registered root and category pages', {
  skip: !process.env.FAI_TEST_PLAYWRIGHT_PATH,timeout:180000,
},async t=>{
  const {page,open,api}=await createStudioFixture(t);
  await api('PUT','/v1/copywriting/rules/pinduoduo',{revision:0,titleLimit:30,sellingPointLimit:60,forbiddenPhrases:[]});
  let count=0;
  for(const route of [...studioRoutes,...categories,...merchantRoutes.map(r=>'/merchant#'+r)]){
    await open(route);
    const main=page.locator('#main:visible,#merchantContent:visible,#commerce-directory:visible').last();
    const summaries=main.locator('details > summary');
    const close=[];
    for(const summary of await summaries.all()){
      if(!await summary.isVisible()) continue;
      const details=summary.locator('..');
      if(await details.evaluate(n=>n.open)){
        await summary.click();
        assert.equal(await details.evaluate(n=>n.open),false,route);
      }
      await summary.click();
      assert.equal(await details.evaluate(n=>n.open),true,route);
      close.push(summary);
      count++;
    }
    for(const summary of close.reverse()) await summary.click();
  }
  assert.ok(count>20,'Too few disclosures clicked');
  t.diagnostic('Disclosure controls verified: '+count);
});
