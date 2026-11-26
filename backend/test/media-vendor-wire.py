"""Exercise the pinned image generator without contacting a model provider."""
import base64
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import threading
from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer
from PIL import Image

sys.path.insert(0,str(Path(__file__).resolve().parents[1]/"integrations"))
from media_vendor import run_vendor

root=Path(sys.argv[1])
calls=[]
with tempfile.TemporaryDirectory() as tmp:
    work=Path(tmp);out=work/"out";out.mkdir()
    ref=work/"real-reference.png";Image.new("RGB",(320,400),"navy").save(ref)
    result=io.BytesIO();Image.new("RGB",(256,256),"ivory").save(result,"PNG")
    class Endpoint(BaseHTTPRequestHandler):
        def log_message(self,*unused):pass
        def do_POST(self):
            body=self.rfile.read(int(self.headers["Content-Length"]))
            calls.append((self.path,ref.read_bytes() in body))
            self.send_response(200);self.send_header("Content-Type","application/json");self.end_headers()
            self.wfile.write(json.dumps({"data":[{"b64_json":base64.b64encode(result.getvalue()).decode()}]}).encode())
    server=ThreadingHTTPServer(("127.0.0.1",0),Endpoint)
    threading.Thread(target=server.serve_forever,daemon=True).start()
    os.environ.update(GPTIMAGE_BASE_URL="http://127.0.0.1:"+str(server.server_port),GPTIMAGE_API_KEY="wire-test",
                      NO_PROXY="127.0.0.1,localhost",no_proxy="127.0.0.1,localhost")
    try:
        req={"source":"commerce","alias":"image-amazon-a-plus","kind":"image","skill":"skills/amazon-a-plus/SKILL.md",
             "ratio":"1:1","slots":["品牌横幅","细节模块"]}
        run_vendor(req,[ref],out,["header test","tile test"],root)
        assert calls==[("/v1/images/edits",True)]*2,calls
        assert sorted(Image.open(p).size for p in out.glob("*.jpg"))==[(300,300),(970,300)]
    finally:server.shutdown();server.server_close()
