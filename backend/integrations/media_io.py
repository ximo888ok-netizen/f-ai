"""Bound command and artifact IO. Commands are selected by the adapters, never by the planner."""
import json
import os
import subprocess
from pathlib import Path
from urllib.parse import urlsplit
import requests


def run(args,cwd,timeout=1050):
    result=subprocess.run([str(a) for a in args],cwd=cwd,stdin=subprocess.DEVNULL,capture_output=True,timeout=timeout)
    if result.returncode:
        raise ValueError("provider command failed")
    return result.stdout.decode("utf8",errors="replace")


def as_json(text):
    try:
        return json.loads(text)
    except ValueError:
        for line in reversed(text.splitlines()):
            try:
                value=json.loads(line)
                if isinstance(value,(dict,list)):
                    return value
            except ValueError:
                pass
    raise ValueError("missing provider JSON")


def values(data,keys):
    if isinstance(data,dict):
        for key,value in data.items():
            if key.lower() in {"input","inputs","request","params","parameters","prompt","uploadedimages","references","source"}:
                continue
            if key.lower() in keys and isinstance(value,(str,int)):
                yield str(value)
            elif key.lower() in {"images","videos","imageurls","videourls","outputs","preview_urls"} and isinstance(value,list):
                for item in value:
                    if isinstance(item,str):yield item
                    else:yield from values(item,keys)
            elif isinstance(value,(dict,list)):
                yield from values(value,keys)
    elif isinstance(data,list):
        for value in data:
            yield from values(value,keys)


def download(url,dest):
    u=urlsplit(url)
    hosts=[h.strip().lower() for h in os.environ.get("MEDIA_DOWNLOAD_HOSTS","").split(",") if h.strip()]
    if u.scheme!="https" or not u.hostname or u.username or u.password or u.port not in {None,443} or not any(
            u.hostname==h or u.hostname.endswith("."+h) for h in hosts):
        raise ValueError("output host not approved")
    with requests.get(url,timeout=90,allow_redirects=False,stream=True) as response:
        if response.status_code!=200:
            raise ValueError("media download failed")
        size=0
        with dest.open("xb") as out:
            for chunk in response.iter_content(65536):
                size+=len(chunk)
                if size>80*1024**2:
                    raise ValueError("output too large")
                out.write(chunk)


def collect_urls(data,out,kind):
    keys={"url","output_url","outputurl","media_url","mediaurl","video_url","videourl","image_url","imageurl","resource_url","resourceurl","downloadurl","resulturl","result_url","image","video"}
    urls=list(dict.fromkeys(v for v in values(data,keys) if v.startswith("https://")))
    if not urls or len(urls)>24:
        raise ValueError("no bounded set of generated media")
    for i,url in enumerate(urls):
        download(url,out/("asset-%02d.%s"%(i+1,"mp4" if kind=="video" else "png")))
