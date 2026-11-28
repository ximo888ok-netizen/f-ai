"""Use the official Aidge OpenAPI through Alibaba Cloud CLI and temporary signed OSS objects."""
import io
import json
import os
from pathlib import Path
import sys
import time
from uuid import uuid4
import oss2
from PIL import Image
from alibabacloud_aidge20260428.client import Client
from alibabacloud_aidge20260428 import models
from alibabacloud_tea_openapi.utils_models import Config


def checked(response):
    result=response.body.to_map()
    if result.get("Success") is not True:
        raise ValueError("Aidge rejected request")
    return result["Data"]


def main():
    sys.path.insert(0,sys.argv[3])
    from media_io import public_download
    inputs=sorted(Path(sys.argv[1]).iterdir())
    if len(inputs)!=2:
        raise ValueError("two images required")
    key=os.environ["ALIBABA_CLOUD_ACCESS_KEY_ID"]
    secret=os.environ["ALIBABA_CLOUD_ACCESS_KEY_SECRET"]
    token=os.environ.get("ALIBABA_CLOUD_SECURITY_TOKEN")
    auth=oss2.StsAuth(key,secret,token) if token else oss2.Auth(key,secret)
    bucket=oss2.Bucket(auth,os.environ["MEDIA_OSS_ENDPOINT"],os.environ["MEDIA_OSS_BUCKET"])
    client=Client(Config(access_key_id=key,access_key_secret=secret,security_token=token,endpoint=os.environ["MEDIA_AIDGE_ENDPOINT"]))
    objects,urls=[],[]
    try:
        for path in inputs:
            with Image.open(path) as im:
                if min(im.size)<256 or max(im.size)>2049:
                    raise ValueError("input dimensions outside the Aidge contract")
            name="fai-tryon/"+uuid4().hex+path.suffix
            objects.append(name)
            bucket.put_object_from_file(name,str(path))
            urls.append(bucket.sign_url("GET",name,1800))
        data=checked(client.virtual_try_on(models.VirtualTryOnRequest(model_image_url=urls[0],cloth_image_url=urls[1],resolution="1K")))
        task_id=data.get("TaskId")
        for _ in range(180 if task_id else 0):
            data=checked(client.query_async_task_result(models.QueryAsyncTaskResultRequest(task_id=task_id)))
            if data.get("Status")=="COMPLETED":
                break
            if data.get("Status") not in {"PENDING","PROCESSING","RUNNING","QUEUED","SUBMITTED"}:
                raise ValueError("Aidge task failed")
            time.sleep(4)
        else:
            if task_id:
                raise TimeoutError("Aidge polling exceeded the task limit")
        result=data.get("Result",data)
        if isinstance(result,str):
            result=json.loads(result)
        url=result.get("ImageUrl") or result.get("url") or data.get("ImageUrl")
        if not isinstance(url,str):
            raise ValueError("missing result")
        with public_download(url,timeout=60) as response:
            if response.status!=200:
                raise ValueError("Aidge download failed")
            raw=bytearray()
            for chunk in response.stream(65536,decode_content=False):
                raw.extend(chunk)
                if len(raw)>10*1024**2:
                    raise ValueError("image exceeds task limit")
        with Image.open(io.BytesIO(raw)) as im:
            if im.width*im.height>16_000_000:
                raise ValueError("image exceeds pixel limit")
            im.convert("RGB").save(Path(sys.argv[2])/"try-on.png")
    finally:
        if objects:
            bucket.batch_delete_objects(objects)

if __name__=="__main__":
    main()
