# sky130hd timing example

This is a small Xylon-owned sequential RTL design and one supported clock constraint used to
exercise the first timing baseline. It is not a signoff design, benchmark score, or tape-out claim.

Run it through the pinned, resource-bounded ORFS `grt` recipe:

```bash
XYLON_OPENROAD_CPUS=1 ./scripts/xylon-timing smoke
```

The command must read back WNS, TNS, one worst setup path, the `5_1_grt` checkpoint and cleanup
evidence before it reports `baseline_ready`.
