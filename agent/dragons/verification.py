# Copyright (c) 2026 XylonStudio
# Licensed under the MIT License
# See LICENSE in the project root for license information

"""
Verification Dragon - Test generation and verification agent.

Generates complete testbenches from RTL code and executes verification.

Process:
1. Analyze RTL to extract module interface (inputs/outputs)
2. Generate SystemVerilog testbench using LLM
3. Create test vectors for basic functionality + corner cases
4. Run Verilator simulation
5. Collect coverage metrics
6. Return TestReport with pass/fail status

Example:
    rtl = RTLCode(...)  # From Design Dragon

    dragon = VerificationDragon(llm_endpoint="http://localhost:8000")
    report = dragon.verify(rtl)

    print(f"Tests: {report.test_cases_passed}/{report.test_cases_passed + report.test_cases_failed}")
    print(f"Coverage: {report.code_coverage * 100:.1f}%")
"""

import logging
import os
import re
import tempfile
from datetime import datetime
from typing import Any

from agent.core.llm_gateway import LLMGateway, LLMProvider, VLLMBackend
from agent.dragons import Dragon, DragonError, DragonMetrics
from agent.models import RTLCode, TestReport
from agent.sandbox import SandboxManager

logger = logging.getLogger(__name__)


class VerificationDragonError(DragonError):
    """Specific errors for Verification Dragon."""
    pass


class VerificationDragon(Dragon[RTLCode, TestReport]):
    """
    Verification Dragon generates testbenches and verifies RTL functionality.

    Responsibilities:
    - Analyze RTL module interface
    - Generate comprehensive testbench
    - Create test vectors (directed + random)
    - Run simulation with Verilator
    - Collect coverage metrics
    - Produce verification report

    NOT responsible for:
    - Formal verification (separate tool)
    - Timing analysis (Optimization Dragon's job)
    - Power analysis (Optimization Dragon's job)
    """

    def __init__(self, llm_endpoint: str):
        """
        Initialize Verification Dragon.

        Args:
            llm_endpoint: LLM API endpoint for testbench generation
        """
        super().__init__(llm_endpoint)

        # LLM gateway for testbench generation
        vllm_base_url = llm_endpoint if llm_endpoint.endswith('/v1') else f"{llm_endpoint}/v1"
        llm_model = os.getenv('VLLM_MODEL') or os.getenv('LLM_MODEL', 'Qwen/Qwen2.5-Coder-32B-Instruct')
        self.llm_gateway = LLMGateway(
            primary_provider=LLMProvider.VLLM,
            backends={
                LLMProvider.VLLM: VLLMBackend(base_url=vllm_base_url, model=llm_model)
            }
        )

        # Sandbox for Verilator simulation
        self.sandbox = SandboxManager()

        # Metrics tracking
        self._start_time: datetime | None = None
        self._end_time: datetime | None = None
        self._llm_calls = 0
        self._llm_tokens = 0
        self._success = False
        self._quality_score = 0.0

    def process(self, input_data: RTLCode) -> TestReport:
        """
        Main processing: generate testbench and verify RTL.

        This is an alias for verify() to satisfy Dragon interface.

        Args:
            input_data: RTL code to verify

        Returns:
            TestReport with verification results

        Raises:
            VerificationDragonError: If verification fails
        """
        return self.verify(input_data)

    def verify(self, rtl: RTLCode) -> TestReport:
        """
        Generate testbench and verify RTL code.

        Process:
        1. Parse RTL module interface
        2. Generate testbench with LLM
        3. Run Verilator simulation
        4. Analyze results
        5. Return verification report

        Args:
            rtl: RTL code from Design Dragon

        Returns:
            TestReport with pass/fail status and coverage

        Raises:
            VerificationDragonError: If testbench generation or simulation fails
        """
        self._start_time = datetime.utcnow()

        try:
            # Step 1: Validate input
            self.validate_input(rtl)
            logger.info(f"Starting verification for module: {rtl.module_name}")

            # Step 2: Analyze RTL interface
            module_info = self._analyze_rtl_interface(rtl.code)
            logger.info(f"Analyzed module: {module_info['inputs']} inputs, {module_info['outputs']} outputs")

            # Step 3: Generate testbench
            testbench_code = self._generate_testbench(rtl, module_info)
            logger.info(f"Generated testbench: {len(testbench_code)} chars")

            # Step 4: Save files
            rtl_file, tb_file = self._save_verification_files(rtl, testbench_code)

            # Step 5: Run simulation
            sim_result = self._run_simulation(rtl_file, tb_file)

            # Step 6: Analyze results
            report = self._create_test_report(
                tb_file=tb_file,
                sim_result=sim_result,
                module_info=module_info
            )

            # Record success metrics
            self._end_time = datetime.utcnow()
            self._success = True
            self._quality_score = self._calculate_quality_score(report)

            logger.info(
                f"Verification complete: {report.test_cases_passed} passed, "
                f"{report.test_cases_failed} failed, "
                f"coverage: {report.code_coverage * 100:.1f}%"
            )

            return report

        except Exception as e:
            self._end_time = datetime.utcnow()
            self._success = False
            logger.error(f"Verification failed: {e}")
            raise VerificationDragonError(f"Verification failed: {e}") from e

    def validate_input(self, input_data: RTLCode) -> bool:
        """
        Validate RTL code before verification.

        Checks:
        - RTL code is not empty
        - Module name is valid
        - File path exists

        Args:
            input_data: RTL code to validate

        Returns:
            True if valid

        Raises:
            VerificationDragonError: If validation fails
        """
        if not input_data.code or len(input_data.code.strip()) == 0:
            raise VerificationDragonError("RTL code is empty")

        if not input_data.module_name or len(input_data.module_name.strip()) == 0:
            raise VerificationDragonError("Module name is missing")

        # Check module declaration exists
        if f"module {input_data.module_name}" not in input_data.code:
            raise VerificationDragonError(
                f"Module declaration 'module {input_data.module_name}' not found in RTL"
            )

        return True

    def get_metrics(self) -> DragonMetrics:
        """
        Return performance metrics for last verification.

        Returns:
            DragonMetrics instance

        Raises:
            VerificationDragonError: If no verification has occurred
        """
        if self._start_time is None or self._end_time is None:
            raise VerificationDragonError("No verification has been performed yet")

        duration = (self._end_time - self._start_time).total_seconds()

        return DragonMetrics(
            start_time=self._start_time,
            end_time=self._end_time,
            duration_seconds=duration,
            llm_calls=self._llm_calls,
            llm_total_tokens=self._llm_tokens,
            success=self._success,
            quality_score=self._quality_score
        )

    # ==================== Internal Methods ====================

    def _analyze_rtl_interface(self, rtl_code: str) -> dict[str, Any]:
        """
        Extract module interface from RTL code.

        Parses:
        - Module name
        - Input ports (names, widths)
        - Output ports (names, widths)
        - Parameters

        Args:
            rtl_code: Verilog source code

        Returns:
            Dictionary with module interface information
        """
        module_info = {
            'inputs': 0,
            'outputs': 0,
            'input_ports': [],
            'output_ports': [],
            'parameters': []
        }

        # Extract input ports
        input_pattern = r'input\s+(?:wire\s+)?(?:\[([0-9:]+)\]\s+)?(\w+)'
        for match in re.finditer(input_pattern, rtl_code):
            width = match.group(1) if match.group(1) else '0:0'
            port_name = match.group(2)
            module_info['input_ports'].append({'name': port_name, 'width': width})
            module_info['inputs'] += 1

        # Extract output ports
        output_pattern = r'output\s+(?:reg\s+|wire\s+)?(?:\[([0-9:]+)\]\s+)?(\w+)'
        for match in re.finditer(output_pattern, rtl_code):
            width = match.group(1) if match.group(1) else '0:0'
            port_name = match.group(2)
            module_info['output_ports'].append({'name': port_name, 'width': width})
            module_info['outputs'] += 1

        return module_info

    def _generate_testbench(self, rtl: RTLCode, module_info: dict) -> str:
        """
        Generate testbench using LLM.

        Args:
            rtl: RTL code
            module_info: Parsed module interface

        Returns:
            SystemVerilog testbench code
        """
        # Build prompt for LLM
        prompt = self._build_testbench_prompt(rtl, module_info)

        # Call LLM
        self._llm_calls += 1
        response = self.llm_gateway.generate(
            prompt=prompt,
            max_tokens=3000,
            temperature=0.3  # Low temperature for deterministic testbenches
        )
        self._llm_tokens += response.input_tokens + response.output_tokens

        testbench_code = response.text

        # Clean up LLM output (remove markdown code blocks if present)
        testbench_code = self._clean_llm_output(testbench_code)

        return testbench_code

    def _build_testbench_prompt(self, rtl: RTLCode, module_info: dict) -> str:
        """
        Build LLM prompt for testbench generation.

        Args:
            rtl: RTL code
            module_info: Module interface

        Returns:
            Prompt string
        """
        inputs_desc = "\n".join([
            f"  - {port['name']} [{port['width']}]"
            for port in module_info['input_ports']
        ])
        outputs_desc = "\n".join([
            f"  - {port['name']} [{port['width']}]"
            for port in module_info['output_ports']
        ])

        prompt = f"""Generate a comprehensive SystemVerilog testbench for the following Verilog module.

Module: {rtl.module_name}

Inputs:
{inputs_desc}

Outputs:
{outputs_desc}

RTL Code:
```verilog
{rtl.code}
```

Requirements:
1. Create a testbench module named `tb_{rtl.module_name}`
2. Instantiate the DUT (Device Under Test)
3. Generate clock if module has clock input
4. Test basic functionality with directed test vectors
5. Test corner cases (min values, max values, boundary conditions)
6. Include assertions to check expected behavior
7. Print "TEST PASSED" or "TEST FAILED" for each test case
8. Generate VCD waveform file for debugging

Output ONLY the SystemVerilog testbench code, no explanations.
"""

        # Disable thinking mode for models that support it (e.g., Qwen 3.5)
        if os.getenv('LLM_NO_THINK', '').lower() in ('1', 'true', 'yes'):
            prompt += "\n/no_think"
        return prompt

    def _clean_llm_output(self, code: str) -> str:
        """
        Clean LLM-generated code (remove markdown, extra text).

        Args:
            code: Raw LLM output

        Returns:
            Cleaned SystemVerilog code
        """
        # Remove markdown code blocks
        code = re.sub(r'```systemverilog\n', '', code)
        code = re.sub(r'```verilog\n', '', code)
        code = re.sub(r'```\n?', '', code)

        # Remove leading/trailing whitespace
        code = code.strip()

        return code

    def _save_verification_files(self, rtl: RTLCode, testbench: str) -> tuple[str, str]:
        """
        Save RTL and testbench to temporary files.

        Args:
            rtl: RTL code
            testbench: Testbench code

        Returns:
            Tuple of (rtl_file_path, testbench_file_path)
        """
        # Create temp directory
        temp_dir = tempfile.mkdtemp(prefix='xylon_verify_')

        # Save RTL
        rtl_file = os.path.join(temp_dir, f"{rtl.module_name}.v")
        with open(rtl_file, 'w') as f:
            f.write(rtl.code)

        # Save testbench
        tb_file = os.path.join(temp_dir, f"tb_{rtl.module_name}.sv")
        with open(tb_file, 'w') as f:
            f.write(testbench)

        logger.info(f"Saved verification files to: {temp_dir}")

        return rtl_file, tb_file

    def _run_simulation(self, rtl_file: str, tb_file: str) -> dict:
        """
        Run Verilator simulation.

        Args:
            rtl_file: Path to RTL file
            tb_file: Path to testbench file

        Returns:
            Simulation result dictionary
        """
        try:
            result = self.sandbox.run_verilator_sim(
                rtl_file=rtl_file,
                tb_file=tb_file,
                timeout=30
            )
            return result

        except Exception as e:
            logger.error(f"Simulation failed: {e}")
            raise VerificationDragonError(f"Simulation failed: {e}") from e

    def _create_test_report(
        self,
        tb_file: str,
        sim_result: dict,
        module_info: dict
    ) -> TestReport:
        """
        Create TestReport from simulation results.

        Args:
            tb_file: Testbench file path
            sim_result: Simulation output
            module_info: Module interface info

        Returns:
            TestReport instance
        """
        # Parse simulation output for pass/fail
        passed, failed, errors = self._parse_simulation_output(sim_result.get('stdout', ''))

        # Calculate coverage (stub for now, real coverage needs Verilator --coverage)
        coverage = self._estimate_coverage(passed, failed, module_info)

        # Look for VCD file
        vcd_file = sim_result.get('vcd_file')

        return TestReport(
            testbench_file_path=tb_file,
            test_cases_passed=passed,
            test_cases_failed=failed,
            code_coverage=coverage,
            waveform_file_path=vcd_file,
            errors=errors
        )

    def _parse_simulation_output(self, output: str) -> tuple[int, int, list[str]]:
        """
        Parse simulation output for test results.

        Args:
            output: Simulation stdout

        Returns:
            Tuple of (passed_count, failed_count, error_messages)
        """
        passed = len(re.findall(r'TEST PASSED', output, re.IGNORECASE))
        failed = len(re.findall(r'TEST FAILED', output, re.IGNORECASE))

        # Extract error messages
        errors = []
        for line in output.split('\n'):
            if 'error' in line.lower() or 'fail' in line.lower():
                errors.append(line.strip())

        return passed, failed, errors

    def _estimate_coverage(self, passed: int, failed: int, module_info: dict) -> float:
        """
        Estimate code coverage (basic heuristic).

        Real coverage requires Verilator --coverage flag.
        This is a placeholder that estimates based on test results.

        Args:
            passed: Number of passed tests
            failed: Number of failed tests
            module_info: Module interface

        Returns:
            Coverage percentage (0.0-1.0)
        """
        total_tests = passed + failed
        if total_tests == 0:
            return 0.0

        # Rough heuristic: assume each test covers some percentage
        # Real implementation needs proper coverage analysis
        base_coverage = 0.3  # Baseline
        test_contribution = (passed / max(total_tests, 1)) * 0.6

        return min(base_coverage + test_contribution, 1.0)

    def _calculate_quality_score(self, report: TestReport) -> float:
        """
        Calculate quality score based on verification results.

        Args:
            report: TestReport

        Returns:
            Quality score (0.0-1.0)
        """
        total_tests = report.test_cases_passed + report.test_cases_failed
        if total_tests == 0:
            return 0.0

        # Pass rate weight: 70%
        pass_rate = report.test_cases_passed / total_tests

        # Coverage weight: 30%
        coverage = report.code_coverage

        quality = (pass_rate * 0.7) + (coverage * 0.3)

        return round(quality, 2)
