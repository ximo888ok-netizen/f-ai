export function generatedAsset(alias) {
  return `EXISTS(SELECT 1 FROM tasks origin WHERE origin.workspace_id=${alias}.workspace_id AND origin.account_id=${alias}.account_id
    AND origin.state='succeeded' AND origin.result->>'assetId'=${alias}.id::text AND origin.provider_id<>'local')`;
}

export const metadata={software:'F-AI Studio',description:'AI-generated content'};
export const provenanceXmp='<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">'+
  '<rdf:Description rdf:about="" xmlns:fai="https://f-ai.example/ns/export/1.0/" fai:aiGenerated="true" fai:software="F-AI Studio"/>'+
  '</rdf:RDF></x:xmpmeta>';

export function drawAiBadge(context,width,height) {
  const font=Math.min(50,Math.max(7,Math.round(Math.min(width,height)*0.04)));
  const padding=Math.max(3,Math.round(font/3));
  const label='AI GENERATED';
  const margin=Math.min(padding,Math.floor(width/12),Math.floor(height/12));
  context.font='bold '+font+'px Arial, sans-serif';
  const badgeWidth=Math.min(Math.ceil(context.measureText(label).width)+2*padding,width-2*margin);
  const badgeHeight=font+2*padding;
  const x=width-margin-badgeWidth;
  const y=Math.max(0,height-margin-badgeHeight);
  context.fillStyle='#111827';
  context.fillRect(x,y,badgeWidth,badgeHeight);
  context.fillStyle='#ffffff';
  context.textBaseline='middle';
  context.fillText(label,x+padding,y+badgeHeight/2,badgeWidth-2*padding);
}
