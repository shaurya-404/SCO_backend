const MINIMUM_SAMPLES = 14 * 24 * 4;
const MINIMUM_HISTORY_DAYS = 14;
const VM_TIERS = [2, 4, 8, 16, 32];
const PRICING = {
  vcpuMonthly: 600,
  ramGbMonthly: 150,
  diskGbMonthly: 4,
};

const roundMoney = (value) => Number(value.toFixed(2));
const observedHistoryDays = (summary) => {
  const first = Date.parse(summary.first_timestamp);
  const last = Date.parse(summary.last_timestamp);
  return Number.isFinite(first) && Number.isFinite(last)
    ? Math.max(0, (last - first) / (24 * 60 * 60 * 1000))
    : 0;
};

export const estimateVmMonthlyCost = ({ vcpu, ram_gb, disk_size_gb }) => (
  roundMoney(
    Number(vcpu) * PRICING.vcpuMonthly
    + Number(ram_gb) * PRICING.ramGbMonthly
    + Number(disk_size_gb) * PRICING.diskGbMonthly,
  )
);

const getVmTarget = (resource, summary) => {
  const currentVcpu = Number(resource.vcpu);
  const currentRam = Number(resource.ram_gb);
  const p99Cpu = Number(summary.p99_cpu);
  const p99Memory = Number(summary.p99_memory);

  return VM_TIERS
    .filter((vcpu) => vcpu < currentVcpu)
    .map((vcpu) => ({
      vcpu,
      ram_gb: Math.max(1, Math.floor(currentRam * vcpu / currentVcpu)),
      disk_size_gb: Number(resource.disk_size_gb),
    }))
    .find((target) => (
      p99Cpu * currentVcpu / target.vcpu <= 70
      && p99Memory * currentRam / target.ram_gb <= 75
      && estimateVmMonthlyCost(target) < Number(resource.monthly_cost)
    ));
};

export const buildRecommendations = (resources, summaries) => {
  const recommendations = [];

  for (const resource of resources) {
    const summary = summaries.get(resource.resource_id);
    const historyDays = summary ? observedHistoryDays(summary) : 0;
    if (
      !summary
      || Number(summary.sample_count) < MINIMUM_SAMPLES
      || historyDays < MINIMUM_HISTORY_DAYS
    ) continue;

    if (
      ['block-volume', 'public-ip'].includes(resource.type)
      && !String(resource.attached_to ?? '').trim()
      && Number(resource.monthly_cost) > 0
      && Number(summary.max_disk) === 0
      && Number(summary.max_iops) === 0
      && Number(summary.max_network_in) === 0
      && Number(summary.max_network_out) === 0
    ) {
      recommendations.push({
        rec_id: `orphan-${resource.resource_id}`,
        resource_id: resource.resource_id,
        action: resource.type === 'block-volume'
          ? 'Remove unattached block volume'
          : 'Release unattached public IP',
        reason: `No attachment and zero disk, I/O, and network activity across ${summary.sample_count} samples over ${historyDays.toFixed(1)} days.`,
        risk_level: 'Safe',
        current_vcpu: null,
        current_ram_gb: null,
        target_vcpu: null,
        target_ram_gb: null,
        current_monthly_cost: roundMoney(Number(resource.monthly_cost)),
        target_monthly_cost: 0,
        estimated_monthly_saving: roundMoney(Number(resource.monthly_cost)),
        p95_cpu: null,
        p99_cpu: null,
        p95_memory: null,
        p99_memory: null,
        sample_count: Number(summary.sample_count),
        history_days: Number(historyDays.toFixed(2)),
      });
      continue;
    }

    if (
      resource.type !== 'VM'
      || Number(summary.p95_cpu) > 20
      || Number(summary.p99_cpu) > 30
      || Number(summary.p95_memory) > 50
      || Number(summary.p99_memory) > 60
      || Number(summary.max_cpu) > 90
      || Number(summary.max_memory) > 90
    ) continue;

    const target = getVmTarget(resource, summary);
    if (!target) continue;

    const targetCost = estimateVmMonthlyCost({
      ...target,
      disk_size_gb: Number(resource.disk_size_gb),
    });
    const currentCost = roundMoney(Number(resource.monthly_cost));
    const cpuAtTarget = Number(summary.p99_cpu) * Number(resource.vcpu) / target.vcpu;
    const memoryAtTarget = Number(summary.p99_memory) * Number(resource.ram_gb) / target.ram_gb;

    recommendations.push({
      rec_id: `rightsize-${resource.resource_id}`,
      resource_id: resource.resource_id,
      action: `Resize ${resource.vcpu} vCPU / ${resource.ram_gb} GB to ${target.vcpu} vCPU / ${target.ram_gb} GB`,
      reason: `Based on ${summary.sample_count} samples: p95 CPU ${Number(summary.p95_cpu).toFixed(1)}%, p99 CPU ${Number(summary.p99_cpu).toFixed(1)}%, p95 memory ${Number(summary.p95_memory).toFixed(1)}%, p99 memory ${Number(summary.p99_memory).toFixed(1)}%. At the target size, estimated p99 is ${cpuAtTarget.toFixed(1)}% CPU and ${memoryAtTarget.toFixed(1)}% memory (70%/75% safety limits). Disk is unchanged.`,
      risk_level: cpuAtTarget <= 55 && memoryAtTarget <= 60 ? 'Low' : 'Medium',
      current_vcpu: Number(resource.vcpu),
      current_ram_gb: Number(resource.ram_gb),
      target_vcpu: target.vcpu,
      target_ram_gb: target.ram_gb,
      current_monthly_cost: currentCost,
      target_monthly_cost: targetCost,
      estimated_monthly_saving: roundMoney(currentCost - targetCost),
      p95_cpu: Number(summary.p95_cpu),
      p99_cpu: Number(summary.p99_cpu),
      p95_memory: Number(summary.p95_memory),
      p99_memory: Number(summary.p99_memory),
      sample_count: Number(summary.sample_count),
      history_days: Number(historyDays.toFixed(2)),
    });
  }

  return recommendations;
};
