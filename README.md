# XylonStudio

Open source chip verification pipeline. Learn. Verify. Tape Out.

🌐 **[xylonstud.io](https://xylonstud.io)** | 📖 **[繁體中文](README.zh-TW.md)**

---

## Demo

https://github.com/user-attachments/assets/b3598b06-df5a-4c50-8fd3-f27e0ca183e0

---

## Overview

XylonStudio is an AI-assisted chip verification platform. Auto-generate test plans, testbenches, and coverage reports from your RTL. Open source, pluggable LLM, education-first.

**Key Features:**
- AI-generated verification test plans from RTL analysis
- C++ Verilator testbench generation with coverage support
- Coverage-driven iteration loop (auto-improve until target met)
- Real Verilator simulation in Docker containers
- Yosys synthesis reports (gate count, cell breakdown)
- AI Debug Assistant explains simulation failures in plain language
- Pluggable LLM (Ollama, vLLM — bring your own model)
- CLI for scripting and CI integration (`python -m agent.cli run ...`)
- Pipeline visualization with real-time WebSocket streaming

---

## Architecture

```
RTL Code
    ↓
Lint (Verilator)
    ↓
Test Plan Generation (LLM)
    ↓
Testbench Generation (LLM)
    ↓
┌─── Simulation (Verilator) ◄──┐
│        ↓                      │
│   PASS? ── No ── Debug Assistant (LLM)
│        │                      │
│       Yes                     │
│        ↓                      │
│   Coverage Analysis           │
│        ↓                      │
│   Target met? ── No ── Improve Testbench (LLM)
│        │
│       Yes
│        ↓
├── Coverage Report
    ↓
Synthesis Report (Yosys, optional)
```

---

## Technology Stack

**Backend:**
- Python 3.11+
- FastAPI
- Async pipeline runner with step callbacks

**LLM (bring your own):**
- Ollama (qwen2.5-coder, deepseek-coder, etc.)
- vLLM (self-hosted)
- Any OpenAI-compatible API

**EDA Tools (Docker):**
- Verilator (lint, simulation, coverage)
- Yosys (synthesis)

**Frontend:**
- Next.js 14
- TypeScript
- Tailwind CSS
- WebSocket for real-time pipeline updates

---

## Quick Start

### Prerequisites
- Python 3.11+
- Node.js 20+
- Docker (for Verilator/Yosys containers)
- Ollama or vLLM endpoint (for LLM features)

### Installation

```bash
# Clone repository
git clone https://github.com/kevintseng/xylon-studio.git
cd xylon-studio

# Backend setup
cd agent
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt

# Start API server
uvicorn agent.api.main:app --host 0.0.0.0 --port 5000

# Frontend setup (in another terminal)
cd ../web
npm install
npm run dev
```

### Example: Run Pipeline

**CLI (fastest way to try it):**

```bash
# Lint only
python -m agent.cli run examples/adder/adder_8bit.v

# Phase A: user-provided C++ testbench + synthesis report
python -m agent.cli run examples/adder/adder_8bit.v \
  --testbench examples/adder/tb_adder_8bit.cpp \
  --synthesis

# Phase B: LLM generates test plan + testbench automatically
python -m agent.cli run examples/adder/adder_8bit.v \
  --llm ollama --model qwen2.5-coder:32b \
  --coverage-target 0.8
```

**REST API:**

```bash
# Phase A: Lint + simulate with your own testbench
curl -X POST http://localhost:5000/api/pipeline/run \
  -H "Content-Type: application/json" \
  -d '{
    "rtl_code": "module adder(input [7:0] a, b, output [8:0] sum); assign sum = a + b; endmodule",
    "testbench_code": "...",
    "coverage_target": 0.80,
    "synthesis_enabled": true
  }'

# Phase B: LLM generates test plan + testbench automatically
curl -X POST http://localhost:5000/api/pipeline/run \
  -H "Content-Type: application/json" \
  -d '{
    "rtl_code": "module adder(input [7:0] a, b, output [8:0] sum); assign sum = a + b; endmodule",
    "coverage_target": 0.80,
    "llm_config": {
      "type": "ollama",
      "endpoint": "http://localhost:11434",
      "model": "qwen2.5-coder:32b"
    }
  }'
```

---

## Example Designs

| Design | Type | Tests | Line Cov | Gates (Yosys) |
|--------|------|-------|----------|---------------|
| [8-bit Adder](examples/adder/) | Combinational | 25 | 100% | — |
| [8-bit Counter](examples/counter/) | Sequential | 10 | 100% | — |
| [Traffic Light FSM](examples/fsm/) | FSM | 9 | 79% | — |
| [16-bit Barrel Shifter](examples/barrel_shifter/) | Combinational | 36 | 80% | 237 |
| [RISC-V ALU](examples/risc-v-alu/) | Combinational (RV32I) | 24 | 50% | 1485 |

Each example includes RTL source and a verified C++ Verilator testbench.

---

## Project Structure

```
xylon/
├── agent/                  # Backend (Python/FastAPI)
│   ├── cli.py              # Command-line pipeline runner (python -m agent.cli)
│   ├── core/               # LLM provider abstraction
│   ├── pipeline/           # Pipeline runner + step functions
│   │   └── steps/          # lint, test_plan, testbench_gen, simulate, coverage,
│   │                       # improve, debug_assist, synthesis
│   ├── api/                # REST + WebSocket endpoints
│   ├── sandbox/            # Docker EDA container management
│   └── tests/              # 101 unit + integration tests
├── web/                    # Frontend (Next.js)
│   ├── app/                # Pages: home, design, verify, pipeline, history
│   ├── components/         # UI components
│   └── lib/                # i18n (EN + zh-TW)
├── examples/               # Example RTL designs with testbenches
└── docs/                   # Design documents
```

---

## Development

### Backend

```bash
cd agent
source venv/bin/activate

# Run unit tests (fast, no Docker required)
pytest agent/

# Run integration tests (requires Docker + Verilator/Yosys containers)
pytest agent/ -m integration

# Lint with ruff
ruff check agent/

# Start API server
uvicorn agent.api.main:app --reload --port 5000
```

### Frontend

```bash
cd web
npm install
npm run dev
```

---

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/pipeline/run` | Run verification pipeline (REST) |
| WS | `/api/pipeline/ws` | Run pipeline with real-time step streaming |
| POST | `/api/design/generate` | Generate RTL from description |
| POST | `/api/verification/verify` | Verify RTL with testbench |

---

## License

XylonStudio uses a **dual-licensing model**:

### Open Source Core (MIT License)
The core platform (this repository) is licensed under the **MIT License**:
- ✅ Free to use, modify, and distribute
- ✅ Commercial use allowed
- ✅ Open source with minimal requirements

See [LICENSE](LICENSE) for full terms.

### Proprietary Enterprise Features
Advanced enterprise features are available under a separate commercial license.

---

## Contact

**Email**: hello@xylonstud.io

---

## Contributing

Contributions are welcome! Please see [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

---

**Built with**: Verilator, Yosys, Ollama, FastAPI, Next.js
