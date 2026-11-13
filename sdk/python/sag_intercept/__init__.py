"""
sag_intercept
~~~~~~~~~~~~~
Auto-patching SAG SDK for Python.

Import this package once at the top of your application:

    import sag_intercept  # patches openai, anthropic, langchain automatically

Environment variables:
    SAG_API_KEY      — Required. Your SAG API key.
    SAG_GATEWAY_URL  — Gateway base URL (default: http://localhost:3000).
    SAG_MODE         — Set to "learn" to log observations without blocking.

Learn mode: when SAG_MODE=learn, all calls are allowed through and logged
to .sag-observations.jsonl so you can generate a tailored policy later.
"""

import os as _os

from ._patch_openai    import patch as _patch_openai
from ._patch_anthropic import patch as _patch_anthropic
from ._patch_langchain import patch as _patch_langchain

# Auto-patch all supported libraries on import
_patch_openai()
_patch_anthropic()
_patch_langchain()

__version__ = "0.1.0"
__all__     = ["check_tool_call"]

# Re-export for manual use
from ._gateway import check_tool_call
