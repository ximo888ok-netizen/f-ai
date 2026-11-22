import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

// Small, synthetic workspace specifications. No merchant account or marketplace data is used.
const specs=[
  {platform:'taobao',width:192,height:192,format:'png'},
  {platform:'pinduoduo',width:192,height:256,format:'jpeg'},
  {platform:'douyin',width:144,height:256,format:'png'},
];
const path='/v1/media/images/platform-templates';
export async function publishFixtureTemplates(api) {
  for (const {platform,...dimensions} of specs) {
    await api('PUT',path+'/'+platform,200,{revision:0,fit:'contain',...dimensions});
  }
}

export async function verifyPlatformExports(api,{createCanvas,loadImage}) {
  const listed=await api('GET',path,200);
  assert.deepEqual(listed.items.map(i=>i.platform),['douyin','pinduoduo','taobao']);
  const sw=64,sh=48, palette=['#c72f27','#358c37','#3047ad','#82298e','#167a84'],assets=[];
  for (const [index,color] of palette.entries()) {
    const canvas=createCanvas(sw,sh), ctx=canvas.getContext('2d');
    ctx.fillStyle=color;
    ctx.fillRect(10,8,44-index*2,32);
    ctx.fillStyle='#182030';
    ctx.fillRect(14,13,5,8);
    const asset=await api('POST','/v1/assets',201,{name:'sample-'+index+'.png',mediaType:'image/png',source:'synthetic',
      purpose:'image template acceptance',dataBase64:canvas.toBuffer('image/png').toString('base64')});
    assets.push(asset.id);
  }
  const items=Array.from({length:6},(_,i)=>({key:'sample-'+i,assetIds:[assets[i%assets.length]],
    platformTemplate:{platform:specs[i%specs.length].platform,revision:1}}));
  const input={id:randomUUID(),items};
  const result=await api('POST','/v1/media/images/batches',201,input);
  assert.equal(result.items.length,items.length);
  for (const [i,item] of result.items.entries()) {
    assert.equal(item.state,'succeeded');
    assert.deepEqual(item.platformTemplate,items[i].platformTemplate);
    const spec=specs[i%specs.length], index=i%assets.length;
    const bytes=await api('GET','/v1/assets/'+item.assetId+'/content',200);
    assert.ok(spec.format==='png'?bytes.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex')):bytes.readUInt16BE(0)===0xffd8);
    const image=await loadImage(bytes);
    assert.deepEqual([image.width,image.height],[spec.width,spec.height]);
    const ctx=createCanvas(image.width,image.height).getContext('2d');
    ctx.drawImage(image,0,0);
    const {data}=ctx.getImageData(0,0,image.width,image.height);
    const scale=Math.min(image.width/sw,image.height/sh);
    const dx=(image.width-sw*scale)/2,dy=(image.height-sh*scale)/2;
    const color=Buffer.from(palette[index].slice(1),'hex');
    function near(x,y,rgb) {
      const pixel=4*(y*image.width+x);
      return rgb.every((channel,c)=>Math.abs(data[pixel+c]-channel)<=18);
    }
    // Check the dominant-color rectangle bounds as well as an asymmetric internal marker.
    let left=image.width,right=-1,top=image.height,bottom=-1;
    for (let y=0;y<image.height;y++) for (let x=0;x<image.width;x++) {
      if (near(x,y,color)) {left=Math.min(left,x);right=Math.max(right,x);top=Math.min(top,y);bottom=Math.max(bottom,y);}
    }
    const observed=[left,top,right+1,bottom+1];
    const expected=[dx+10*scale,dy+8*scale,dx+(54-index*2)*scale,dy+40*scale];
    assert.ok(expected.every((value,k)=>Math.abs(value-observed[k])<=3),'Subject bounds changed in '+item.key);
    assert.ok(near(Math.floor(dx+16*scale),Math.floor(dy+16*scale),[24,32,48]),'Subject marker changed in '+item.key);
  }
  await api('PUT',path+'/taobao',200,{revision:1,width:256,height:256,fit:'cover',format:'jpeg'});
  assert.deepEqual(await api('POST','/v1/media/images/batches',200,input),result);
  const updated=await api('POST','/v1/media/images/batches',201,{id:randomUUID(),items:[{
    ...items[0],platformTemplate:{platform:'taobao',revision:2},
  }]});
  const covered=updated.items[0];
  assert.equal(covered.state,'succeeded');
  assert.deepEqual(covered.platformTemplate,{platform:'taobao',revision:2});
  const bytes=await api('GET','/v1/assets/'+covered.assetId+'/content',200);
  assert.equal(bytes.readUInt16BE(0),0xffd8);
  const image=await loadImage(bytes);
  assert.deepEqual([image.width,image.height],[256,256]);
  const ctx=createCanvas(256,256).getContext('2d');
  ctx.drawImage(image,0,0);
  // At 'cover' scale the left asymmetric marker is at (43,85). A 'contain' render places it at (64,96).
  const pixel=ctx.getImageData(43,85,1,1).data;
  assert.ok([24,32,48].every((v,i)=>Math.abs(v-pixel[i])<=18));
  return {platforms:specs.length,sourceFixtures:assets.length,decodedExports:result.items.length,updatedCoverExports:1};
}
