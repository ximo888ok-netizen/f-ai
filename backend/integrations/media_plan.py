"""Translate the pinned creative brief into shot descriptions. The model has no tools or credentials."""
import base64
import io
import json
import os
from pathlib import Path
import subprocess
from PIL import Image
import requests

def thumbnail(path):
    with Image.open(path) as im:
        im.thumbnail((768,768))
        buf=io.BytesIO()
        im.convert("RGB").save(buf,format="JPEG",quality=80)
        return {"type":"image_url","image_url":{"url":"data:image/jpeg;base64,"+base64.b64encode(buf.getvalue()).decode()}}


def shots(req,inputs,skill,work):
    count=req["minOutputs"]
    goal=req["brief"]+"\n交付平台："+req["channel"]+"；画幅："+(req.get("ratio") or "沿用参考图")
    key=os.environ.get("MEDIA_PLANNER_KEY")
    if not key:
        if req["source"] in {"commerce","fal"} or req["alias"]=="video-ad-rewrite":
            raise ValueError("planner required")
        return [goal+("\n图位："+slot if slot else "") for slot in (req.get("slots") or [""]*count)]
    refs=[thumbnail(p) for p in inputs if p.suffix in {".jpg",".png"}][:5]
    if req["alias"]=="video-ad-rewrite":
        video=next(p for p in inputs if p.suffix==".mp4")
        subprocess.run(["ffmpeg","-nostdin","-v","error","-i",str(video),"-vf","fps=1,scale=480:-2","-frames:v","8",str(work/"frame-%02d.jpg")],check=True,timeout=60)
        refs.extend(thumbnail(p) for p in sorted(work.glob("frame-*.jpg")))
    guide=skill.read_text(encoding="utf-8")[:18000]
    messages=[{"role":"system","content":"你是电商媒体策划。根据技能说明、商品资料和参考素材编写成品生成提示词。只返回 JSON 对象，prompts 为指定数量的非空字符串。禁止编造规格、认证或营销承诺。不要输出命令或网址。"},
              {"role":"user","content":[{"type":"text","text":json.dumps({"skill":guide,"deliverable":req["title"],"ordered_shots":req.get("slots",[]),"brief":goal,"count":count},ensure_ascii=False)},*refs]}]
    response=requests.post("https://api.openai.com/v1/chat/completions",headers={"Authorization":"Bearer "+key},
                           json={"model":os.environ["MEDIA_PLANNER_MODEL"],"messages":messages,"response_format":{"type":"json_object"}},timeout=100,allow_redirects=False)
    response.raise_for_status()
    data=json.loads(response.json()["choices"][0]["message"]["content"])
    prompts=data.get("prompts")
    if not isinstance(prompts,list) or len(prompts)!=count or not all(isinstance(p,str) and 0<len(p.strip())<=8000 for p in prompts):
        raise ValueError("invalid shot plan")
    return prompts
