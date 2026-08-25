import json

from agent.local_app import ResourceSnapshot
from agent.openroad import resource
from agent.openroad.resource import evaluate_openroad_preflight


def snapshot(
    *,
    cpus: int = 12,
    load: float = 2.0,
    memory: int | None = 60,
    disk_gib: float = 20.0,
    available_gib: float | None = 12.0,
) -> ResourceSnapshot:
    return ResourceSnapshot(
        logical_cpus=cpus,
        load_one_minute=load,
        memory_free_percent=memory,
        disk_free_bytes=int(disk_gib * 1024**3),
        memory_available_bytes=(
            None if available_gib is None else int(available_gib * 1024**3)
        ),
    )


def test_openroad_preflight_admits_bounded_idle_host():
    assert evaluate_openroad_preflight(snapshot(), requested_cpus=4) == []


def test_openroad_preflight_rejects_cpu_budget_above_runtime_cap():
    assert evaluate_openroad_preflight(snapshot(), requested_cpus=5) == [
        "requested CPUs must not exceed 4"
    ]


def test_openroad_preflight_blocks_cpu_memory_and_disk_pressure():
    blockers = evaluate_openroad_preflight(
        snapshot(load=9.0, memory=20, disk_gib=5.0),
        requested_cpus=4,
    )
    assert len(blockers) == 3
    assert "CPU load" in blockers[0]
    assert "memory free" in blockers[1]
    assert "disk free" in blockers[2]


def test_openroad_preflight_fails_closed_on_unknown_memory():
    blockers = evaluate_openroad_preflight(
        snapshot(memory=None, available_gib=None),
        requested_cpus=4,
    )
    assert len(blockers) == 2
    assert "available memory could not be measured safely" in blockers[0]
    assert "memory availability percentage could not be measured safely" in blockers[1]


def test_openroad_preflight_blocks_low_absolute_memory_even_when_percent_is_high():
    blockers = evaluate_openroad_preflight(
        snapshot(memory=70, available_gib=4.0),
        requested_cpus=4,
    )
    assert blockers == [
        "memory available 4.0 GiB is below the 8.0 GiB OpenROAD safety floor"
    ]


def test_blocked_resource_cli_keeps_diagnostic_visible_on_stderr(
    monkeypatch, capsys, tmp_path
):
    monkeypatch.setattr(
        resource,
        "collect_resource_snapshot",
        lambda _repo: snapshot(load=9.0, memory=20, disk_gib=5.0),
    )

    assert resource.main(["--repo", str(tmp_path), "--cpus", "4"]) == 1
    captured = capsys.readouterr()
    assert captured.out == ""
    payload = json.loads(captured.err)
    assert payload["status"] == "blocked"
    assert len(payload["blockers"]) == 3


def test_ready_resource_cli_remains_machine_readable_on_stdout(
    monkeypatch, capsys, tmp_path
):
    monkeypatch.setattr(
        resource,
        "collect_resource_snapshot",
        lambda _repo: snapshot(),
    )

    assert resource.main(["--repo", str(tmp_path), "--cpus", "4"]) == 0
    captured = capsys.readouterr()
    assert captured.err == ""
    assert json.loads(captured.out)["status"] == "ready"
