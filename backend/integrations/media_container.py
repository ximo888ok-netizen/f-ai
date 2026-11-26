"""Execute the selected pinned media workflow in a disposable non-root container."""
import asyncio
import base64
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

sys.path.insert(0,str(Path(__file__).resolve().parent))

TOOLS={"linkpix":"qhkit","dlazy":"dlazy","fal":"genmedia","kling":"kling","vidu":"vidu-cli","pixverse":"pixverse","minimax":"mmx","ark":"arkcli"}
KEYS={"linkpix":"QHKIT_TOKEN","dlazy":"DLAZY_API_KEY","fal":"FAL_KEY","wan":"DASHSCOPE_API_KEY",
      "commerce":"OPENAI_API_KEY","minimax":"MINIMAX_API_KEY","runway":"RUNWAY_MCP_TOKEN","vidu":"VIDU_TOKEN"}
IMAGE_TYPES={".png",".jpg",".jpeg",".webp"}
SOURCE=Path(sys.argv[2]).resolve() if __name__=="__main__" and len(sys.argv)>2 else Path("/opt/source")
PROFILE=Path("/opt/vendor-profile")


def has_profile_files():
    if not PROFILE.is_dir() or PROFILE.is_symlink():
        return False
    for root, _, files in os.walk(PROFILE, followlinks=False):
        for name in files:
            path=Path(root)/name
            try:
                if not path.is_symlink() and path.is_file() and path.stat().st_size>0:
                    return True
            except OSError:
                continue
    return False


def preflight(source,files,alias):
    if not all((SOURCE/f).is_file() for f in files):return "source_missing"
    if not all(shutil.which(b) for b in ["ffmpeg","ffprobe",*([TOOLS[source]] if source in TOOLS else [])]):return "runtime_unavailable"
    deps=["PIL","requests"]
    if source in {"aidge","runway"}:deps.append("oss2")
    if source=="aidge":deps.append("alibabacloud_aidge20260428")
    if source=="runway":deps.extend(["mcp","jsonschema"])
    if source=="firered":deps.append("websockets")
    if source=="suite":deps.extend(["numpy","dotenv"])
    if not all(importlib.util.find_spec(d) is not None for d in deps):return "runtime_unavailable"
    profile=source in {"minimax","dlazy","vidu","kling","pixverse","ark"} and has_profile_files()
    if source in KEYS and not os.environ.get(KEYS[source]) and not (profile and source in {"minimax","dlazy","vidu"}):return "credentials_required"
    if source in {"kling","pixverse","ark"} and not profile:return "credentials_required"
    if source=="kling" and not os.environ.get("MEDIA_IMAGE_MODEL" if alias.startswith("image-") else "MEDIA_VIDEO_MODEL"):return "model_required"
    if source in {"commerce","fal"} or alias=="video-ad-rewrite":
        if not (os.environ.get("MEDIA_PLANNER_KEY") and os.environ.get("MEDIA_PLANNER_MODEL")):return "planner_required"
    if source=="byte" and not (os.environ.get("SEEDANCE_EP_ID") and os.environ.get("BYTEPLUS_API_KEY" if alias=="video-ad-rewrite" else "ARK_API_KEY")):return "credentials_required"
    if source=="suite" and not os.environ.get({"openai":"OPENAI_API_KEY","gemini":"GEMINI_API_KEY","tongyi":"DASHSCOPE_API_KEY","doubao":"ARK_API_KEY","stability":"STABILITY_API_KEY"}.get(os.environ.get("MEDIA_SUITE_PROVIDER","openai"),"INVALID")):return "credentials_required"
    if source=="firered" and not os.environ.get("OPENSTORYLINE_URL"):return "service_required"
    if source in {"runway","aidge"} and not all(os.environ.get(k) for k in ["MEDIA_OSS_BUCKET","MEDIA_OSS_ENDPOINT","ALIBABA_CLOUD_ACCESS_KEY_ID","ALIBABA_CLOUD_ACCESS_KEY_SECRET"]):return "credentials_required"
    if source=="aidge" and not os.environ.get("MEDIA_AIDGE_ENDPOINT"):return "service_required"
    if source in {"linkpix","wan","ark","byte","kling","pixverse","runway"} and not os.environ.get("MEDIA_DOWNLOAD_HOSTS"):return "service_required"
    return "configured"


def collect(out,kind,minimum):
    from PIL import Image
    files=[];total=0
    for i,p in enumerate(sorted(out.rglob("*"))):
        if p.is_symlink() or not p.is_file():continue
        if kind=="image" and p.suffix.lower() in IMAGE_TYPES:
            target=out.parent/("validated-%02d.png"%i)
            with Image.open(p) as im:
                if im.width*im.height>32_000_000:raise ValueError("image too large")
                im.save(target,"PNG")
            if target.stat().st_size>10*1024**2:
                with Image.open(p) as im:
                    target=target.with_suffix(".jpg");im.convert("RGB").save(target,quality=90)
        elif kind=="video" and p.suffix.lower()==".mp4":
            probe=subprocess.run(["ffprobe","-v","error","-select_streams","v:0","-show_entries","stream=codec_type:format=duration","-of","json",str(p)],check=True,capture_output=True,timeout=20)
            meta=json.loads(probe.stdout)
            if not meta["streams"] or not (0<float(meta["format"]["duration"])<=1800):raise ValueError("invalid video")
            target=p
            if p.stat().st_size>10*1024**2:
                target=out.parent/("validated-%02d.mp4"%i)
                bitrate=int(9*1024**2*8/float(meta["format"]["duration"])-128000)
                if bitrate<100000:raise ValueError("video too large for delivery")
                subprocess.run(["ffmpeg","-nostdin","-v","error","-i",str(p),"-map","0:v:0","-map","0:a:0?","-c:v","libx264","-b:v",str(bitrate),"-c:a","aac","-b:a","96k","-movflags","+faststart",str(target)],check=True,timeout=180)
        else:continue
        size=target.stat().st_size;total+=size
        if not 0<size<=10*1024**2 or total>48*1024**2 or len(files)>=24:raise ValueError("output limit")
        files.append({"ext":target.suffix,"data":base64.b64encode(target.read_bytes()).decode("ascii")})
    if len(files)<minimum:raise ValueError("incomplete delivery")
    return files


def execute(req):
    from media_plan import shots
    from media_services import fire_red,runway,seedance
    from media_vendor import run_vendor
    source=req["source"]
    if preflight(source,[req["skill"]],req["alias"])!="configured":raise ValueError("unavailable")
    with tempfile.TemporaryDirectory() as directory:
        work=Path(directory);out=work/"out";out.mkdir()
        home=work/"home";home.mkdir()
        if PROFILE.is_dir():shutil.copytree(PROFILE,home,dirs_exist_ok=True)
        os.environ.update(HOME=str(home),USERPROFILE=str(home))
        if os.name=="nt":os.environ.update(APPDATA=str(home),LOCALAPPDATA=str(home))
        inputs=[]
        for item in req["assets"]:
            name=item["name"]
            if Path(name).name!=name or Path(name).suffix not in {".png",".jpg",".mp4"}:raise ValueError("invalid input")
            path=work/name;path.write_bytes(base64.b64decode(item["data"],validate=True));inputs.append(path)
        if source=="aidge":
            inputdir=work/"inputs";inputdir.mkdir()
            for p in inputs:p.rename(inputdir/p.name)
            subprocess.run([sys.executable,"-I",str(SOURCE/"aidge/run.py"),str(inputdir),str(out)],timeout=1100,check=True)
        else:
            if source=="commerce":
                os.environ["GPTIMAGE_API_KEY"]=os.environ["OPENAI_API_KEY"];os.environ["GPTIMAGE_BASE_URL"]="https://api.openai.com"
                if os.environ.get("MEDIA_IMAGE_MODEL"):os.environ["GPTIMAGE_MODEL"]=os.environ["MEDIA_IMAGE_MODEL"]
            prompts=shots(req,inputs,SOURCE/req["skill"],work)
            if source=="firered":fire_red(req,inputs,out,prompts[0],SOURCE)
            elif source=="byte":seedance(req,inputs,out,prompts[0])
            elif source=="runway":asyncio.run(runway(req,inputs,out,prompts[0]))
            else:run_vendor(req,inputs,out,prompts,SOURCE)
        return {"status":"succeeded","text":"制作完成。","files":collect(out,req["kind"],req["minOutputs"])}


if __name__=="__main__":
    try:
        req=json.load(sys.stdin)
        if sys.argv[1]=="probe":
            print(json.dumps({"state":preflight(req["source"],req["files"],req["alias"])}))
        else:print(json.dumps(execute(req),ensure_ascii=True))
    except Exception:
        print('{"status":"failed","text":"","files":[]}')
