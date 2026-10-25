import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRecommendations, estimateVmMonthlyCost } from './recommendationEngine.js';

const vm = {
  resource_id: 'vm-large',
  name: 'large-vm',
  type: 'VM',
  vcpu: 8,
  ram_gb: 16,
  disk_size_gb: 160,
  monthly_cost: 8000,
  environment: 'dev',
};

const vmSummary = (overrides = {}) => ({
  sample_count: 2880,
  first_timestamp: '2026-09-25T00:00:00Z',
  last_timestamp: '2026-10-25T00:00:00Z',
  p95_cpu: 15,
  p99_cpu: 20,
  p95_memory: 30,
  p99_memory: 30,
  max_cpu: 45,
  max_memory: 55,
  max_disk: 60,
  max_iops: 20,
  max_network_in: 10,
  max_network_out: 10,
  ...overrides,
});

test('generates a smaller target and savings from transparent illustrative pricing', () => {
  const [recommendation] = buildRecommendations([vm], new Map([[vm.resource_id, vmSummary()]]));

  assert.equal(recommendation.target_vcpu, 4);
  assert.equal(recommendation.target_ram_gb, 8);
  assert.equal(recommendation.current_monthly_cost, 8000);
  assert.equal(recommendation.target_monthly_cost, estimateVmMonthlyCost({
    vcpu: 4,
    ram_gb: 8,
    disk_size_gb: 160,
  }));
  assert.equal(recommendation.estimated_monthly_saving, 3760);
  assert.match(recommendation.reason, /p99 CPU 20\.0%/);
});

test('does not resize when a recorded peak breaches the safety threshold', () => {
  const recommendations = buildRecommendations(
    [vm],
    new Map([[vm.resource_id, vmSummary({ max_cpu: 98 })]]),
  );

  assert.deepEqual(recommendations, []);
});

test('does not recommend resources without at least fourteen days of samples', () => {
  const recommendations = buildRecommendations(
    [vm],
    new Map([[vm.resource_id, vmSummary({ sample_count: 1343 })]]),
  );

  assert.deepEqual(recommendations, []);
});

test('does not treat a high sample count in a short window as fourteen days of history', () => {
  const recommendations = buildRecommendations(
    [vm],
    new Map([[
      vm.resource_id,
      vmSummary({
        first_timestamp: '2026-10-24T00:00:00Z',
        last_timestamp: '2026-10-25T00:00:00Z',
      }),
    ]]),
  );

  assert.deepEqual(recommendations, []);
});

test('suggests orphan cleanup only when attachment and all observed activity are absent', () => {
  const volume = {
    resource_id: 'volume-unused',
    type: 'block-volume',
    attached_to: '',
    monthly_cost: 500,
  };
  const summary = vmSummary({
    max_cpu: 0,
    max_memory: 0,
    max_disk: 0,
    max_iops: 0,
    max_network_in: 0,
    max_network_out: 0,
  });
  const [recommendation] = buildRecommendations([volume], new Map([[volume.resource_id, summary]]));

  assert.equal(recommendation.estimated_monthly_saving, 500);
  assert.equal(recommendation.target_monthly_cost, 0);
  assert.equal(recommendation.risk_level, 'Safe');
});

test('does not recommend cleanup if any activity is observed', () => {
  const volume = {
    resource_id: 'volume-active',
    type: 'block-volume',
    attached_to: '',
    monthly_cost: 500,
  };
  const recommendations = buildRecommendations(
    [volume],
    new Map([[volume.resource_id, vmSummary({ max_disk: 2 })]]),
  );

  assert.deepEqual(recommendations, []);
});
