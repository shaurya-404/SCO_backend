# Optimization Engine

This package contains a cost-optimization engine for the SmartCloud Optimizer backend.

## Design

The engine is structured around a linear-program-inspired objective:

- maximize total monthly savings
- subject to a budget constraint
- while selecting only resources that meet cost-saving heuristics

## Core ideas

1. Aggregate resource usage metrics per VM or resource.
2. Score each candidate using utilization and idle metrics.
3. Estimate potential savings based on monthly cost and action type.
4. Sort by objective value and apply a budget-aware greedy selection step.
5. Attach an AI reasoner to interpret and explain the final recommendations.

## Example

```js
import { createOptimizationEngine, mountReasoner } from './optimization_engine/index.js';

const engine = createOptimizationEngine({ maxBudget: 50000 });
const result = engine.run({ resources, metricsByResource });

const withAi = mountReasoner(engine, 'gemini', {
  apiKey: process.env.GEMINI_API_KEY,
});

const aiReasoning = await withAi.ai.reason({
  recommendations: result.recommendations,
  summary: result.summary,
});
```

## Providers

- `local` - built-in heuristic summary
- `gemini` - Gemini API reasoning hook
- `openai` - OpenAI chat-completions reasoning hook

This keeps the optimization engine deterministic while leaving room for model-based review.
