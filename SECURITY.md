# Security Policy

## Supported Versions

We release security updates for the following versions:

| Version | Supported          |
| ------- | ------------------ |
| 1.0.x   | :white_check_mark: |
| < 1.0   | :x:                |

---

## Reporting a Vulnerability

**We take security seriously.** If you discover a security vulnerability in XylonStudio, please report it responsibly.

### Where to Report

**Email**: hello@xylonstud.io

**DO NOT** open a public GitHub issue for security vulnerabilities.

### What to Include

Please provide:

1. **Description**: What is the vulnerability?
2. **Impact**: What could an attacker do?
3. **Steps to reproduce**: How to trigger the vulnerability
4. **Affected versions**: Which versions are vulnerable
5. **Suggested fix** (optional): How might we fix it

**Example**:
```
Subject: SQL Injection in API endpoint

Description: The /api/design endpoint is vulnerable to SQL injection
Impact: Attacker could read/modify database
Steps: Send payload: {"spec": "'; DROP TABLE users--"}
Affected: v1.0.0 - v1.0.5
Suggested fix: Use parameterized queries
```

---

## Response Timeline

| Timeframe | Action |
|-----------|--------|
| **Within 48 hours** | Initial response acknowledging receipt |
| **Within 1 week** | Severity assessment and preliminary fix timeline |
| **Within 2 weeks** | Patch development (for critical vulnerabilities) |
| **Within 1 month** | Public disclosure (coordinated with reporter) |

**Critical vulnerabilities** (RCE, data breach) are prioritized and fixed within 48-72 hours.

---

## Disclosure Policy

### Coordinated Disclosure

We follow **coordinated disclosure**:

1. **You report** the vulnerability privately
2. **We acknowledge** within 48 hours
3. **We develop** a fix
4. **We release** the patch
5. **We publicly disclose** (crediting you, if desired)

**Typical timeline**: 30-90 days from report to public disclosure

### Public Disclosure

After the fix is released:
- We publish a security advisory on GitHub
- We update CHANGELOG.md with CVE (if assigned)
- We credit the reporter (unless they prefer anonymity)

---

## Security Best Practices

### For Users

1. **Keep XylonStudio updated** to the latest version
2. **Use `.env` for secrets**, never hardcode API keys
3. **Limit server access** to trusted networks only
4. **Enable firewall** on production servers
5. **Review code** before running untrusted designs

### For Contributors

1. **Never commit** secrets (API keys, passwords, tokens)
2. **Use parameterized queries** for database access
3. **Validate all user inputs** (see `agent/core/input_validator.py`)
4. **Follow secure coding standards** (OWASP Top 10)
5. **Run security tests** before submitting PR

---

## Known Security Considerations

### Design by Design

**LLM-generated code is untrusted by default.**

XylonStudio runs all generated RTL in sandboxed Docker containers:
- No network access
- Limited filesystem (read-only)
- Resource limits (CPU, memory, time)

See `agent/sandbox/` for implementation.

### Customer Data

**Customer designs are treated as secrets.**

- Stored in `proprietary/customer-data/` (excluded from git)
- Never used for LLM training without explicit consent
- Encrypted at rest (if enterprise tier)
- Deleted upon request (GDPR/CCPA compliance)

### LLM Prompt Injection

**Awareness**: Adversarial specs could attempt prompt injection.

**Mitigation**:
- Input validation (`agent/core/input_validator.py`)
- Output sanitization (RTL linting before execution)
- Cost limits (`agent/core/cost_limiter.py`)

If you find a successful prompt injection, **please report it**!

---

## Security Features

### Implemented

- ✅ **Input validation** (length, charset, rate limiting)
- ✅ **Sandbox execution** (Docker isolation)
- ✅ **Cost limiting** (prevent runaway LLM costs)
- ✅ **Secrets management** (.env, never in git)
- ✅ **Output sanitization** (Verilator linting)

### Roadmap

- [ ] **Formal verification** (prove RTL correctness)
- [ ] **Differential testing** (compare against reference)
- [ ] **Model watermarking** (detect stolen models)
- [ ] **Rate limiting per IP** (DDoS prevention)

---

## Hall of Fame

We recognize security researchers who responsibly disclose vulnerabilities:

*(No reports yet - be the first!)*

**Reward**: Public acknowledgment + XylonStudio swag

---

## Contact

**Security Team**: hello@xylonstud.io

**PGP Key** (for encrypted reports):
```
-----BEGIN PGP PUBLIC KEY BLOCK-----
[To be added]
-----END PGP PUBLIC KEY BLOCK-----
```

**Response time**: 48 hours maximum

---

## Security Advisories

**CVE Database**: [GitHub Security Advisories](https://github.com/kevintseng/xylon-studio/security/advisories)

**Past advisories**: None yet (project launched 2026-04-01)

---

**Thank you for helping keep XylonStudio secure! 🛡️**

*Last updated: 2026-04-02*
