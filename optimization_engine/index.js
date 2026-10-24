import { buildRecommendationCandidates, solveLinearProgram } from './core/linearOptimizer.js';
import { createReasoningAgent, mountReasoner } from './ai/agentFactory.js';

const defaultConfig = {
  maxBudget: 100000,
  provider: 'local',
};

export const createOptimizationEngine = (config = {}) => {
  const engineConfig = { ...defaultConfig, ...config };

  return {
    config: engineConfig,
    run({ resources = [], metricsByResource = {} } = {}) {
      const candidates = buildRecommendationCandidates(resources, metricsByResource, engineConfig);
      const solution = solveLinearProgram(candidates, engineConfig);

      const recommendations = solution.selectedRecommendations.map((item) => ({
        resource_id: item.resource_id,
        name: item.name,
        type: item.type,
        environment: item.environment,
        owner: item.owner,
        action: item.action,
        monthly_cost: item.monthly_cost,
        estimated_savings: item.estimatedSavings,
        confidence: Number((item.efficiency * 100).toFixed(1)),
        risk_level: item.riskLevel,
        target_configuration: item.targetConfiguration,
        reason: item.reason,
      }));

      return {
        engine: 'linear-program-inspired-optimizer',
        summary: {
          objective: 'maximize total savings under a budget constraint',
          candidate_count: candidates.length,
          selected_count: recommendations.length,
          total_savings: Number(solution.totalSavings.toFixed(2)),
          budget_used: Number(solution.budgetUsed.toFixed(2)),
          max_budget: Number(engineConfig.maxBudget),
        },
        recommendations,
        solver: solution,
      };
    },
    withAi(provider = engineConfig.provider, options = {}) {
      return mountReasoner(this, provider, options);
    },
  };
};

export { buildRecommendationCandidates, solveLinearProgram, createReasoningAgent, mountReasoner };

export default createOptimizationEngine;
