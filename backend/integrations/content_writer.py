"""Use upstream agents with a strict structured-output transport."""
import json
from urllib.parse import urlsplit


def generate(request, error):
    from ecommerce_agent.agents.orchestrator import ContentOrchestrator
    import httpx
    from openai import OpenAI
    model, body = request["model"], request["parameters"]
    if not model.get("key"):
        raise error("MODEL_NOT_CONFIGURED")
    if body["platform"] not in {"taobao", "douyin", "xiaohongshu"}:
        raise error("INVALID_UPSTREAM_PARAMETERS")

    class StructuredModel:
        def chat_json(self, user_message, system_prompt=""):
            response = client.chat.completions.create(
                model=model["name"], messages=[
                    {"role": "system", "content": system_prompt + "\n用 JSON 对象输出，严格遵循指定的顶层字段。"
                     "所有文案只采用用户提供的商品事实。不得据平台名推断已上架、库存或销售情况，"
                     "不得虚构外观、性能、材质等级、功效、销量、认证或使用测试。资料少时减少卖点条数。"},
                    {"role": "user", "content": user_message},
                ], response_format={"type": "json_object"}, max_tokens=8192,
                extra_body={"thinking": {"type": "disabled"}} if urlsplit(model["baseUrl"]).hostname == "api.deepseek.com" else None,
            )
            choice = response.choices[0]
            if choice.finish_reason != "stop" or not choice.message.content:
                raise error("INVALID_PROVIDER_RESULT")
            try:
                values = json.loads(choice.message.content)
            except ValueError:
                raise error("INVALID_PROVIDER_RESULT") from None
            if not isinstance(values, dict) or not values:
                raise error("INVALID_PROVIDER_RESULT")
            return values

    local = urlsplit(model["baseUrl"]).hostname in {"localhost", "127.0.0.1", "::1"}
    with OpenAI(api_key=model["key"], base_url=model["baseUrl"], max_retries=0, timeout=60,
                http_client=httpx.Client(trust_env=not local, timeout=60)) as client:
        orchestrator = ContentOrchestrator(model_client=StructuredModel())
        return orchestrator.generate_dict({
            "title": body["title"], "category": body["category"], "platform": body["platform"],
            "original_description": body["facts"], "selling_points": body.get("sellingPoints", []),
            "tone": body.get("tone", "professional"), "target_audience": body.get("audience", ""),
            "constraints": ["保留商品资料中的事实；缺少依据时不要添加规格、功效、认证或检测结论。"],
        })
