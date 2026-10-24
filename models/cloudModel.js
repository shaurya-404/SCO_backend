import db from '../database/connection.js';

const normalizeRow = (row) => Object.fromEntries(
  Object.entries(row).map(([key, value]) => [key, typeof value === 'bigint' ? Number(value) : value]),
);

const queryOne = (sql, params = []) => new Promise((resolve, reject) => {
  db.all(sql, ...params, (err, rows) => {
    if (err) reject(err);
    else resolve(rows[0] && normalizeRow(rows[0]));
  });
});

const queryAll = (sql, params = []) => new Promise((resolve, reject) => {
  db.all(sql, ...params, (err, rows) => {
    if (err) reject(err);
    else resolve(rows.map(normalizeRow));
  });
});

export const CloudModel = {
  getUserByEmail: (email) => queryOne(`SELECT * FROM users WHERE email = ?`, [email]),
  getUserById: (userId) => queryOne(`SELECT * FROM users WHERE user_id = ?`, [userId]),

  createUser: (userId, email, password, name, role) => {
    return new Promise((resolve, reject) => {
      db.run(
        `INSERT INTO users (user_id, email, password, name, role, is_admin) VALUES (?, ?, ?, ?, ?, FALSE)`,
        userId, email, password, name, role || 'engineer',
        function(err) {
          if (err) reject(err);
          else resolve({ user_id: userId, email, name, role: role || 'engineer', is_admin: false });
        }
      );
    });
  },

  updateUserProfile: (userId, { name, email, role }) => new Promise((resolve, reject) => {
    db.all(
      `UPDATE users SET name = ?, email = ?, role = ? WHERE user_id = ?
       RETURNING user_id, email, name, role, is_admin`,
      name, email, role, userId,
      (err, rows) => {
        if (err) reject(err);
        else resolve(rows[0] && normalizeRow(rows[0]));
      },
    );
  }),

  getCompanyDetails: () => queryOne(`
    SELECT name, website, industry, contact_email, address
    FROM company_settings WHERE company_id = 'default'
  `),

  updateCompanyDetails: ({ name, website, industry, contact_email, address }) => new Promise((resolve, reject) => {
    db.all(
      `UPDATE company_settings
       SET name = ?, website = ?, industry = ?, contact_email = ?, address = ?
       WHERE company_id = 'default'
       RETURNING name, website, industry, contact_email, address`,
      name, website, industry, contact_email, address,
      (err, rows) => {
        if (err) reject(err);
        else resolve(rows[0] && normalizeRow(rows[0]));
      },
    );
  }),

  getAllInventory: () => {
    return new Promise((resolve, reject) => {
      db.all(`SELECT * FROM inventory`, (err, rows) => {
        if (err) reject(err);
        else resolve(rows);
      });
    });
  },

  getResourceById: (id) => queryOne(`SELECT * FROM inventory WHERE resource_id = ?`, [id]),

  getInventoryStats: () => queryOne(`
    SELECT
      COUNT(*) as total_resources,
      SUM(monthly_cost) as total_monthly_cost,
      SUM(CASE WHEN type = 'VM' THEN 1 ELSE 0 END) as total_vms,
      SUM(CASE WHEN type = 'block-volume' THEN 1 ELSE 0 END) as total_volumes,
      SUM(CASE WHEN type = 'public-ip' THEN 1 ELSE 0 END) as total_ips
    FROM inventory
  `),

  getMetricsForResource: (id, days = 30) => {
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    return queryAll(
      `SELECT * FROM metrics WHERE resource_id = ? AND CAST(timestamp AS TIMESTAMP) >= CAST(? AS TIMESTAMP) ORDER BY timestamp`,
      [id, cutoff],
    );
  },

  getFleetUtilization: async (days, filters = {}) => {
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    const conditions = [`CAST(metrics.timestamp AS TIMESTAMP) >= CAST(? AS TIMESTAMP)`];
    const params = [cutoff];
    for (const [field, value] of [
      ['region', filters.region],
      ['environment', filters.environment],
      ['owner', filters.team],
    ]) {
      if (value) {
        conditions.push(`inventory.${field} = ?`);
        params.push(value);
      }
    }
    const where = conditions.join(' AND ');
    const [summary, history] = await Promise.all([
      queryOne(`SELECT
          COUNT(*) AS sample_count,
          COUNT(DISTINCT metrics.resource_id) AS resource_count,
          MIN(CAST(metrics.timestamp AS TIMESTAMP)) AS history_start,
          MAX(CAST(metrics.timestamp AS TIMESTAMP)) AS history_end,
          AVG(metrics.cpu_pct) AS avg_cpu,
          quantile_cont(metrics.cpu_pct, 0.95) AS p95_cpu,
          AVG(metrics.memory_pct) AS avg_memory,
          quantile_cont(metrics.memory_pct, 0.95) AS p95_memory,
          AVG(metrics.disk_pct) AS avg_disk,
          quantile_cont(metrics.disk_pct, 0.95) AS p95_disk,
          AVG(metrics.iops) AS avg_iops,
          AVG(metrics.network_in_mb) AS avg_network_in_mb,
          AVG(metrics.network_out_mb) AS avg_network_out_mb
        FROM metrics
        JOIN inventory USING (resource_id)
        WHERE ${where}`, params),
      queryAll(`SELECT
          time_bucket(INTERVAL '1 hour', CAST(metrics.timestamp AS TIMESTAMP)) AS timestamp,
          AVG(metrics.cpu_pct) AS cpu_pct,
          MAX(metrics.cpu_pct) AS peak_cpu_pct,
          AVG(metrics.memory_pct) AS memory_pct,
          MAX(metrics.memory_pct) AS peak_memory_pct,
          AVG(metrics.disk_pct) AS disk_pct,
          MAX(metrics.disk_pct) AS peak_disk_pct,
          AVG(metrics.iops) AS iops,
          AVG(metrics.network_in_mb) AS network_in_mb,
          AVG(metrics.network_out_mb) AS network_out_mb,
          COUNT(*) AS sample_count
        FROM metrics
        JOIN inventory USING (resource_id)
        WHERE ${where}
        GROUP BY 1
        ORDER BY 1`, params),
    ]);
    return {
      days,
      filters: {
        region: filters.region || null,
        environment: filters.environment || null,
        team: filters.team || null,
      },
      summary,
      history,
    };
  },

  getResourcePercentiles: (id) => queryOne(`
    SELECT
      quantile_cont(cpu_pct, 0.95) as p95_cpu,
      quantile_cont(cpu_pct, 0.99) as p99_cpu,
      quantile_cont(memory_pct, 0.95) as p95_memory,
      quantile_cont(memory_pct, 0.99) as p99_memory
    FROM metrics
    WHERE resource_id = ?
  `, [id]),

  getAnomalies: () => {
    return new Promise((resolve, reject) => {
      db.all(`
        SELECT * FROM metrics 
        WHERE is_anomaly = 'true' OR cpu_pct > 90 OR memory_pct > 90 
        ORDER BY timestamp DESC LIMIT 100
      `, (err, rows) => {
        if (err) reject(err);
        else resolve(rows);
      });
    });
  },

  getAllRecommendations: () => {
    return new Promise((resolve, reject) => {
      db.all(`SELECT recommendations.*, inventory.name, inventory.type, inventory.region,
          inventory.environment, inventory.owner, inventory.disk_size_gb
        FROM recommendations
        JOIN inventory USING (resource_id)
        ORDER BY estimated_monthly_saving DESC`, (err, rows) => {
        if (err) reject(err);
        else resolve(rows.map(normalizeRow));
      });
    });
  },

  getRecommendationSavings: (recIds) => {
    if (!recIds || recIds.length === 0) return Promise.resolve(0);
    const placeholders = recIds.map(() => '?').join(',');
    return queryOne(
      `SELECT COALESCE(SUM(estimated_monthly_saving), 0) as total_savings
       FROM recommendations
       WHERE status IN ('Pending', 'Accepted', 'Applied', 'Implemented') AND rec_id IN (${placeholders})`,
      recIds,
    ).then((row) => row.total_savings);
  },

  updateRecommendationStatus: (recId, status) => {
    return new Promise((resolve, reject) => {
      db.all(`UPDATE recommendations SET status = ? WHERE rec_id = ? RETURNING rec_id`, status, recId, (err, rows) => {
        if (err) reject(err);
        else resolve({ updated: rows.length });
      });
    });
  },

  batchUpdateRecommendations: (recIds, status) => {
    return new Promise((resolve, reject) => {
      if (!recIds || recIds.length === 0) {
        return resolve({ updated: 0 });
      }
      const placeholders = recIds.map(() => '?').join(',');
      db.all(`UPDATE recommendations SET status = ? WHERE rec_id IN (${placeholders}) RETURNING rec_id`, status, ...recIds, (err, rows) => {
        if (err) reject(err);
        else resolve({ updated: rows.length });
      });
    });
  },

  getCostSummary: () => queryOne(`SELECT SUM(monthly_cost) as total_current_spend FROM inventory`),

  getCostBreakdown: async () => {
    const [envRows, teamRows, savingRows] = await Promise.all([
      queryAll(`SELECT environment, SUM(monthly_cost) AS cost FROM inventory GROUP BY environment`),
      queryAll(`SELECT owner, SUM(monthly_cost) AS cost FROM inventory GROUP BY owner`),
      queryAll(`SELECT inventory.environment, inventory.owner,
          SUM(recommendations.estimated_monthly_saving) AS savings
        FROM recommendations
        JOIN inventory USING (resource_id)
        WHERE recommendations.status IN ('Pending', 'Accepted', 'Applied', 'Implemented')
        GROUP BY inventory.environment, inventory.owner`),
    ]);
    const by_environment = Object.fromEntries(envRows.map((row) => [row.environment, row.cost]));
    const by_department = Object.fromEntries(teamRows.map((row) => [row.owner, row.cost]));
    const savings_by_environment = {};
    const savings_by_department = {};
    for (const row of savingRows) {
      savings_by_environment[row.environment] = (savings_by_environment[row.environment] ?? 0) + row.savings;
      savings_by_department[row.owner] = (savings_by_department[row.owner] ?? 0) + row.savings;
    }
    return {
      by_environment,
      by_department,
      savings_by_environment,
      savings_by_department,
      projected_by_environment: Object.fromEntries(Object.entries(by_environment).map(
        ([environment, cost]) => [environment, Math.max(0, cost - (savings_by_environment[environment] ?? 0))],
      )),
      projected_by_department: Object.fromEntries(Object.entries(by_department).map(
        ([owner, cost]) => [owner, Math.max(0, cost - (savings_by_department[owner] ?? 0))],
      )),
    };
  },

  getPotentialSavings: async () => {
    const row = await queryOne(`SELECT SUM(estimated_monthly_saving) as total_savings
      FROM recommendations
      WHERE status IN ('Pending', 'Accepted', 'Applied', 'Implemented')`);
    return row ? row.total_savings || 0 : 0;
  }
};