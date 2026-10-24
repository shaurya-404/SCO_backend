import express from "express"
import * as controller from "../controllers/cloudController.js"
import { authenticateToken, requireAdmin } from "../middleware/middleware.js"

const router = express.Router()

// Auth Routes
router.post("/auth/register", controller.register)
router.post("/auth/login", controller.login)
router.get("/auth/me", authenticateToken, controller.getMe)
router.put("/auth/profile", authenticateToken, controller.updateProfile)
router.get("/company", authenticateToken, controller.getCompanyDetails)
router.put("/company", authenticateToken, requireAdmin, controller.updateCompanyDetails)

// Core Resource & Analytics Routes (Protected)
router.get("/inventory", authenticateToken, controller.getInventory)
router.get("/inventory/stats", authenticateToken, controller.getInventoryStats)
router.get("/metrics/fleet", authenticateToken, controller.getFleetMetrics)
router.get("/resources/:id", authenticateToken, controller.getResourceById)
router.get("/metrics/anomalies", authenticateToken, controller.getAnomalies)
router.get("/metrics/:id", authenticateToken, controller.getResourceMetrics)
router.get("/metrics/:id/percentiles", authenticateToken, controller.getResourcePercentiles)

// Recommendations Routes
router.get("/recommendations", authenticateToken, controller.getRecommendations)
router.post("/recommendations/refresh", authenticateToken, controller.refreshRecommendationsData)
router.post("/recommendations/regenerate", authenticateToken, controller.regenerateMetricsAndRecommendations)
router.post("/recommendations/:id/action", authenticateToken, controller.updateRecommendationAction)
router.post("/recommendations/:id/apply", authenticateToken, controller.applyRecommendation)
router.post("/recommendations/:id/dismiss", authenticateToken, controller.dismissRecommendation)
router.post("/recommendations/batch-apply", authenticateToken, controller.batchApplyRecommendations)

// Cost Analysis Routes
router.get("/costs/summary", authenticateToken, controller.getCostSummary)
router.get("/costs/breakdown", authenticateToken, controller.getCostBreakdown)
router.get("/costs/forecast", authenticateToken, controller.getCostForecast)
router.get("/costs/before-vs-after", authenticateToken, controller.getCostBeforeVsAfter)

// Alerts & Bonus Features Routes
router.get("/alerts", authenticateToken, controller.getAlerts)
router.get("/forecast", authenticateToken, controller.getForecast)
router.post("/optimization/run", authenticateToken, controller.runOptimizationEngine)
router.post("/simulator/what-if", authenticateToken, controller.runSimulatorWhatIf)
router.post("/ai/explain", authenticateToken, controller.explainAI)
router.get("/export/:format", authenticateToken, controller.exportData)
router.get("/sustainability", authenticateToken, controller.getSustainability)

export default router