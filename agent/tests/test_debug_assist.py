"""Tests for Debug Assistant step."""

from dataclasses import dataclass
from unittest.mock import AsyncMock, MagicMock

import pytest

from agent.pipeline.models import StepStatus
from agent.pipeline.steps.debug_assist import run_debug_assist_step


@dataclass
class MockLLMResponse:
    """Mock LLM response object."""

    text: str
    provider: MagicMock = None
    model: str = "mock-model"

    def __post_init__(self):
        if self.provider is None:
            self.provider = MagicMock()
            self.provider.value = "mock"


@pytest.fixture
def mock_llm():
    """Create a mock LLM provider with async generate()."""
    llm = MagicMock()
    llm.generate = AsyncMock()
    return llm


VALID_DEBUG_JSON = """{
  "error_type": "compilation",
  "summary": "Missing semicolon at line 12",
  "root_cause": "Verilog syntax error from incomplete statement",
  "fix_suggestions": ["Add semicolon after assign", "Check line 12"],
  "learning_point": "Every Verilog statement needs a terminating semicolon"
}"""


@pytest.mark.asyncio
async def test_debug_assist_valid_json(mock_llm):
    """Debug step parses valid JSON response from LLM."""
    mock_llm.generate.return_value = MockLLMResponse(text=VALID_DEBUG_JSON)

    result = await run_debug_assist_step(
        rtl_code="module m; endmodule",
        testbench_code="int main() { return 0; }",
        sim_stdout="",
        sim_stderr="syntax error",
        llm=mock_llm,
    )

    assert result.status == StepStatus.PASSED
    assert result.output["error_type"] == "compilation"
    assert "semicolon" in result.output["summary"].lower()
    assert len(result.output["fix_suggestions"]) == 2
    assert result.output["fix_suggestions"][0] == "Add semicolon after assign"
    assert "semicolon" in result.output["learning_point"].lower()
    assert result.output["llm_provider"] == "mock"
    assert result.output["llm_model"] == "mock-model"


@pytest.mark.asyncio
async def test_debug_assist_json_with_prose(mock_llm):
    """Debug step extracts JSON even when LLM adds surrounding prose."""
    response = f"Sure! Here is the analysis:\n\n{VALID_DEBUG_JSON}\n\nLet me know if you need more."
    mock_llm.generate.return_value = MockLLMResponse(text=response)

    result = await run_debug_assist_step(
        rtl_code="module m; endmodule",
        testbench_code="",
        sim_stdout="",
        sim_stderr="",
        llm=mock_llm,
    )

    assert result.status == StepStatus.PASSED
    assert result.output["error_type"] == "compilation"


@pytest.mark.asyncio
async def test_debug_assist_malformed_json(mock_llm):
    """Debug step falls back to summary when JSON is malformed."""
    mock_llm.generate.return_value = MockLLMResponse(
        text="{ error_type: compilation, missing quotes }"
    )

    result = await run_debug_assist_step(
        rtl_code="module m; endmodule",
        testbench_code="",
        sim_stdout="",
        sim_stderr="",
        llm=mock_llm,
    )

    assert result.status == StepStatus.PASSED
    assert result.output["summary"] != ""
    # Fallback: error_type defaults to "unknown" when JSON is broken
    assert result.output["error_type"] == "unknown"


@pytest.mark.asyncio
async def test_debug_assist_no_json(mock_llm):
    """Debug step handles plain-text response."""
    mock_llm.generate.return_value = MockLLMResponse(
        text="This looks like a missing semicolon error."
    )

    result = await run_debug_assist_step(
        rtl_code="module m; endmodule",
        testbench_code="",
        sim_stdout="",
        sim_stderr="",
        llm=mock_llm,
    )

    assert result.status == StepStatus.PASSED
    assert "semicolon" in result.output["summary"].lower()


@pytest.mark.asyncio
async def test_debug_assist_llm_exception(mock_llm):
    """Debug step returns ERROR status when LLM call fails."""
    mock_llm.generate.side_effect = Exception("LLM timeout")

    result = await run_debug_assist_step(
        rtl_code="module m; endmodule",
        testbench_code="",
        sim_stdout="",
        sim_stderr="",
        llm=mock_llm,
    )

    assert result.status == StepStatus.ERROR
    assert "LLM timeout" in result.errors[0]


@pytest.mark.asyncio
async def test_debug_assist_truncates_long_inputs(mock_llm):
    """Debug step truncates long inputs to prevent token overflow."""
    mock_llm.generate.return_value = MockLLMResponse(text=VALID_DEBUG_JSON)

    long_rtl = "// comment\n" * 1000  # ~11000 chars
    long_tb = "int x;\n" * 1000

    result = await run_debug_assist_step(
        rtl_code=long_rtl,
        testbench_code=long_tb,
        sim_stdout="x" * 5000,
        sim_stderr="y" * 5000,
        llm=mock_llm,
    )

    # Verify prompt was truncated — check generate was called with bounded prompt
    assert result.status == StepStatus.PASSED
    call_args = mock_llm.generate.call_args
    prompt = call_args[0][0]
    # Prompt contains truncated sections (3000 + 3000 + 2000 + 2000 + template overhead)
    assert len(prompt) < 15000


@pytest.mark.asyncio
async def test_debug_assist_missing_fields(mock_llm):
    """Debug step handles JSON with missing optional fields."""
    minimal_json = '{"summary": "something broke"}'
    mock_llm.generate.return_value = MockLLMResponse(text=minimal_json)

    result = await run_debug_assist_step(
        rtl_code="module m; endmodule",
        testbench_code="",
        sim_stdout="",
        sim_stderr="",
        llm=mock_llm,
    )

    assert result.status == StepStatus.PASSED
    assert result.output["summary"] == "something broke"
    assert result.output["error_type"] == "unknown"
    assert result.output["fix_suggestions"] == []
    assert result.output["learning_point"] == ""
