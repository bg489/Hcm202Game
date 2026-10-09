const mysql = require('mysql2/promise');

const memoryGames = new Map();
const scoreEvents = new Map();
const memoryLocks = new Map();
let pool = null;
let storageMode = 'memory';

function configured() {
  return Boolean(process.env.DATABASE_URL || process.env.DB_HOST);
}

function sslConfig() {
  if (process.env.DB_SSL === 'false') return undefined;
  let ca = process.env.DB_SSL_CA || undefined;
  if (process.env.DB_SSL_CA_FILE) {
    const fs = require('node:fs');
    ca = fs.readFileSync(process.env.DB_SSL_CA_FILE, 'utf8');
  }
  return { rejectUnauthorized: true, ...(ca ? { ca } : {}) };
}

async function initialize() {
  if (!configured()) return;
  const common = { waitForConnections: true, connectionLimit: 8, queueLimit: 0, decimalNumbers: true, ssl: sslConfig() };
  if (process.env.DATABASE_URL) {
    const url = new URL(process.env.DATABASE_URL);
    pool = mysql.createPool({
      ...common,
      host: url.hostname,
      port: Number(url.port || 3306),
      database: decodeURIComponent(url.pathname.replace(/^\//, '')),
      user: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
    });
  } else {
    pool = mysql.createPool({ ...common, host: process.env.DB_HOST, port: Number(process.env.DB_PORT || 3306), database: process.env.DB_NAME, user: process.env.DB_USER, password: process.env.DB_PASSWORD });
  }
  await pool.query(`CREATE TABLE IF NOT EXISTS games (
    id VARCHAR(64) PRIMARY KEY,
    state_json LONGTEXT NOT NULL,
    created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)
  ) ENGINE=InnoDB`);
  await pool.query(`CREATE TABLE IF NOT EXISTS scores (
    game_id VARCHAR(64) NOT NULL,
    team_id VARCHAR(64) NOT NULL,
    team_name VARCHAR(100) NOT NULL,
    score INT NOT NULL DEFAULT 0,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (game_id, team_id),
    CONSTRAINT scores_game_fk FOREIGN KEY (game_id) REFERENCES games(id) ON DELETE CASCADE
  ) ENGINE=InnoDB`);
  await pool.query(`CREATE TABLE IF NOT EXISTS score_events (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    game_id VARCHAR(64) NOT NULL,
    team_id VARCHAR(64) NOT NULL,
    points INT NOT NULL,
    reason VARCHAR(255) NOT NULL,
    player_name VARCHAR(100) NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX score_events_game_idx (game_id, created_at),
    CONSTRAINT score_events_game_fk FOREIGN KEY (game_id) REFERENCES games(id) ON DELETE CASCADE
  ) ENGINE=InnoDB`);
  storageMode = 'mysql';
}

function getMode() { return storageMode; }

async function createGame(state) {
  if (!pool) {
    memoryGames.set(state.id, structuredClone(state));
    return structuredClone(state);
  }
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    await connection.execute('INSERT INTO games (id, state_json) VALUES (?, ?)', [state.id, JSON.stringify(state)]);
    for (const team of state.teams) {
      await connection.execute('INSERT INTO scores (game_id, team_id, team_name, score) VALUES (?, ?, ?, ?)', [state.id, team.id, team.name, team.score]);
    }
    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
  return state;
}

async function getGame(id) {
  if (!pool) return memoryGames.has(id) ? structuredClone(memoryGames.get(id)) : null;
  const [rows] = await pool.execute('SELECT state_json FROM games WHERE id = ?', [id]);
  return rows.length ? JSON.parse(rows[0].state_json) : null;
}

async function getLatestGame() {
  if (!pool) {
    const latest = [...memoryGames.values()].sort((a, b) => b.createdAt - a.createdAt)[0];
    return latest ? structuredClone(latest) : null;
  }
  const [rows] = await pool.query('SELECT state_json FROM games ORDER BY created_at DESC, id DESC LIMIT 1');
  return rows.length ? JSON.parse(rows[0].state_json) : null;
}

async function updateGame(id, mutator) {
  if (!pool) {
    const previous = memoryLocks.get(id) || Promise.resolve();
    let release;
    const lock = new Promise((resolve) => { release = resolve; });
    memoryLocks.set(id, lock);
    await previous;
    try {
      const current = memoryGames.get(id);
      if (!current) return null;
      const result = await mutator(structuredClone(current));
      if (result?.state) {
        memoryGames.set(id, structuredClone(result.state));
        if (result.scoreEvent) scoreEvents.set(id, [...(scoreEvents.get(id) || []), result.scoreEvent]);
      }
      return result;
    } finally {
      release();
      if (memoryLocks.get(id) === lock) memoryLocks.delete(id);
    }
  }

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [rows] = await connection.execute('SELECT state_json FROM games WHERE id = ? FOR UPDATE', [id]);
    if (!rows.length) { await connection.rollback(); return null; }
    const result = await mutator(JSON.parse(rows[0].state_json));
    if (result?.state) {
      const state = result.state;
      await connection.execute('UPDATE games SET state_json = ? WHERE id = ?', [JSON.stringify(state), id]);
      for (const team of state.teams) {
        await connection.execute(`INSERT INTO scores (game_id, team_id, team_name, score) VALUES (?, ?, ?, ?)
          ON DUPLICATE KEY UPDATE team_name = VALUES(team_name), score = VALUES(score)`, [id, team.id, team.name, team.score]);
      }
      if (result.scoreEvent) {
        const ev = result.scoreEvent;
        await connection.execute('INSERT INTO score_events (game_id, team_id, points, reason, player_name) VALUES (?, ?, ?, ?, ?)', [id, ev.teamId, ev.points, ev.reason, ev.playerName]);
      }
    }
    await connection.commit();
    return result;
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

async function getScores(gameId) {
  if (!pool) {
    const game = memoryGames.get(gameId);
    return game ? game.teams.map(({ id, name, score }) => ({ teamId: id, teamName: name, score })) : [];
  }
  const [rows] = await pool.execute('SELECT team_id AS teamId, team_name AS teamName, score FROM scores WHERE game_id = ? ORDER BY score DESC', [gameId]);
  return rows;
}

module.exports = { initialize, getMode, createGame, getGame, getLatestGame, updateGame, getScores };
