"""
sag_intercept._patch_langchain
~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
Monkey-patches BaseTool.run() (and arun()) to intercept every LangChain
tool execution through the SAG gateway.
"""

from ._gateway import check_tool_call


def patch():
    """Patch langchain_core.tools.BaseTool.run. Safe to call multiple times."""
    try:
        # LangChain v0.1+ uses langchain_core
        from langchain_core.tools import BaseTool
    except ImportError:
        try:
            from langchain.tools import BaseTool
        except ImportError:
            return  # LangChain not installed — nothing to patch

    _orig_run  = BaseTool.run
    _orig_arun = getattr(BaseTool, "arun", None)

    if getattr(_orig_run, "_sag_patched", False):
        return  # already patched

    def _patched_run(self, tool_input, *args, **kwargs):
        tool_name = getattr(self, "name", "unknown_tool")

        # Normalise input to dict
        if isinstance(tool_input, str):
            args_dict = {"input": tool_input}
        elif isinstance(tool_input, dict):
            args_dict = tool_input
        else:
            args_dict = {"input": str(tool_input)}

        result = check_tool_call(tool_name, args_dict)
        if not result.get("allowed", True):
            raise PermissionError(
                f"SAG denied LangChain tool '{tool_name}': {result.get('reason', 'Policy violation')}"
            )

        return _orig_run(self, tool_input, *args, **kwargs)

    _patched_run._sag_patched  = True
    _patched_run._sag_original = _orig_run
    BaseTool.run = _patched_run

    # Async variant
    if _orig_arun:
        async def _patched_arun(self, tool_input, *args, **kwargs):
            tool_name = getattr(self, "name", "unknown_tool")
            if isinstance(tool_input, str):
                args_dict = {"input": tool_input}
            elif isinstance(tool_input, dict):
                args_dict = tool_input
            else:
                args_dict = {"input": str(tool_input)}

            result = check_tool_call(tool_name, args_dict)
            if not result.get("allowed", True):
                raise PermissionError(
                    f"SAG denied LangChain tool '{tool_name}': {result.get('reason', 'Policy violation')}"
                )

            return await _orig_arun(self, tool_input, *args, **kwargs)

        _patched_arun._sag_patched  = True
        _patched_arun._sag_original = _orig_arun
        BaseTool.arun = _patched_arun
