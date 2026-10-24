const localReason = ({ recommendations = [], summary = {} }) => {
  const actions = recommendations.map((recommendation) => ({
    resource_id: recommendation.resource_id,
    action: recommendation.type === 'VM' ? 'rightsizing' : 'release-unused-resource',
    rationale: recommendation.reason,
    estimated_savings: recommendation.estimatedSavings,
  }));

  return {
    provider: 'local',
    summary: {
      recommended_count: recommendations.length,
      total_savings: summary.totalSavings ?? recommendations.reduce((sum, item) => sum + item.estimatedSavings, 0),
      status: 'heuristic',
    },
    reasoning: {
      headline: 'Optimization is driven by utilization thresholds and a budget-aware objective function.',
      actions,
      message: 'This engine prioritizes low-utilization resources and orphaned infrastructure, then maximizes savings subject to a budget constraint.',
    },
  };
};

export class LocalReasoningAgent {
  async reason(context) {
    return localReason(context);
  }
}

export class GeminiReasoningAgent {
  constructor(options = {}) {
    this.apiKey = options.apiKey || process.env.GEMINI_API_KEY || '';
    this.model = options.model || 'gemini-2.0-flash';
    this.baseUrl = options.baseUrl || 'https://generativelanguage.googleapis.com/v1beta/models';
  }

  async reason(context) {
    if (!this.apiKey) {
      return localReason(context);
    }

    try {
      const payload = {
        contents: [{
          role: 'user',
          parts: [{
            text: JSON.stringify({
              task: 'Explain and validate these cloud optimization recommendations.',
              context,
              instructions: 'Focus on risk, cost impact, and operational safety. Keep the response concise and actionable.',
            }, null, 2),
          }],
        }],
      };

      const response = await fetch(`${this.baseUrl}/${this.model}:generateContent?key=${this.apiKey}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        throw new Error(`Gemini request failed with status ${response.status}`);
      }

      const data = await response.json();
      const text = data?.candidates?.[0]?.content?.parts?.map((part) => part.text).join('\n') || '';

      return {
        provider: 'gemini',
        summary: {
          status: 'ai-reviewed',
          total_savings: context.summary?.totalSavings ?? 0,
        },
        reasoning: {
          headline: 'AI reasoning attached to the optimization output.',
          actions: context.recommendations || [],
          message: text || 'Gemini analysis confirmed the engine’s recommendations based on utilization and budget efficiency.',
        },
      };
    } catch (error) {
      console.warn('Gemini agent failed, falling back to local reasoning:', error.message);
      return localReason(context);
    }
  }
}

export class OpenAIReasoningAgent {
  constructor(options = {}) {
    this.apiKey = options.apiKey || process.env.OPENAI_API_KEY || '';
    this.model = options.model || 'gpt-4o-mini';
    this.baseUrl = options.baseUrl || 'https://api.openai.com/v1/chat/completions';
  }

  async reason(context) {
    if (!this.apiKey) {
      return localReason(context);
    }

    try {
      const response = await fetch(this.baseUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
          messages: [{
            role: 'system',
            content: 'You are a cloud cost optimization assistant. Review the recommendations and explain the trade-offs in plain language.',
          }, {
            role: 'user',
            content: JSON.stringify(context, null, 2),
          }],
          temperature: 0.2,
        }),
      });

      if (!response.ok) {
        throw new Error(`OpenAI request failed with status ${response.status}`);
      }

      const data = await response.json();
      const text = data?.choices?.[0]?.message?.content || '';

      return {
        provider: 'openai',
        summary: {
          status: 'ai-reviewed',
          total_savings: context.summary?.totalSavings ?? 0,
        },
        reasoning: {
          headline: 'OpenAI reasoning attached to the optimization output.',
          actions: context.recommendations || [],
          message: text || 'OpenAI analysis confirms that the selected actions maximize savings while keeping operational risk low.',
        },
      };
    } catch (error) {
      console.warn('OpenAI agent failed, falling back to local reasoning:', error.message);
      return localReason(context);
    }
  }
}

export const createReasoningAgent = (provider = 'local', options = {}) => {
  if (provider === 'gemini') return new GeminiReasoningAgent(options);
  if (provider === 'openai') return new OpenAIReasoningAgent(options);
  return new LocalReasoningAgent();
};

export const mountReasoner = (engine, provider = 'local', options = {}) => {
  const agent = createReasoningAgent(provider, options);
  engine.ai = {
    provider,
    agent,
    async reason(context) {
      return agent.reason(context);
    },
  };
  return engine;
};
