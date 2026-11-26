"""HTTP service adapters. Only a fixed method/host or the bound editing service is contacted."""
import asyncio
import base64
from contextlib import ExitStack,contextmanager
import json
import os
from pathlib import Path
import sys
import time
from urllib.parse import quote
from uuid import uuid4
import requests
from media_io import run,as_json,values,download


def seedance(req,inputs,out,prompt):
    rewrite=req["alias"]=="video-ad-rewrite"
    base="https://ark.ap-southeast.bytepluses.com/api/v3" if rewrite else "https://ark.cn-beijing.volces.com/api/v3"
    token=os.environ["BYTEPLUS_API_KEY" if rewrite else "ARK_API_KEY"]
    headers={"Authorization":"Bearer "+token}
    content=[{"type":"text","text":prompt}]
    for i,p in enumerate(p for p in inputs if p.suffix!=".mp4"):
        mime="image/png" if p.suffix==".png" else "image/jpeg"
        role="reference_image" if rewrite or req.get("frameMode")=="references" else ("first_frame" if i==0 else "last_frame")
        content.append({"type":"image_url","role":role,"image_url":{"url":"data:"+mime+";base64,"+base64.b64encode(p.read_bytes()).decode()}})
    response=requests.post(base+"/contents/generations/tasks",headers=headers,json={"model":os.environ["SEEDANCE_EP_ID"],
                           "content":content,"ratio":req.get("ratio") or "9:16"},timeout=50,allow_redirects=False)
    response.raise_for_status()
    task=response.json()["id"]
    for _ in range(172):
        result=requests.get(base+"/contents/generations/tasks/"+quote(task,safe=""),headers=headers,timeout=30,allow_redirects=False)
        result.raise_for_status()
        body=result.json()
        if body["status"]=="succeeded":
            download(body["content"]["video_url"],out/"film.mp4");return
        if body["status"] not in {"queued","running"}:raise ValueError("Seedance failed")
        time.sleep(5)
    raise TimeoutError("Seedance still pending")


def fire_red(req,inputs,out,prompt,source_root):
    base=os.environ["OPENSTORYLINE_URL"].rstrip("/")
    s=requests.post(base+"/api/sessions",timeout=20);s.raise_for_status()
    sid=s.json()["session_id"]
    root=base+"/api/sessions/"+quote(sid,safe="")
    with ExitStack() as stack:
        files=[("files",(p.name,stack.enter_context(p.open("rb")),"video/mp4")) for p in inputs]
        r=requests.post(root+"/media",files=files,timeout=100);r.raise_for_status()
    script=source_root/Path(req["skill"]).parent/"scripts/bridge_openstoryline.py"
    result=as_json(run([sys.executable,script,"--base-url",base,"--session-id",sid,"--lang","zh","--prompt",
                        "使用本会话上传的实拍素材完成剪辑并渲染最终 MP4。\n"+prompt],out.parent))
    if not result.get("ok") or result.get("interrupted"):raise ValueError("editing incomplete")
    r=requests.get(root,timeout=25);r.raise_for_status()
    paths=[]
    def visit(value):
        if isinstance(value,dict):
            for k,v in value.items():
                if k=="preview_urls" and isinstance(v,list):
                    paths.extend(x for x in v if isinstance(x,str) and Path(x).name.startswith("output_") and x.lower().endswith(".mp4"))
                else:visit(v)
        elif isinstance(value,list):
            for v in value:visit(v)
    visit(r.json().get("history",[]))
    if not paths:raise ValueError("missing rendered session output")
    with requests.get(root+"/preview",params={"path":paths[-1]},timeout=80,stream=True,allow_redirects=False) as response:
        if response.status_code!=200:raise ValueError("preview unavailable")
        size=0
        with (out/"edited.mp4").open("xb") as f:
            for chunk in response.iter_content(65536):
                size+=len(chunk)
                if size>80*1024**2:raise ValueError("video too large")
                f.write(chunk)


@contextmanager
def signed_inputs(inputs):
    import oss2
    if not inputs:
        yield [];return
    ak,secret=os.environ["ALIBABA_CLOUD_ACCESS_KEY_ID"],os.environ["ALIBABA_CLOUD_ACCESS_KEY_SECRET"]
    sts=os.environ.get("ALIBABA_CLOUD_SECURITY_TOKEN")
    bucket=oss2.Bucket(oss2.StsAuth(ak,secret,sts) if sts else oss2.Auth(ak,secret),os.environ["MEDIA_OSS_ENDPOINT"],os.environ["MEDIA_OSS_BUCKET"])
    keys,urls=[],[]
    try:
        for p in inputs:
            k="fai-runway/"+uuid4().hex+p.suffix;keys.append(k)
            bucket.put_object_from_file(k,str(p));urls.append(bucket.sign_url("GET",k,1800))
        yield urls
    finally:
        if keys:bucket.batch_delete_objects(keys)


async def runway(req,inputs,out,prompt):
    from mcp import ClientSession
    from mcp.client.streamable_http import streamablehttp_client
    from jsonschema import validate
    headers={"Authorization":"Bearer "+os.environ["RUNWAY_MCP_TOKEN"]}
    async with streamablehttp_client("https://mcp.runwayml.com/mcp",headers=headers) as (rd,wr,_):
        async with ClientSession(rd,wr) as client:
            await client.initialize()
            catalog={t.name:t.inputSchema for t in (await client.list_tools()).tools}
            method="generate_image" if req["kind"]=="image" else "generate_video"
            def args_for(name,fields):
                schema=catalog[name];props=schema.get("properties",{})
                args={k:v for k,v in fields.items() if k in props and v is not None}
                validate(args,schema);return args
            def unpack(r):
                if r.isError:raise ValueError("Runway rejected request")
                if r.structuredContent:return r.structuredContent
                return as_json("\n".join(b.text for b in r.content if b.type=="text"))
            with signed_inputs(inputs) as urls:
                schema=catalog[method].get("properties",{})
                fields={"prompt":prompt,"promptText":prompt,"aspectRatio":req.get("ratio"),"ratio":req.get("ratio")}
                if urls:
                    if req["kind"]=="video":
                        key="sourceVideo" if inputs[0].suffix==".mp4" else "startFrame"
                        if len(urls)!=1 or key not in schema:raise ValueError("unsupported Runway source")
                        fields[key]=urls[0]
                    else:
                        key=next((k for k in ["referenceImages","referenceImageUrls","imageUrls"] if k in schema),None)
                        if not key:raise ValueError("Runway references unavailable")
                        obj=schema[key].get("items",{}).get("properties",{})
                        fields[key]=[{("uri" if "uri" in obj else "url"):u,**({"tag":"product"+str(i+1)} if "tag" in obj else {})} for i,u in enumerate(urls)] if obj else urls
                result=unpack(await client.call_tool(method,args_for(method,fields)))
                job=next(values(result,{"taskid","task_id","id"}),None)
                if not job:raise ValueError("no Runway job")
                for _ in range(160):
                    data=unpack(await client.call_tool("get_task",args_for("get_task",{"id":job,"taskId":job})))
                    if "task_failed" in str(data):raise ValueError("Runway task failed")
                    url=next((v for v in values(data,{"url","asseturl","outputurl"}) if v.startswith("https://") and v not in urls),None)
                    if url:
                        download(url,out/("result.png" if req["kind"]=="image" else "result.mp4"));return
                    await asyncio.sleep(5)
                raise TimeoutError("Runway still pending")
