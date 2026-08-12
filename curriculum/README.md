# XylonStudio Verification Curriculum

A 3-lab sequence teaching chip verification methodology using XylonStudio.

## Target Audience

- **University students** — CS/EE undergraduates learning digital design
- **Bootcamp learners** — career switchers entering chip verification
- **Junior DV engineers** — first 1-2 years on the job

## Prerequisites

- Basic Verilog (modules, always blocks, assign, reg/wire)
- Familiarity with digital logic (combinational vs sequential)
- Command line basics
- XylonStudio installed (Verilator + Docker or equivalent)

## Lab Sequence

| Lab | Topic | Difficulty | Time |
|-----|-------|-----------|------|
| [Lab 1](lab1-adder/) | Combinational verification (adder) | Beginner | 2 hours |
| [Lab 2](lab2-counter/) | Sequential verification (counter with reset) | Intermediate | 3 hours |
| [Lab 3](lab3-fsm/) | State machine verification (traffic light) | Intermediate | 3 hours |

## Learning Objectives

By the end of this curriculum, students will be able to:

1. **Write test plans** — identify scenarios, edge cases, coverage targets
2. **Write Verilator testbenches** — in C++, with proper clock/reset handling
3. **Interpret coverage reports** — line, toggle, branch coverage
4. **Iterate on coverage gaps** — add tests to hit uncovered paths
5. **Read synthesis reports** — gate count, cell breakdown

## How to Use This Curriculum

### For Students

Each lab has:
- `README.md` — problem statement, learning objectives, grading criteria
- `dut.v` — the RTL module under test (provided)
- `starter/tb.cpp` — minimal testbench template (fill in the blanks)
- `solution/tb.cpp` — reference solution (view after submitting)

Run the pipeline:
```bash
python -m agent.cli run dut.v -t starter/tb.cpp --synthesis
```

### For Educators

- Each lab estimates 2-3 hours of student work
- Grading rubric included (coverage %, test quality, code style)
- Solutions provided but encourage students to submit starter work first
- Can be adapted for individual assignment or lab section

## License

MIT — free to use and modify for educational purposes.
