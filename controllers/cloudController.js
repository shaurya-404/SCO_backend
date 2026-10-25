import jwt from 'jsonwebtoken';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import db from '../database/connection.js';
import { CloudModel } from '../models/cloudModel.js';
import { createOptimizationEngine, mountReasoner } from '../optimization_engine/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const simulatorScript = path.resolve(__dirname, '../simulator/simulator.py');

const getErrorMessage = (error) => error instanceof Error ? error.message : String(error);
const toPublicUser = (user) => ({
  id: user.user_id,
  email: user.email,
  name: user.name,
  role: user.role,
  is_admin: user.is_admin === true,
});

const createSession = (user) => {
  const secret = process.env.JWT_SECRET || "fallback_secret";
  const token = jwt.sign(
    {
      sub: user.email,
      userId: user.user_id,
      role: user.role,
      name: user.name,
      is_admin: user.is_admin === true,
    },
    secret,
    { expiresIn: "8h" }
  );
  return { token, user: toPublicUser(user) };
};

export const register = async (req, res) => {
  try {
    const { email, password, name, role } = req.body ?? {};
    if (!email || !password || !name) {
      return res.status(400).json({ error: "Email, password, and name are required" });
    }
    if (typeof role !== 'string' || !role.trim() || role.trim().length > 120) {
      return res.status(400).json({ error: 'Job description is required and must be 120 characters or fewer.' });
    }

    const existingUser = await CloudModel.getUserByEmail(email);
    if (existingUser) {
      return res.status(409).json({ error: "User with this email already exists" });
    }

    const userId = `usr-${Date.now()}`;
    const newUser = await CloudModel.createUser(userId, email, password, name, role.trim());

    res.status(201).json(createSession(newUser));
  } catch (err) {
    res.status(500).json({ error: getErrorMessage(err) });
  }
};

export const login = async (req, res) => {
  try {
    const { email, password } = req.body ?? {};
    if (!email || !password) {
      return res.status(400).json({ error: "Email and password are required" });
    }

    const user = await CloudModel.getUserByEmail(email);
    if (!user || user.password !== password) {
      return res.status(401).json({ error: "Invalid email or password" });
    }

    res.json(createSession(user));
  } catch (err) {
    res.status(500).json({ error: getErrorMessage(err) });
  }
};

export const getMe = async (req, res) => {
  try {
    const user = req.user.userId
      ? await CloudModel.getUserById(req.user.userId)
      : await CloudModel.getUserByEmail(req.user.sub);
    if (!user) return res.status(404).json({ error: "User not found" });
    res.json({ user: toPublicUser(user) });
  } catch (err) {
    res.status(500).json({ error: getErrorMessage(err) });
  }
};

export const updateProfile = async (req, res) => {
  try {
    const { name, email, role } = req.body ?? {};
    if (
      typeof name !== "string" || !name.trim() || name.trim().length > 120 ||
      typeof email !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()) || email.trim().length > 254 ||
      typeof role !== "string" || !role.trim() || role.trim().length > 120
    ) {
      return res.status(400).json({ error: "Provide a valid name, email address, and job description of 120 characters or fewer." });
    }

    const normalizedEmail = email.trim();
    const existingUser = await CloudModel.getUserByEmail(normalizedEmail);
    if (existingUser && existingUser.user_id !== req.user.userId) {
      return res.status(409).json({ error: "An account with this email already exists." });
    }

    const updatedUser = await CloudModel.updateUserProfile(req.user.userId, {
      name: name.trim(),
      email: normalizedEmail,
      role: role.trim(),
    });
    if (!updatedUser) return res.status(404).json({ error: "User not found." });
    res.json(createSession(updatedUser));
  } catch (err) {
    res.status(500).json({ error: getErrorMessage(err) });
  }
};

export const getCompanyDetails = async (_req, res) => {
  try {
    const company = await CloudModel.getCompanyDetails();
    if (!company) return res.status(404).json({ error: "Company details have not been configured." });
    res.json(company);
  } catch (err) {
    res.status(500).json({ error: getErrorMessage(err) });
  }
};

export const updateCompanyDetails = async (req, res) => {
  try {
    const { name, website = "", industry = "", contact_email = "", address = "" } = req.body ?? {};
    const fields = { name, website, industry, contact_email, address };
    if (
      typeof name !== "string" || !name.trim() || name.trim().length > 160 ||
      typeof website !== "string" || website.length > 255 ||
      typeof industry !== "string" || industry.length > 120 ||
      typeof contact_email !== "string" || contact_email.length > 254 ||
      typeof address !== "string" || address.length > 500 ||
      (req.body.monthly_budget !== undefined &&
        (!Number.isFinite(Number(req.body.monthly_budget)) || Number(req.body.monthly_budget) < 0)) ||
      (contact_email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact_email.trim()))
    ) {
      return res.status(400).json({ error: "Provide valid company details within the allowed field lengths." });
    }
    if (website.trim()) {
      try {
        const parsedWebsite = new URL(website.trim());
        if (!["http:", "https:"].includes(parsedWebsite.protocol)) throw new Error("Invalid website protocol");
      } catch {
        return res.status(400).json({ error: "Website must be a valid http or https URL." });
      }
    }

    const company = await CloudModel.updateCompanyDetails({
      ...fields,
      name: name.trim(),
      website: website.trim(),
      industry: industry.trim(),
      contact_email: contact_email.trim(),
      address: address.trim(),
      monthly_budget: req.body.monthly_budget === undefined
        ? (await CloudModel.getCompanyDetails()).monthly_budget
        : Number(req.body.monthly_budget),
    });
    if (!company) return res.status(404).json({ error: "Company details have not been configured." });
    res.json(company);
  } catch (err) {
    res.status(500).json({ error: getErrorMessage(err) });
  }
};

export const getInventory = async (req, res) => {
  try {
    const data = await CloudModel.getAllInventory();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: getErrorMessage(err) });
  }
};

export const getInventoryStats = async (req, res) => {
  try {
    const stats = await CloudModel.getInventoryStats();
    res.json(stats);
  } catch (err) {
    res.status(500).json({ error: getErrorMessage(err) });
  }
};

export const getFleetMetrics = async (_req, res) => {
  try {
    const resources = await CloudModel.getFleetUtilization();
    const measured = resources.filter((resource) => resource.sample_count);
    const mean = (key) => measured.length
      ? measured.reduce((sum, resource) => sum + Number(resource[key] || 0), 0) / measured.length
      : 0;
    res.json({
      summary: {
        resource_count: resources.length,
        measured_resource_count: measured.length,
        avg_cpu_pct: mean('avg_cpu'),
        avg_memory_pct: mean('avg_memory'),
        avg_disk_pct: mean('avg_disk'),
        avg_network_in_mb: mean('avg_network_in'),
        avg_network_out_mb: mean('avg_network_out'),
        high_cpu_resources: measured.filter((resource) => resource.p95_cpu >= 80).length,
        high_memory_resources: measured.filter((resource) => resource.p95_memory >= 80).length,
      },
      resources,
    });
  } catch (err) {
    res.status(500).json({ error: getErrorMessage(err) });
  }
};

export const getResourceById = async (req, res) => {
  try {
    const resource = await CloudModel.getResourceById(req.params.id);
    if (!resource) {
      return res.status(404).json({ error: "Resource not found" });
    }
    res.json(resource);
  } catch (err) {
    res.status(500).json({ error: getErrorMessage(err) });
  }
};

export const getResourceMetrics = async (req, res) => {
  try {
    const requestedDays = Number(req.query.days ?? 30);
    if (![7, 14, 30, 90].includes(requestedDays)) {
      return res.status(400).json({ error: "Days must be one of 7, 14, 30, or 90." });
    }
    const metrics = await CloudModel.getMetricsForResource(req.params.id, requestedDays);
    res.json(metrics);
  } catch (err) {
    res.status(500).json({ error: getErrorMessage(err) });
  }
};

export const getFleetUtilization = async (req, res) => {
  try {
    const days = Number(req.query.days ?? 30);
    if (![7, 14, 30, 90].includes(days)) {
      return res.status(400).json({ error: "Days must be one of 7, 14, 30, or 90." });
    }
    const filters = {
      region: typeof req.query.region === 'string' ? req.query.region : '',
      environment: typeof req.query.environment === 'string' ? req.query.environment : '',
      team: typeof req.query.team === 'string' ? req.query.team : '',
    };
    const utilization = await CloudModel.getFleetUtilization(days, filters);
    res.json(utilization);
  } catch (err) {
    res.status(500).json({ error: getErrorMessage(err) });
  }
};

export const getResourcePercentiles = async (req, res) => {
  try {
    const percentiles = await CloudModel.getResourcePercentiles(req.params.id);
    res.json(percentiles);
  } catch (err) {
    res.status(500).json({ error: getErrorMessage(err) });
  }
};

export const getAnomalies = async (req, res) => {
  try {
    const anomalies = await CloudModel.getAnomalies();
    res.json(anomalies);
  } catch (err) {
    res.status(500).json({ error: getErrorMessage(err) });
  }
};

export const getRecommendations = async (req, res) => {
  try {
    const recs = await CloudModel.getAllRecommendations();
    res.json(recs);
  } catch (err) {
    res.status(500).json({ error: getErrorMessage(err) });
  }
};

export const refreshRecommendationsData = async (_req, res) => {
  try {
    const { refreshRecommendations } = await import('../database/connection.js');
    await refreshRecommendations();
    const recs = await CloudModel.getAllRecommendations();
    res.json({ success: true, refreshed: true, recommendations: recs });
  } catch (err) {
    res.status(500).json({ error: getErrorMessage(err) });
  }
};

export const regenerateMetricsAndRecommendations = async (req, res) => {
  try {
    const { seed = Date.now() } = req.body ?? {};

    await new Promise((resolve, reject) => {
      execFile(process.platform === 'win32' ? 'python' : 'python3', [simulatorScript, '--seed', String(seed)], {
        cwd: path.dirname(simulatorScript),
        timeout: 120000,
      }, (error, stdout, stderr) => {
        if (error) {
          reject(new Error(stderr?.trim() || stdout?.trim() || error.message));
        } else {
          resolve({ stdout, stderr });
        }
      });
    });

    const { importGeneratedData, refreshRecommendations } = await import('../database/connection.js');
    const importResult = await importGeneratedData({ force: true });
    await refreshRecommendations();
    const recs = await CloudModel.getAllRecommendations();

    res.json({
      success: true,
      regenerated: true,
      import: importResult,
      recommendations: recs,
    });
  } catch (err) {
    res.status(500).json({ error: getErrorMessage(err) });
  }
};

export const updateRecommendationAction = async (req, res) => {
  try {
    const { status } = req.body ?? {};
    const statusMap = {
      Accepted: 'Accepted',
      Applied: 'Accepted',
      Dismissed: 'Dismissed',
      Implemented: 'Implemented',
    };
    if (!statusMap[status]) {
      return res.status(400).json({ error: "Status must be Accepted, Dismissed, or Implemented." });
    }
    const result = await CloudModel.updateRecommendationStatus(req.params.id, statusMap[status]);
    if (!result.updated) return res.status(404).json({ error: "Recommendation not found." });
    res.json({ success: true, ...result, status: statusMap[status] });
  } catch (err) {
    res.status(500).json({ error: getErrorMessage(err) });
  }
};

export const applyRecommendation = async (req, res) => {
  try {
    const result = await CloudModel.updateRecommendationStatus(req.params.id, 'Accepted');
    if (!result.updated) return res.status(404).json({ error: "Recommendation not found." });
    res.json({ success: true, ...result, status: 'Accepted' });
  } catch (err) {
    res.status(500).json({ error: getErrorMessage(err) });
  }
};

export const dismissRecommendation = async (req, res) => {
  try {
    const result = await CloudModel.updateRecommendationStatus(req.params.id, 'Dismissed');
    if (!result.updated) return res.status(404).json({ error: "Recommendation not found." });
    res.json({ success: true, ...result, status: 'Dismissed' });
  } catch (err) {
    res.status(500).json({ error: getErrorMessage(err) });
  }
};

export const batchApplyRecommendations = async (req, res) => {
  try {
    const { rec_ids } = req.body;
    const savings = await CloudModel.getRecommendationSavings(rec_ids);
    const result = await CloudModel.batchUpdateRecommendations(rec_ids, 'Accepted');
    res.json({ success: true, applied_count: result.updated, total_estimated_savings: savings });
  } catch (err) {
    res.status(500).json({ error: getErrorMessage(err) });
  }
};

export const getCostSummary = async (req, res) => {
  try {
    const summary = await CloudModel.getCostSummary();
    res.json(summary);
  } catch (err) {
    res.status(500).json({ error: getErrorMessage(err) });
  }
};

export const getCostBreakdown = async (req, res) => {
  try {
    const breakdown = await CloudModel.getCostBreakdown();
    res.json(breakdown);
  } catch (err) {
    res.status(500).json({ error: getErrorMessage(err) });
  }
};

export const getCostForecast = async (req, res) => {
  try {
    const summary = await CloudModel.getCostSummary();
    const current = Number(summary?.total_current_spend || 0);
    const utilization = await CloudModel.getWeeklyUtilizationChange();
    const recent = Number(utilization?.recent_usage || 0);
    const previous = Number(utilization?.previous_usage || 0);
    const change = previous > 0 ? Math.max(-0.2, Math.min((recent - previous) / previous, 0.2)) : 0;
    const project = (days) => Math.round(current * Math.max(0, 1 + change * days / 30));
    res.json({
      current_monthly_spend: current,
      forecast_30_days: project(30),
      forecast_60_days: project(60),
      forecast_90_days: project(90),
      utilization_change_pct: Number((change * 100).toFixed(1)),
      method: 'Linear extrapolation of the last 7 days versus the previous 7 days of cost-weighted utilization; capped at 20% change per 30 days.',
    });
  } catch (err) {
    res.status(500).json({ error: getErrorMessage(err) });
  }
};

export const getCostBeforeVsAfter = async (req, res) => {
  try {
    const summary = await CloudModel.getCostSummary();
    const current = Number(summary?.total_current_spend ?? 0);
    const savings = await CloudModel.getPotentialSavings();
    res.json({
      current_monthly_spend: current,
      optimized_monthly_spend: Math.max(0, current - savings),
      projected_monthly_savings: savings,
      included_statuses: ['Pending', 'Accepted', 'Implemented'],
      note: 'Current spend remains based on inventory pricing. Projected savings include all non-dismissed recommendations and do not represent realized bill reductions.',
    });
  } catch (err) {
    res.status(500).json({ error: getErrorMessage(err) });
  }
};

export const getAlerts = async (req, res) => {
  try {
    const [anomalies, fleet, cost, budget, utilization] = await Promise.all([
      CloudModel.getAnomalies(),
      CloudModel.getFleetUtilization(),
      CloudModel.getCostSummary(),
      CloudModel.getMonthlyBudget(),
      CloudModel.getWeeklyUtilizationChange(),
    ]);
    const latestByResource = new Map();
    for (const anomaly of anomalies) {
      if (!latestByResource.has(anomaly.resource_id)) latestByResource.set(anomaly.resource_id, anomaly);
    }
    const alerts = [...latestByResource.values()].map((anomaly) => ({
      alert_id: `anomaly-${anomaly.resource_id}`,
      type: 'utilization-anomaly',
      severity: anomaly.cpu_pct > 95 || anomaly.memory_pct > 95 ? 'High' : 'Medium',
      message: `${anomaly.resource_id} reached ${anomaly.cpu_pct}% CPU and ${anomaly.memory_pct}% memory.`,
      reason: anomaly.is_anomaly === 'true'
        ? 'The simulator marked this interval as an anomalous production spike.'
        : 'A measured CPU or memory value exceeded 90%.',
      timestamp: anomaly.timestamp,
    }));
    const monthlySpend = Number(cost?.total_current_spend || 0);
    const monthlyBudget = Number(budget?.monthly_budget || 0);
    if (monthlyBudget > 0 && monthlySpend >= monthlyBudget) {
      alerts.push({
        alert_id: 'budget-overrun',
        type: 'budget-overrun',
        severity: 'High',
        message: `Current estimated monthly spend (${monthlySpend.toFixed(0)}) exceeds the workspace budget (${monthlyBudget.toFixed(0)}).`,
        reason: 'Inventory monthly prices are above the configured workspace budget.',
        timestamp: new Date().toISOString(),
      });
    } else if (monthlyBudget > 0 && monthlySpend >= monthlyBudget * 0.9) {
      alerts.push({
        alert_id: 'budget-near-limit',
        type: 'budget-risk',
        severity: 'Medium',
        message: `Estimated monthly spend is at ${Math.round(monthlySpend / monthlyBudget * 100)}% of the workspace budget.`,
        reason: 'Inventory monthly prices are within 10% of the configured workspace budget.',
        timestamp: new Date().toISOString(),
      });
    }
    const recentUsage = Number(utilization?.recent_usage || 0);
    const previousUsage = Number(utilization?.previous_usage || 0);
    if (previousUsage > 0 && recentUsage > previousUsage * 1.15) {
      alerts.push({
        alert_id: 'usage-cost-trend',
        type: 'estimated-cost-trend',
        severity: 'Medium',
        message: 'Cost-weighted utilization has risen by more than 15% week over week.',
        reason: 'This is an estimated spend-pressure signal derived from utilization and listed monthly prices, not a cloud billing feed.',
        timestamp: new Date().toISOString(),
      });
    }
    for (const resource of fleet) {
      if (Number(resource.p95_cpu) >= 85 || Number(resource.p95_memory) >= 85) {
        alerts.push({
          alert_id: `capacity-${resource.resource_id}`,
          type: 'capacity-risk',
          severity: 'High',
          message: `${resource.resource_id} is trending toward capacity limits (p95 CPU ${Number(resource.p95_cpu).toFixed(1)}%, memory ${Number(resource.p95_memory).toFixed(1)}%).`,
          reason: 'One or more 95th-percentile utilization metrics is at least 85%.',
          timestamp: resource.latest_timestamp,
        });
      }
    }
    res.json(alerts);
  } catch (err) {
    res.status(500).json({ error: getErrorMessage(err) });
  }
};

export const getForecast = async (req, res) => {
  try {
    const [utilization, forecast] = await Promise.all([
      CloudModel.getWeeklyUtilizationChange(),
      CloudModel.getCostSummary(),
    ]);
    const recent = Number(utilization?.recent_usage || 0);
    const previous = Number(utilization?.previous_usage || 0);
    const growth = previous > 0 ? Math.max(-20, Math.min(((recent - previous) / previous) * 100, 20)) : 0;
    res.json({
      trend: growth > 1 ? 'increasing' : growth < -1 ? 'decreasing' : 'stable',
      projected_growth_rate_pct: Number(growth.toFixed(1)),
      recommendation: Number(forecast?.total_current_spend || 0) > 0
        ? 'Projection compares cost-weighted utilization in the latest week with the prior week. Validate against actual provider billing before budgeting.'
        : 'No inventory cost data is available to create a spend projection.',
      method: 'Cost-weighted utilization trend; this demo has no provider billing history.',
    });
  } catch (err) {
    res.status(500).json({ error: getErrorMessage(err) });
  }
};

export const runOptimizationEngine = async (req, res) => {
  try {
    const { maxBudget, provider = 'local', aiReasoning = false } = req.body ?? {};
    const budget = maxBudget === undefined ? 250000 : Number(maxBudget);
    if (!Number.isFinite(budget) || budget <= 0) {
      return res.status(400).json({ error: 'maxBudget must be a positive finite number.' });
    }

    const [resources, metricRows] = await Promise.all([
      CloudModel.getAllInventory(),
      new Promise((resolve, reject) => {
        db.all(`SELECT * FROM metrics ORDER BY resource_id, timestamp`, (err, rows) => {
          if (err) reject(err);
          else resolve(rows || []);
        });
      }),
    ]);

    const metricsByResource = {};
    for (const row of metricRows) {
      if (!metricsByResource[row.resource_id]) {
        metricsByResource[row.resource_id] = [];
      }
      metricsByResource[row.resource_id].push(row);
    }

    const engine = createOptimizationEngine({
      maxBudget: budget,
      provider,
    });

    const result = engine.run({ resources, metricsByResource });

    if (aiReasoning && provider !== 'local') {
      try {
        const attachedEngine = mountReasoner(engine, provider, {
          apiKey: provider === 'gemini' ? process.env.GEMINI_API_KEY : process.env.OPENAI_API_KEY,
        });
        result.ai = await attachedEngine.ai.reason({
          recommendations: result.recommendations,
          summary: result.summary,
        });
      } catch (reasoningError) {
        result.ai = {
          provider,
          status: 'fallback',
          message: 'AI reasoner could not be mounted; local optimization explanation was used instead.',
          error: getErrorMessage(reasoningError),
        };
      }
    }

    res.json(result);
  } catch (err) {
    res.status(500).json({ error: getErrorMessage(err) });
  }
};

export const runSimulatorWhatIf = async (req, res) => {
  try {
    const { shutdownDevAtNight = false, rightsizeUnderutilized = false } = req.body ?? {};
    if (typeof shutdownDevAtNight !== 'boolean' || typeof rightsizeUnderutilized !== 'boolean') {
      return res.status(400).json({ error: 'Scenario options must be boolean values.' });
    }
    const recommendations = await CloudModel.getAllRecommendations();
    const byResource = new Map();
    for (const recommendation of recommendations) {
      if (recommendation.status !== 'Pending') continue;
      const key = recommendation.resource_id;
      const current = byResource.get(key) ?? {
        cost: Number(recommendation.monthly_cost || 0),
        shutdownSaving: 0,
        rightsizeSaving: 0,
        actions: [],
      };
      if (shutdownDevAtNight && recommendation.rec_id.startsWith('schedule-')) {
        current.shutdownSaving += Number(recommendation.estimated_monthly_saving || 0);
        current.actions.push(recommendation.action);
      }
      if (rightsizeUnderutilized && recommendation.rec_id.startsWith('rightsize-')) {
        current.rightsizeSaving += Number(recommendation.estimated_monthly_saving || 0);
        current.actions.push(recommendation.action);
      }
      byResource.set(key, current);
    }
    const selected = [...byResource.values()].filter((item) => item.actions.length);
    const breakdown = selected.reduce((result, item) => {
      const requested = item.shutdownSaving + item.rightsizeSaving;
      const cap = item.cost > 0 ? item.cost : requested;
      const ratio = requested > cap ? cap / requested : 1;
      result.shutdownDevAtNight += item.shutdownSaving * ratio;
      result.rightsizeUnderutilized += item.rightsizeSaving * ratio;
      return result;
    }, { shutdownDevAtNight: 0, rightsizeUnderutilized: 0 });
    const simulatedSavings = breakdown.shutdownDevAtNight + breakdown.rightsizeUnderutilized;

    res.json({
      simulatedMonthlySavings: simulatedSavings,
      resourceCount: selected.length,
      breakdown,
      message: `Estimated from ${selected.length} eligible resources and their pending recommendation savings. Schedules and resizing are proposals only.`,
    });
  } catch (err) {
    res.status(500).json({ error: getErrorMessage(err) });
  }
};

export const explainAI = async (req, res) => {
  try {
    const { resource_id } = req.body ?? {};
    if (typeof resource_id !== 'string' || !resource_id.trim()) {
      return res.status(400).json({ error: 'A resource_id is required.' });
    }
    const resource = await CloudModel.getResourceById(resource_id.trim());
    if (!resource) return res.status(404).json({ error: 'Resource not found.' });
    const [percentiles, metrics, recommendations] = await Promise.all([
      CloudModel.getResourcePercentiles(resource.resource_id),
      CloudModel.getMetricsForResource(resource.resource_id),
      CloudModel.getAllRecommendations(),
    ]);
    const recommendation = recommendations.find((item) => item.resource_id === resource.resource_id && item.status === 'Pending');
    const latest = metrics.at(-1);
    const reason = recommendation
      ? `${recommendation.action}. ${recommendation.reason} Estimated saving: ${recommendation.estimated_monthly_saving} per month; risk: ${recommendation.risk_level}.`
      : 'No pending optimization recommendation meets the current safety thresholds for this resource.';
    res.json({
      provider: 'local-rules',
      explanation: `${resource.name} (${resource.resource_id}) costs ${resource.monthly_cost} per month. p95 CPU is ${Number(percentiles?.p95_cpu || 0).toFixed(1)}%, p99 CPU ${Number(percentiles?.p99_cpu || 0).toFixed(1)}%, p95 memory ${Number(percentiles?.p95_memory || 0).toFixed(1)}%, and p99 memory ${Number(percentiles?.p99_memory || 0).toFixed(1)}%. Latest sample: ${latest ? `${latest.cpu_pct}% CPU, ${latest.memory_pct}% memory` : 'unavailable'}. ${reason} Estimates use illustrative INR pricing and are not a cloud control action.`
    });
  } catch (err) {
    res.status(500).json({ error: getErrorMessage(err) });
  }
};

export const exportData = async (req, res) => {
  try {
    const format = req.params.format;
    if (!['terraform', 'csv', 'bash'].includes(format)) {
      return res.status(400).json({ error: 'Supported export formats are terraform, csv, and bash.' });
    }
    const [resources, recommendations] = await Promise.all([
      CloudModel.getAllInventory(),
      CloudModel.getAllRecommendations(),
    ]);
    const pending = recommendations.filter((item) => item.status === 'Pending');
    const quoteCsv = (value) => `"${String(value ?? '').replaceAll('"', '""')}"`;
    if (format === 'terraform') {
      const values = pending.map((item) => ({
        resource_id: item.resource_id,
        action: item.action,
        target_configuration: item.target_configuration,
        estimated_monthly_saving_inr: item.estimated_monthly_saving,
        risk_level: item.risk_level,
      }));
      res.json({
        format: 'terraform',
        content: `# Review-only output. This does not modify cloud resources.\nlocals {\n  smartcloud_recommendations = jsondecode(${JSON.stringify(JSON.stringify(values))})\n}`,
      });
    } else if (format === 'csv') {
      res.json({
        format: 'csv',
        content: [
          ['resource_id', 'name', 'type', 'region', 'environment', 'owner', 'vcpu', 'ram_gb', 'disk_size_gb', 'monthly_cost_inr', 'attached_to'],
          ...resources.map((item) => [item.resource_id, item.name, item.type, item.region, item.environment, item.owner, item.vcpu, item.ram_gb, item.disk_size_gb, item.monthly_cost, item.attached_to]),
        ].map((row) => row.map(quoteCsv).join(',')).join('\n'),
      });
    } else {
      res.json({
        format,
        content: `#!/usr/bin/env bash\n# Review-only report. No cloud commands are run.\ncat <<'SMARTCLOUD_RECOMMENDATIONS'\n${pending.map((item) => `${item.resource_id}: ${item.action}; target=${item.target_configuration || 'review'}; estimated_saving_inr=${item.estimated_monthly_saving}; risk=${item.risk_level}`).join('\n')}\nSMARTCLOUD_RECOMMENDATIONS`,
      });
    }
  } catch (err) {
    res.status(500).json({ error: getErrorMessage(err) });
  }
};

export const getSustainability = async (req, res) => {
  try {
    const savings = Number(await CloudModel.getPotentialSavings());
    const energySaved = Number((savings * 0.02).toFixed(1));
    const carbonSaved = Number((energySaved * 0.7).toFixed(1));
    res.json({
      carbon_saved_kg_co2e_per_month: carbonSaved,
      equivalent_trees_planted: Number((carbonSaved * 12 / 22).toFixed(1)),
      energy_saved_kwh: energySaved,
      assumptions: {
        kwh_per_inr_saved: 0.02,
        kg_co2e_per_kwh: 0.7,
        kg_co2e_per_tree_year: 22,
        basis: 'Illustrative factors applied to pending estimated monthly savings; not measured power or a carbon-accounting result.',
      },
    });
  } catch (err) {
    res.status(500).json({ error: getErrorMessage(err) });
  }
};