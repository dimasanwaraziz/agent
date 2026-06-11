import pg from 'pg';

const { Pool } = pg;

// Connection config will be pulled from env or use defaults
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/agent_db'
});

export async function initDb() {
  const client = await pool.connect();
  try {
    console.log('Initializing database schema...');
    
    // Create vector extension
    await client.query('CREATE EXTENSION IF NOT EXISTS vector');
    
    // Create settings table
    await client.query(`
      CREATE TABLE IF NOT EXISTS settings (
        key VARCHAR(255) PRIMARY KEY,
        value TEXT NOT NULL
      )
    `);

    // Create messages table
    await client.query(`
      CREATE TABLE IF NOT EXISTS messages (
        id SERIAL PRIMARY KEY,
        session_id VARCHAR(255) NOT NULL,
        role VARCHAR(50) NOT NULL,
        content TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Create memories table (384 dimensions for Xenova/all-MiniLM-L6-v2)
    await client.query(`
      CREATE TABLE IF NOT EXISTS memories (
        id SERIAL PRIMARY KEY,
        content TEXT NOT NULL,
        embedding vector(384) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    console.log('Database schema initialized successfully.');
  } catch (error) {
    console.error('Error initializing database:', error);
    throw error;
  } finally {
    client.release();
  }
}

export async function query(text, params) {
  return pool.query(text, params);
}

export async function getSettings() {
  const res = await query('SELECT * FROM settings');
  const settingsObj = {};
  res.rows.forEach(row => {
    try {
      settingsObj[row.key] = JSON.parse(row.value);
    } catch {
      settingsObj[row.key] = row.value;
    }
  });
  return settingsObj;
}

export async function saveSetting(key, value) {
  const serialized = typeof value === 'string' ? value : JSON.stringify(value);
  await query(
    'INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = $2',
    [key, serialized]
  );
}
