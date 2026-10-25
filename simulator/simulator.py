"""Generate repeatable SmartCloud Optimizer demo data as CSV files."""

from __future__ import annotations

import argparse
import csv
import json
import math
import random
from datetime import datetime, timedelta, timezone
from pathlib import Path


RESOURCE_COUNT = 100
VM_COUNT = 80
VOLUME_COUNT = 12
IP_COUNT = RESOURCE_COUNT - VM_COUNT - VOLUME_COUNT
HISTORY_DAYS = 30
INTERVAL_MINUTES = 15
SAMPLES_PER_DAY = 24 * 60 // INTERVAL_MINUTES
SAMPLES_PER_RESOURCE = HISTORY_DAYS * SAMPLES_PER_DAY

REGIONS = ("Noida", "Bangalore", "Mumbai")
ENVIRONMENTS = ("prod", "staging", "dev")
TEAMS = ("Core-Eng", "Payments", "Analytics", "Growth", "Infra")
VCU_OPTIONS = (2, 4, 8, 16, 32)
WORKLOADS = ("low-steady", "bursty", "batch", "steady-prod")

INVENTORY_FIELDS = (
    "resource_id", "name", "type", "region", "environment", "owner",
    "vcpu", "ram_gb", "disk_size_gb", "monthly_cost", "creation_date",
    "attached_to", "workload_pattern",
)
METRIC_FIELDS = (
    "resource_id", "timestamp", "cpu_pct", "memory_pct", "disk_pct",
    "iops", "network_in_mb", "network_out_mb", "is_anomaly",
)


def clamp(value: float, minimum: float = 0, maximum: float = 100) -> float:
    return max(minimum, min(value, maximum))


def vm_monthly_cost(vcpu: int, ram_gb: int, disk_gb: int) -> float:
    """Illustrative INR pricing, not a quote from a cloud provider."""
    return round(vcpu * 600 + ram_gb * 150 + disk_gb * 4, 2)


def make_inventory(rng: random.Random) -> list[dict[str, object]]:
    resources: list[dict[str, object]] = []
    for index in range(1, RESOURCE_COUNT + 1):
        resource_id = f"vm-cluster-{1000 + index}"
        environment = ENVIRONMENTS[(index - 1) % len(ENVIRONMENTS)]
        created = datetime(2024, 1, 1, tzinfo=timezone.utc) + timedelta(
            days=rng.randrange(1000)
        )
        common: dict[str, object] = {
            "resource_id": resource_id,
            "region": REGIONS[(index - 1) % len(REGIONS)],
            "environment": environment,
            "owner": TEAMS[(index - 1) % len(TEAMS)],
            "creation_date": created.date().isoformat(),
        }

        if index <= VM_COUNT:
            vcpu = VCU_OPTIONS[(index - 1) % len(VCU_OPTIONS)]
            workload = WORKLOADS[(index - 1) % len(WORKLOADS)]
            resources.append({
                **common,
                "name": f"instance-{index}-{environment}",
                "type": "VM",
                "vcpu": vcpu,
                "ram_gb": vcpu * 2,
                "disk_size_gb": vcpu * 20,
                "monthly_cost": vm_monthly_cost(vcpu, vcpu * 2, vcpu * 20),
                "attached_to": "",
                "workload_pattern": (
                    f"{workload}+dev-weekends-idle"
                    if environment == "dev" else workload
                ),
            })
        elif index <= VM_COUNT + VOLUME_COUNT:
            volume_number = index - VM_COUNT
            size_gb = (volume_number % 4 + 1) * 100
            orphaned = volume_number % 4 == 0
            resources.append({
                **common,
                "name": f"volume-{volume_number:02d}",
                "type": "block-volume",
                "vcpu": 0,
                "ram_gb": 0,
                "disk_size_gb": size_gb,
                "monthly_cost": round(size_gb * 5, 2),
                "attached_to": "" if orphaned else f"vm-cluster-{1000 + volume_number}",
                "workload_pattern": "orphaned" if orphaned else "attached-volume",
            })
        else:
            ip_number = index - VM_COUNT - VOLUME_COUNT
            orphaned = ip_number % 3 == 0
            resources.append({
                **common,
                "name": f"public-ip-{ip_number:02d}",
                "type": "public-ip",
                "vcpu": 0,
                "ram_gb": 0,
                "disk_size_gb": 0,
                "monthly_cost": 300.0,
                "attached_to": "" if orphaned else f"vm-cluster-{1000 + ip_number}",
                "workload_pattern": "orphaned" if orphaned else "attached-ip",
            })
    return resources


def generate_vm_metrics(
    resource: dict[str, object],
    timestamp: datetime,
    sample_index: int,
    rng: random.Random,
) -> tuple[float, float, float, float, float, float, bool]:
    environment = str(resource["environment"])
    pattern = str(resource["workload_pattern"]).split("+", maxsplit=1)[0]
    hour = timestamp.hour + timestamp.minute / 60
    weekend = timestamp.weekday() >= 5
    daily_wave = (1 + math.sin((hour - 8) * math.pi / 12)) / 2

    if pattern == "low-steady":
        cpu, memory = rng.uniform(4, 12) + daily_wave * 3, rng.uniform(18, 34)
        traffic, iops = rng.uniform(0.1, 3), rng.uniform(1, 12)
    elif pattern == "bursty":
        peak = 62 if 13 <= hour < 15 else 0
        cpu = rng.uniform(5, 14) + peak + daily_wave * 8
        memory = rng.uniform(30, 50) + peak * 0.35
        traffic, iops = rng.uniform(2, 9) + peak * 0.8, rng.uniform(8, 30) + peak * 1.4
    elif pattern == "batch":
        batch_peak = 72 if 2 <= hour < 4 else 0
        cpu, memory = rng.uniform(2, 7) + batch_peak, rng.uniform(15, 28) + batch_peak * 0.65
        traffic, iops = rng.uniform(0.2, 2) + batch_peak * 0.6, rng.uniform(2, 10) + batch_peak * 1.2
    else:
        cpu = rng.uniform(28, 47) + daily_wave * 18
        memory = rng.uniform(45, 67) + daily_wave * 8
        traffic, iops = rng.uniform(8, 24) + daily_wave * 16, rng.uniform(30, 85) + daily_wave * 45

    off_hours = hour >= 20 or hour < 8
    if environment in ("dev", "staging") and (weekend or off_hours):
        cpu, memory = rng.uniform(0.5, 3), rng.uniform(8, 18)
        traffic, iops = rng.uniform(0, 0.5), rng.uniform(0, 2)

    # A short production spike makes the anomaly visible and reproducible.
    is_anomaly = (
        resource["resource_id"] == "vm-cluster-1001"
        and SAMPLES_PER_RESOURCE - 300 <= sample_index < SAMPLES_PER_RESOURCE - 296
    )
    if is_anomaly:
        cpu, memory, traffic, iops = 98, 94, 180, 420

    disk = clamp(24 + sample_index / SAMPLES_PER_DAY * 0.55 + rng.uniform(-1.5, 1.5))
    return (
        round(clamp(cpu), 2),
        round(clamp(memory), 2),
        round(disk, 2),
        round(max(iops, 0), 2),
        round(max(traffic * rng.uniform(0.45, 0.8), 0), 2),
        round(max(traffic * rng.uniform(0.35, 0.75), 0), 2),
        is_anomaly,
    )


def generate_resource_metrics(
    resource: dict[str, object],
    timestamp: datetime,
    sample_index: int,
    rng: random.Random,
) -> tuple[float, float, float, float, float, float, bool]:
    if resource["type"] == "VM":
        return generate_vm_metrics(resource, timestamp, sample_index, rng)
    if resource["workload_pattern"] == "orphaned":
        return 0, 0, 0, 0, 0, 0, False
    if resource["type"] == "block-volume":
        disk = clamp(48 + sample_index / SAMPLES_PER_DAY * 0.25 + rng.uniform(-2, 2))
        return (
            0, 0, round(disk, 2), round(rng.uniform(3, 45), 2),
            round(rng.uniform(0.1, 2), 2), round(rng.uniform(0.1, 2), 2), False,
        )
    return (
        0, 0, 0, 0, round(rng.uniform(0.1, 8), 2),
        round(rng.uniform(0.1, 8), 2), False,
    )


def write_dataset(output_dir: Path, seed: int) -> tuple[int, int]:
    rng = random.Random(seed)
    resources = make_inventory(rng)
    now = datetime.now(timezone.utc)
    end_time = now.replace(
        minute=(now.minute // INTERVAL_MINUTES) * INTERVAL_MINUTES,
        second=0,
        microsecond=0,
    )
    start_time = end_time - timedelta(days=HISTORY_DAYS)
    output_dir.mkdir(parents=True, exist_ok=True)

    with (output_dir / "resources.csv").open("w", newline="", encoding="utf-8") as file:
        writer = csv.DictWriter(file, fieldnames=INVENTORY_FIELDS)
        writer.writeheader()
        writer.writerows(resources)

    with (output_dir / "metrics.csv").open("w", newline="", encoding="utf-8") as file:
        writer = csv.DictWriter(file, fieldnames=METRIC_FIELDS)
        writer.writeheader()
        for resource in resources:
            for sample_index in range(SAMPLES_PER_RESOURCE):
                timestamp = start_time + timedelta(minutes=INTERVAL_MINUTES * sample_index)
                values = generate_resource_metrics(resource, timestamp, sample_index, rng)
                cpu, memory, disk, iops, network_in, network_out, anomaly = values
                writer.writerow({
                    "resource_id": resource["resource_id"],
                    "timestamp": timestamp.isoformat().replace("+00:00", "Z"),
                    "cpu_pct": cpu,
                    "memory_pct": memory,
                    "disk_pct": disk,
                    "iops": iops,
                    "network_in_mb": network_in,
                    "network_out_mb": network_out,
                    "is_anomaly": str(anomaly).lower(),
                })

    assumptions = {
        "dataset": "SmartCloud Optimizer simulated demo data",
        "currency": "INR",
        "resource_count": RESOURCE_COUNT,
        "resource_mix": {"VM": VM_COUNT, "block-volume": VOLUME_COUNT, "public-ip": IP_COUNT},
        "metric_history_days": HISTORY_DAYS,
        "metric_interval_minutes": INTERVAL_MINUTES,
        "metric_samples_per_resource": SAMPLES_PER_RESOURCE,
        "random_seed": seed,
        "pricing_assumptions": {
            "VM": "INR 600 per vCPU-month + INR 150 per GB RAM-month + INR 4 per disk GB-month",
            "block-volume": "INR 5 per GB-month",
            "public-ip": "INR 300 per month",
            "note": "Illustrative flat rates for this demo, not a provider quote.",
        },
        "patterns": [
            "Low steady utilization", "Bursty daily peaks", "Nightly batch workloads",
            "Higher steady production workloads", "Development VMs idle on weekends",
            "Development and staging VMs idle from 8 PM to 8 AM and on weekends",
            "Orphaned volumes and public IPs have zero observed activity",
            "One four-sample production spike, flagged in metrics.csv",
        ],
        "metric_units": {
            "cpu_pct": "percent", "memory_pct": "percent", "disk_pct": "percent used",
            "iops": "I/O operations per second",
            "network_in_mb": "MB transferred during each 15-minute interval",
            "network_out_mb": "MB transferred during each 15-minute interval",
        },
    }
    with (output_dir / "assumptions.json").open("w", encoding="utf-8") as file:
        json.dump(assumptions, file, indent=2)
        file.write("\n")

    return len(resources), len(resources) * SAMPLES_PER_RESOURCE


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=Path(__file__).resolve().parent / "generated",
        help="Output folder (default: simulator/generated).",
    )
    parser.add_argument("--seed", type=int, default=42, help="Repeatable data seed.")
    args = parser.parse_args()

    resource_count, metric_count = write_dataset(args.output_dir, args.seed)
    print(f"Generated {resource_count} resources and {metric_count} metric rows.")
    print(f"Output directory: {args.output_dir.resolve()}")


if __name__ == "__main__":
    main()