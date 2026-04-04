# Contributing to XylonStudio

**Welcome, Dragon Tamer!** 🐉

We're excited you want to contribute to XylonStudio. This guide will help you get started.

---

## 📜 License Agreement

By contributing to XylonStudio, you agree that:

1. **Your contributions will be licensed under the MIT License** (same as the project)
2. **You have the right to contribute** (you own the code or have permission)

**No CLA required** - by submitting a PR, you accept these terms.

---

## 🚀 Quick Start

### 1. Fork & Clone

```bash
# Fork on GitHub, then:
git clone https://github.com/YOUR-USERNAME/xylonstudio
cd xylonstudio
```

### 2. Set Up Development Environment

**Backend (Python)**:
```bash
cd agent
python3 -m venv venv
source venv/bin/activate
pip install -e ".[test]"
pytest  # Verify setup
```

**Frontend (Next.js)**:
```bash
cd web
npm install
npm run dev  # Verify setup
```

### 3. Create a Branch

```bash
git checkout -b feature/your-feature-name
# or
git checkout -b fix/bug-description
```

### 4. Make Changes

- **Read existing code first** (understand patterns)
- **Write tests** (TDD encouraged)
- **Follow code standards** (see CLAUDE.md)
- **Run tests locally** before pushing

### 5. Commit & Push

```bash
git add .
git commit -m "feat(dragons): add new optimization dragon"
git push origin feature/your-feature-name
```

**⚠️ IMPORTANT**: Do NOT add "Co-Authored-By: AI" or similar attribution. See [Commit Guidelines](#commit-guidelines) below.

### 6. Open Pull Request

- Reference related issues (e.g., "Fixes #42")
- Describe what you changed and why
- Include test results
- Wait for review

---

## 🎯 What to Contribute

### 🌟 High-Priority Areas

1. **Dragon Improvements**
   - [ ] Better RTL quality (Design Dragon)
   - [ ] Formal verification support (Verification Dragon)
   - [ ] Power/area optimization (Optimization Dragon)
   - [ ] Security checks (Guardian Dragon)

2. **EDA Tool Integration**
   - [ ] Support more PDKs (TSMC, Intel, Samsung)
   - [ ] Yosys optimization passes
   - [ ] OpenROAD parameter tuning
   - [ ] Magic DRC rule customization

3. **Web UI/UX**
   - [ ] Real-time progress visualization
   - [ ] Interactive Verilog editor
   - [ ] Waveform viewer integration
   - [ ] Dark mode support

4. **Documentation**
   - [ ] Tutorial videos
   - [ ] Example designs (RISC-V, DSP, etc.)
   - [ ] API documentation
   - [ ] Troubleshooting guides

5. **Testing**
   - [ ] More test cases (edge cases)
   - [ ] Performance benchmarks
   - [ ] E2E integration tests
   - [ ] Continuous fuzzing

### 💡 Good First Issues

Check [GitHub Issues labeled "good first issue"](https://github.com/kevintseng/xylon-studio/labels/good%20first%20issue) for beginner-friendly tasks.

---

## 📏 Code Standards

### Python (Backend)

**Required**:
- ✅ Type hints (mypy strict mode)
- ✅ Google-style docstrings
- ✅ Pytest tests (min 80% coverage)
- ✅ Ruff formatting
- ✅ Line length: 100 chars

**Example**:
```python
from typing import Optional
from pydantic import BaseModel


class RTLCode(BaseModel):
    """Generated Verilog RTL code."""
    
    code: str
    module_name: str
    quality_score: float
    
    def validate_syntax(self) -> bool:
        """
        Validate Verilog syntax using Verilator.
        
        Returns:
            True if syntax is valid, False otherwise.
        """
        # Implementation...
        pass
```

**Before committing**:
```bash
# Run linter and type checker
ruff check agent/
mypy agent/
```

### TypeScript (Frontend)

**Required**:
- ✅ Strict TypeScript (no `any`)
- ✅ Functional components + hooks
- ✅ Tailwind CSS (no inline styles)
- ✅ ESLint + Prettier
- ✅ Jest + React Testing Library

**Example**:
```typescript
interface DragonStatus {
  name: string;
  status: 'idle' | 'running' | 'error';
  progress: number;
}

export function DragonDashboard() {
  const [dragons, setDragons] = useState<DragonStatus[]>([]);
  
  useEffect(() => {
    fetchDragonStatus().then(setDragons);
  }, []);
  
  return (
    <div className="grid grid-cols-2 gap-4">
      {dragons.map(dragon => (
        <DragonCard key={dragon.name} dragon={dragon} />
      ))}
    </div>
  );
}
```

**Before committing**:
```bash
npm run lint
npm run type-check
```

---

## 🧪 Testing Requirements

### Python

**Unit tests** (fast, isolated):
```python
def test_design_dragon_generates_adder():
    dragon = DesignDragon(mock_llm)
    spec = DesignSpec(description="8-bit adder")
    rtl = dragon.breathe_rtl(spec)
    assert "module adder_8bit" in rtl.code
```

**Integration tests** (use real tools):
```python
@pytest.mark.slow
def test_full_synthesis_flow():
    rtl = generate_rtl("barrel shifter")
    synth_result = yosys_synthesize(rtl)
    assert synth_result.area < 10000  # um²
```

**Coverage requirement**: ≥ 80%

### TypeScript

**Component tests**:
```typescript
test('DragonCard shows status correctly', () => {
  const dragon = { name: 'Design', status: 'running', progress: 0.5 };
  render(<DragonCard dragon={dragon} />);
  expect(screen.getByText('Design')).toBeInTheDocument();
  expect(screen.getByRole('progressbar')).toHaveValue(50);
});
```

---

## 💬 Commit Guidelines

### Format

```
<type>(<scope>): <subject>

<body>
```

**Types**:
- `feat`: New feature
- `fix`: Bug fix
- `refactor`: Code refactoring
- `docs`: Documentation
- `test`: Tests
- `perf`: Performance improvement
- `chore`: Maintenance

**Examples**:
```bash
feat(design-dragon): add pipeline optimization
fix(api): handle LLM timeout gracefully
docs(agents): update Design Dragon docstring
test(verification): add coverage edge cases
```

### ⚠️ IMPORTANT: No AI Attribution

**DO NOT** add:
- ❌ "Co-Authored-By: Claude Sonnet 4.5"
- ❌ "Generated by AI"
- ❌ "Assistant: GPT-4"

**Why**: XylonStudio maintains human accountability for all code. AI tools are assistants, not authors.

If you used AI assistance:
- ✅ Review and understand the code
- ✅ Test thoroughly
- ✅ Commit under your name
- ✅ Take responsibility for quality

---

## 🔍 Code Review Process

### What We Look For

1. **Correctness**: Does it work? Are there tests?
2. **Code quality**: Readable, maintainable, follows conventions
3. **Performance**: No obvious bottlenecks
4. **Security**: No vulnerabilities (injection, XSS, etc.)
5. **Documentation**: Clear docstrings, comments where needed

### Review Timeline

- **Simple fixes** (< 50 lines): 1-2 days
- **Features** (< 500 lines): 3-5 days
- **Major changes** (> 500 lines): 1-2 weeks

**Tip**: Smaller PRs get reviewed faster!

### If Changes Requested

- Don't take it personally - we're building quality software together
- Ask questions if unclear
- Make requested changes
- Re-request review

---

## 🤝 Community Guidelines

### Code of Conduct

1. **Be respectful** - No harassment, discrimination, or trolling
2. **Be constructive** - Critique code, not people
3. **Be collaborative** - Help others learn and grow
4. **Be transparent** - Admit mistakes, ask for help when stuck

### Communication Channels

- **GitHub Issues**: Bug reports, feature requests
- **GitHub Discussions**: Questions, ideas, show & tell
- **Discord** (coming soon): Real-time chat
- **Email**: hello@xylonstud.io (for private matters)

---

## 🎁 Recognition

### Contributors Wall

All contributors will be listed in:
- `CONTRIBUTORS.md` (alphabetical)
- Release notes (per release)
- Website (coming soon)

### Swag

Significant contributors receive:
- XylonStudio stickers
- Dragon-themed t-shirts
- Early access to enterprise features

**Significant** = 5+ merged PRs or major feature contribution

---

## 🐛 Reporting Bugs

### Security Vulnerabilities

**DO NOT** open public issues for security bugs!

Email: **hello@xylonstud.io**

We'll respond within 48 hours.

### Regular Bugs

Use [GitHub Issues](https://github.com/kevintseng/xylon-studio/issues/new?template=bug_report.md):

**Include**:
1. **What happened**: Describe the bug
2. **Expected behavior**: What should happen instead
3. **Steps to reproduce**: How to trigger the bug
4. **Environment**: OS, Python/Node version, etc.
5. **Logs**: Error messages, stack traces

**Example**:
```markdown
### What happened
Design Dragon crashes when generating barrel shifter

### Expected behavior
Should generate RTL successfully

### Steps to reproduce
1. Run: `python -m agent.cli design "16-bit barrel shifter"`
2. Observe crash after ~10 seconds

### Environment
- OS: macOS 14.2
- Python: 3.11.7
- XylonStudio: 1.0.0

### Logs
```
Traceback (most recent call last):
  File "agent/dragons/design.py", line 42
    ...
```
```

---

## 💡 Feature Requests

Use [GitHub Issues](https://github.com/kevintseng/xylon-studio/issues/new?template=feature_request.md):

**Include**:
1. **Problem**: What pain point does this solve?
2. **Proposed solution**: How would it work?
3. **Alternatives**: Other ways to solve it?
4. **Use case**: Real-world example

**Example**:
```markdown
### Problem
Designers waste time converting between Verilog and Chisel

### Proposed solution
Add a "Chisel Dragon" that:
- Converts Verilog → Chisel
- Generates Chisel from specs
- Validates Chisel code

### Alternatives
- Use existing verilog2chisel tools (but less integrated)
- Manual conversion (tedious)

### Use case
Research lab wants to use modern Chisel but has legacy Verilog
```

---

## 📚 Resources

### Learning Materials

**Chip Design**:
- [Digital VLSI Design (Rabaey)](http://bwrcs.eecs.berkeley.edu/Classes/icdesign/)
- [OpenROAD Tutorials](https://openroad.readthedocs.io/)

**Verilog**:
- [Verilog Tutorial (ASIC World)](http://www.asic-world.com/verilog/veritut.html)
- [IEEE 1800-2017 Standard](https://ieeexplore.ieee.org/document/8299595)

**Python**:
- [FastAPI Documentation](https://fastapi.tiangolo.com/)
- [Pydantic V2 Guide](https://docs.pydantic.dev/latest/)

**TypeScript/React**:
- [Next.js 16 Docs](https://nextjs.org/docs)
- [shadcn/ui Components](https://ui.shadcn.com/)

### Development Tools

- **Verilator**: `brew install verilator` (macOS)
- **Yosys**: `brew install yosys`
- **Ruff**: `pip install ruff`
- **mypy**: `pip install mypy`

---

## 🎓 Mentorship

### New to Open Source?

We offer mentorship for first-time contributors:

1. Pick a "good first issue"
2. Comment: "I'd like to work on this, can someone mentor me?"
3. A maintainer will guide you through the process

### New to Chip Design?

Check out our [Learning Path](docs/learning-path.md) for beginners.

---

## ❓ FAQ

**Q: Can I contribute if I'm not a chip designer?**
A: Yes! We need help with web UI, docs, testing, and more.

**Q: What if my PR isn't perfect?**
A: That's okay! We'll help you improve it through code review.

**Q: How long until my PR is merged?**
A: Depends on complexity. Simple fixes: days. Major features: weeks.

**Q: Can I be paid to contribute?**
A: We're exploring bounties for specific features. Stay tuned!

**Q: What if I disagree with a review comment?**
A: Explain your reasoning. We're open to discussion.

---

## 🐉 Thank You!

**Every contribution makes XylonStudio stronger.**

Whether you:
- Fix a typo in docs
- Report a bug
- Review someone's PR
- Build a new feature

**You're helping democratize chip design. Thank you!**

---

**Ready to contribute?** Pick an issue and let's build something amazing together!

For questions, open an issue on GitHub or email hello@xylonstud.io
