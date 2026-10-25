import db from '../database/connection.js';

const queryOne = (sql) => new Promise((resolve, reject) => {
  db.all(sql, (error, rows) => {
    if (error) reject(error);
    else resolve(rows[0]);
  });
});

const run = (sql, ...params) => new Promise((resolve, reject) => {
  db.run(sql, ...params, (error) => {
    if (error) reject(error);
    else resolve();
  });
});

const closeDatabase = () => new Promise((resolve, reject) => {
  db.close((error) => {
    if (error) reject(error);
    else resolve();
  });
});

try {
  const count = await queryOne('SELECT COUNT(*) AS recommendation_count FROM recommendations');
  await run("UPDATE recommendations SET status = 'Pending'");
  console.log(`Reset ${Number(count.recommendation_count)} recommendation(s) to Pending.`);
} catch (error) {
  console.error('Could not reset recommendation statuses:', error);
  process.exitCode = 1;
} finally {
  try {
    await closeDatabase();
  } catch (error) {
    console.error('Could not close the database connection:', error);
    process.exitCode = 1;
  }
}
