import duckdb from 'duckdb';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { buildRecommendations } from '../optimization_engine/core/recommendationEngine.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const dbDir = path.join(__dirname, '../../DATABASE');
if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
}

const dbPath = process.env.DB_PATH
    ? path.resolve(process.cwd(), process.env.DB_PATH)
    : path.join(dbDir, 'local_metrics.duckdb');

function resetLocalDatabase() {
    const walPath = `${dbPath}.wal`;
    const shmPath = `${dbPath}.shm`;
    [dbPath, walPath, shmPath].forEach((filePath) => {
        if (fs.existsSync(filePath)) {
            fs.rmSync(filePath, { force: true });
        }
    });
}

function createDatabaseConnection() {
    try {
        return new duckdb.Database(dbPath);
    } catch (error) {
        console.warn('DuckDB connection failed while opening the local database. Resetting the local DB.', error);
        resetLocalDatabase();
        return new duckdb.Database(dbPath);
    }
}

let db = createDatabaseConnection();

export async function ensureDatabaseConnection() {
    await new Promise((resolve, reject) => {
        db.all('SELECT 1 AS ok', (err, rows) => {
            if (err) {
                reject(err);
                return;
            }
            resolve(rows);
        });
    }).catch((error) => {
        console.warn('DuckDB connection was stale or corrupted. Rebuilding the local database.', error);
        resetLocalDatabase();
        db = new duckdb.Database(dbPath);
    });
}

const all = (sql, ...params) => new Promise((resolve, reject) => {
    db.all(sql, ...params, (err, rows) => {
        if (err) reject(err);
        else resolve(rows);
    });
});

const run = (sql, ...params) => new Promise((resolve, reject) => {
    db.run(sql, ...params, (err) => {
        if (err) reject(err);
        else resolve();
    });
});

const generatedDataDir = path.join(__dirname, '../simulator/generated');
const sqlString = (value) => `'${value.replaceAll("'", "''")}'`;

export async function refreshRecommendations(withinTransaction = false) {
    if (!withinTransaction) {
        await run('BEGIN TRANSACTION');
    }
    try {
        await run(`CREATE OR REPLACE TEMP TABLE generated_recommendations AS
            WITH metric_summary AS (
            SELECT
                resource_id,
                COUNT(*) AS sample_count,
                MAX(cpu_pct) AS max_cpu,
                MAX(memory_pct) AS max_memory,
                quantile_cont(cpu_pct, 0.95) AS p95_cpu,
                quantile_cont(cpu_pct, 0.99) AS p99_cpu,
                quantile_cont(memory_pct, 0.95) AS p95_memory,
                quantile_cont(memory_pct, 0.99) AS p99_memory,
                MAX(disk_pct) AS max_disk,
                MAX(iops) AS max_iops,
                MAX(network_in_mb) AS max_network_in,
                MAX(network_out_mb) AS max_network_out,
                quantile_cont(cpu_pct, 0.95) FILTER (
                    WHERE EXTRACT(hour FROM CAST(timestamp AS TIMESTAMP)) >= 20
                       OR EXTRACT(hour FROM CAST(timestamp AS TIMESTAMP)) < 8
                       OR EXTRACT(isodow FROM CAST(timestamp AS TIMESTAMP)) >= 6
                ) AS off_hours_p95_cpu,
                quantile_cont(memory_pct, 0.95) FILTER (
                    WHERE EXTRACT(hour FROM CAST(timestamp AS TIMESTAMP)) >= 20
                       OR EXTRACT(hour FROM CAST(timestamp AS TIMESTAMP)) < 8
                       OR EXTRACT(isodow FROM CAST(timestamp AS TIMESTAMP)) >= 6
                ) AS off_hours_p95_memory
            FROM metrics
            GROUP BY resource_id
        ),
        candidates AS (
            SELECT
                'orphan-' || inventory.resource_id AS rec_id,
                inventory.resource_id,
                CASE inventory.type
                    WHEN 'block-volume' THEN 'Remove unattached block volume'
                    ELSE 'Release unattached public IP'
                END AS action,
                'No attachment and zero disk, I/O, and network activity across at least 14 days of recorded metrics.'
                    AS reason,
                ROUND(inventory.monthly_cost, 2) AS estimated_monthly_saving,
                'Safe' AS risk_level,
                NULL::VARCHAR AS target_configuration,
                95.0 AS confidence
            FROM inventory
            JOIN metric_summary USING (resource_id)
            WHERE inventory.type IN ('block-volume', 'public-ip')
                AND NULLIF(TRIM(inventory.attached_to), '') IS NULL
                AND inventory.monthly_cost > 0
                AND metric_summary.sample_count >= 1344
                AND metric_summary.max_disk = 0
                AND metric_summary.max_iops = 0
                AND metric_summary.max_network_in = 0
                AND metric_summary.max_network_out = 0

            UNION ALL

            SELECT
                'rightsize-' || inventory.resource_id AS rec_id,
                inventory.resource_id,
                'Right-size VM to '
                    || CAST(GREATEST(1, CAST(inventory.vcpu / 2 AS INTEGER)) AS VARCHAR)
                    || ' vCPU / '
                    || CAST(GREATEST(1, CAST(inventory.ram_gb / 2 AS INTEGER)) AS VARCHAR)
                    || ' GB RAM' AS action,
                'Utilization across '
                    || CAST(metric_summary.sample_count AS VARCHAR)
                    || ' recorded samples is consistently low (p95 CPU '
                    || CAST(ROUND(metric_summary.p95_cpu, 1) AS VARCHAR)
                    || '%, p99 CPU '
                    || CAST(ROUND(metric_summary.p99_cpu, 1) AS VARCHAR)
                    || '%, p95 memory '
                    || CAST(ROUND(metric_summary.p95_memory, 1) AS VARCHAR)
                    || '%, p99 memory '
                    || CAST(ROUND(metric_summary.p99_memory, 1) AS VARCHAR)
                    || '%). Proposed target halves the current vCPU and memory; verify workload and provider pricing before rollout.'
                    AS reason,
                ROUND(GREATEST(0,
                    inventory.monthly_cost - (
                        GREATEST(1, CAST(inventory.vcpu / 2 AS INTEGER)) * 600
                        + GREATEST(1, CAST(inventory.ram_gb / 2 AS INTEGER)) * 150
                        + inventory.disk_size_gb * 4
                    )
                ), 2) AS estimated_monthly_saving,
                CASE
                    WHEN metric_summary.p99_cpu <= 15 AND metric_summary.p99_memory <= 40 THEN 'Low'
                    ELSE 'Medium'
                END AS risk_level,
                CAST(GREATEST(1, CAST(inventory.vcpu / 2 AS INTEGER)) AS VARCHAR)
                    || ' vCPU / '
                    || CAST(GREATEST(1, CAST(inventory.ram_gb / 2 AS INTEGER)) AS VARCHAR)
                    || ' GB RAM' AS target_configuration,
                CASE
                    WHEN metric_summary.p99_cpu <= 15 AND metric_summary.p99_memory <= 40 THEN 90.0
                    ELSE 75.0
                END AS confidence
            FROM inventory
            JOIN metric_summary USING (resource_id)
            WHERE inventory.type = 'VM'
                AND metric_summary.sample_count >= 1344
                AND metric_summary.p95_cpu <= 20
                AND metric_summary.p99_cpu <= 30
                AND metric_summary.p95_memory <= 50
                AND metric_summary.p99_memory <= 60
                AND metric_summary.max_cpu <= 90
                AND metric_summary.max_memory <= 90
                AND inventory.vcpu >= 4

            UNION ALL

            SELECT
                'schedule-' || inventory.resource_id AS rec_id,
                inventory.resource_id,
                'Schedule off-hours shutdown (8 PM–8 AM)' AS action,
                'Recorded off-hours and weekend p95 utilization is low (CPU '
                    || CAST(ROUND(metric_summary.off_hours_p95_cpu, 1) AS VARCHAR)
                    || '%, memory '
                    || CAST(ROUND(metric_summary.off_hours_p95_memory, 1) AS VARCHAR)
                    || '%). Schedule only after confirming no overnight jobs or availability requirements.'
                    AS reason,
                ROUND(inventory.monthly_cost * 0.5, 2) AS estimated_monthly_saving,
                'Medium' AS risk_level,
                'Weekdays 8 PM–8 AM; weekends: stopped' AS target_configuration,
                70.0 AS confidence
            FROM inventory
            JOIN metric_summary USING (resource_id)
            WHERE inventory.type = 'VM'
                AND inventory.environment IN ('dev', 'staging')
                AND metric_summary.sample_count >= 1344
                AND metric_summary.off_hours_p95_cpu <= 10
                AND metric_summary.off_hours_p95_memory <= 30
            )
            SELECT
                candidates.rec_id,
                candidates.resource_id,
                candidates.action,
                candidates.reason,
                candidates.estimated_monthly_saving,
                candidates.risk_level,
                candidates.target_configuration,
                candidates.confidence,
                COALESCE(recommendations.status, 'Pending') AS status
            FROM candidates
            LEFT JOIN recommendations USING (rec_id)`);

        await run(`DELETE FROM recommendations`);
        await run(`INSERT INTO recommendations (
            rec_id, resource_id, action, reason, estimated_monthly_saving, risk_level,
            target_configuration, confidence, status
        )
        SELECT rec_id, resource_id, action, reason, estimated_monthly_saving, risk_level,
            target_configuration, confidence, status
        FROM generated_recommendations`);
        await run(`DROP TABLE generated_recommendations`);
        const [resources, metricSummaries, existing] = await Promise.all([
            all(`SELECT * FROM inventory`),
            all(`SELECT
                    resource_id, COUNT(*) AS sample_count,
                    MIN(CAST(timestamp AS TIMESTAMP)) AS first_timestamp,
                    MAX(CAST(timestamp AS TIMESTAMP)) AS last_timestamp,
                    MAX(cpu_pct) AS max_cpu, MAX(memory_pct) AS max_memory,
                    quantile_cont(cpu_pct, 0.95) AS p95_cpu,
                    quantile_cont(cpu_pct, 0.99) AS p99_cpu,
                    quantile_cont(memory_pct, 0.95) AS p95_memory,
                    quantile_cont(memory_pct, 0.99) AS p99_memory,
                    MAX(disk_pct) AS max_disk, MAX(iops) AS max_iops,
                    MAX(network_in_mb) AS max_network_in,
                    MAX(network_out_mb) AS max_network_out
                FROM metrics GROUP BY resource_id`),
            all(`SELECT rec_id, status FROM recommendations`),
        ]);
        const summaries = new Map(metricSummaries.map((summary) => [summary.resource_id, summary]));
        const previousStatuses = new Map(existing.map((recommendation) => [
            recommendation.rec_id,
            recommendation.status === 'Applied' ? 'Accepted' : recommendation.status,
        ]));
        const recommendations = buildRecommendations(resources, summaries);

        await run(`DELETE FROM recommendations`);
        for (const recommendation of recommendations) {
            await run(`INSERT INTO recommendations (
                rec_id, resource_id, action, reason, estimated_monthly_saving, risk_level, status,
                current_vcpu, current_ram_gb, target_vcpu, target_ram_gb,
                current_monthly_cost, target_monthly_cost, p95_cpu, p99_cpu,
                p95_memory, p99_memory, sample_count, history_days
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            recommendation.rec_id,
            recommendation.resource_id,
            recommendation.action,
            recommendation.reason,
            recommendation.estimated_monthly_saving,
            recommendation.risk_level,
            previousStatuses.get(recommendation.rec_id) ?? 'Pending',
            recommendation.current_vcpu,
            recommendation.current_ram_gb,
            recommendation.target_vcpu,
            recommendation.target_ram_gb,
            recommendation.current_monthly_cost,
            recommendation.target_monthly_cost,
            recommendation.p95_cpu,
            recommendation.p99_cpu,
            recommendation.p95_memory,
            recommendation.p99_memory,
            recommendation.sample_count,
            recommendation.history_days);
        }
        if (!withinTransaction) {
            await run('COMMIT');
        }
    } catch (error) {
        if (!withinTransaction) {
            try {
                await run('ROLLBACK');
            } catch (rollbackError) {
                throw new AggregateError([error, rollbackError], 'Recommendation refresh and rollback both failed');
            }
        }
        throw error;
    }
}

async function ensureGeneratedDataTables() {
    await run(`CREATE TABLE IF NOT EXISTS inventory (
        resource_id VARCHAR PRIMARY KEY,
        name VARCHAR,
        type VARCHAR,
        region VARCHAR,
        environment VARCHAR,
        owner VARCHAR,
        vcpu INT,
        ram_gb INT,
        disk_size_gb INT,
        monthly_cost DOUBLE,
        creation_date VARCHAR,
        attached_to VARCHAR,
        workload_pattern VARCHAR
    )`);
    await run(`CREATE TABLE IF NOT EXISTS metrics (
        resource_id VARCHAR,
        timestamp VARCHAR,
        cpu_pct DOUBLE,
        memory_pct DOUBLE,
        disk_pct DOUBLE,
        iops DOUBLE,
        network_in_mb DOUBLE,
        network_out_mb DOUBLE,
        is_anomaly VARCHAR DEFAULT 'false'
    )`);
    await run(`CREATE TABLE IF NOT EXISTS recommendations (
        rec_id VARCHAR PRIMARY KEY,
        resource_id VARCHAR,
        action VARCHAR,
        reason VARCHAR,
        estimated_monthly_saving DOUBLE,
        risk_level VARCHAR,
        target_configuration VARCHAR,
        confidence DOUBLE,
        status VARCHAR,
        current_vcpu INT,
        current_ram_gb INT,
        target_vcpu INT,
        target_ram_gb INT,
        current_monthly_cost DOUBLE,
        target_monthly_cost DOUBLE,
        p95_cpu DOUBLE,
        p99_cpu DOUBLE,
        p95_memory DOUBLE,
        p99_memory DOUBLE,
        sample_count INT,
        history_days DOUBLE
    )`);
    const recommendationColumns = await all(`PRAGMA table_info('recommendations')`);
    if (!recommendationColumns.some((column) => column.name === 'target_configuration')) {
        await run(`ALTER TABLE recommendations ADD COLUMN target_configuration VARCHAR`);
    }
    if (!recommendationColumns.some((column) => column.name === 'confidence')) {
        await run(`ALTER TABLE recommendations ADD COLUMN confidence DOUBLE`);
    }

    const inventoryColumns = await all(`PRAGMA table_info('inventory')`);
    if (!inventoryColumns.some((column) => column.name === 'attached_to')) {
        await run(`ALTER TABLE inventory ADD COLUMN attached_to VARCHAR`);
    }
    if (!inventoryColumns.some((column) => column.name === 'workload_pattern')) {
        await run(`ALTER TABLE inventory ADD COLUMN workload_pattern VARCHAR`);
    }

    const metricColumns = await all(`PRAGMA table_info('metrics')`);
    if (!metricColumns.some((column) => column.name === 'iops')) {
        await run(`ALTER TABLE metrics ADD COLUMN iops DOUBLE`);
    }

    //const recommendationColumns = await all(`PRAGMA table_info('recommendations')`);
    const recommendationMigrations = {
        current_vcpu: 'INT',
        current_ram_gb: 'INT',
        target_vcpu: 'INT',
        target_ram_gb: 'INT',
        current_monthly_cost: 'DOUBLE',
        target_monthly_cost: 'DOUBLE',
        p95_cpu: 'DOUBLE',
        p99_cpu: 'DOUBLE',
        p95_memory: 'DOUBLE',
        p99_memory: 'DOUBLE',
        sample_count: 'INT',
        history_days: 'DOUBLE',
    };
    for (const [column, type] of Object.entries(recommendationMigrations)) {
        if (!recommendationColumns.some((item) => item.name === column)) {
            await run(`ALTER TABLE recommendations ADD COLUMN ${column} ${type}`);
        }
    }
    await run(`UPDATE recommendations SET status = 'Accepted' WHERE status = 'Applied'`);
}

export async function importGeneratedData({ force = false } = {}) {
    const resourcePath = path.join(generatedDataDir, 'resources.csv');
    const metricsPath = path.join(generatedDataDir, 'metrics.csv');
    const [resourceStats, metricsStats] = await Promise.all([
        fs.promises.stat(resourcePath),
        fs.promises.stat(metricsPath),
    ]);
    const fingerprint = JSON.stringify([
        resourceStats.size,
        resourceStats.mtimeMs,
        metricsStats.size,
        metricsStats.mtimeMs,
    ]);

    await ensureGeneratedDataTables();
    await run(`CREATE TABLE IF NOT EXISTS generated_data_imports (
        dataset_name VARCHAR PRIMARY KEY,
        fingerprint VARCHAR NOT NULL
    )`);

    if (!force) {
        const previousImport = await all(
            `SELECT fingerprint FROM generated_data_imports WHERE dataset_name = 'simulator'`,
        );
        if (previousImport[0]?.fingerprint === fingerprint) {
            await refreshRecommendations();
            return { imported: false };
        }
    }

    const escapedResourcePath = sqlString(resourcePath);
    const escapedMetricsPath = sqlString(metricsPath);
    await run('BEGIN TRANSACTION');
    try {
        await run(`CREATE OR REPLACE TEMP TABLE generated_resources AS
            SELECT * FROM read_csv_auto(${escapedResourcePath}, header = true)`);
        await run(`CREATE OR REPLACE TEMP TABLE generated_metrics AS
            SELECT * FROM read_csv_auto(${escapedMetricsPath}, header = true)`);

        await run(`DELETE FROM inventory`);
        await run(`INSERT INTO inventory (
            resource_id, name, type, region, environment, owner, vcpu, ram_gb,
            disk_size_gb, monthly_cost, creation_date, attached_to, workload_pattern
        )
        SELECT resource_id, name, type, region, environment, owner, vcpu, ram_gb,
            disk_size_gb, monthly_cost, creation_date, attached_to, workload_pattern
        FROM generated_resources`);

        await run(`DELETE FROM metrics`);
        await run(`INSERT INTO metrics (
            resource_id, timestamp, cpu_pct, memory_pct, disk_pct, iops,
            network_in_mb, network_out_mb, is_anomaly
        )
        SELECT resource_id, CAST(timestamp AS VARCHAR), cpu_pct, memory_pct,
            disk_pct, iops, network_in_mb, network_out_mb, CAST(is_anomaly AS VARCHAR)
        FROM generated_metrics`);

        await refreshRecommendations(true);

        await run(`DELETE FROM generated_data_imports WHERE dataset_name = 'simulator'`);
        await run(
            `INSERT INTO generated_data_imports (dataset_name, fingerprint) VALUES ('simulator', ?)`,
            fingerprint,
        );

        const resources = await all(`SELECT COUNT(*) AS count FROM inventory`);
        const metrics = await all(`SELECT COUNT(*) AS count FROM metrics`);
        await run('DROP TABLE generated_resources');
        await run('DROP TABLE generated_metrics');
        await run('COMMIT');
        return {
            imported: true,
            resourceCount: Number(resources[0].count),
            metricCount: Number(metrics[0].count),
        };
    } catch (error) {
        try {
            await run('ROLLBACK');
        } catch (rollbackError) {
            throw new AggregateError([error, rollbackError], 'Generated data import and rollback both failed');
        }
        throw error;
    }
}

export async function initializeDatabase() {
    await ensureDatabaseConnection();

    await run(`CREATE TABLE IF NOT EXISTS users (
        user_id VARCHAR PRIMARY KEY,
        email VARCHAR,
        password VARCHAR,
        name VARCHAR,
        role VARCHAR,
        is_admin BOOLEAN DEFAULT FALSE
    )`);

    const userColumns = await all(`PRAGMA table_info('users')`);
    if (!userColumns.some((column) => column.name === 'is_admin')) {
        await run(`ALTER TABLE users ADD COLUMN is_admin BOOLEAN DEFAULT FALSE`);
    }

    const users = await all(`SELECT user_id FROM users LIMIT 1`);
    if (users.length === 0) {
        await run(`INSERT INTO users (user_id, email, password, name, role, is_admin) VALUES
            ('usr-1', 'engineer@cloud.com', 'password123', 'Alex (DevOps)', 'engineer', FALSE),
            ('usr-2', 'finance@cloud.com', 'password123', 'Sarah (Finance)', 'finance', FALSE),
            ('usr-3', 'admin@cloud.com', 'password123', 'Leadership', 'leadership', TRUE)`);
    }
    await run(`CREATE TABLE IF NOT EXISTS company_settings (
        company_id VARCHAR PRIMARY KEY,
        name VARCHAR NOT NULL,
        website VARCHAR NOT NULL,
        industry VARCHAR NOT NULL,
        contact_email VARCHAR NOT NULL,
        address VARCHAR NOT NULL,
        monthly_budget DOUBLE DEFAULT 1000000
    )`);
    const companyColumns = await all(`PRAGMA table_info('company_settings')`);
    if (!companyColumns.some((column) => column.name === 'monthly_budget')) {
        await run(`ALTER TABLE company_settings ADD COLUMN monthly_budget DOUBLE DEFAULT 1000000`);
    }

    const company = await all(`SELECT company_id FROM company_settings WHERE company_id = 'default'`);
    if (company.length === 0) {
        await run(`INSERT INTO company_settings (
            company_id, name, website, industry, contact_email, address, monthly_budget
        ) VALUES ('default', 'Your Company', '', '', '', '', 1000000)`);
    }

    await run(`UPDATE users SET is_admin = TRUE WHERE user_id = 'usr-3' AND email = 'admin@cloud.com' AND role = 'leadership'`);

    const importResult = await importGeneratedData();
    if (importResult.imported) {
        console.log(
            `Imported simulator data: ${importResult.resourceCount} resources and ${importResult.metricCount} metrics.`,
        );
    }
}

export default db;