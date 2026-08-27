from __future__ import annotations

from pathlib import Path

import pytest

from agent.openroad.librelane_diagnosis import MAX_REPORT_BYTES, build_librelane_diagnosis


def _readback() -> dict[str, object]:
    return {
        "paths": {
            "metrics": "runs/RUN_2026-08-26_05-36-27/final/metrics.csv",
            "resolved": "runs/RUN_2026-08-26_05-36-27/resolved.json",
        },
        "metrics": {"timing__setup__wns": -12.440470339336347},
    }


def _config() -> dict[str, object]:
    return {"RUN_POST_CTS_RESIZER_TIMING": False}


def _write_report(path: Path, *, slack: float, corner: str = "max_ss_100C_1v60") -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    required = 1.086048
    arrival = required - slack
    path.write_text(
        "\n".join([
            "============================================================================",
            "report_checks -path_delay max (Setup)",
            "============================================================================",
            f"======================= {corner} Corner ===================================",
            "",
            "Startpoint: _1066_ (rising edge-triggered flip-flop clocked by core_clock)",
            "Endpoint: _1058_ (rising edge-triggered flip-flop clocked by core_clock)",
            "Path Group: core_clock",
            "Path Type: max",
            "",
            f"                                              {arrival:.6f}   data arrival time",
            f"                                              {required:.6f}   data required time",
            "---------------------------------------------------------------------------------------------",
            f"                                             {slack:.6f}   slack (VIOLATED)" if slack < 0 else f"                                             {slack:.6f}   slack (MET)",
            "",
        ]) + "\n",
        encoding="utf-8",
    )


def test_selects_most_negative_native_max_report_and_derives_stage_corner(tmp_path: Path) -> None:
    run_root = tmp_path / "run"
    _write_report(
        run_root / "runs/RUN_2026-08-26_05-36-27/31-openroad-stamidpnr/nom_tt_025C_1v80/max.rpt",
        slack=-4.783188,
        corner="nom_tt_025C_1v80",
    )
    _write_report(
        run_root / "runs/RUN_2026-08-26_05-36-27/54-openroad-stapostpnr/max_ss_100C_1v60/max.rpt",
        slack=-12.440471,
        corner="max_ss_100C_1v60",
    )

    diagnosis = build_librelane_diagnosis(run_root, _readback(), config=_config())

    assert diagnosis["status"] == "available"
    assert diagnosis["stage"] == "openroad_stapostpnr"
    assert diagnosis["corner"] == "max_ss_100C_1v60"
    assert diagnosis["report"]["path"].endswith("/54-openroad-stapostpnr/max_ss_100C_1v60/max.rpt")
    assert diagnosis["arrival_ns"] == pytest.approx(13.526519)
    assert diagnosis["required_ns"] == pytest.approx(1.086048)
    assert diagnosis["slack_ns"] == pytest.approx(-12.440471)
    assert diagnosis["next_action"]["strategy"] == "cts"


def test_prefers_final_stage_match_over_more_negative_earlier_stage(tmp_path: Path) -> None:
    run_root = tmp_path / "run"
    _write_report(
        run_root / "runs/RUN_2026-08-26_05-36-27/31-openroad-stamidpnr/nom_tt_025C_1v80/max.rpt",
        slack=-12.000000,
        corner="nom_tt_025C_1v80",
    )
    _write_report(
        run_root / "runs/RUN_2026-08-26_05-36-27/54-openroad-stapostpnr/max_ss_100C_1v60/max.rpt",
        slack=-8.000000,
        corner="max_ss_100C_1v60",
    )
    readback = _readback()
    readback["metrics"]["timing__setup__wns"] = -8.0

    diagnosis = build_librelane_diagnosis(run_root, readback, config=_config())

    assert diagnosis["status"] == "available"
    assert diagnosis["stage"] == "openroad_stapostpnr"
    assert diagnosis["corner"] == "max_ss_100C_1v60"
    assert diagnosis["slack_ns"] == pytest.approx(-8.0)


def test_missing_report_is_explicitly_unavailable(tmp_path: Path) -> None:
    diagnosis = build_librelane_diagnosis(tmp_path / "run", _readback(), config=_config())
    assert diagnosis["status"] == "unavailable"
    assert diagnosis["unavailable_reason"] == "missing_report"
    assert diagnosis["next_action"] is None


def test_malformed_report_fails_closed(tmp_path: Path) -> None:
    run_root = tmp_path / "run"
    path = run_root / "runs/RUN_2026-08-26_05-36-27/31-openroad-stamidpnr/nom_tt_025C_1v80/max.rpt"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        "\n".join([
            "report_checks -path_delay max (Setup)",
            "Startpoint: launch_reg/Q",
            "Path Type: max",
            "-4.783188 slack (VIOLATED)",
        ]) + "\n",
        encoding="utf-8",
    )

    diagnosis = build_librelane_diagnosis(run_root, _readback(), config=_config())
    assert diagnosis["status"] == "unavailable"
    assert diagnosis["unavailable_reason"] == "incomplete_path_identity"


def test_oversized_report_fails_closed(tmp_path: Path) -> None:
    run_root = tmp_path / "run"
    path = run_root / "runs/RUN_2026-08-26_05-36-27/31-openroad-stamidpnr/nom_tt_025C_1v80/max.rpt"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b"x" * (MAX_REPORT_BYTES + 1))

    diagnosis = build_librelane_diagnosis(run_root, _readback(), config=_config())
    assert diagnosis["status"] == "unavailable"
    assert diagnosis["unavailable_reason"] == "report_exceeds_bounded_limit"


def test_out_of_run_symlink_report_is_not_followed(tmp_path: Path) -> None:
    run_root = tmp_path / "run"
    outside = tmp_path / "outside-max.rpt"
    _write_report(outside, slack=-4.783188)
    report_link = run_root / "runs/RUN_2026-08-26_05-36-27/31-openroad-stamidpnr/nom_tt_025C_1v80/max.rpt"
    report_link.parent.mkdir(parents=True, exist_ok=True)
    report_link.symlink_to(outside)

    diagnosis = build_librelane_diagnosis(run_root, _readback(), config=_config())
    assert diagnosis["status"] == "unavailable"
    assert diagnosis["unavailable_reason"] == "missing_report"
