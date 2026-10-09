require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const db = require('./database');
const { makeNewGame, applyAction } = require('./game');

const app = express();
const port = Number(process.env.PORT || 4000);
const adminSessions = new Map();
const gameStateSubscribers = new Set();
const ADMIN_ONLY_ACTIONS = new Set(['update_question', 'set_sound']);
const PLAYER_ONLY_ACTIONS = new Set(['join_team', 'leave_team', 'buzz', 'answer']);
const uploadDir = process.env.UPLOAD_DIR || path.join(__dirname, '..', 'uploads');
fs.mkdirSync(uploadDir, { recursive: true });
const origins = (process.env.CORS_ORIGIN || 'http://localhost:5173').split(',').map((value) => value.trim()).filter(Boolean);
app.use(cors({ origin(origin, callback) {
  if (!origin || origins.includes('*') || origins.includes(origin)) return callback(null, true);
  return callback(new Error(`Origin ${origin} is not allowed by CORS.`));
} }));
app.use(express.json({ limit: '1mb' }));
app.use('/uploads', express.static(uploadDir, { maxAge: '1d' }));

function readAdminToken(req) {
  const match = /^Bearer\s+(.+)$/i.exec(req.get('authorization') || '');
  return match?.[1] || '';
}

function isAdmin(req) {
  const token = readAdminToken(req);
  const createdAt = adminSessions.get(token);
  if (!createdAt) return false;
  if (Date.now() - createdAt > 12 * 60 * 60 * 1000) {
    adminSessions.delete(token);
    return false;
  }
  return true;
}

function requireAdmin(req, res, next) {
  if (isAdmin(req)) return next();
  return res.status(401).json({ error: 'Thao tác này chỉ dành cho chủ trì trò chơi. Hãy đăng nhập admin.' });
}

function safeEqual(value, expected) {
  const valueBuffer = Buffer.from(String(value || ''));
  const expectedBuffer = Buffer.from(String(expected || ''));
  return valueBuffer.length === expectedBuffer.length && crypto.timingSafeEqual(valueBuffer, expectedBuffer);
}

const storage = multer.diskStorage({
  destination: (_req, _file, callback) => callback(null, uploadDir),
  filename: (_req, file, callback) => callback(null, `${crypto.randomUUID()}${path.extname(file.originalname).toLowerCase()}`),
});
const upload = multer({
  storage,
  limits: { fileSize: 12 * 1024 * 1024 },
  fileFilter: (_req, file, callback) => {
    if (['audio/mpeg', 'audio/mp3', 'audio/wav', 'audio/x-wav', 'audio/ogg', 'audio/mp4', 'audio/aac', 'audio/webm'].includes(file.mimetype)) return callback(null, true);
    return callback(new Error('Chỉ nhận file âm thanh MP3, WAV, OGG, AAC hoặc WebM.'));
  },
});

function publicState(state) {
  const copy = structuredClone(state);
  copy.teams.forEach((team) => team.members.forEach((member) => { delete member.playerTokenHash; }));
  if (copy.startedAt) copy.questions.forEach((question) => { delete question.correctIndex; });
  copy.serverNow = Date.now();
  return copy;
}

function sendGameState(response, state) {
  if (response.destroyed || response.writableEnded) return;
  response.write(`event: game-state\ndata: ${JSON.stringify(state)}\n\n`);
}

function publishGameState(state) {
  for (const response of gameStateSubscribers) {
    try {
      sendGameState(response, state);
    } catch {
      gameStateSubscribers.delete(response);
    }
  }
}

function resolvePlayerSession(state, req) {
  const token = req.get('x-player-token') || '';
  if (!token) return null;
  const tokenHash = crypto.createHash('sha256').update(token).digest();
  for (const team of state.teams) {
    for (const member of team.members) {
      if (!member.playerTokenHash) continue;
      const savedHash = Buffer.from(member.playerTokenHash, 'hex');
      if (savedHash.length === tokenHash.length && crypto.timingSafeEqual(savedHash, tokenHash)) {
        return { playerId: member.id, teamId: team.id, groupNumber: member.groupNumber, name: member.name };
      }
    }
  }
  return null;
}

app.post('/api/admin/login', (req, res) => {
  const username = String(req.body?.username || '');
  const password = String(req.body?.password || '');
  const expectedUsername = process.env.ADMIN_USERNAME || 'admin';
  const expectedPassword = process.env.ADMIN_PASSWORD || '12345';
  if (username !== expectedUsername || !safeEqual(password, expectedPassword)) {
    return res.status(401).json({ error: 'Tên đăng nhập hoặc mật khẩu chưa đúng.' });
  }
  const token = crypto.randomBytes(32).toString('hex');
  adminSessions.set(token, Date.now());
  return res.json({ token, role: 'admin', username: expectedUsername });
});

app.get('/api/admin/session', requireAdmin, (_req, res) => res.json({ authenticated: true, role: 'admin' }));
app.post('/api/admin/logout', (req, res) => {
  const token = readAdminToken(req);
  if (token) adminSessions.delete(token);
  return res.status(204).end();
});

app.get('/api/health', (_req, res) => res.json({ ok: true, storage: db.getMode() }));
app.get('/api/games/latest', async (_req, res, next) => {
  try {
    const state = await db.getLatestGame();
    res.json(state ? publicState(state) : null);
  } catch (error) { next(error); }
});
app.get('/api/games/stream', async (req, res) => {
  res.status(200).set({
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();
  gameStateSubscribers.add(res);
  let closed = false;
  const heartbeat = setInterval(() => {
    try {
      if (!res.destroyed && !res.writableEnded) res.write(': keep-alive\n\n');
    } catch {
      cleanup();
    }
  }, 20000);
  const cleanup = () => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    gameStateSubscribers.delete(res);
  };
  res.on('close', cleanup);
  try {
    const state = await db.getLatestGame();
    if (state) sendGameState(res, publicState(state));
  } catch (error) {
    console.error('Game event stream failed:', error.message);
    cleanup();
    res.end();
  }
});
app.get('/api/games/:id', async (req, res, next) => {
  try {
    const state = await db.getGame(req.params.id);
    if (!state) return res.status(404).json({ error: 'Không tìm thấy game.' });
    return res.json(publicState(state));
  } catch (error) { return next(error); }
});
app.get('/api/games/:id/scores', async (req, res, next) => {
  try { res.json(await db.getScores(req.params.id)); } catch (error) { next(error); }
});
app.post('/api/games', requireAdmin, async (_req, res, next) => {
  try {
    const state = await db.createGame(makeNewGame());
    publishGameState(publicState(state));
    res.status(201).json(state);
  } catch (error) { next(error); }
});
app.post('/api/games/:id/actions', async (req, res, next) => {
  try {
    if (ADMIN_ONLY_ACTIONS.has(req.body?.type) && !isAdmin(req)) {
      return res.status(401).json({ error: 'Thao tác này chỉ dành cho chủ trì trò chơi. Hãy đăng nhập admin.' });
    }
    if (PLAYER_ONLY_ACTIONS.has(req.body?.type) && isAdmin(req)) {
      return res.status(403).json({ error: 'Tài khoản chủ trì chỉ điều khiển game; người chơi dùng thiết bị không đăng nhập admin.' });
    }
    const result = await db.updateGame(req.params.id, async (state) => {
      const actionType = req.body?.type;
      const playerSession = resolvePlayerSession(state, req);
      const hostOnlyBoardAction = ['select_topic', 'select_question'].includes(actionType) && state.phase === 'board_pick';
      const playerOnlyTurnAction = (actionType === 'select_topic' && state.phase === 'topic_pick') || (actionType === 'select_question' && state.phase === 'question_pick');
      const playerSessionAction = ['leave_team', 'buzz', 'answer'].includes(actionType) || playerOnlyTurnAction;
      if (actionType === 'join_team' && playerSession) {
        const error = new Error('Thiết bị này đã đăng ký một người chơi trong game hiện tại.');
        error.status = 409;
        throw error;
      }
      if (playerSessionAction && !playerSession) {
        const error = new Error('Hãy đăng ký tên và nhóm trên thiết bị này trước khi thao tác.');
        error.status = 401;
        throw error;
      }
      if (hostOnlyBoardAction && !isAdmin(req)) {
        const error = new Error('Chủ trì cần đăng nhập để bắt đầu lượt chơi.');
        error.status = 401;
        throw error;
      }
      if (playerOnlyTurnAction && isAdmin(req)) {
        const error = new Error('Thao tác này thuộc lượt chọn của đội đang chơi.');
        error.status = 403;
        throw error;
      }
      const payload = { ...(req.body?.payload || {}) };
      if (actionType === 'leave_team') payload.playerId = playerSession.playerId;
      if (actionType === 'buzz' && payload.teamId !== playerSession?.teamId) {
        const error = new Error('Bạn chỉ có thể bấm chuông cho nhóm đã đăng ký trên thiết bị này.');
        error.status = 403;
        throw error;
      }
      if (['answer', 'select_question'].includes(actionType) && state.phase === 'question_pick' && playerSession?.teamId !== state.activeTeamId) {
        const error = new Error('Chỉ người chơi của đội đang chơi mới được chọn câu hỏi tiếp theo.');
        error.status = 403;
        throw error;
      }
      if (actionType === 'answer') {
        if (playerSession?.teamId !== state.activeTeamId) {
          const error = new Error('Chỉ người chơi của đội đang có lượt mới được trả lời.');
          error.status = 403;
          throw error;
        }
        payload.playerId = playerSession.playerId;
      }
      if (actionType === 'select_topic' && state.phase === 'topic_pick' && playerSession?.teamId !== state.activeTeamId) {
        const error = new Error('Chỉ đội vừa thắng chủ đề mới được chọn chủ đề tiếp theo.');
        error.status = 403;
        throw error;
      }
      const outcome = applyAction(state, actionType, payload);
      state.revision = (Number.isInteger(state.revision) ? state.revision : 0) + 1;
      if (outcome.event) state.lastEvent = { id: crypto.randomUUID(), kind: outcome.event, at: Date.now() };
      return { ...outcome, response: { state: publicState(state), event: outcome.event || null, ...(outcome.playerSession ? { playerSession: outcome.playerSession } : {}) } };
    });
    if (!result) return res.status(404).json({ error: 'Không tìm thấy game.' });
    publishGameState(result.response.state);
    return res.json(result.response);
  } catch (error) { return next(error); }
});
app.post('/api/uploads/sounds', requireAdmin, upload.single('sound'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Chưa chọn file âm thanh.' });
  return res.status(201).json({ fileUrl: `/uploads/${req.file.filename}` });
});

app.use((error, _req, res, _next) => {
  const status = error.status || (error instanceof multer.MulterError ? 400 : 500);
  if (status >= 500) console.error(error);
  return res.status(status).json({ error: error.message || 'Lỗi máy chủ.' });
});

db.initialize().then(async () => {
  const latest = await db.getLatestGame();
  if (!latest) await db.createGame(makeNewGame());
}).then(() => {
  app.listen(port, '0.0.0.0', () => console.log(`SIX SHOWDOWN API listening on ${port} (${db.getMode()})`));
}).catch((error) => {
  console.error('MySQL initialization failed:', error.message);
  process.exit(1);
});
