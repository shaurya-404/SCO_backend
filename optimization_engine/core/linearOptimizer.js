const clamp = (value, min = 0, max = 1) => Math.min(max, Math.max(min, value));

const average = (values = []) => {
  if (!values.length) return 0;
  return values.reduce((sum, value) => sum + Number(value || 0), 0) / values.length;
};

const percentile = (values = [], p = 0.95) => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = clamp((sorted.length - 1) * p, 0, sorted.length - 1);
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower];
  const weight = index - lower;
  return sorted[lower] * (1 - weight) + sorted[upper] * weight;
};

export const summarizeMetrics = (metrics = []) => {
  const cpuValues = metrics.map((item) => Number(item.cpu_pct || 0));
  const memoryValues = metrics.map((item) => Number(item.memory_pct || 0));
  const diskValues = metrics.map((item) => Number(item.disk_pct || 0));
  const networkInValues = metrics.map((item) => Number(item.network_in_mb || 0));
  const networkOutValues = metrics.map((item) => Number(item.network_out_mb || 0));

  return {
    sampleCount: metrics.length,
    avgCpu: average(cpuValues),
    avgMemory: average(memoryValues),
    avgDisk: average(diskValues),
    maxCpu: Math.max(...cpuValues, 0),
    maxMemory: Math.max(...memoryValues, 0),
    p95Cpu: percentile(cpuValues, 0.95),
    p99Cpu: percentile(cpuValues, 0.99),
    p95Memory: percentile(memoryValues, 0.95),
    p99Memory: percentile(memoryValues, 0.99),
    avgNetworkIn: average(networkInValues),
    avgNetworkOut: average(networkOutValues),
  };
};

const computeIdleScore = (summary) => {
  const normalizedCpu = clamp(1 - summary.avgCpu / 100, 0, 1);
  const normalizedMemory = clamp(1 - summary.avgMemory / 100, 0, 1);
  const normalizedDisk = clamp(1 - summary.avgDisk / 100, 0, 1);
  return (normalizedCpu * 0.5) + (normalizedMemory * 0.3) + (normalizedDisk * 0.2);
};

const computeRiskScore = (resource, summary) => {
  const cpuRisk = clamp(summary.p99Cpu / 100, 0, 1);
  const memoryRisk = clamp(summary.p99Memory / 100, 0, 1);
  const orphanPenalty = resource.type !== 'VM' && !resource.attached_to ? 0.5 : 0;
  const vmPenalty = resource.type === 'VM' ? 0.15 : 0;
  return clamp(cpuRisk * 0.45 + memoryRisk * 0.35 + orphanPenalty + vmPenalty, 0, 1);
};

const computeActionRatio = (resource) => {
  if (resource.type === 'block-volume' || resource.type === 'public-ip') return 1;
  const targetVcpu = Math.max(1, Math.floor(Number(resource.vcpu || 0) / 2));
  const targetRam = Math.max(1, Math.floor(Number(resource.ram_gb || 0) / 2));
  const targetCost = targetVcpu * 600 + targetRam * 150 + Number(resource.disk_size_gb || 0) * 4;
  return Number(resource.monthly_cost) > 0
    ? Math.max(0, (Number(resource.monthly_cost) - targetCost) / Number(resource.monthly_cost))
    : 0;
};

const buildRecommendationText = (resource, summary) => {
  if (resource.type === 'block-volume') {
    return 'Remove or archive unattached volume because it is idle and contributes storage cost without load.';
  }
  if (resource.type === 'public-ip') {
    return 'Release provisioned public IP because it is unused and shows no ingress or egress traffic.';
  }

  return `Right-size VM based on sustained low utilization: avg CPU ${summary.avgCpu.toFixed(1)}%, avg memory ${summary.avgMemory.toFixed(1)}%, p99 CPU ${summary.p99Cpu.toFixed(1)}%.`;
};

export const buildRecommendationCandidates = (resources = [], metricsByResource = {}, config = {}) => {
  const maxBudget = Number(config.maxBudget) || Number.MAX_SAFE_INTEGER;

  return resources
    .map((resource) => {
      const metrics = metricsByResource[resource.resource_id] || [];
      const summary = summarizeMetrics(metrics);
      const idleScore = computeIdleScore(summary);
      const riskScore = computeRiskScore(resource, summary);
      const actionRatio = computeActionRatio(resource);

      const savings = Number(resource.monthly_cost || 0) * actionRatio;
      const targetConfiguration = resource.type === 'VM'
        ? `${Math.max(1, Math.floor(Number(resource.vcpu || 0) / 2))} vCPU / ${Math.max(1, Math.floor(Number(resource.ram_gb || 0) / 2))} GB RAM`
        : null;
      const efficiency = clamp((idleScore * 0.7) + ((1 - riskScore) * 0.3), 0, 1);
      const objectiveCoefficient = savings * (0.4 + efficiency);

      if (!metrics.length || !Number(resource.monthly_cost || 0)) {
        return null;
      }

      const shouldRecommend = (() => {
        if (resource.type === 'block-volume') {
          return !resource.attached_to && summary.avgDisk <= 5 && summary.avgNetworkIn <= 0.5 && summary.avgNetworkOut <= 0.5;
        }
        if (resource.type === 'public-ip') {
          return !resource.attached_to && summary.avgNetworkIn <= 0.5 && summary.avgNetworkOut <= 0.5;
        }

        return (
          Number(resource.vcpu || 0) >= 4 &&
          summary.p95Cpu <= 20 &&
          summary.p99Cpu <= 30 &&
          summary.p95Memory <= 50 &&
          summary.p99Memory <= 60 &&
          summary.maxCpu <= 90 &&
          summary.maxMemory <= 90
        );
      })();

      if (!shouldRecommend) {
        return null;
      }

      return {
        resource_id: resource.resource_id,
        name: resource.name,
        type: resource.type,
        environment: resource.environment,
        owner: resource.owner,
        monthly_cost: Number(resource.monthly_cost || 0),
        estimatedSavings: Number(savings.toFixed(2)),
        objectiveCoefficient: Number(objectiveCoefficient.toFixed(4)),
        utilization: {
          avgCpu: summary.avgCpu,
          avgMemory: summary.avgMemory,
          p95Cpu: summary.p95Cpu,
          p99Cpu: summary.p99Cpu,
          p95Memory: summary.p95Memory,
          p99Memory: summary.p99Memory,
        },
        idleScore,
        riskScore,
        riskLevel: riskScore < 0.3 ? 'Low' : riskScore < 0.6 ? 'Medium' : 'High',
        targetConfiguration,
        efficiency,
        action: resource.type === 'VM' ? 'rightsizing' : 'release-unused-resource',
        reason: buildRecommendationText(resource, summary),
        constraintWeight: Number(savings.toFixed(2)),
        selected: false,
        maxBudget,
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.objectiveCoefficient - a.objectiveCoefficient);
};

export const solveLinearProgram = (candidates = [], config = {}) => {
  const maxBudget = Number(config.maxBudget) || Number.MAX_SAFE_INTEGER;

  let budgetUsed = 0;
  const selected = [];

  for (const candidate of candidates) {
    const canSelect = budgetUsed + candidate.estimatedSavings <= maxBudget;
    const decision = canSelect ? 1 : 0;

    if (decision === 1) {
      budgetUsed += candidate.estimatedSavings;
    }

    selected.push({
      ...candidate,
      selected: decision === 1,
      decision,
      budgetUsedAfterSelection: Number(budgetUsed.toFixed(2)),
    });
  }

  const totalSavings = selected
    .filter((candidate) => candidate.selected)
    .reduce((sum, candidate) => sum + candidate.estimatedSavings, 0);

  return {
    objectiveValue: Number(totalSavings.toFixed(2)),
    totalSavings: Number(totalSavings.toFixed(2)),
    maxBudget,
    budgetUsed: Number(budgetUsed.toFixed(2)),
    selectedRecommendations: selected.filter((candidate) => candidate.selected),
    deferredRecommendations: selected.filter((candidate) => !candidate.selected),
    candidateCount: selected.length,
    solver: 'linear-program-inspired-greedy-allocation',
  };
};
