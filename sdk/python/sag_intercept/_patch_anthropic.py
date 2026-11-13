"""
sag_intercept._patch_anthropic
~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
Monkey-patches anthropic.messages.create to intercept tool_use blocks
through the SAG gateway before the model can act on them.
"""

import json
from ._gateway import check_tool_call


def _extract_tool_uses(messages):
    """
    Scan messages for assistant messages containing tool_use content blocks.
    Returns a list of (tool_name, args) tuples.
    """
    calls = []
    for msg in messages or []:
        if not isinstance(msg, dict):
            continue
        if msg.get("role") != "assistant":
            continue
        for block in msg.get("content") or []:
            if not isinstance(block, dict):
                continue
            if block.get("type") == "tool_use":
                name  = block.get("name", "")
                input_ = block.get("input", {})
                if isinstance(input_, str):
                    try:
                        input_ = json.loads(input_)
                    except (json.JSONDecodeError, TypeError):
                        input_ = {}
                if name:
                    calls.append((name, input_))
    return calls


def patch():
    """Patch anthropic.messages.create. Safe to call multiple times."""
    try:
        import anthropic
    except ImportError:
        return  # anthropic not installed — nothing to patch

    client_cls = anthropic.Anthropic
    _orig      = client_cls.messages.create if hasattr(client_cls, "messages") else None

    # The Anthropic client uses instance-level resources — patch at the class level
    try:
        from anthropic.resources.messages import Messages
        _orig_create = Messages.create

        if getattr(_orig_create, "_sag_patched", False):
            return

        def _patched_create(self, *args, **kwargs):
            messages = kwargs.get("messages") or (args[0] if args else [])
            tool_calls = _extract_tool_uses(messages)

            for tool_name, tool_args in tool_calls:
                result = check_tool_call(tool_name, tool_args)
                if not result.get("allowed", True):
                    raise PermissionError(
                        f"SAG denied tool call '{tool_name}': {result.get('reason', 'Policy violation')}"
                    )

            return _orig_create(self, *args, **kwargs)

        _patched_create._sag_patched = True
        _patched_create._sag_original = _orig_create
        Messages.create = _patched_create

    except (ImportError, AttributeError):
        pass
