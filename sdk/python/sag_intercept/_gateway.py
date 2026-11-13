"""
sag_intercept._gateway
~~~~~~~~~~~~~~~~~~~~~~~
Sends a tool call to the SAG gateway and returns the decision.

Reads SAG_API_KEY and SAG_GATEWAY_URL from the environment.
"""

import json
import os
import urllib.request
import urllib.error


def check_tool_call(tool: str, args: dict) -> dict:
    """
    POST /api/gateway/execute with the given tool + args.

    Returns a dict with at least:
      - allowed: bool
      - decision: str  ("APPROVED" | "DENIED" | "ESCALATED")
      - reason: str | None

    Raises RuntimeError if SAG_API_KEY or SAG_GATEWAY_URL are not set.
    Raises urllib.error.URLError on network failure.
    """
    api_key     = os.environ.get("SAG_API_KEY", "")
    gateway_url = os.environ.get("SAG_GATEWAY_URL", "http://localhost:3000")
    sag_mode    = os.environ.get("SAG_MODE", "")

    if sag_mode == "learn":
        # Learning mode — log only, never block
        _log_observation(tool, args)
        return {"allowed": True, "decision": "APPROVED", "reason": "learn mode — logged only"}

    if not api_key:
        raise RuntimeError(
            "SAG_API_KEY environment variable is not set. "
            "Get your key from the SAG dashboard and export SAG_API_KEY=<key>"
        )

    payload = json.dumps({"tool": tool, "action": "EXECUTE", "args": args}).encode("utf-8")
    url     = gateway_url.rstrip("/") + "/api/gateway/execute"

    req = urllib.request.Request(
        url,
        data=payload,
        headers={
            "Content-Type":  "application/json",
            "Authorization": f"Bearer {api_key}",
        },
        method="POST",
    )

    try:
        with urllib.request.urlopen(req, timeout=5) as resp:
            body = json.loads(resp.read().decode("utf-8"))
            body.setdefault("allowed", True)
            return body
    except urllib.error.HTTPError as e:
        body_bytes = e.read()
        try:
            body = json.loads(body_bytes.decode("utf-8"))
        except Exception:
            body = {}
        if e.code == 403:
            body["allowed"]  = False
            body.setdefault("decision", "DENIED")
        elif e.code == 202:
            body.setdefault("decision", "ESCALATED")
            body["allowed"]  = False
        else:
            # Unknown HTTP error — fail closed
            body["allowed"]  = False
            body.setdefault("decision", "DENIED")
            body.setdefault("reason",   f"SAG gateway returned HTTP {e.code}")
        return body


def _log_observation(tool: str, args: dict) -> None:
    """Append a learn-mode observation to .sag-observations.jsonl"""
    import datetime
    record = {
        "timestamp": datetime.datetime.utcnow().isoformat() + "Z",
        "tool":      tool,
        "args":      args,
    }
    with open(".sag-observations.jsonl", "a", encoding="utf-8") as f:
        f.write(json.dumps(record) + "\n")
