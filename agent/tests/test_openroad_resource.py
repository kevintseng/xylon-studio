from agent.local_app import ResourceSnapshot
from agent.openroad.resource import evaluate_openroad_preflight


def snapshot(
    *,
    cpus: int = 12,
    load: float = 2.0,
    memory: int | None = 60,
    disk_gib: float = 20.0,
) -> ResourceSnapshot:
    return ResourceSnapshot(
        logical_cpus=cpus,
        load_one_minute=load,
        memory_free_percent=memory,
        disk_free_bytes=int(disk_gib * 1024**3),
    )


def test_openroad_preflight_admits_bounded_idle_host():
    assert evaluate_openroad_preflight(snapshot(), requested_cpus=4) == []


def test_openroad_preflight_blocks_cpu_memory_and_disk_pressure():
    blockers = evaluate_openroad_preflight(
        snapshot(load=9.0, memory=20, disk_gib=5.0),
        requested_cpus=4,
    )
    assert len(blockers) == 3
    assert "CPU load" in blockers[0]
    assert "memory free" in blockers[1]
    assert "disk free" in blockers[2]


def test_openroad_preflight_allows_unknown_memory_but_keeps_other_guards():
    assert evaluate_openroad_preflight(snapshot(memory=None), requested_cpus=4) == []
    assert evaluate_openroad_preflight(snapshot(memory=None), requested_cpus=0) == [
        "requested CPUs must be at least 1"
    ]
