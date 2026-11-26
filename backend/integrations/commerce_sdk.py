"""Read-only binding to the published Core SDK, with a fixed merchant credential snapshot."""
import importlib.metadata
import re


def redact(value, secrets):
    if isinstance(value, list):
        return [redact(item, secrets) for item in value]
    if isinstance(value, dict):
        return {k: redact(v, secrets) for k, v in value.items()
                if not re.search(r"token|secret|cookie|authorization|phone|mobile|address|receiver|buyer_nick|recipient|身份证", k, re.I)}
    if isinstance(value, str) and any(secret and secret in value for secret in secrets):
        return "[已隐藏凭据]"
    if isinstance(value, int) and abs(value) > 2**53 - 1:
        return str(value)
    return value


async def invoke(request, error):
    if importlib.metadata.version("mcp-cn-commerce") != "0.1.6":
        raise error("INTEGRATION_DEPENDENCY_MISSING")
    from shared.platform_clients import create_platform_client, operation_catalog
    if request["action"] == "probe":
        from zoneinfo import ZoneInfo
        ZoneInfo("Asia/Shanghai")
        return {platform: [name for name, op in operation_catalog(platform).items()
                           if op.supported and op.contract_status == "documented"] for platform in request["platforms"]}
    if request["action"] == "report":
        from shared.aggregation import build_daily_report
        try:
            return build_daily_report(request["date"], request["shops"], timezone="Asia/Shanghai")
        except (ValueError, TypeError, KeyError, AttributeError):
            raise error("INVALID_UPSTREAM_PARAMETERS") from None
    platform, name = request["platform"], request["operation"]
    op = operation_catalog(platform).get(name)
    if op is None or not op.supported or op.contract_status != "documented":
        raise error("OPERATION_UNSUPPORTED")
    params, credentials = request["params"], request["credentials"]
    if platform == "oceanengine":
        if any("advertiser" in k.lower() for k in params):
            raise error("INVALID_UPSTREAM_PARAMETERS")
        advertiser = int(request["advertiserId"])
        if name == "get_account_balance":
            params["advertiser_id"] = advertiser
        else:
            params["advertiser_ids"] = [advertiser]
    try:
        async with create_platform_client(platform, credentials) as client:
            response = await client.call(name, params)
    except ValueError:
        raise error("INVALID_UPSTREAM_PARAMETERS") from None
    if not isinstance(response, dict) or "error_response" in response or "error" in response:
        raise error("UPSTREAM_REJECTED")
    secrets = [v for k, v in credentials.items() if k in {"access_token", "app_secret", "sign_secret"}]
    return redact(response, secrets)
