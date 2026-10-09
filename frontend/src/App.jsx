import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AudioLines, BadgeCheck, Check, ChevronDown, CircleHelp, Clock3, Crown,
  Database, LockKeyhole, LogOut, Music2, Plus, RotateCcw, Save,
  Settings2, ShieldAlert, Sparkles, Trophy, Users, Volume2, X,
} from 'lucide-react';

const API_BASE = (import.meta.env.VITE_API_URL || `${window.location.protocol}//${window.location.hostname}:4000`).replace(/\/$/, '');
const ADMIN_TOKEN_KEY = 'six-showdown-admin-token';
const PLAYER_PROFILE_KEY = 'six-showdown-player-profile';
const GROUPS = [1, 2, 3, 4, 5, 7];
const LETTERS = ['A', 'B', 'C', 'D'];
const SOUND_LABELS = {
  buzz: { title: 'Chuông giành lượt', hint: 'Phát khi đội đầu tiên giành được quyền trả lời.', icon: '🔔' },
  correct: { title: 'Trả lời đúng', hint: 'Phát khi đáp án đúng.', icon: '🎉' },
  wrong: { title: 'Trả lời sai', hint: 'Phát khi đáp án sai hoặc đội hết giờ.', icon: '⛔' },
  reveal: { title: 'Mở câu hỏi', hint: 'Phát khi một ô câu hỏi được mở.', icon: '✨' },
};

async function request(path, options = {}) {
  const headers = new Headers(options.headers || {});
  const token = window.localStorage.getItem(ADMIN_TOKEN_KEY);
  const playerToken = readPlayerProfile()?.token;
  if (token) headers.set('Authorization', `Bearer ${token}`);
  if (playerToken) headers.set('X-Player-Token', playerToken);
  const response = await fetch(`${API_BASE}${path}`, { ...options, headers });
  const data = response.status === 204 ? null : await response.json().catch(() => null);
  if (!response.ok) {
    if (response.status === 401 && token) {
      window.localStorage.removeItem(ADMIN_TOKEN_KEY);
      window.dispatchEvent(new Event('six-showdown-admin-expired'));
    }
    throw new Error(data?.error || `Máy chủ trả về lỗi ${response.status}.`);
  }
  return data;
}

function soundUrl(url) { return url ? `${API_BASE}${url}` : ''; }

function fmtTime(milliseconds) {
  const seconds = Math.max(0, Math.ceil(milliseconds / 1000));
  return `00:${String(seconds).padStart(2, '0')}`;
}

function readPlayerProfile() {
  try {
    const saved = window.localStorage.getItem(PLAYER_PROFILE_KEY);
    return saved ? JSON.parse(saved) : null;
  } catch { return null; }
}

function Modal({ title, icon: Icon, onClose, children, className = '' }) {
  return (
    <div className="modal-scrim" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className={`modal-panel ${className}`} role="dialog" aria-modal="true" aria-label={title}>
        <div className="modal-heading"><div className="modal-title"><span className="modal-icon"><Icon size={17} /></span><h2>{title}</h2></div><button className="icon-button" onClick={onClose} aria-label="Đóng"><X size={18} /></button></div>
        {children}
      </section>
    </div>
  );
}

function AdminLoginModal({ username, password, onUsername, onPassword, onSubmit, onClose, busy }) {
  return <Modal title="Đăng nhập chủ trì" icon={LockKeyhole} onClose={onClose} className="admin-login-modal">
    <p className="modal-description">Chủ trì đăng nhập để điều khiển bảng câu hỏi, chủ đề, âm thanh và tạo game.</p>
    <form className="admin-login-form" onSubmit={onSubmit}>
      <label className="field-block"><span>TÀI KHOẢN</span><input autoComplete="username" value={username} onChange={(event) => onUsername(event.target.value)} maxLength={60} /></label>
      <label className="field-block"><span>MẬT KHẨU</span><input type="password" autoComplete="current-password" value={password} onChange={(event) => onPassword(event.target.value)} maxLength={100} autoFocus /></label>
      <div className="modal-actions"><button type="button" className="soft-button" onClick={onClose}>Hủy</button><button type="submit" className="primary-button" disabled={busy || !username.trim() || !password}><LockKeyhole size={14} /> Đăng nhập</button></div>
    </form>
  </Modal>;
}

function App() {
  const [game, setGame] = useState(null);
  const [storageMode, setStorageMode] = useState('memory');
  const [isHost, setIsHost] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [syncStatus, setSyncStatus] = useState('connecting');
  const [authBusy, setAuthBusy] = useState(false);
  const [toast, setToast] = useState('');
  const [modal, setModal] = useState(null);
  const [adminUsername, setAdminUsername] = useState('admin');
  const [adminPassword, setAdminPassword] = useState('');
  const [playerProfile, setPlayerProfile] = useState(readPlayerProfile);
  const [playerName, setPlayerName] = useState('');
  const [groupNumber, setGroupNumber] = useState('1');
  const [clock, setClock] = useState(Date.now());
  const [serverClockOffset, setServerClockOffset] = useState(0);
  const [apiError, setApiError] = useState('');
  const [pendingAction, setPendingAction] = useState('');
  const audioRef = useRef(null);
  const lastEventRef = useRef(null);
  const gameRef = useRef(null);
  const timeoutRef = useRef(null);
  const actionBusyRef = useRef(false);
  const pollBusyRef = useRef(false);
  const streamConnectedRef = useRef(false);
  const serverClockOffsetRef = useRef(0);
  const syncStatusTimerRef = useRef(null);

  const flash = useCallback((message) => {
    setToast(message);
    window.clearTimeout(flash.timer);
    flash.timer = window.setTimeout(() => setToast(''), 3400);
  }, []);

  const playSound = useCallback((key, source = gameRef.current) => {
    const url = soundUrl(source?.sounds?.[key]);
    if (!url) return;
    if (audioRef.current) audioRef.current.pause();
    const audio = new Audio(url);
    audioRef.current = audio;
    audio.volume = 0.82;
    audio.play().catch(() => {});
  }, []);

  const syncState = useCallback((next, { allowSameTimestampGame = false, requestStartedAt, responseReceivedAt } = {}) => {
    if (!next) return false;
    const current = gameRef.current;
    const nextRevision = Number.isInteger(next.revision) ? next.revision : 0;
    const currentRevision = Number.isInteger(current?.revision) ? current.revision : 0;
    if (current && current.id === next.id && nextRevision < currentRevision) return false;
    if (current && current.id !== next.id) {
      const nextCreatedAt = Number(next.createdAt || 0);
      const currentCreatedAt = Number(current.createdAt || 0);
      if (nextCreatedAt < currentCreatedAt || (nextCreatedAt === currentCreatedAt && !allowSameTimestampGame)) return false;
    }
    if (Number.isFinite(next.serverNow) && Number.isFinite(requestStartedAt) && Number.isFinite(responseReceivedAt)) {
      const receivedAt = responseReceivedAt;
      const startedAt = requestStartedAt;
      const offset = next.serverNow - ((startedAt + receivedAt) / 2);
      if (Math.abs(offset - serverClockOffsetRef.current) > 25) {
        serverClockOffsetRef.current = offset;
        setServerClockOffset(offset);
      }
    }
    const changed = !current || current.id !== next.id || nextRevision > currentRevision;
    if (!changed) {
      setSyncStatus((status) => status === 'offline' || status === 'connecting' ? (streamConnectedRef.current ? 'connected' : 'polling') : status);
      return true;
    }
    gameRef.current = next;
    setClock(Date.now());
    setGame(next);
    window.clearTimeout(syncStatusTimerRef.current);
    if (current) {
      setSyncStatus('updated');
      syncStatusTimerRef.current = window.setTimeout(() => setSyncStatus(streamConnectedRef.current ? 'connected' : 'polling'), 1400);
    } else setSyncStatus(streamConnectedRef.current ? 'connected' : 'polling');
    return true;
  }, []);

  const loadInitial = useCallback(async () => {
    setLoading(true);
    setApiError('');
    setSyncStatus('connecting');
    try {
      if (window.localStorage.getItem(ADMIN_TOKEN_KEY)) {
        try {
          await request('/api/admin/session');
          setIsHost(true);
        } catch { setIsHost(false); }
      } else setIsHost(false);
      const health = await request('/api/health');
      setStorageMode(health.storage || 'memory');
      const requestStartedAt = Date.now();
      const current = await request('/api/games/latest');
      const responseReceivedAt = Date.now();
      if (!current) throw new Error('Chưa có game. Hãy đăng nhập chủ trì rồi tạo game mới.');
      lastEventRef.current = current.lastEvent?.id || null;
      syncState(current, { requestStartedAt, responseReceivedAt });
    } catch (error) {
      setApiError(error.message);
      setSyncStatus('offline');
    } finally {
      setLoading(false);
    }
  }, [syncState]);

  useEffect(() => { loadInitial(); }, [loadInitial]);

  useEffect(() => {
    const stream = new EventSource(`${API_BASE}/api/games/stream`);
    stream.onopen = () => {
      streamConnectedRef.current = true;
      setSyncStatus('connected');
    };
    stream.onerror = () => {
      streamConnectedRef.current = false;
      setSyncStatus((status) => status === 'offline' ? status : 'polling');
    };
    stream.addEventListener('game-state', (event) => {
      try {
        const next = JSON.parse(event.data);
        const previousId = gameRef.current?.id;
        const accepted = syncState(next);
        if (accepted && (!previousId || previousId !== next.id)) lastEventRef.current = next.lastEvent?.id || null;
        if (accepted) setApiError('');
      } catch { /* malformed events are recovered by the polling fallback */ }
    });
    return () => {
      streamConnectedRef.current = false;
      stream.close();
    };
  }, [syncState]);

  useEffect(() => {
    const resetHost = () => setIsHost(false);
    window.addEventListener('six-showdown-admin-expired', resetHost);
    return () => window.removeEventListener('six-showdown-admin-expired', resetHost);
  }, []);

  useEffect(() => {
    if (game?.id && playerProfile && playerProfile.gameId !== game.id) {
      window.localStorage.removeItem(PLAYER_PROFILE_KEY);
      setPlayerProfile(null);
    }
  }, [game?.id, playerProfile]);

  useEffect(() => {
    if (!game?.id) return undefined;
    const refreshLatest = async () => {
      if (document.hidden || !navigator.onLine || pollBusyRef.current) return;
      pollBusyRef.current = true;
      const requestStartedAt = Date.now();
      try {
        const latest = await request('/api/games/latest');
        const responseReceivedAt = Date.now();
        if (latest) {
          const accepted = syncState(latest, { requestStartedAt, responseReceivedAt });
          if (accepted && latest.id !== game.id) lastEventRef.current = latest.lastEvent?.id || null;
          setApiError('');
        }
      } catch (error) {
        setApiError(error.message);
        window.clearTimeout(syncStatusTimerRef.current);
        if (!streamConnectedRef.current) setSyncStatus('offline');
      } finally {
        pollBusyRef.current = false;
      }
    };
    const timer = window.setInterval(refreshLatest, 3000);
    const refreshWhenActive = () => { if (!document.hidden) refreshLatest(); };
    document.addEventListener('visibilitychange', refreshWhenActive);
    window.addEventListener('online', refreshWhenActive);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', refreshWhenActive);
      window.removeEventListener('online', refreshWhenActive);
    };
  }, [game?.id, syncState]);

  useEffect(() => () => window.clearTimeout(syncStatusTimerRef.current), []);

  useEffect(() => {
    const timer = window.setInterval(() => setClock(Date.now()), 250);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!game?.answerDeadlineAt || game.phase !== 'answering') return undefined;
    if (clock + serverClockOffset >= game.answerDeadlineAt && timeoutRef.current !== game.answerDeadlineAt) {
      timeoutRef.current = game.answerDeadlineAt;
      request(`/api/games/${game.id}/actions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'timeout' }) })
        .then((result) => syncState(result.state))
        .catch(() => { timeoutRef.current = null; });
    }
    if (clock + serverClockOffset < game.answerDeadlineAt && timeoutRef.current !== game.answerDeadlineAt) timeoutRef.current = null;
    return undefined;
  }, [clock, serverClockOffset, game?.answerDeadlineAt, game?.id, game?.phase, syncState]);

  useEffect(() => {
    const event = game?.lastEvent;
    if (event && event.id !== lastEventRef.current) {
      lastEventRef.current = event.id;
      if (event.kind && Date.now() - event.at < 4000) playSound(event.kind, game);
    }
  }, [game, playSound]);

  const activeQuestion = useMemo(() => game?.questions.find((question) => question.id === game.activeQuestionId) || null, [game]);
  const activeTeam = useMemo(() => game?.teams.find((team) => team.id === game.activeTeamId) || null, [game]);
  const currentPlayer = playerProfile?.gameId === game?.id ? playerProfile : null;
  const isActivePlayer = Boolean(currentPlayer && currentPlayer.teamId === game?.activeTeamId);
  const teamRanking = useMemo(() => [...(game?.teams || [])].sort((a, b) => b.score - a.score), [game]);
  const selectedTopic = useMemo(() => game?.topics.find((topic) => topic.id === game.selectedTopicId), [game]);
  const visibleQuestions = useMemo(() => game?.questions.filter((question) => question.topicId === game.selectedTopicId) || [], [game]);
  const topicPoints = useMemo(() => visibleQuestions.reduce((sum, question) => sum + question.points, 0), [visibleQuestions]);
  const openedQuestions = useMemo(() => visibleQuestions.filter((question) => question.status !== 'available').length, [visibleQuestions]);
  const countdown = game?.phase === 'buzz_wait' && game.buzzOpenAt ? fmtTime(game.buzzOpenAt - (clock + serverClockOffset)) : null;
  const answerCountdown = game?.phase === 'answering' && game.answerDeadlineAt ? fmtTime(game.answerDeadlineAt - (clock + serverClockOffset)) : null;

  const act = useCallback(async (type, payload = {}) => {
    if (!gameRef.current?.id || actionBusyRef.current) return null;
    actionBusyRef.current = true;
    setBusy(true);
    setPendingAction(type);
    setApiError('');
    try {
      const requestStartedAt = Date.now();
      const result = await request(`/api/games/${gameRef.current.id}/actions`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type, payload }),
      });
      const responseReceivedAt = Date.now();
      const accepted = syncState(result.state, { requestStartedAt, responseReceivedAt });
      if (result.event && accepted && result.state.lastEvent?.id !== lastEventRef.current) {
        lastEventRef.current = result.state.lastEvent?.id || lastEventRef.current;
        playSound(result.event, result.state);
      }
      return result;
    } catch (error) {
      try {
        const latest = await request('/api/games/latest');
        if (latest) syncState(latest);
        setApiError('');
      } catch (refreshError) {
        setApiError(refreshError.message);
        window.clearTimeout(syncStatusTimerRef.current);
        if (!streamConnectedRef.current) setSyncStatus('offline');
      }
      flash(error.message);
      return null;
    } finally {
      actionBusyRef.current = false;
      setBusy(false);
      setPendingAction('');
    }
  }, [flash, playSound, syncState]);

  async function loginAdmin(event) {
    event.preventDefault();
    if (authBusy) return;
    setAuthBusy(true);
    try {
      const result = await request('/api/admin/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: adminUsername, password: adminPassword }),
      });
      window.localStorage.setItem(ADMIN_TOKEN_KEY, result.token);
      setIsHost(true);
      setAdminPassword('');
      setModal(null);
      flash('Đã đăng nhập quyền chủ trì.');
    } catch (error) { flash(error.message); }
    finally { setAuthBusy(false); }
  }

  async function logoutAdmin() {
    try { await request('/api/admin/logout', { method: 'POST' }); } catch { /* local sign-out still completes */ }
    window.localStorage.removeItem(ADMIN_TOKEN_KEY);
    setIsHost(false);
    setModal(null);
    flash('Đã đăng xuất quyền chủ trì.');
  }

  async function startNewGame() {
    if (actionBusyRef.current || !isHost) return;
    actionBusyRef.current = true;
    setBusy(true);
    setPendingAction('new_game');
    try {
      const requestStartedAt = Date.now();
      const next = await request('/api/games', { method: 'POST' });
      const responseReceivedAt = Date.now();
      syncState(next, { allowSameTimestampGame: true, requestStartedAt, responseReceivedAt });
      lastEventRef.current = null;
      setPlayerName('');
      flash('Đã tạo game mới.');
    } catch (error) { flash(error.message); }
    finally {
      actionBusyRef.current = false;
      setBusy(false);
      setPendingAction('');
    }
  }

  async function registerPlayer(event) {
    event.preventDefault();
    if (!playerName.trim()) { flash('Nhập tên người chơi trước nhé.'); return; }
    const result = await act('join_team', { name: playerName, groupNumber });
    if (result?.playerSession) {
      const profile = { ...result.playerSession, gameId: result.state.id };
      window.localStorage.setItem(PLAYER_PROFILE_KEY, JSON.stringify(profile));
      setPlayerProfile(profile);
      setPlayerName('');
      flash(`Đã đăng ký bạn vào Nhóm ${profile.groupNumber}. Thiết bị này chỉ thao tác cho nhóm đó.`);
    }
  }

  async function leaveTeam() {
    if (!currentPlayer || game?.startedAt) return;
    const { name, groupNumber: previousGroup } = currentPlayer;
    const result = await act('leave_team');
    if (!result) return;
    window.localStorage.removeItem(PLAYER_PROFILE_KEY);
    setPlayerProfile(null);
    setPlayerName(name);
    setGroupNumber(String(previousGroup));
    flash(`Đã rời Nhóm ${previousGroup}. Chọn nhóm đúng rồi đăng ký lại nhé.`);
  }

  async function submitAnswer(optionIndex) {
    if (!currentPlayer || currentPlayer.teamId !== activeTeam?.id) { flash('Chỉ người chơi đã đăng ký trong đội đang chơi mới được trả lời.'); return; }
    const result = await act('answer', { optionIndex, playerId: currentPlayer.playerId });
    if (result) {
      const answer = result.state.lastAnswer;
      if (answer?.topicCompleted) flash(`${answer.roundWinnerName} nhận ${answer.pointsAwarded.toLocaleString('vi-VN')} điểm từ các câu trả lời đúng.`);
      else if (answer?.isCorrect) flash(`Chính xác! ${activeTeam?.name} tiếp tục chủ đề này.`);
      else if (result.state.stealOpportunity) flash('Đội đã mắc 2 lỗi liên tiếp. Các đội khác hãy giành chuông để cướp điểm chủ đề!');
      else if (result.state.phase === 'buzz_wait') flash('Chưa đúng. Cơ hội giành chuông chuyển sang đội khác.');
      else flash(`Chưa đúng — ${result.state.strikeCount}/2 lỗi liên tiếp.`);
    }
  }

  async function buzz(team) {
    const result = await act('buzz', { teamId: team.id });
    if (result) flash(`${team.name} đã giành quyền trả lời!`);
  }

  async function uploadSound(key, file) {
    if (!file) return;
    if (file.size > 12 * 1024 * 1024) { flash('File âm thanh tối đa 12 MB.'); return; }
    try {
      const body = new FormData(); body.append('sound', file);
      const uploaded = await request('/api/uploads/sounds', { method: 'POST', body });
      const result = await act('set_sound', { soundKey: key, fileUrl: uploaded.fileUrl });
      if (result) flash(`Đã gắn âm thanh: ${SOUND_LABELS[key].title}.`);
    } catch (error) { flash(error.message); }
  }

  if (loading) return <div className="boot-screen" role="status" aria-live="polite"><div className="boot-logo">6</div><span>ĐANG ĐỒNG BỘ LƯỢT CHƠI...</span><small>Đang lấy bảng điểm và trạng thái mới nhất từ máy chủ</small></div>;
  if (apiError && !game) return <div className="boot-screen error-screen"><ShieldAlert size={30} /><h1>Chưa kết nối được máy chủ game</h1><p>{apiError}</p><button className="primary-button" onClick={loadInitial}><RotateCcw size={16} /> Thử kết nối lại</button><small>Đảm bảo backend Node.js đang chạy ở {API_BASE}</small></div>;

  const teamsReady = game?.teams.every((team) => team.members.length > 0) || false;
  const selectedGroupFull = Boolean(game?.teams.find((team) => team.groupNumber === Number(groupNumber))?.members.length >= 6);
  const canPickTile = game && ((isHost && game.phase === 'board_pick' && teamsReady) || (!isHost && game.phase === 'question_pick' && isActivePlayer));
  const answerEnabled = !isHost && isActivePlayer && game?.phase === 'answering' && Boolean(activeTeam?.members.length);
  const usableTiles = visibleQuestions.filter((question) => question.status === 'available').length;
  const syncLabel = syncStatus === 'offline'
    ? 'MẤT KẾT NỐI'
    : busy
      ? pendingAction === 'buzz' ? 'ĐANG GỬI CHUÔNG' : pendingAction === 'answer' ? 'ĐANG GỬI ĐÁP ÁN' : 'ĐANG ĐỒNG BỘ'
      : syncStatus === 'updated' ? 'VỪA CẬP NHẬT' : syncStatus === 'polling' ? 'ĐỒNG BỘ DỰ PHÒNG' : 'ĐỒNG BỘ LIVE';
  const boardPickMessage = !game?.startedAt
    ? 'Mở bất kỳ ô nào để bắt đầu chủ đề đầu tiên.'
    : game.lastAnswer?.revealedCorrectAnswer
      ? 'Cả 6 nhóm đều đã sai câu mở. Hãy mở ô khác để tranh chuông.'
      : 'Chủ đề mới đã chọn. Chủ trì mở câu đầu để cả 6 nhóm tranh chuông.';

  return (
    <div className="app-shell">
      <div className="ambient ambient-a" /><div className="ambient ambient-b" />
      <div className="app-content">
        <header className="topbar">
          <a className="brand" href="#top" aria-label="SIX SHOWDOWN">
            <span className="brand-mark"><span>6</span><i /></span>
            <span className="brand-copy"><strong>SIX SHOWDOWN</strong><small>THE ULTIMATE QUIZ BATTLE</small></span>
          </a>
          <div className="show-tag"><span className="live-dot" /> SÂN KHẤU ĐANG MỞ <span className="tag-divider">/</span> SEASON 01</div>
          <div className="top-actions">
            <span className={`storage-pill ${storageMode === 'mysql' ? 'storage-mysql' : ''}`}><Database size={13} />{storageMode === 'mysql' ? 'AIVEN MYSQL' : 'DEMO LOCAL'}</span>
            <span className={`role-pill ${isHost ? 'role-host' : 'role-player'}`}>{isHost ? 'CHỦ TRÌ' : 'NGƯỜI CHƠI'}</span>
            {isHost && <>
              <button className="soft-button" onClick={() => setModal('sounds')}><Volume2 size={15} /><span>Âm thanh</span></button>
              <button className="soft-button" disabled={Boolean(game?.startedAt)} onClick={() => setModal('questions')}><Settings2 size={15} /><span>Câu hỏi</span></button>
              <button className="new-game-button" disabled={busy} onClick={startNewGame}><Plus size={15} /><span>Game mới</span></button>
              <button className="soft-button host-session-button" onClick={logoutAdmin}><LogOut size={15} /><span>Đăng xuất</span></button>
            </>}
            {!isHost && <button className="soft-button admin-login-button" onClick={() => setModal('admin-login')}><LockKeyhole size={15} /><span>Chủ trì đăng nhập</span></button>}
          </div>
        </header>

        {apiError && <button className="connection-warning" onClick={() => setApiError('')}><ShieldAlert size={14} /> Không nhận được phản hồi từ API. Chạm để ẩn thông báo. <X size={13} /></button>}

        <section className="hero-strip" id="top">
          <div className="hero-title"><div className="eyebrow"><span className="eyebrow-line" /> TRÒ CHƠI ĐỐI KHÁNG TRỰC TIẾP <span className="eyebrow-line" /></div><h1>SÁU ĐỘI. <em>MỘT CHIẾC CÚP.</em></h1><p>Gọi tên đồng đội. Nhấn chuông. Chọn đáp án khóa chặt.</p></div>
          <div className="hero-counters">
            <div className="counter-card"><span>VÒNG ĐẤU</span><strong>01</strong><small>TRỰC TIẾP</small></div>
            <div className="counter-card"><span>CÂU ĐÃ MỞ</span><strong>{String(openedQuestions).padStart(2, '0')}<i> / 08</i></strong><small className="counter-topic">{selectedTopic?.title || 'CHỌN CHỦ ĐỀ'}</small><div className="progress-line"><span style={{ width: `${(openedQuestions / 8) * 100}%` }} /></div></div>
            <div className="counter-card counter-time"><span>TRẠNG THÁI</span><strong className="phase-label">{game?.status === 'complete' ? 'KẾT THÚC' : game?.startedAt ? 'ĐANG CHƠI' : 'SẴN SÀNG'}</strong><small aria-live="polite"><span className={`live-dot sync-dot sync-${syncStatus} ${busy ? 'sync-busy' : ''}`} /> {syncLabel}</small></div>
          </div>
        </section>

        <section className="teams-section">
          <div className="section-head"><div><span className="section-kicker">BẢNG ĐIỂM</span><h2>SÁU ĐỘI THI ĐẤU</h2></div><span className="section-note"><Users size={14} /> Mỗi đội tối đa 6 thành viên</span></div>
          <div className="team-grid">
            {teamRanking.map((team, index) => {
              const questionTried = activeQuestion?.attemptedTeamIds?.includes(team.id);
              const isStrikeOwner = game?.stealOpportunity && team.id === game.originalTeamId;
              const isOwnTeam = !isHost && currentPlayer?.teamId === team.id;
              const canBuzz = isOwnTeam && game?.phase === 'buzz_wait' && clock + serverClockOffset >= (game.buzzOpenAt || 0) && Boolean(team.members.length) && !questionTried && !isStrikeOwner;
              const isTurn = team.id === game?.activeTeamId && game?.phase === 'answering';
              return <article className={`team-card ${isTurn ? 'team-current' : ''} ${team.members.length === 0 ? 'team-empty' : ''}`} key={team.id} style={{ '--team-color': team.color }}>
                <div className="team-topline"><span className="team-color-dot" /><span className="team-rank">#{String(index + 1).padStart(2, '0')}</span>{index === 0 && team.score > 0 && <Crown className="crown-icon" size={15} />}</div>
                <div className="team-heading"><strong>{team.name}</strong><div className="team-score">{team.score.toLocaleString('vi-VN')}<small> ĐIỂM</small></div></div>
                <div className="team-roster"><div className="roster-caption"><Users size={12} /> {team.members.length} THÀNH VIÊN</div><div className="member-list">{team.members.length ? team.members.slice(0, 3).map((member) => <span className="member-chip" key={member.id}>{member.name}</span>) : <span className="no-members">Chờ người chơi...</span>}{team.members.length > 3 && <span className="member-chip more-members">+{team.members.length - 3}</span>}</div></div>
                {game?.phase === 'buzz_wait' && <button className={`buzz-button ${canBuzz ? 'buzz-ready' : ''} ${game.stealOpportunity && canBuzz ? 'buzz-steal' : ''}`} disabled={!canBuzz || busy} onClick={() => buzz(team)}>{canBuzz ? <><span className="buzz-ring" /> {game.stealOpportunity ? 'CƯỚP ĐIỂM' : 'GIÀNH CHUÔNG'}</> : isHost ? 'CHỦ TRÌ THEO DÕI' : !currentPlayer ? 'CHƯA ĐĂNG KÝ' : isStrikeOwner && isOwnTeam ? 'ĐÃ ĐẠT 2 LỖI' : questionTried ? 'ĐÃ THỬ' : isOwnTeam ? <><LockKeyhole size={12} /> {countdown && countdown !== '00:00' ? 'CHỜ CHUÔNG' : 'CHƯA SẴN SÀNG'}</> : 'CHỈ NHÓM CỦA BẠN'}</button>}
                {isTurn && <div className="turn-indicator"><AudioLines size={13} /> ĐANG TRẢ LỜI</div>}
              </article>;
            })}
          </div>
        </section>

        <main className="game-layout">
          <section className="board-panel">
            <div className="panel-heading"><div><span className="section-kicker">BẢNG CÂU HỎI</span><h2>CHỌN Ô BÍ MẬT</h2></div><span className="tile-counter">{usableTiles} / 08 Ô · TỐI ĐA {topicPoints.toLocaleString('vi-VN')} ĐIỂM</span></div>
            <div className="topic-selector"><span>CHỦ ĐỀ</span>{game?.topics.map((topic, index) => {
              const remaining = game.questions.filter((question) => question.topicId === topic.id && question.status === 'available').length;
              const selected = game.selectedTopicId === topic.id;
              const canChangeTopic = (isHost && game.phase === 'board_pick' && !game.startedAt) || (!isHost && game.phase === 'topic_pick' && isActivePlayer);
              return <button type="button" key={topic.id} className={`topic-tab ${selected ? 'topic-tab-active' : ''} ${remaining === 0 ? 'topic-tab-done' : ''}`} disabled={!canChangeTopic || remaining === 0 || busy} onClick={() => act('select_topic', { topicId: topic.id })}><i>{String(index + 1).padStart(2, '0')}</i><span>{topic.title}</span><b>{remaining}</b></button>;
            })}</div>
            {game?.phase === 'question_pick' && activeTeam && <div className="picker-banner" style={{ '--team-color': activeTeam.color }}><span className="live-dot" /> Lượt của <strong>{activeTeam.name}</strong> — chọn một ô câu hỏi{game.strikeCount > 0 && <><span className="strike-label">LỖI LIÊN TIẾP</span><span className="strike-marks" aria-label={`${game.strikeCount} trên 2 lỗi`}>{[0, 1].map((strike) => <b key={strike} className={strike < game.strikeCount ? 'strike-on' : ''}>X</b>)}</span></>}</div>}
            {game?.phase === 'topic_pick' && activeTeam && <div className="picker-banner topic-picker-banner" style={{ '--team-color': activeTeam.color }}><Trophy size={13} /> <strong>{activeTeam.name}</strong> đã nhận {game.lastAnswer?.pointsAwarded?.toLocaleString('vi-VN')} điểm tích lũy — đội thắng hãy chọn chủ đề tiếp theo</div>}
            {game?.phase === 'board_pick' && <div className={`picker-banner ${teamsReady ? '' : 'picker-banner-wait'}`}>{teamsReady ? <><Sparkles size={14} /> {isHost ? boardPickMessage : 'Chủ trì đăng nhập để mở ô câu hỏi và bắt đầu màn chơi.'}</> : <><Users size={14} /> Hãy ghép ít nhất 1 người chơi vào đủ 6 đội trước khi chủ trì mở câu đầu tiên</>}</div>}
            <div className="question-grid">
              {visibleQuestions.map((question, index) => {
                const active = question.status === 'active';
                const done = question.status === 'done';
                return <button key={question.id} className={`question-tile ${active ? 'tile-active' : ''} ${done ? 'tile-done' : ''} ${canPickTile && !done ? 'tile-selectable' : ''}`} disabled={!canPickTile || done || busy} onClick={() => act('select_question', { questionId: question.id })}>
                  <span className="tile-number-badge">{String(index + 1)}</span>
                  <span className="tile-answer-copy"><strong>{done ? 'ĐÃ CHƠI' : active ? 'ĐANG CHƠI' : `CÂU HỎI ${String(index + 1).padStart(2, '0')}`}</strong><small>{done ? 'HOÀN THÀNH' : active ? 'ĐANG MỞ TRÊN SÂN KHẤU' : 'CHỌN ĐỂ MỞ'}</small></span>
                  <span className="tile-points">{question.points}<i>ĐIỂM</i></span>
                </button>;
              })}
            </div>
            <div className="board-footer"><span><span className="legend-dot legend-available" /> Ô chưa mở</span><span><span className="legend-dot legend-active" /> Ô đang chơi</span><span><span className="legend-dot legend-done" /> Đã hoàn thành</span></div>
          </section>

          <section className="question-panel">
            <div className="panel-heading stage-heading"><div><span className="section-kicker">{selectedTopic?.title || 'MIC TRUNG TÂM'}</span><h2>{activeQuestion ? `CÂU ${String(visibleQuestions.findIndex((q) => q.id === activeQuestion.id) + 1).padStart(2, '0')}` : 'SÂN KHẤU CHÍNH'}</h2></div><div className={`status-stamp ${game?.phase === 'answering' ? 'stamp-hot' : ''}`}>{game?.phase === 'answering' ? <><span className="live-dot" /> LIVE</> : game?.status === 'complete' ? 'KẾT THÚC' : 'ON AIR'}</div></div>
            {!activeQuestion && game?.phase !== 'complete' && <div className="stage-empty"><div className="empty-emblem"><CircleHelp size={29} /><span>?</span></div><span className="section-kicker">{game?.phase === 'topic_pick' ? 'CHỦ ĐỀ ĐÃ KẾT THÚC' : game?.phase === 'question_pick' ? 'ĐẾN LƯỢT ĐỘI BẠN' : 'SÂN KHẤU SẴN SÀNG'}</span><h3>{game?.phase === 'topic_pick' ? `${activeTeam?.name || 'Đội thắng'} hãy chọn chủ đề` : game?.phase === 'question_pick' ? `${activeTeam?.name || 'Đội chơi'} hãy chọn ô` : 'Một câu hỏi đang chờ'}</h3><p>{game?.phase === 'topic_pick' ? 'Chủ đề vừa rồi đã khép lại. Đội thắng bấm vào chủ đề còn lại để chuyển sang màn chơi mới.' : game?.phase === 'question_pick' ? 'Đội đang chơi chọn một ô còn sáng trên bảng để mở câu hỏi tiếp theo.' : isHost ? 'Chọn một ô trên bảng để mở màn giành chuông.' : 'Chờ chủ trì mở một ô để bắt đầu màn giành chuông.'}</p><div className="ready-line"><span className="live-dot" /> {game?.phase === 'topic_pick' ? 'ĐỘI THẮNG CHỌN CHỦ ĐỀ MỚI' : game?.phase === 'question_pick' ? (game.strikeCount ? `LỖI LIÊN TIẾP ${game.strikeCount}/2` : 'LỢI THẾ CHỌN CÂU HỎI') : '8 CÂU HỎI ĐANG ẨN'}</div></div>}
            {activeQuestion && <div className="question-stage" key={activeQuestion.id}>
              <div className="stage-meta"><span className="question-chip"><Sparkles size={12} /> CÂU HỎI BÍ MẬT</span><span className="points-chip"><Trophy size={12} /> {activeQuestion.points} ĐIỂM</span></div>
              <h3 className="question-prompt">{activeQuestion.prompt}</h3>
              {(game?.phase === 'buzz_wait' || game?.phase === 'answering') && <div className="answer-grid">{activeQuestion.options.map((option, index) => {
                const lastIsWrong = game.lastAnswer?.questionId === activeQuestion.id && !game.lastAnswer.isCorrect && game.lastAnswer.optionIndex === index;
                return <button key={`${index}-${option}`} className={`answer-option ${answerEnabled ? 'answer-enabled' : ''} ${lastIsWrong ? 'answer-wrong' : ''}`} disabled={!answerEnabled || busy || Boolean(game.lastAnswer?.isCorrect)} onClick={() => submitAnswer(index)}><span className="answer-letter">{LETTERS[index]}</span><span className="answer-text">{option}</span>{lastIsWrong && <X size={16} className="answer-x" />}</button>;
              })}</div>}
              {game?.phase === 'buzz_wait' && <div className={`timer-banner ${game.stealOpportunity ? 'timer-steal' : ''}`}><div className="timer-glyph"><Clock3 size={17} /></div><div><strong>{game.stealOpportunity ? 'CƠ HỘI CƯỚP ĐIỂM CHỦ ĐỀ' : countdown === '00:00' ? 'CHUÔNG ĐÃ MỞ!' : 'THỜI GIAN ĐỌC CÂU HỎI'}</strong><small>{game.stealOpportunity ? 'Đội nhanh nhất nhấn chuông rồi chọn một đáp án. Chủ đề kết thúc ngay sau lượt cướp.' : countdown === '00:00' ? 'Đội nhanh nhất hãy nhấn nút giành chuông.' : 'Đội sẵn sàng có thể chuẩn bị đáp án.'}</small></div><b className={countdown === '00:00' || game.stealOpportunity ? 'timer-open' : ''}>{game.stealOpportunity ? '2 ×' : countdown || '00:00'}</b></div>}
              {game?.phase === 'answering' && <div className="answer-turn-bar"><div className="turn-dot" style={{ backgroundColor: activeTeam?.color }} /><div className="turn-copy"><strong>{activeTeam?.name} ĐANG TRẢ LỜI</strong><small>{isActivePlayer ? `${currentPlayer.name} — chọn một đáp án trên thiết bị đã đăng ký.` : 'Chỉ thành viên đã đăng ký của đội đang chơi mới có thể chọn đáp án.'}</small></div><span className="answer-clock"><Clock3 size={14} /> {answerCountdown}</span></div>}
              {game?.lastAnswer?.questionId === activeQuestion.id && !game.lastAnswer.isCorrect && <div className="wrong-feedback"><ShieldAlert size={15} /><span>{game.lastAnswer.timedOut ? `${game.lastAnswer.teamName} hết giờ trả lời.` : `${game.lastAnswer.playerName} chọn chưa đúng.`}</span><strong>{game.stealOpportunity ? 'Các đội khác có thể cướp điểm chủ đề' : game.roundType === 'opening' ? 'Đội khác có thể giành chuông' : `Lỗi liên tiếp ${game.strikeCount}/2`}</strong></div>}
            </div>}
            {game?.phase === 'complete' && !activeQuestion && <div className="complete-stage"><div className="champion-icon"><Trophy size={29} /></div><span className="section-kicker">VÒNG ĐẤU ĐÃ KHÉP LẠI</span><h3>{teamRanking[0]?.score ? `VINH DANH ${teamRanking[0]?.name}` : 'CHƯA CÓ ĐỘI GHI ĐIỂM'}</h3><p>{teamRanking[0]?.score ? `Đội dẫn đầu với ${teamRanking[0].score} điểm.` : 'Cả sân khấu đã sẵn sàng cho một lượt chơi mới.'}</p>{isHost ? <button className="primary-button" onClick={startNewGame}><RotateCcw size={15} /> Bắt đầu game mới</button> : <small>Chờ chủ trì bắt đầu game mới.</small>}</div>}
            {game?.lastAnswer?.topicCompleted && <div className="topic-award-feedback"><Trophy size={17} /><div><strong>CHỦ ĐỀ ĐÃ KHÉP LẠI</strong><span>{game.lastAnswer.roundWinnerName} nhận {game.lastAnswer.pointsAwarded.toLocaleString('vi-VN')} điểm từ các câu trả lời đúng trong chủ đề “{game.lastAnswer.topicTitle}”. Chuyển sang chủ đề khác.</span></div></div>}
            {game?.lastAnswer?.isCorrect && !activeQuestion && !game.lastAnswer.topicCompleted && <div className="correct-feedback"><BadgeCheck size={17} /><div><strong>ĐÁP ÁN CHÍNH XÁC</strong><span>{game.lastAnswer.playerName} giúp {game.lastAnswer.teamName} tiếp tục chơi chủ đề này. Điểm câu đúng được cộng vào phần thưởng của đội khi chủ đề kết thúc.</span></div><Trophy size={17} /></div>}
            {game?.lastAnswer?.revealedCorrectAnswer && !activeQuestion && <div className="reveal-feedback"><BadgeCheck size={16} /><div><strong>ĐÁP ÁN ĐÚNG</strong><span>{game.lastAnswer.revealedCorrectAnswer}</span></div><small>KHÔNG CÒN ĐỘI NÀO TRẢ LỜI</small></div>}
          </section>
        </main>

        {!isHost && <section className="join-panel">
          <div className="join-intro"><span className="join-icon"><Users size={19} /></span><div><span className="section-kicker">NGƯỜI CHƠI TỰ ĐĂNG KÝ</span><h2>THAM GIA MỘT NHÓM</h2><p>Nhập tên của bạn rồi chọn nhóm muốn tham gia.</p></div></div>
          {currentPlayer ? <div className="player-registration-row"><div className="player-registered-card"><BadgeCheck size={18} /><div><strong>{currentPlayer.name} · NHÓM {currentPlayer.groupNumber}</strong><span>Thiết bị này chỉ được giành chuông và thao tác cho nhóm đã đăng ký.</span></div></div>{!game?.startedAt && <button className="leave-team-button" type="button" disabled={busy} onClick={leaveTeam}><LogOut size={14} /> RỜI NHÓM</button>}</div> : <form className="join-form" onSubmit={registerPlayer}>
            <label className="field-block name-field"><span>TÊN NGƯỜI CHƠI</span><input value={playerName} onChange={(event) => setPlayerName(event.target.value)} maxLength={60} placeholder="Tên của bạn" disabled={Boolean(game?.startedAt)} /></label>
            <label className="field-block"><span>NHÓM / ĐỘI</span><div className="select-wrap"><select value={groupNumber} onChange={(event) => setGroupNumber(event.target.value)}>{GROUPS.map((group) => {
              const team = game?.teams.find((candidate) => candidate.groupNumber === group);
              const memberCount = team?.members.length || 0;
              return <option key={group} value={group} disabled={memberCount >= 6}>Nhóm {group} · {memberCount}/6 người</option>;
            })}</select><ChevronDown size={14} /></div></label>
            <button className="join-button" type="submit" disabled={busy || Boolean(game?.startedAt) || !playerName.trim() || selectedGroupFull}><Plus size={17} /> ĐĂNG KÝ</button>
          </form>}
          {game?.startedAt && <div className="registration-lock"><LockKeyhole size={13} /> Danh sách khóa khi câu đầu tiên mở</div>}
        </section>}

        <footer className="footer-row"><span><span className="footer-spark">✦</span> SIX SHOWDOWN <i>•</i> LIVE QUIZ ARENA</span><span>ĐIỂM SỐ {storageMode === 'mysql' ? 'ĐƯỢC LƯU TRÊN MYSQL' : 'LƯU TRONG PHIÊN DEMO'} <Database size={12} /></span></footer>
      </div>

      {toast && <div className="toast-message"><span className="toast-check"><Check size={14} /></span>{toast}</div>}
      {modal === 'admin-login' && <AdminLoginModal username={adminUsername} password={adminPassword} onUsername={setAdminUsername} onPassword={setAdminPassword} onSubmit={loginAdmin} onClose={() => setModal(null)} busy={authBusy} />}
      {modal === 'questions' && game && <QuestionModal game={game} onClose={() => setModal(null)} onSave={(question) => act('update_question', question)} />}
      {modal === 'sounds' && game && <SoundModal game={game} onClose={() => setModal(null)} onUpload={uploadSound} onRemove={(key) => act('set_sound', { soundKey: key, fileUrl: null })} onPreview={(key) => playSound(key)} />}
    </div>
  );
}

function QuestionModal({ game, onClose, onSave }) {
  const [selectedTopicId, setSelectedTopicId] = useState(game.selectedTopicId || game.topics[0]?.id);
  const [draftsByTopic, setDraftsByTopic] = useState(() => Object.fromEntries(game.topics.map((topic) => [topic.id, game.questions.filter((question) => question.topicId === topic.id).map((question) => ({ ...question, options: [...question.options] }))])));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const drafts = draftsByTopic[selectedTopicId] || [];
  const selectedTopic = game.topics.find((topic) => topic.id === selectedTopicId);
  const update = (questionIndex, field, value, optionIndex) => setDraftsByTopic((current) => ({
    ...current,
    [selectedTopicId]: current[selectedTopicId].map((question, i) => {
      if (i !== questionIndex) return question;
      if (field === 'option') return { ...question, options: question.options.map((option, j) => j === optionIndex ? value : option) };
      return { ...question, [field]: value };
    }),
  }));
  async function saveAll(event) {
    event.preventDefault(); setSaving(true); setError('');
    for (const question of drafts) {
      const result = await onSave({ questionId: question.id, prompt: question.prompt, options: question.options, correctIndex: Number(question.correctIndex), points: Number(question.points) });
      if (!result) { setError('Không lưu được một câu hỏi. Kiểm tra nội dung rồi thử lại.'); setSaving(false); return; }
    }
    setSaving(false); onClose();
  }
  return <Modal title="Biên tập câu hỏi" icon={Settings2} onClose={onClose} className="question-modal">
    <p className="modal-description">Chọn chủ đề để sửa 8 câu trắc nghiệm. Mỗi câu có 4 lựa chọn, một đáp án đúng và mức điểm riêng.</p>
    <div className="editor-topic-tabs">{game.topics.map((topic, index) => <button type="button" key={topic.id} className={selectedTopicId === topic.id ? 'editor-topic-active' : ''} onClick={() => { setSelectedTopicId(topic.id); setError(''); }}><i>{index + 1}</i>{topic.title}</button>)}</div>
    <form onSubmit={saveAll} className="question-editor-list"><h3 className="editor-topic-title">{selectedTopic?.title}</h3>{drafts.map((question, qi) => <details className="question-editor-card" key={question.id} open={qi === 0}>
      <summary><span className="editor-number">{String(qi + 1).padStart(2, '0')}</span><span>{question.prompt}</span><ChevronDown size={15} /></summary>
      <div className="editor-body"><label className="field-block editor-prompt"><span>NỘI DUNG CÂU HỎI</span><input value={question.prompt} maxLength={200} onChange={(event) => update(qi, 'prompt', event.target.value)} /></label>
        <div className="editor-answers">{question.options.map((option, oi) => <label className={`editor-option ${Number(question.correctIndex) === oi ? 'editor-correct' : ''}`} key={`${qi}-${oi}`}><input type="radio" name={`correct-${question.id}`} checked={Number(question.correctIndex) === oi} onChange={() => update(qi, 'correctIndex', oi)} /><b>{LETTERS[oi]}</b><input value={option} maxLength={100} onChange={(event) => update(qi, 'option', event.target.value, oi)} /></label>)}</div>
        <label className="field-block points-field"><span>ĐIỂM THƯỞNG</span><div className="points-input"><input type="number" min="1" max="5000" value={question.points} onChange={(event) => update(qi, 'points', event.target.value)} /><span>ĐIỂM</span></div></label>
      </div>
    </details>)}
      {error && <div className="form-error"><ShieldAlert size={15} />{error}</div>}
      <div className="modal-actions"><span className="editor-save-note">Đang chỉnh {drafts.length} câu · {selectedTopic?.title}</span><button className="soft-button" type="button" onClick={onClose}>Hủy</button><button className="primary-button" disabled={saving}><Save size={15} />{saving ? 'Đang lưu...' : 'Lưu 8 câu của chủ đề'}</button></div>
    </form>
  </Modal>;
}

function SoundModal({ game, onClose, onUpload, onRemove, onPreview }) {
  return <Modal title="Âm thanh sân khấu" icon={Music2} onClose={onClose} className="sound-modal">
    <p className="modal-description">Gắn hiệu ứng riêng cho từng khoảnh khắc. File được tải lên backend để mọi máy mở cùng game đều nghe được.</p>
    <div className="sound-list">{Object.entries(SOUND_LABELS).map(([key, sound]) => <article className="sound-row" key={key}>
      <div className="sound-icon">{sound.icon}</div><div className="sound-copy"><strong>{sound.title}</strong><span>{game.sounds?.[key] ? 'Đã gắn âm thanh' : sound.hint}</span></div>
      {game.sounds?.[key] && <button type="button" className="icon-button preview-button" aria-label="Nghe thử" onClick={() => onPreview(key)}><Volume2 size={16} /></button>}
      {game.sounds?.[key] && <button type="button" className="icon-button remove-button" aria-label="Gỡ âm thanh" onClick={() => onRemove(key)}><X size={15} /></button>}
      <label className="upload-sound-button"><AudioLines size={14} />{game.sounds?.[key] ? 'Thay file' : 'Tải lên'}<input type="file" accept="audio/*,.mp3,.wav,.ogg,.aac,.webm" onChange={(event) => { onUpload(key, event.target.files?.[0]); event.target.value = ''; }} /></label>
    </article>)}</div>
    <div className="sound-note"><Volume2 size={15} /><span>Định dạng MP3, WAV, OGG, AAC, WebM · tối đa 12 MB mỗi file.</span></div>
    <div className="modal-actions"><button className="primary-button" onClick={onClose}>Hoàn tất</button></div>
  </Modal>;
}

export default App;
