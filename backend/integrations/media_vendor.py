"""Fixed provider commands. Creative text is an argument, never executable code."""
import json
import os
import re
from pathlib import Path
import sys
import time

from media_io import as_json,collect_urls,download,run,values


def run_vendor(req,inputs,out,prompts,root=Path("/opt/source")):
    kind,source,alias=req["kind"],req["source"],req["alias"]
    prompt="制作要求："+prompts[0]
    image=kind=="image"
    images=[str(p) for p in inputs if p.suffix in {".jpg",".png"}]
    videos=[str(p) for p in inputs if p.suffix==".mp4"]
    skill=root/req["skill"]
    cwd=out.parent
    ratio=req.get("ratio") or ("1:1" if image else "9:16")
    model=os.environ.get("MEDIA_IMAGE_MODEL" if image else "MEDIA_VIDEO_MODEL")
    if source=="commerce":
        sizes={"1:1":"1024x1024","3:4":"1024x1536","9:16":"1024x1536","4:3":"1536x1024","16:9":"1536x1024"}
        references=[value for p in images for value in ["--image",p]]
        for i,shot in enumerate(prompts):
            run([sys.executable,"-I",skill.parent/"scripts/generate.py","--prompt",shot,*references,
                 "--size",sizes[ratio],"--out",out/("shot-%02d.png"%(i+1))],cwd)
        if alias=="image-amazon-white-background":
            tool=skill.parent/"scripts/check_main_image.py"
            # Failing the pre-fix check is expected. Its output must still exist and be decoded at delivery.
            import subprocess
            target=out/"shot-01.png"
            check=subprocess.run([sys.executable,"-I",str(tool),str(target),"--fix",str(cwd/"fixed.png")],capture_output=True,timeout=60)
            if check.returncode not in {0,1} or not (cwd/"fixed.png").is_file():
                raise ValueError("white image check failed")
            (cwd/"fixed.png").replace(target)
        if alias=="image-taobao-detail-long-image":
            pages=sorted(out.glob("shot-*.png"))
            run([sys.executable,"-I",skill.parent/"scripts/stitch_long_image.py",*pages,"--out",out/"detail.jpg"],cwd)
            for p in (out/"detail-slices").glob("*.jpg"):
                p.rename(out/("slice-"+p.name))
        if alias=="image-amazon-a-plus":
            modules={"品牌横幅":"overlay","核心卖点":"header","场景模块":"header","细节模块":"tile300"}
            for p,slot in zip(sorted(out.glob("shot-*.png")),req["slots"],strict=True):
                run([sys.executable,"-I",skill.parent/"scripts/crop_to_modules.py",p,"--module",modules[slot],"--out",p.with_suffix(".jpg")],cwd)
                p.unlink()
        if alias=="image-xiaohongshu-cover":
            from PIL import Image,ImageOps
            for p in out.glob("*.png"):
                with Image.open(p) as im:poster=ImageOps.fit(im.convert("RGB"),(1080,1440),Image.Resampling.LANCZOS)
                poster.save(p)
        return
    if source=="dlazy":
        for i,shot in enumerate(prompts):
            run(["dlazy",model or "seedream-5.0-pro","--prompt",shot,"--images",*images,"--size",ratio,"--save",out/("detail-%02d.jpg"%i)],cwd)
        return
    if source=="suite":
        provider=os.environ.get("MEDIA_SUITE_PROVIDER","openai")
        product={"product_name":req["brief"][:100],"product_description_for_prompt":req["brief"],"platform":req["channel"]}
        result_dir=cwd/"suite"
        run([sys.executable,root/"scripts/generate.py","--product",json.dumps(product,ensure_ascii=False),
             "--provider",provider,"--product-images",",".join(images),"--types","white_bg,selling_pt,lifestyle","--output-dir",result_dir],cwd)
        report=json.loads((result_dir/"generate_result.json").read_text())
        files=[]
        for key in ["white_bg","selling_pt","lifestyle"]:
            if report[key]["status"]!="ok":raise ValueError("incomplete product suite")
            path=Path(report[key]["path"]).resolve()
            if path.parent!=result_dir.resolve() or path.suffix.lower() not in {".jpg",".jpeg",".png"}:raise ValueError("invalid suite file")
            files.append(path)
        for i,p in enumerate(files): p.rename(out/("suite-%02d"%i+p.suffix.lower()))
        return
    if source=="wan":
        refs=[]
        scripts=skill.parent/"scripts"
        for p in images:
            refs.append(run([sys.executable,scripts/"file_to_oss.py","--file",p,"--model","wan2.7-image"],cwd).strip().splitlines()[-1])
        msg=run([sys.executable,scripts/"image-generation-editing.py","--user_requirement",prompt,"--n","1",*(["--input_images",*refs] if refs else [])],cwd)
        import re
        urls=re.findall(r'result No\.\s*\d+:\s*(https://[^\s]+)',msg)
        if not urls: raise ValueError("no completed Wan image")
        download(urls[0],out/"wan.png")
        return
    if source=="linkpix":
        labels={"image-linkpix-main-image-set":"套图模式","image-linkpix-ecom-image":"套图模式","image-linkpix-detail-page":"电商详情图"}
        body={"modelLabel":labels.get(alias,model or ("智慧模型" if image else "Viduq3-turbo")),"uploadedImages":images}
        if body["modelLabel"]=="套图模式":body.update(customCopy=req["brief"],imageCount=req["minOutputs"])
        elif body["modelLabel"]!="电商详情图":body["prompt"]=prompt
        if not image:body["duration"]=5
        data=as_json(run(["qhkit",kind,"generate",json.dumps(body,ensure_ascii=False)],cwd))
        if data.get("ok") is False:raise ValueError("LinkPix rejected input")
        collect_urls({k:v for k,v in data.items() if k!="raw"},out,kind)
        return
    if source=="fal":
        refs=[as_json(run(["genmedia","upload",p,"--json"],cwd))["url"] for p in images]
        for i,shot in enumerate(prompts):
            run(["genmedia","run",model or "fal-ai/nano-banana-pro/edit","--image_urls",*refs,"--prompt",shot,
                 "--download",out/("sku-%02d-{index}.{ext}"%i),"--json"],cwd)
        return
    if source=="minimax":
        args=["mmx",kind,"generate","--prompt",prompt,"--quiet"]
        if image: args+=["--model",model or "MiniMax-H3-Image","--aspect-ratio",ratio,"--out",out/"product.png"]
        else:args+=["--download",out/"product.mp4"]+(["--model",model] if model else [])
        if images:args+=["--image",images[0]]
        if image:
            for p in images[1:]:args+=["--image",p]
        elif len(images)>1:args+=["--last-frame",images[1]]
        run(args,cwd);return
    if source=="ark":
        args=["arkcli","+gen","--modality",kind,"--format","json"]
        if model:args+=["--model",model]
        for p in images:args+=["--input","@"+p]
        if not image:args+=["--wait","--timeout","15m"]
        collect_urls(as_json(run([*args,prompt],cwd)),out,kind);return
    if source=="pixverse":
        if image:args=["create","image",*(["--image",*images] if images else [])]
        elif len(images)==2 and not videos:args=["create","transition","--images",*images]
        elif len(inputs)>1 or videos:args=["create","reference",*(["--images",*images] if images else []),*(["--videos",*videos] if videos else [])]
        else:args=["create","video",*(["--image",*images] if images else [])]
        collect_urls(as_json(run(["pixverse",*args,"--prompt",prompt,*(["--model",model] if model else []),"--json"],cwd)),out,kind);return
    if source=="vidu":
        mode=("reference2image" if images else "text2image") if image else (
            "character2video" if videos or len(images)>2 else "headtailimg2video" if len(images)==2 else "img2video" if images else "text2video")
        args=["vidu-cli","task","submit","--type",mode,"--prompt",prompt,"--model-version",model or ("3.2_image_2_5_pro" if image else "3.2"),
              "--resolution","2k" if image else "1080p","--wait","--output",str(out)]
        if not image:args+=["--duration","5"]
        if mode in {"img2video","headtailimg2video"}:args+=["--transition","pro"]
        for p in images:args+=["--image",p]
        for p in videos:args+=["--video",p]
        run(args,cwd);return
    if source=="kling":
        if not model: raise ValueError("select a Kling model supported by the bound account")
        if image:args=["image_to_image" if images else "text_to_image"]
        elif videos and images and len(inputs)==2:args=["motion_control"]
        else:args=["omni_ref_video" if videos or len(images)>2 else "image_to_video" if images else "text_to_video"]
        for i,p in enumerate(images):args+=["--tailImage" if args[0]=="image_to_video" and i==1 else "--image",p]
        for p in videos:args+=["--video",p]
        args+=["--model",model,"--poll","60"]
        if args[0]!="motion_control":args+=[prompt]
        result=as_json(run(["kling",*args],cwd))
        job=next(values(result,{"generationid"}),None)
        def works(node):
            if isinstance(node,dict):
                for key,value in node.items():
                    if key=="works" and isinstance(value,list):yield from values(value,{"url"})
                    elif isinstance(value,(dict,list)):yield from works(value)
            elif isinstance(node,list):
                for v in node:yield from works(v)
        for _ in range(14):
            if list(works(result)):break
            if not job:raise ValueError("no Kling job ID")
            if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]{0,127}",job):
                raise ValueError("invalid Kling task ID")
            result=as_json(run(["kling","query_tasks","--poll","60",job],cwd))
        collect_urls({"outputs":list(works(result))},out,kind);return
    raise ValueError("unknown vendor")
