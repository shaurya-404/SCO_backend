import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRecommendationCandidates, solveLinearProgram } from '../optimization_engine/core/linearOptimizer.js';

const lowUsage = Array.from({ length: 100 }, () => ({
  cpu_pct: 8,
  memory_pct: 20,
  disk_pct: 30,
  network_in_mb: 1,
  network_out_mb: 1,
}));

test('right-sizing candidates include a concrete lower target and price-derived saving', () => {
  const candidates = buildRecommendationCandidates([{
    resource_id: 'vm-large',
    name: 'vm-large',
    type: 'VM',
    vcpu: 4,
    ram_gb: 8,
    disk_size_gb: 80,
    monthly_cost: 3920,
    attached_to: '',
  }], { 'vm-large': lowUsage });

  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].targetConfiguration, '2 vCPU / 4 GB RAM');
  assert.equal(candidates[0].estimatedSavings, 1800);
  assert.equal(candidates[0].riskLevel, 'Low');
});

test('peak thresholds prevent a recommendation despite low average utilization', () => {
  const metrics = [...lowUsage.slice(0, 99), {
    cpu_pct: 98,
    memory_pct: 94,
    disk_pct: 30,
    network_in_mb: 1,
    network_out_mb: 1,
  }];
  const candidates = buildRecommendationCandidates([{
    resource_id: 'vm-bursty',
    type: 'VM',
    vcpu: 8,
    ram_gb: 16,
    disk_size_gb: 160,
    monthly_cost: 7840,
  }], { 'vm-bursty': metrics });

  assert.equal(candidates.length, 0);
});

test('budget selection respects the configured total savings cap', () => {
  const result = solveLinearProgram([
    { estimatedSavings: 80, objectiveCoefficient: 10 },
    { estimatedSavings: 40, objectiveCoefficient: 9 },
  ], { maxBudget: 100 });

  assert.equal(result.totalSavings, 80);
  assert.equal(result.selectedRecommendations.length, 1);
  assert.equal(result.deferredRecommendations.length, 1);
});
