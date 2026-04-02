# XylonStudio

AI-driven chip design automation platform.

📖 **[繁體中文](README.zh-TW.md)**

---

## Demo

> **20-second platform walkthrough** — Design Dragon, Verification Dragon, History & Workspace.
>
> Build the demo video locally: `cd demo-video && npm install && npm run render`
>
> See [demo-video/](demo-video/) for the Remotion source.

---

## Overview

XylonStudio automates chip design workflows using AI agents and open-source EDA tools.

**Key Features:**
- Natural language to RTL generation
- Automated testbench creation
- Timing optimization
- Layout verification

---

## Architecture

```
Natural Language Spec
    ↓
Design Agent (RTL Generation)
    ↓
Verification Agent (Testbench + Coverage)
    ↓
Optimization Agent (Timing Closure)
    ↓
DRC Agent (Layout Verification)
    ↓
GDSII Output
```

---

## Technology Stack

**Backend:**
- Python 3.11+
- FastAPI
- vLLM (LLM inference)
- PostgreSQL, Redis

**LLM:**
- DeepSeek Coder V2 (236B) - open-source base model
- Self-hosted deployment supported

**EDA Tools:**
- Yosys (synthesis)
- Verilator (simulation)
- OpenROAD (place & route)
- Magic (DRC/LVS)

**Frontend:**
- Next.js 16
- TypeScript
- Tailwind CSS

---

## Quick Start

### Prerequisites
- Python 3.11+
- Node.js 20+
- Claude API key or OpenAI API key

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

# Setup environment
cp ../.env.example ../.env
# Edit .env and add your LLM API key

# Start API server
python -m agent.main

# Frontend setup (in another terminal)
cd ../web
npm install
npm run dev
```

### Example Usage

```bash
# Generate RTL
curl -X POST http://localhost:5000/api/generate \
  -H "Content-Type: application/json" \
  -d '{
    "description": "16-bit barrel shifter with pipeline",
    "target_freq": "2 GHz"
  }'
```

---

## Project Structure

```
xylon/
├── agent/              # AI agent service (Python)
│   ├── dragons/        # Agent implementations
│   ├── core/           # LLM gateway, orchestrator
│   ├── api/            # FastAPI routes
│   └── tests/          # Test suite
├── web/                # Web UI (Next.js)
├── scripts/            # Deployment scripts
├── docs/               # Documentation
└── examples/           # Example designs
```

---

## Development

### Backend

```bash
cd agent
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt

# Run tests
pytest agent/tests/

# Start API server
python -m agent.main
```

### Frontend

```bash
cd web
npm install
npm run dev
```

---

## Documentation

- [API Reference](docs/API.md) - API documentation
- [Contributing](CONTRIBUTING.md) - Contribution guidelines
- [Security](SECURITY.md) - Security policy

---

## License

XylonStudio uses a **dual-licensing model**:

### Open Source Core (MIT License)
The core platform (this repository) is licensed under the **MIT License**:
- ✅ Free to use, modify, and distribute
- ✅ Commercial use allowed
- ✅ No restrictions on enterprise or hosted services
- ✅ Open source with minimal requirements

See [LICENSE](LICENSE) for full terms.

### Proprietary Enterprise Features
Advanced enterprise features are available under a separate commercial license:
- Advanced optimization algorithms
- Enterprise-grade security features
- Multi-tenant architecture
- Priority support and SLA

---

## Contact

**Email**: hello@xylonstud.io

---

## Contributing

Contributions are welcome! Please see [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

---

**Built with**: OpenROAD, DeepSeek Coder, vLLM, Verilator
