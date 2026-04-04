"""Unit tests for pipeline steps."""

from unittest.mock import MagicMock

import pytest

from agent.pipeline.models import StepStatus
from agent.pipeline.steps.coverage import run_coverage_step
from agent.pipeline.steps.lint import run_lint_step
from agent.pipeline.steps.simulate import run_simulate_step


@pytest.fixture
def mock_sandbox():
    """Create mock SandboxManager."""
    return MagicMock()


@pytest.fixture
def rtl_file(tmp_path):
    """Real temp RTL file."""
    f = tmp_path / "design.v"
    f.write_text("module design; endmodule\n")
    return str(f)


@pytest.fixture
def tb_file(tmp_path):
    """Real temp testbench file."""
    f = tmp_path / "tb.sv"
    f.write_text("module tb; endmodule\n")
    return str(f)


@pytest.mark.asyncio
async def test_lint_step_pass(mock_sandbox, rtl_file):
    """Test lint step with successful lint."""
    mock_sandbox.lint_verilog_string.return_value = {
        'success': True,
        'warnings': ['warning 1'],
        'errors': [],
        'stdout': 'Lint passed',
        'stderr': '',
        'duration_seconds': 2.5,
    }

    result = await run_lint_step(rtl_file, mock_sandbox)

    assert result.step_name == 'lint'
    assert result.status == StepStatus.PASSED
    assert len(result.warnings) == 1
    assert len(result.errors) == 0
    assert result.duration_seconds == 2.5


@pytest.mark.asyncio
async def test_lint_step_fail(mock_sandbox, rtl_file):
    """Test lint step with lint errors."""
    mock_sandbox.lint_verilog_string.return_value = {
        'success': False,
        'warnings': [],
        'errors': ['Syntax error at line 42'],
        'stdout': '',
        'stderr': 'Syntax error at line 42',
        'duration_seconds': 1.2,
    }

    result = await run_lint_step(rtl_file, mock_sandbox)

    assert result.step_name == 'lint'
    assert result.status == StepStatus.FAILED
    assert len(result.errors) == 1


@pytest.mark.asyncio
async def test_lint_step_error(mock_sandbox, rtl_file):
    """Test lint step with exception."""
    mock_sandbox.lint_verilog_string.side_effect = RuntimeError('Container failed')

    result = await run_lint_step(rtl_file, mock_sandbox)

    assert result.step_name == 'lint'
    assert result.status == StepStatus.ERROR
    assert len(result.errors) == 1


@pytest.mark.asyncio
async def test_simulate_step_pass(mock_sandbox, rtl_file, tb_file):
    """Test simulation step with passing test."""
    mock_sandbox.run_verilator_sim_string.return_value = {
        'success': True,
        'stdout': 'PASS',
        'stderr': '',
        'vcd_file': '/tmp/sim.vcd',
        'coverage_data': None,
        'duration_seconds': 5.0,
    }

    result = await run_simulate_step(rtl_file, tb_file, mock_sandbox)

    assert result.step_name == 'simulate'
    assert result.status == StepStatus.PASSED
    assert result.output['test_passed'] is True


@pytest.mark.asyncio
async def test_simulate_step_fail(mock_sandbox, rtl_file, tb_file):
    """Test simulation step with failing test."""
    mock_sandbox.run_verilator_sim_string.return_value = {
        'success': True,
        'stdout': 'FAIL: Assertion failed at cycle 100',
        'stderr': '',
        'vcd_file': '/tmp/sim.vcd',
        'coverage_data': None,
        'duration_seconds': 8.0,
    }

    result = await run_simulate_step(rtl_file, tb_file, mock_sandbox)

    assert result.step_name == 'simulate'
    assert result.status == StepStatus.FAILED


@pytest.mark.asyncio
async def test_coverage_step_success(mock_sandbox, rtl_file, tb_file):
    """Test coverage step with successful simulation and coverage."""
    mock_sandbox.run_verilator_sim_string.return_value = {
        'success': True,
        'stdout': 'Test completed',
        'stderr': '',
        'vcd_file': None,
        'coverage_data': {
            'raw_report': 'Total coverage (80/100) 80.00%',
            'summary': 'Coverage report',
            'success': True,
        },
        'duration_seconds': 12.0,
    }

    step_result, coverage_report = await run_coverage_step(rtl_file, tb_file, mock_sandbox)

    assert step_result.step_name == 'coverage'
    assert step_result.status == StepStatus.PASSED
    assert abs(coverage_report.line_coverage - 0.80) < 0.01
    # Score uses weighted average from CoverageReport.DEFAULT_WEIGHTS (0.4/0.3/0.3)
    # 0.80 * (0.4 + 0.3 + 0.3) = 0.80
    assert abs(coverage_report.score - 0.80) < 0.01


@pytest.mark.asyncio
async def test_coverage_step_sim_failed(mock_sandbox, rtl_file, tb_file):
    """Test coverage step when simulation fails."""
    mock_sandbox.run_verilator_sim_string.return_value = {
        'success': False,
        'stdout': '',
        'stderr': 'Simulation error',
        'vcd_file': None,
        'coverage_data': None,
        'duration_seconds': 3.0,
    }

    step_result, coverage_report = await run_coverage_step(rtl_file, tb_file, mock_sandbox)

    assert step_result.step_name == 'coverage'
    assert step_result.status == StepStatus.FAILED
    assert coverage_report.score == 0.0
