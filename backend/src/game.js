const crypto = require('node:crypto');
const TOPICS = require('./topics.json');
const GROUPS = [1, 2, 3, 4, 5, 7];
const TEAM_COLORS = ['#ef5350', '#42a5f5', '#ffca28', '#66bb6a', '#ab7bff', '#ff8a45'];

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function makeNewGame() {
  const id = `game-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const teams = GROUPS.map((groupNumber, i) => ({ id: `group-${groupNumber}`, groupNumber, name: `NHÓM ${groupNumber}`, color: TEAM_COLORS[i], score: 0, members: [] }));
  return {
    id,
    title: 'SIX SHOWDOWN',
    createdAt: Date.now(),
    revision: 0,
    startedAt: null,
    status: 'setup',
    phase: 'board_pick',
    teams,
    topics: TOPICS.map(({ id: topicId, title }) => ({ id: topicId, title })),
    selectedTopicId: TOPICS[0].id,
    questions: TOPICS.flatMap((topic) => topic.questions),
    completedTopicIds: [],
    topicEarnedPoints: 0,
    activeQuestionId: null,
    activeTeamId: null,
    originalTeamId: null,
    strikeCount: 0,
    strikeOwnerName: null,
    stealOpportunity: false,
    stealTeamId: null,
    roundType: null,
    buzzOpenAt: null,
    answerDeadlineAt: null,
    lastAnswer: null,
    lastEvent: null,
    sounds: { buzz: null, correct: null, wrong: null, reveal: null },
  };
}

function findTeam(state, teamId) { return state.teams.find((team) => team.id === teamId); }
function findQuestion(state) { return state.questions.find((question) => question.id === state.activeQuestionId); }
function topicQuestions(state, topicId = state.selectedTopicId) {
  return state.questions.filter((question) => question.topicId === topicId);
}

function remainingInTopic(state, topicId = state.selectedTopicId) {
  return topicQuestions(state, topicId).filter((question) => question.status === 'available').length;
}

function remainingTopics(state) {
  return state.topics.some((topic) => !state.completedTopicIds.includes(topic.id));
}

function finishTopic(state, winner, event, playerName) {
  const questions = topicQuestions(state);
  const topic = state.topics.find((item) => item.id === state.selectedTopicId);
  const points = Math.max(0, Number(state.topicEarnedPoints) || 0);
  for (const question of questions) question.status = 'done';
  if (!state.completedTopicIds.includes(state.selectedTopicId)) state.completedTopicIds.push(state.selectedTopicId);
  winner.score += points;
  state.lastAnswer = {
    ...state.lastAnswer,
    topicId: state.selectedTopicId,
    topicTitle: topic?.title || 'Chủ đề',
    roundWinnerTeamId: winner.id,
    roundWinnerName: winner.name,
    pointsAwarded: points,
    topicCompleted: true,
  };
  state.activeQuestionId = null;
  state.activeTeamId = winner.id;
  state.originalTeamId = null;
  state.phase = remainingTopics(state) ? 'topic_pick' : 'complete';
  state.status = state.phase === 'complete' ? 'complete' : 'live';
  state.strikeCount = 0;
  state.strikeOwnerName = null;
  state.topicEarnedPoints = 0;
  state.stealOpportunity = false;
  state.stealTeamId = null;
  state.buzzOpenAt = null;
  state.answerDeadlineAt = null;
  state.roundType = null;
  return {
    state,
    event,
    scoreEvent: {
      teamId: winner.id,
      points,
      reason: `${topic?.title || 'Chủ đề'} — điểm từ câu trả lời đúng`.slice(0, 255),
      playerName: playerName || `Đội ${winner.name}`,
    },
  };
}

function recordStrike(state, { question, team, member, optionIndex = null, timedOut = false, now }) {
  state.strikeCount += 1;
  state.lastAnswer = {
    teamId: team.id,
    teamName: team.name,
    playerName: member?.name || '',
    optionIndex,
    isCorrect: false,
    timedOut,
    strikeCount: state.strikeCount,
    questionId: question.id,
    answeredAt: now,
  };
  state.answerDeadlineAt = null;
  if (state.strikeCount >= 2) {
    if (!question.attemptedTeamIds.includes(team.id)) question.attemptedTeamIds.push(team.id);
    state.strikeOwnerName = member?.name || state.strikeOwnerName;
    state.activeTeamId = null;
    state.phase = 'buzz_wait';
    state.stealOpportunity = true;
    state.stealTeamId = null;
    state.buzzOpenAt = now;
    return { state, event: 'wrong' };
  }

  question.status = 'done';
  state.activeQuestionId = null;
  state.activeTeamId = team.id;
  state.stealOpportunity = false;
  state.stealTeamId = null;
  if (remainingInTopic(state) > 0) {
    state.phase = 'question_pick';
    return { state, event: 'wrong' };
  }
  return finishTopic(state, team, 'wrong', member?.name);
}

function applyAction(state, action, payload = {}) {
  const now = Date.now();
  state.completedTopicIds ||= [];
  state.strikeCount = Number.isInteger(state.strikeCount) ? state.strikeCount : 0;
  state.topicEarnedPoints = Number.isFinite(state.topicEarnedPoints) ? state.topicEarnedPoints : 0;
  state.strikeOwnerName ??= null;
  state.stealOpportunity ??= false;
  state.stealTeamId ??= null;
  switch (action) {
    case 'join_team': {
      if (state.startedAt) throw httpError(409, 'Đã mở câu hỏi đầu tiên; không thể thêm thành viên vào game đang chơi.');
      const name = String(payload.name || '').trim();
      const groupNumber = Number(payload.groupNumber);
      if (!name || name.length > 60) throw httpError(400, 'Tên người chơi cần có từ 1 đến 60 ký tự.');
      if (!GROUPS.includes(groupNumber)) throw httpError(400, 'Nhóm tham gia không hợp lệ.');
      const team = state.teams.find((candidate) => candidate.groupNumber === groupNumber);
      if (!team) throw httpError(400, 'Không tìm thấy đội tương ứng với nhóm đã chọn.');
      if (team.members.length >= 6) throw httpError(409, `${team.name} đã đủ 6 thành viên.`);
      const token = crypto.randomBytes(32).toString('hex');
      const member = {
        id: `player-${Math.random().toString(36).slice(2, 10)}`,
        name,
        groupNumber,
        playerTokenHash: crypto.createHash('sha256').update(token).digest('hex'),
      };
      team.members.push(member);
      return { state, playerSession: { token, playerId: member.id, teamId: team.id, groupNumber, name } };
    }
    case 'leave_team': {
      if (state.startedAt) throw httpError(409, 'Danh sách đội đã khóa sau khi câu đầu tiên mở.');
      const team = state.teams.find((candidate) => candidate.members.some((member) => member.id === payload.playerId));
      if (!team) throw httpError(404, 'Không tìm thấy người chơi trong nhóm.');
      team.members = team.members.filter((member) => member.id !== payload.playerId);
      return { state };
    }
    case 'select_topic': {
      if (!['board_pick', 'topic_pick'].includes(state.phase)) throw httpError(409, 'Chỉ có thể chọn chủ đề khi bắt đầu hoặc sau khi kết thúc một chủ đề.');
      const topic = state.topics.find((item) => item.id === payload.topicId);
      if (!topic) throw httpError(400, 'Chủ đề không hợp lệ.');
      if (state.phase === 'board_pick' && state.startedAt && topic.id !== state.selectedTopicId) throw httpError(409, 'Chủ đề mới đã được đội thắng chọn; hãy mở một ô câu hỏi của chủ đề đó.');
      if (state.phase === 'topic_pick' && state.completedTopicIds.includes(topic.id)) throw httpError(409, 'Chủ đề này đã kết thúc, hãy chọn một chủ đề khác.');
      if (!topicQuestions(state, topic.id).some((question) => question.status === 'available')) throw httpError(409, 'Chủ đề này đã chơi hết câu hỏi.');
      state.selectedTopicId = payload.topicId;
      if (state.phase === 'topic_pick') {
        state.phase = 'board_pick';
        state.activeTeamId = null;
        state.strikeCount = 0;
        state.strikeOwnerName = null;
        state.topicEarnedPoints = 0;
        state.stealOpportunity = false;
        state.stealTeamId = null;
        state.originalTeamId = null;
        state.roundType = null;
        state.buzzOpenAt = null;
        state.answerDeadlineAt = null;
        state.lastAnswer = null;
      }
      return { state };
    }
    case 'select_question': {
      const question = state.questions.find((item) => item.id === payload.questionId && item.topicId === state.selectedTopicId);
      if (!question || question.status !== 'available') throw httpError(409, 'Ô này đã được chơi hoặc không thuộc chủ đề đang chọn.');
      if (state.phase === 'board_pick') {
        if (state.teams.some((team) => team.members.length === 0)) throw httpError(409, 'Hãy thêm ít nhất một người chơi vào đủ cả 6 đội trước khi mở câu đầu tiên.');
        state.startedAt = state.startedAt || now;
        state.status = 'live';
        state.activeQuestionId = question.id;
        state.roundType = 'opening';
        state.activeTeamId = null;
        state.originalTeamId = null;
        state.strikeCount = 0;
        state.strikeOwnerName = null;
        state.stealOpportunity = false;
        state.stealTeamId = null;
        question.status = 'active';
        state.phase = 'buzz_wait';
        state.buzzOpenAt = now + 15000;
        state.lastAnswer = null;
        return { state, event: 'reveal' };
      }
      if (state.phase !== 'question_pick' || !state.activeTeamId) throw httpError(409, 'Hiện chưa tới lượt chọn câu hỏi.');
      state.originalTeamId = state.activeTeamId;
      state.stealTeamId = null;
      state.stealOpportunity = false;
      state.activeQuestionId = question.id;
      state.roundType = 'turn';
      state.phase = 'answering';
      state.answerDeadlineAt = now + 20000;
      question.status = 'active';
      state.lastAnswer = null;
      return { state, event: 'reveal' };
    }
    case 'buzz': {
      if (state.phase !== 'buzz_wait') throw httpError(409, 'Chuông hiện không mở.');
      if (state.buzzOpenAt && now < state.buzzOpenAt) throw httpError(425, 'Chuông chưa mở, hãy chờ đồng hồ về 0.');
      const question = findQuestion(state);
      const team = findTeam(state, payload.teamId);
      if (!question || !team || !team.members.length) throw httpError(400, 'Đội chưa có thành viên hoặc không hợp lệ.');
      if (question.attemptedTeamIds.includes(team.id)) throw httpError(409, 'Đội này đã trả lời câu hỏi đó.');
      if (state.stealOpportunity && team.id === state.originalTeamId) throw httpError(409, 'Đội đã đạt 2 lỗi không thể giành quyền cướp.');
      state.activeTeamId = team.id;
      state.phase = 'answering';
      state.answerDeadlineAt = now + 20000;
      state.buzzOpenAt = null;
      if (state.stealOpportunity) state.stealTeamId = team.id;
      else if (state.roundType === 'opening') {
        state.originalTeamId = team.id;
        state.strikeCount = 0;
      }
      return { state, event: 'buzz' };
    }
    case 'answer': {
      if (state.phase !== 'answering') throw httpError(409, 'Hiện chưa nhận đáp án.');
      const question = findQuestion(state);
      const team = findTeam(state, state.activeTeamId);
      const member = team?.members.find((candidate) => candidate.id === payload.playerId);
      const optionIndex = Number(payload.optionIndex);
      if (!question || !team || !member) throw httpError(400, 'Chọn một thành viên trong đội đang trả lời.');
      if (state.answerDeadlineAt && now >= state.answerDeadlineAt) throw httpError(409, 'Đã hết giờ; đáp án đã bị khóa.');
      if (!Number.isInteger(optionIndex) || optionIndex < 0 || optionIndex > 3) throw httpError(400, 'Vui lòng chọn một trong 4 đáp án.');
      if (question.attemptedTeamIds.includes(team.id)) throw httpError(409, 'Đáp án của đội này đã bị khóa.');
      question.attemptedTeamIds.push(team.id);
      const isCorrect = optionIndex === question.correctIndex;
      if (isCorrect) state.topicEarnedPoints += question.points;
      state.lastAnswer = { teamId: team.id, teamName: team.name, playerName: member.name, optionIndex, isCorrect, questionId: question.id, answeredAt: now, strikeCount: state.strikeCount };
      state.answerDeadlineAt = null;
      if (state.stealOpportunity && state.stealTeamId === team.id) {
        question.status = 'done';
        if (isCorrect) return finishTopic(state, team, 'correct', member.name);
        const originalTeam = findTeam(state, state.originalTeamId);
        if (!originalTeam) throw httpError(409, 'Không tìm thấy đội đã đạt 2 lỗi.');
        return finishTopic(state, originalTeam, 'wrong', state.strikeOwnerName);
      }

      if (isCorrect) {
        question.status = 'done';
        state.activeTeamId = team.id;
        state.activeQuestionId = null;
        state.strikeCount = 0;
        state.strikeOwnerName = null;
        if (state.roundType === 'opening') {
          state.originalTeamId = team.id;
          state.roundType = null;
        }
        if (remainingInTopic(state) > 0) {
          state.phase = 'question_pick';
          state.status = 'live';
          return { state, event: 'correct' };
        }
        return finishTopic(state, team, 'correct', member.name);
      }
      if (state.roundType === 'opening') {
        const hasAnotherTeam = state.teams.some((candidate) => candidate.members.length && !question.attemptedTeamIds.includes(candidate.id));
        state.activeTeamId = null;
        state.answerDeadlineAt = null;
        if (hasAnotherTeam) {
          state.phase = 'buzz_wait';
          state.buzzOpenAt = now;
          return { state, event: 'wrong' };
        }
        question.status = 'done';
        state.activeQuestionId = null;
        state.originalTeamId = null;
        state.roundType = null;
        state.phase = 'board_pick';
        state.lastAnswer.revealedCorrectAnswer = question.options[question.correctIndex];
        return { state, event: 'wrong' };
      }
      return recordStrike(state, { question, team, member, optionIndex, now });
    }
    case 'timeout': {
      if (state.phase !== 'answering' || !state.answerDeadlineAt || now < state.answerDeadlineAt) throw httpError(409, 'Lượt trả lời chưa hết giờ.');
      const question = findQuestion(state);
      const team = findTeam(state, state.activeTeamId);
      if (!question || !team) throw httpError(409, 'Không tìm thấy câu hỏi hoặc đội đang trả lời.');
      if (question.attemptedTeamIds.includes(team.id)) throw httpError(409, 'Đội này đã trả lời câu hỏi đó.');
      question.attemptedTeamIds.push(team.id);
      state.lastAnswer = { teamId: team.id, teamName: team.name, playerName: '', optionIndex: null, isCorrect: false, timedOut: true, questionId: question.id, answeredAt: now, strikeCount: state.strikeCount };
      if (state.stealOpportunity && state.stealTeamId === team.id) {
        question.status = 'done';
        const originalTeam = findTeam(state, state.originalTeamId);
        if (!originalTeam) throw httpError(409, 'Không tìm thấy đội đã đạt 2 lỗi.');
        return finishTopic(state, originalTeam, 'wrong', state.strikeOwnerName);
      }
      if (state.roundType === 'opening') {
        const hasAnotherTeam = state.teams.some((candidate) => candidate.members.length && !question.attemptedTeamIds.includes(candidate.id));
        state.activeTeamId = null;
        state.answerDeadlineAt = null;
        if (hasAnotherTeam) {
          state.phase = 'buzz_wait';
          state.buzzOpenAt = now;
          return { state, event: 'wrong' };
        }
        question.status = 'done';
        state.activeQuestionId = null;
        state.originalTeamId = null;
        state.roundType = null;
        state.phase = 'board_pick';
        state.lastAnswer.revealedCorrectAnswer = question.options[question.correctIndex];
        return { state, event: 'wrong' };
      }
      return recordStrike(state, { question, team, timedOut: true, now });
    }
    case 'update_question': {
      if (state.startedAt) throw httpError(409, 'Bộ câu hỏi đã khóa sau khi game bắt đầu.');
      const question = state.questions.find((item) => item.id === payload.questionId);
      const prompt = String(payload.prompt || '').trim();
      const options = Array.isArray(payload.options) ? payload.options.map((option) => String(option || '').trim()) : [];
      const correctIndex = Number(payload.correctIndex);
      const points = Number(payload.points);
      if (!question || prompt.length < 5 || prompt.length > 200 || options.length !== 4 || options.some((option) => !option || option.length > 100) || !Number.isInteger(correctIndex) || correctIndex < 0 || correctIndex > 3 || !Number.isInteger(points) || points < 1 || points > 5000) {
        throw httpError(400, 'Câu hỏi cần có nội dung, 4 đáp án, một đáp án đúng và điểm từ 1 đến 5000.');
      }
      Object.assign(question, { prompt, options, correctIndex, points });
      return { state };
    }
    case 'set_sound': {
      if (!['buzz', 'correct', 'wrong', 'reveal'].includes(payload.soundKey)) throw httpError(400, 'Loại âm thanh không hợp lệ.');
      const fileUrl = payload.fileUrl === null ? null : String(payload.fileUrl || '');
      if (fileUrl && !fileUrl.startsWith('/uploads/')) throw httpError(400, 'Đường dẫn âm thanh không hợp lệ.');
      state.sounds[payload.soundKey] = fileUrl || null;
      return { state };
    }
    default:
      throw httpError(400, 'Thao tác không hợp lệ.');
  }
}

module.exports = { GROUPS, TOPICS, makeNewGame, applyAction, httpError };
