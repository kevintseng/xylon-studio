# Copyright (c) 2026 XylonStudio
# Licensed under the MIT License
# See LICENSE in the project root for license information

"""
Design Dragon - RTL generation agent.

Generates synthesizable Verilog RTL code from natural language specifications.

Process:
1. Parse specification
2. Generate initial RTL using LLM
3. Lint check with Verilator
4. If lint fails: fix and retry (up to 5 iterations)
5. Return lint-clean RTL

Example:
    spec = DesignSpec(
        description="8-bit ripple carry adder",
        target_freq="100 MHz"
    )

    dragon = DesignDragon(llm_endpoint="http://localhost:8000")
    rtl = dragon.breathe_rtl(spec)

    print(f"Generated {rtl.module_name} with quality {rtl.quality_score}")
"""

import logging
import os
import tempfile
import uuid
from datetime import datetime

from agent.core.llm_gateway import LLMGateway, LLMProvider, VLLMBackend
from agent.dragons import Dragon, DragonError, DragonMetrics
from agent.models import DesignSpec, RTLCode
from agent.sandbox import SandboxManager

logger = logging.getLogger(__name__)


class DesignDragonError(DragonError):
    """Specific errors for Design Dragon."""
    pass


class DesignDragon(Dragon[DesignSpec, RTLCode]):
    """
    Design Dragon generates Verilog RTL from natural language specifications.

    Responsibilities:
    - Parse user specification
    - Generate syntactically correct Verilog
    - Ensure code passes Verilator lint
    - Provide quality metrics

    Limitations:
    - Does NOT guarantee functional correctness (handled by Verification Dragon)
    - Does NOT optimize for area/power (handled by Optimization Dragon)
    - Does NOT check DRC/LVS (handled by Guardian Dragon)
    """

    def __init__(self, llm_endpoint: str, max_iterations: int = 5):
        """
        Initialize Design Dragon.

        Args:
            llm_endpoint: URL of LLM API (e.g., "http://localhost:8000")
            max_iterations: Maximum lint-fix iterations (default: 5)
        """
        super().__init__(llm_endpoint)
        self.max_iterations = max_iterations

        # Initialize LLM Gateway with vLLM/Ollama-compatible backend
        vllm_base_url = llm_endpoint if llm_endpoint.endswith('/v1') else f"{llm_endpoint}/v1"
        llm_model = os.getenv('VLLM_MODEL') or os.getenv('LLM_MODEL', 'Qwen/Qwen2.5-Coder-32B-Instruct')
        self.llm_gateway = LLMGateway(
            primary_provider=LLMProvider.VLLM,
            backends={
                LLMProvider.VLLM: VLLMBackend(base_url=vllm_base_url, model=llm_model)
            }
        )

        self.sandbox_manager = SandboxManager()
        self._current_metrics: DragonMetrics | None = None

    def validate_input(self, input_data: DesignSpec) -> bool:
        """
        Validate design specification.

        Checks:
        - Description is present and reasonable length
        - Target frequency is specified
        - Module name (if provided) is valid Verilog identifier

        Args:
            input_data: Design specification to validate

        Returns:
            True if valid

        Raises:
            DesignDragonError: If validation fails
        """
        # Description must be present
        if not input_data.description or len(input_data.description.strip()) == 0:
            raise DesignDragonError("Design description cannot be empty")

        # Description should not be too short (likely not enough detail)
        if len(input_data.description.strip()) < 10:
            raise DesignDragonError("Design description too short (min 10 characters)")

        # Target frequency must be present
        if not input_data.target_freq:
            raise DesignDragonError("Target frequency not specified")

        # Module name (if provided) must be valid Verilog identifier
        if input_data.module_name:
            if not self._is_valid_verilog_identifier(input_data.module_name):
                raise DesignDragonError(
                    f"Invalid module name '{input_data.module_name}': "
                    "must start with letter/underscore and contain only alphanumerics/underscore"
                )

        return True

    def process(self, input_data: DesignSpec) -> RTLCode:
        """
        Generate RTL from specification.

        This is an alias for breathe_rtl() to satisfy Dragon interface.

        Args:
            input_data: Design specification

        Returns:
            Generated RTL code

        Raises:
            DesignDragonError: If generation fails
        """
        return self.breathe_rtl(input_data)

    def breathe_rtl(self, spec: DesignSpec) -> RTLCode:
        """
        Main entry point for RTL generation.

        Process:
        1. Validate input specification
        2. Generate initial RTL using LLM
        3. Lint check with Verilator
        4. If lint fails: include errors in context and regenerate
        5. Repeat up to max_iterations
        6. Return lint-clean RTL or fail

        Args:
            spec: Design specification

        Returns:
            Generated RTL code with metadata

        Raises:
            DesignDragonError: If cannot generate lint-clean RTL after max_iterations
        """
        start_time = datetime.utcnow()
        llm_calls = 0
        total_tokens = 0

        logger.info(f"🐉 Design Dragon: Starting RTL generation for '{spec.description[:50]}...'")

        # Validate input
        self.validate_input(spec)

        # Context for iterative refinement
        lint_context: list[str] = []

        for iteration in range(1, self.max_iterations + 1):
            logger.info(f"🐉 Iteration {iteration}/{self.max_iterations}")

            # Generate RTL
            rtl_code, tokens = self._generate_rtl_from_spec(spec, iteration, lint_context)
            llm_calls += 1
            total_tokens += tokens

            # Lint check
            lint_result = self._run_verilator_lint(rtl_code)

            if lint_result['passed']:
                # Success!
                logger.info(f"✅ RTL generation succeeded on iteration {iteration}")

                # Build RTLCode object
                rtl_obj = self._finalize_rtl(spec, rtl_code, lint_result['warnings'])

                # Record metrics
                end_time = datetime.utcnow()
                duration_seconds = (end_time - start_time).total_seconds()

                self._current_metrics = DragonMetrics(
                    start_time=start_time,
                    end_time=end_time,
                    duration_seconds=duration_seconds,
                    llm_calls=llm_calls,
                    llm_total_tokens=total_tokens,
                    success=True,
                    quality_score=rtl_obj.quality_score
                )

                return rtl_obj

            # Lint failed - add errors to context for next iteration
            lint_context.append(
                f"Iteration {iteration} lint errors:\n" +
                "\n".join(lint_result['errors'])
            )
            logger.warning(f"⚠️  Lint failed: {len(lint_result['errors'])} errors")

        # Failed after max iterations
        error_msg = f"Failed to generate lint-clean RTL after {self.max_iterations} iterations"
        logger.error(f"❌ {error_msg}")

        end_time = datetime.utcnow()
        duration_seconds = (end_time - start_time).total_seconds()

        self._current_metrics = DragonMetrics(
            start_time=start_time,
            end_time=end_time,
            duration_seconds=duration_seconds,
            llm_calls=llm_calls,
            llm_total_tokens=total_tokens,
            success=False,
            quality_score=0.0
        )

        raise DesignDragonError(error_msg)

    def get_metrics(self) -> DragonMetrics:
        """
        Return performance metrics for last execution.

        Returns:
            DragonMetrics instance

        Raises:
            DesignDragonError: If no execution has occurred yet
        """
        if self._current_metrics is None:
            raise DesignDragonError("No metrics available - Dragon has not been executed yet")

        return self._current_metrics

    # ==================== Private Methods ====================

    def _generate_rtl_from_spec(
        self,
        spec: DesignSpec,
        iteration: int,
        lint_context: list[str]
    ) -> tuple[str, int]:
        """
        Call LLM to generate Verilog RTL.

        Args:
            spec: Design specification
            iteration: Current iteration number
            lint_context: Previous lint errors (if any)

        Returns:
            Tuple of (rtl_code, total_tokens)
        """
        # Build prompt
        prompt = self._build_prompt(spec, iteration, lint_context)

        # Call LLM
        response = self.llm_gateway.generate(
            prompt=prompt,
            max_tokens=4000,
            temperature=0.7 if iteration == 1 else 0.5  # Lower temperature for fixes
        )

        # Extract Verilog code from response
        rtl_code = self._extract_verilog(response.text)

        total_tokens = response.input_tokens + response.output_tokens

        return rtl_code, total_tokens

    def _build_prompt(self, spec: DesignSpec, iteration: int, lint_context: list[str]) -> str:
        """
        Build LLM prompt for RTL generation.

        Prompt Engineering Strategy:
        - Use domain-specific terminology
        - Include coding standards
        - Provide lint errors from previous attempts
        - Request explicit comments for complex logic

        Args:
            spec: Design specification
            iteration: Current iteration
            lint_context: Previous lint errors

        Returns:
            Complete prompt string
        """
        # Base prompt
        prompt_parts = [
            "You are an expert Verilog RTL designer. Generate synthesizable Verilog code.",
            "",
            "**Design Specification:**",
            f"- Description: {spec.description}",
            f"- Target Frequency: {spec.target_freq}",
        ]

        if spec.max_area:
            prompt_parts.append(f"- Max Area: {spec.max_area}")
        if spec.max_power:
            prompt_parts.append(f"- Max Power: {spec.max_power}")
        if spec.module_name:
            prompt_parts.append(f"- Module Name: {spec.module_name}")

        prompt_parts.extend([
            "",
            "**Coding Standards:**",
            "- Use SystemVerilog subset (synthesizable)",
            "- Include explicit clock and reset signals",
            "- Use non-blocking assignments (<=) for sequential logic",
            "- Use blocking assignments (=) for combinational logic",
            "- Add comments for complex logic",
            "- Avoid latches (infer flip-flops or combinational logic)",
            "",
            "**Output Format:**",
            "Return ONLY the Verilog code, enclosed in ```verilog code blocks.",
            "Do not include explanations outside the code block.",
            ""
        ])

        # If this is a retry, include previous lint errors
        if lint_context:
            prompt_parts.extend([
                "**Previous Attempt Issues:**",
                *lint_context,
                "",
                "Please fix these issues in the new generation.",
                ""
            ])

        prompt = "\n".join(prompt_parts)
        # Disable thinking mode for models that support it (e.g., Qwen 3.5)
        if os.getenv('LLM_NO_THINK', '').lower() in ('1', 'true', 'yes'):
            prompt += "\n/no_think"
        return prompt

    def _extract_verilog(self, llm_response: str) -> str:
        """
        Extract Verilog code from LLM response.

        Looks for ```verilog code blocks.

        Args:
            llm_response: Full LLM response text

        Returns:
            Extracted Verilog code

        Raises:
            DesignDragonError: If no code block found
        """
        lines = llm_response.split('\n')
        in_code_block = False
        code_lines = []

        for line in lines:
            stripped = line.strip()

            if stripped.startswith('```verilog') or stripped.startswith('```systemverilog'):
                in_code_block = True
                continue
            elif stripped == '```' and in_code_block:
                in_code_block = False
                continue

            if in_code_block:
                code_lines.append(line)

        if not code_lines:
            raise DesignDragonError("LLM response does not contain Verilog code block")

        return '\n'.join(code_lines)

    def _run_verilator_lint(self, rtl_code: str) -> dict:
        """
        Run Verilator lint to check code quality.

        Uses Sandbox Manager to execute Verilator in isolated Docker container.

        Args:
            rtl_code: Verilog source code

        Returns:
            Dict with keys:
            - passed (bool): Whether lint passed
            - errors (List[str]): Lint errors
            - warnings (List[str]): Lint warnings
        """
        # Extract module name for temp file
        module_name = self._extract_module_name(rtl_code)
        if not module_name:
            # Use UUID to prevent race conditions in concurrent requests
            module_name = f"temp_design_{uuid.uuid4().hex[:8]}"

        # Save to temp file in designs/ directory (Docker volume mount)
        designs_dir = os.path.join(os.getcwd(), 'designs')
        os.makedirs(designs_dir, exist_ok=True)

        temp_file = os.path.join(designs_dir, f"{module_name}.v")

        try:
            with open(temp_file, 'w') as f:
                f.write(rtl_code)

            logger.debug(f"Saved RTL to {temp_file} for linting")

            # Run Verilator lint via Sandbox Manager
            # Path inside container: /designs/{module_name}.v
            container_path = f"/designs/{module_name}.v"
            lint_result = self.sandbox_manager.lint_verilog(container_path)

            # Parse result
            passed = lint_result['success']
            errors = lint_result.get('errors', [])
            warnings = lint_result.get('warnings', [])

            logger.debug(
                f"Verilator lint: passed={passed}, "
                f"{len(errors)} errors, {len(warnings)} warnings"
            )

            return {
                'passed': passed,
                'errors': errors,
                'warnings': warnings
            }

        except Exception as e:
            logger.error(f"Verilator lint failed with exception: {e}")
            # Return error result
            return {
                'passed': False,
                'errors': [f"Lint execution error: {str(e)}"],
                'warnings': []
            }

        finally:
            # Clean up temp file
            try:
                if os.path.exists(temp_file):
                    os.remove(temp_file)
                    logger.debug(f"Cleaned up temp file: {temp_file}")
            except Exception as cleanup_error:
                logger.warning(f"Failed to clean up temp file {temp_file}: {cleanup_error}")

    def _finalize_rtl(self, spec: DesignSpec, rtl_code: str, lint_warnings: list[str]) -> RTLCode:
        """
        Create RTLCode object from generated code.

        Args:
            spec: Original design specification
            rtl_code: Generated Verilog code
            lint_warnings: Warnings from Verilator lint

        Returns:
            RTLCode instance
        """
        # Extract module name
        module_name = self._extract_module_name(rtl_code)
        if not module_name:
            module_name = spec.module_name or "generated_module"

        # Save to temp file
        temp_dir = tempfile.gettempdir()
        file_path = os.path.join(temp_dir, f"{module_name}.v")

        with open(file_path, 'w') as f:
            f.write(rtl_code)

        logger.info(f"💾 Saved RTL to {file_path}")

        # Calculate quality score (simple heuristic for now)
        quality_score = self._calculate_quality_score(rtl_code, lint_warnings)

        return RTLCode(
            module_name=module_name,
            file_path=file_path,
            code=rtl_code,
            lines_of_code=len(rtl_code.split('\n')),
            quality_score=quality_score,
            lint_warnings=lint_warnings
        )

    def _extract_module_name(self, rtl_code: str) -> str | None:
        """
        Extract module name from Verilog code.

        Args:
            rtl_code: Verilog source code

        Returns:
            Module name or None if not found
        """
        lines = rtl_code.split('\n')
        for line in lines:
            stripped = line.strip()
            if stripped.startswith('module '):
                # Extract module name (between 'module ' and first space/parenthesis)
                parts = stripped.split()
                if len(parts) >= 2:
                    module_name = parts[1].split('(')[0].strip(';')
                    return module_name
        return None

    def _calculate_quality_score(self, rtl_code: str, lint_warnings: list[str]) -> float:
        """
        Calculate quality score for generated RTL.

        Heuristic factors:
        - Fewer lint warnings = higher score
        - Presence of comments = higher score
        - Reasonable code structure = higher score

        Args:
            rtl_code: Verilog source code
            lint_warnings: Lint warnings

        Returns:
            Quality score (0.0-1.0)
        """
        score = 1.0

        # Penalize lint warnings
        score -= len(lint_warnings) * 0.05

        # Reward for comments
        comment_lines = [line for line in rtl_code.split('\n') if '//' in line or '/*' in line]
        comment_ratio = len(comment_lines) / len(rtl_code.split('\n'))
        if comment_ratio > 0.1:  # At least 10% comments
            score += 0.1

        # Penalize very short code (likely incomplete)
        if len(rtl_code.split('\n')) < 20:
            score -= 0.2

        # Clamp to [0, 1]
        return max(0.0, min(1.0, score))

    @staticmethod
    def _is_valid_verilog_identifier(name: str) -> bool:
        """
        Check if name is a valid Verilog identifier.

        Args:
            name: Identifier to check

        Returns:
            True if valid
        """
        if not name:
            return False

        # Must start with letter or underscore
        if not (name[0].isalpha() or name[0] == '_'):
            return False

        # Rest must be alphanumeric or underscore
        for char in name[1:]:
            if not (char.isalnum() or char == '_'):
                return False

        return True
