"""Single request per process. No platform credentials or model keys in argv or logs."""
import asyncio
import contextlib
import json
from pathlib import Path
import sys
from urllib.parse import urlparse

sys.path.insert(0, str(Path(__file__).resolve().parent))


class IntegrationError(Exception):
    pass


def dispatch(request):
    kind = request["kind"]
    if kind == "commerce":
        from commerce_sdk import invoke
        return asyncio.run(invoke(request, IntegrationError))
    if kind == "content":
        from ecommerce_agent.agents.orchestrator import ContentOrchestrator
        if request["action"] == "probe":
            return {"engine": ContentOrchestrator.__name__}
        from content_writer import generate
        return generate(request, IntegrationError)
    if kind == "customer":
        sys.path.insert(0, str(Path(request["source"]).resolve()))
        from Agent.CustomerAgent.custom import LLMClient, MessageBuilder
        if request["action"] == "probe":
            return {"engine": "Customer-Agent"}
        return asyncio.run(draft(LLMClient, MessageBuilder, request))
    raise IntegrationError("INVALID_UPSTREAM_PARAMETERS")


async def draft(client_type, builder_type, request):
    model, params = request["model"], request["parameters"]
    if not model.get("key"):
        raise IntegrationError("MODEL_NOT_CONFIGURED")
    from utils.llm_provider import build_llm_profile
    local = urlparse(model["baseUrl"]).hostname in {"localhost", "127.0.0.1", "::1"}
    profile = build_llm_profile({"provider": model["provider"], "model_name": model["name"], "api_base": model["baseUrl"],
                                 "api_key": model["key"], "tool_policy": "disabled",
                                 "endpoint_trust_mode": "local" if local else "explicit"})
    client = client_type(profile=profile)
    builder = builder_type(instructions=["为客服人员起草回复。仅依据提供的事实，资料不足请澄清，不承诺退款或已执行操作。"],
                           business_hours={"start": "00:00", "end": "23:59"})
    data = json.dumps({"买家问题": params["question"], "参考资料": params.get("facts", "")}, ensure_ascii=False)
    messages = builder.build_messages(data, [], dependencies={"shop_name": "当前店铺", "product_list": ""})
    await client.initialize()
    try:
        reply = await client.chat(messages, use_tools=False)
        if not isinstance(reply.content, str) or not reply.content.strip() or reply.has_tool_calls:
            raise IntegrationError("INVALID_PROVIDER_RESULT")
        return {"text": reply.content.strip()}
    finally:
        await client.close()


def main():
    try:
        request = json.load(sys.stdin)
        with contextlib.redirect_stdout(sys.stderr):
            data = dispatch(request)
        result = {"ok": True, "data": data}
    except IntegrationError as exc:
        result = {"ok": False, "error": str(exc)}
    except (ModuleNotFoundError, ImportError):
        result = {"ok": False, "error": "INTEGRATION_DEPENDENCY_MISSING"}
    except Exception:
        result = {"ok": False, "error": "UPSTREAM_REJECTED"}
    print(json.dumps(result, ensure_ascii=True, allow_nan=False))


if __name__ == "__main__":
    main()
