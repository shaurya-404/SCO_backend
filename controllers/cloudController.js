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

    const existingUser = await CloudModel.getUserByEmail(email);
    if (existingUser) {
      return res.status(409).json({ error: "User with this email already exists" });
    }

    const userId = `usr-${Date.now()}`;
    const newUser = await CloudModel.createUser(userId, email, password, name, role);

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
      return res.status(400).json({ error: "Provide a valid name, email address, and job description." });
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
    const metrics = await CloudModel.getMetricsForResource(req.params.id);
    res.json(metrics);
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
      execFile('python3', [simulatorScript, '--seed', String(seed)], {
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
    const { status } = req.body;
    const result = await CloudModel.updateRecommendationStatus(req.params.id, status || 'Applied');
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ error: getErrorMessage(err) });
  }
};

export const applyRecommendation = async (req, res) => {
  try {
    const result = await CloudModel.updateRecommendationStatus(req.params.id, 'Applied');
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ error: getErrorMessage(err) });
  }
};

export const dismissRecommendation = async (req, res) => {
  try {
    const result = await CloudModel.updateRecommendationStatus(req.params.id, 'Dismissed');
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ error: getErrorMessage(err) });
  }
};

export const batchApplyRecommendations = async (req, res) => {
  try {
    const { rec_ids } = req.body;
    const savings = await CloudModel.getRecommendationSavings(rec_ids);
    const result = await CloudModel.batchUpdateRecommendations(rec_ids, 'Applied');
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
    const current = summary ? summary.total_current_spend || 245000 : 245000;
    res.json({
      current_monthly_spend: current,
      forecast_30_days: Math.round(current * 1.03),
      forecast_60_days: Math.round(current * 1.06),
      forecast_90_days: Math.round(current * 1.10)
    });
  } catch (err) {
    res.status(500).json({ error: getErrorMessage(err) });
  }
};

export const getCostBeforeVsAfter = async (req, res) => {
  try {
    const summary = await CloudModel.getCostSummary();
    const current = summary ? summary.total_current_spend || 245000 : 245000;
    const savings = await CloudModel.getPotentialSavings();
    res.json({
      current_monthly_spend: current,
      optimized_monthly_spend: Math.max(0, current - savings),
      projected_monthly_savings: savings
    });
  } catch (err) {
    res.status(500).json({ error: getErrorMessage(err) });
  }
};

export const getAlerts = async (req, res) => {
  try {
    const anomalies = await CloudModel.getAnomalies();
    const alerts = anomalies.map((a, i) => ({
      alert_id: `alt-${i + 1}`,
      severity: a.cpu_pct > 95 ? 'High' : 'Medium',
      message: `Resource ${a.resource_id} exhibited high CPU/memory utilization (${a.cpu_pct}% CPU).`,
      timestamp: a.timestamp
    }));
    res.json(alerts);
  } catch (err) {
    res.status(500).json({ error: getErrorMessage(err) });
  }
};

export const getForecast = async (req, res) => {
  try {
    res.json({
      trend: "increasing",
      projected_growth_rate_pct: 3.5,
      recommendation: "Review auto-scaling policies for dev clusters and terminate orphaned storage volumes."
    });
  } catch (err) {
    res.status(500).json({ error: getErrorMessage(err) });
  }
};

export const runOptimizationEngine = async (req, res) => {
  try {
    const { maxBudget, provider = 'local', aiReasoning = false } = req.body ?? {};

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
      maxBudget: Number(maxBudget) || 250000,
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
    const { shutdownDevAtNight, rightsizeUnderutilized } = req.body;
    let simulatedSavings = 0;
    if (shutdownDevAtNight) simulatedSavings += 1450;
    if (rightsizeUnderutilized) simulatedSavings += 2300;

    res.json({
      simulatedMonthlySavings: simulatedSavings,
      message: "Simulation completed successfully based on active parameters."
    });
  } catch (err) {
    res.status(500).json({ error: getErrorMessage(err) });
  }
};

export const explainAI = async (req, res) => {
  try {
    const { resource_id, metrics_summary } = req.body;
    res.json({
      explanation: `AI Cost Analysis for ${resource_id || 'Target Resource'}: Based on metrics (${metrics_summary || 'low utilization'}), this asset is over-provisioned and can be safely rightsized or terminated to reduce monthly burn rate.`
    });
  } catch (err) {
    res.status(500).json({ error: getErrorMessage(err) });
  }
};

export const exportData = async (req, res) => {
  try {
    const format = req.params.format;
    if (format === 'terraform') {
      res.json({
        format: 'terraform',
        content: 'resource "aws_instance" "optimized_vm" { ami = "ami-0c55b159cbfafe1f0" instance_type = "t3.small" }'
      });
    } else if (format === 'csv') {
      res.json({
        format: 'csv',
        content: 'resource_id,name,type,monthly_cost\nvm-cluster-1001,instance-1-prod,VM,3820.0'
      });
    } else {
      res.json({
        format: format || 'json',
        content: '# Automated remediation script\naws ec2 modify-instance-attribute --instance-id vm-cluster-1001 --instance-type t3.small'
      });
    }
  } catch (err) {
    res.status(500).json({ error: getErrorMessage(err) });
  }
};

export const getSustainability = async (req, res) => {
  try {
    res.json({
      carbon_saved_kg_co2e_per_month: 412.5,
      equivalent_trees_planted: 19,
      energy_saved_kwh: 950.0
    });
  } catch (err) {
    res.status(500).json({ error: getErrorMessage(err) });
  }
};