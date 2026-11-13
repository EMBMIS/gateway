"""
sag_intercept._patch_openai
~~~~~~~~~~~~~~~~~~~~~~~~~~~~
Monkey-patches openai.chat.completions.create to intercept tool calls
through the SAG gateway before the model can act on them.
"""

import json
from ._gateway import check_tool_call


def _extract_tool_calls(messages):
    """
    Scan messages for any assistant messages containing tool_calls or
    function_call entries.  Returns a list of (tool_name, args) tuples.
    """
    calls = []
    for msg in messages or []:
        if not isinstance(msg, dict):
            continue
        role = msg.get("role", "")
        if role == "assistant":
            # New-style tool_calls
            for tc in msg.get("tool_calls") or []:
                fn = tc.get("function", {})
                name = fn.get("name")
                try:
                    args = json.loads(fn.get("arguments", "{}"))
                except (json.JSONDecodeError, TypeError):
                    args = {}
                if name:
                    calls.append((name, args))
            # Legacy function_call
            fc = msg.get("function_call")
            if fc and fc.get("name"):
                try:
                    args = json.loads(fc.get("arguments", "{}"))
                except (json.JSONDecodeError, TypeError):
                    args = {}
                calls.append((fc["name"], args))
    return calls


def patch():
    """Patch openai.chat.completions.create. Safe to call multiple times."""
    try:
        import openai
    except ImportError:
        return  # openai not installed — nothing to patch

    _orig = openai.chat.completions.create

    if getattr(_orig, "_sag_patched", False):
        return  # already patched

    def _patched_create(*args, **kwargs):
        messages = kwargs.get("messages") or (args[1] if len(args) > 1 else [])
        tool_calls = _extract_tool_calls(messages)

        for tool_name, tool_args in tool_calls:
            result = check_tool_call(tool_name, tool_args)
            if not result.get("allowed", True):
                raise PermissionError(
                    f"SAG denied tool call '{tool_name}': {result.get('reason', 'Policy violation')}"
                )

        return _orig(*args, **kwargs)

    _patched_create._sag_patched = True
    _patched_create._sag_original = _orig
    openai.chat.completions.create = _patched_create
