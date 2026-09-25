/**
 * Grammar Discovery — backend API (Google Apps Script Web App).
 *
 * GET  ?action=login&student_id=101&lesson_id=mod1_conditionals
 *      -> validates the student, returns name, lesson settings and attempt counters.
 *         If the student has already passed the lesson, the reward section and the
 *         student's saved practice answers are included.
 *
 * POST {"action":"check","student_id":"101","lesson_id":"...","answers":{"q1":"...","r1":"..."}}
 *      -> checks the discovery answers against the AnswerKey tab, records the attempt,
 *         returns the ids of wrong answers and, on success, the reward HTML.
 *
 * POST {"action":"practice","student_id":"101","lesson_id":"...","exercise_id":"ex1",
 *       "event":"check|reveal|submit","check_number":2,"score":60,"answers":{"1":"..."},
 *       "revealed":["2","4"],"client_time":"..."}
 *      -> records one practice event in the Practice tab (only after the lesson is unlocked).
 *
 * POST {"action":"draft","student_id":"101","lesson_id":"...","answers":{"q1":"..."},"client_time":"..."}
 *      -> saves the unfinished discovery answers (one row per student and lesson in the Drafts tab),
 *         so the student can continue on another device. Returned by login as "draft".
 *
 * POST {"action":"admin","teacher_id":"T-...","op":"overview|add_student|update_student|delete_student|
 *       save_lesson|reset_progress", ...}
 *      -> teacher control center (teacher.html). Every op requires a teacher ID from the Teachers tab.
 *
 * POST bodies are sent as text/plain so the browser skips the CORS preflight.
 * The correct discovery answers live ONLY in the AnswerKey tab of the spreadsheet,
 * never in this file or in the website code.
 */

const SHEETS = {
  students: { name: 'Students', headers: ['student_id', 'student_name', 'class'] },
  lessons: {
    name: 'Lessons',
    headers: ['lesson_id', 'lesson_title', 'max_attempts', 'practice_reveal_after', 'practice_max_checks'],
  },
  attempts: {
    name: 'Attempts',
    headers: ['timestamp', 'student_id', 'lesson_id', 'attempt_number', 'score', 'answers_json', 'passed'],
  },
  practice: {
    name: 'Practice',
    headers: ['timestamp', 'student_id', 'lesson_id', 'exercise_id', 'event', 'check_number', 'score',
      'answers_json', 'revealed_items', 'client_time'],
  },
  answerKey: { name: 'AnswerKey', headers: ['lesson_id', 'question_id', 'correct_answer'] },
  teachers: { name: 'Teachers', headers: ['teacher_id', 'teacher_name'] },
  drafts: { name: 'Drafts', headers: ['student_id', 'lesson_id', 'answers_json', 'client_time', 'updated_at'] },
};

const MAX_ANSWER_LENGTH = 200;
const MAX_WRITING_LENGTH = 3000;
const MAX_PRACTICE_ITEMS = 30;
const DEFAULT_PRACTICE_REVEAL_AFTER = 5;
const PRACTICE_EVENTS = ['check', 'reveal', 'submit'];

// ---------------------------------------------------------------- entry points

function doGet(e) {
  return respond_(() => {
    const p = (e && e.parameter) || {};
    if (p.action === 'login') return login_(p.student_id, p.lesson_id);
    throw apiError_('unknown_action', 'Невідома дія.');
  });
}

function doPost(e) {
  return respond_(() => {
    let body;
    try {
      body = JSON.parse(e.postData.contents);
    } catch (err) {
      throw apiError_('bad_request', 'Некоректний запит.');
    }
    if (body.action === 'check') return check_(body);
    if (body.action === 'practice') return practice_(body);
    if (body.action === 'draft') return draft_(body);
    if (body.action === 'admin') return admin_(body);
    throw apiError_('unknown_action', 'Невідома дія.');
  });
}

// ---------------------------------------------------------------- actions

function login_(studentId, lessonId) {
  const ctx = loadContext_(studentId, lessonId);
  return {
    ok: true,
    student: { id: ctx.student.student_id, name: ctx.student.student_name, class: ctx.student.class },
    lesson: {
      id: ctx.lesson.lesson_id,
      title: ctx.lesson.lesson_title,
      max_attempts: ctx.maxAttempts, // null = unlimited
      practice_reveal_after: ctx.practiceRevealAfter, // null = never
      practice_max_checks: ctx.practiceMaxChecks, // null = unlimited
    },
    attempts_used: ctx.attempts.length,
    passed: ctx.passed,
    reward: ctx.passed ? reward_(ctx.lesson.lesson_id) : null,
    practice: ctx.passed ? latestPractice_(ctx.student.student_id, ctx.lesson.lesson_id) : null,
    draft: readDraft_(ctx.student.student_id, ctx.lesson.lesson_id),
  };
}

function draft_(body) {
  const ctx = loadContext_(body.student_id, body.lesson_id);
  const given = body.answers && typeof body.answers === 'object' ? body.answers : {};
  const answers = {};
  Object.keys(given).slice(0, 40).forEach((k) => {
    if (/^[A-Za-z0-9_]{1,20}$/.test(k)) answers[k] = String(given[k] == null ? '' : given[k]).slice(0, MAX_ANSWER_LENGTH);
  });
  const clientTime = String(body.client_time || '').slice(0, 40);

  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    // Created on first use, so older spreadsheets need no manual upgrade for this tab.
    ensureSheet_(SpreadsheetApp.getActiveSpreadsheet(), SHEETS.drafts);
    const existing = readTable_(SHEETS.drafts).find((row) =>
      row.student_id === ctx.student.student_id && row.lesson_id === ctx.lesson.lesson_id);
    // Ignore an older draft arriving late (e.g. sent from a phone that was offline).
    if (existing && existing.client_time && clientTime && existing.client_time > clientTime) return { ok: true, stale: true };
    const fields = {
      student_id: ctx.student.student_id,
      lesson_id: ctx.lesson.lesson_id,
      answers_json: JSON.stringify(answers),
      client_time: clientTime,
      updated_at: new Date(),
    };
    writeRow_(SHEETS.drafts, existing ? existing._row : null, fields);
  } finally {
    lock.releaseLock();
  }
  return { ok: true };
}

function readDraft_(studentId, lessonId) {
  if (!SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEETS.drafts.name)) return null;
  const row = readTable_(SHEETS.drafts).find((r) => r.student_id === studentId && r.lesson_id === lessonId);
  if (!row) return null;
  let answers = {};
  try {
    answers = JSON.parse(row.answers_json || '{}');
  } catch (err) {
    answers = {};
  }
  return { answers: answers, client_time: row.client_time };
}

function check_(body) {
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const ctx = loadContext_(body.student_id, body.lesson_id);
    const base = { ok: true, max_attempts: ctx.maxAttempts };

    // Already passed earlier: just hand the reward back, don't record another attempt.
    if (ctx.passed) {
      return Object.assign(base, {
        passed: true,
        already_passed: true,
        wrong: [],
        attempts_used: ctx.attempts.length,
        reward: reward_(ctx.lesson.lesson_id),
        practice: latestPractice_(ctx.student.student_id, ctx.lesson.lesson_id),
      });
    }

    if (ctx.maxAttempts && ctx.attempts.length >= ctx.maxAttempts) {
      throw apiError_('no_attempts_left', 'Спроби вичерпано. Зверніться до вчителя.');
    }

    const key = readTable_(SHEETS.answerKey).filter((row) => row.lesson_id === ctx.lesson.lesson_id);
    if (!key.length) throw apiError_('no_answer_key', 'Для цього модуля ще немає ключа відповідей.');

    const given = body.answers && typeof body.answers === 'object' ? body.answers : {};
    const recorded = {};
    const wrong = [];
    key.forEach((row) => {
      const answer = String(given[row.question_id] == null ? '' : given[row.question_id]).slice(0, MAX_ANSWER_LENGTH);
      recorded[row.question_id] = answer;
      const accepted = row.correct_answer.split('|').map(normalize_);
      if (accepted.indexOf(normalize_(answer)) === -1) wrong.push(row.question_id);
    });

    const passed = wrong.length === 0;
    const score = Math.round(((key.length - wrong.length) / key.length) * 100);
    const attemptNumber = ctx.attempts.length + 1;

    sheet_(SHEETS.attempts).appendRow([
      new Date(),
      ctx.student.student_id,
      ctx.lesson.lesson_id,
      attemptNumber,
      score,
      JSON.stringify(recorded),
      passed,
    ]);

    return Object.assign(base, {
      passed: passed,
      wrong: wrong,
      score: score,
      attempts_used: attemptNumber,
      reward: passed ? reward_(ctx.lesson.lesson_id) : null,
      practice: passed ? {} : null,
    });
  } finally {
    lock.releaseLock();
  }
}

function practice_(body) {
  const ctx = loadContext_(body.student_id, body.lesson_id);
  if (!ctx.passed) throw apiError_('not_unlocked', 'Спершу пройдіть кроки відкриття правила.');

  const exerciseId = String(body.exercise_id || '');
  if (!/^[A-Za-z0-9_-]{1,40}$/.test(exerciseId)) throw apiError_('bad_request', 'Некоректна вправа.');
  const event = String(body.event || '');
  if (PRACTICE_EVENTS.indexOf(event) === -1) throw apiError_('bad_request', 'Некоректна дія.');

  const answers = {};
  const given = body.answers && typeof body.answers === 'object' ? body.answers : {};
  Object.keys(given).slice(0, MAX_PRACTICE_ITEMS).forEach((k) => {
    if (/^[0-9]{1,3}$/.test(k)) answers[k] = String(given[k] == null ? '' : given[k]).slice(0, MAX_WRITING_LENGTH);
  });
  const revealed = (Array.isArray(body.revealed) ? body.revealed : [])
    .map(String)
    .filter((k) => /^[0-9]{1,3}$/.test(k))
    .slice(0, MAX_PRACTICE_ITEMS);

  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    // Limits are enforced here too, not only in the browser.
    if (event === 'check' || event === 'reveal') {
      const checksDone = readTable_(SHEETS.practice).filter((row) =>
        row.student_id === ctx.student.student_id && row.lesson_id === ctx.lesson.lesson_id &&
        row.exercise_id === exerciseId && row.event === 'check').length;
      if (event === 'check' && ctx.practiceMaxChecks && checksDone >= ctx.practiceMaxChecks) {
        throw apiError_('practice_limit', 'Ліміт перевірок для цієї вправи вичерпано.');
      }
      if (event === 'reveal' && (ctx.practiceRevealAfter === null || checksDone < ctx.practiceRevealAfter)) {
        throw apiError_('practice_reveal_locked', 'Відповіді для цієї вправи ще не можна подивитися.');
      }
    }
    sheet_(SHEETS.practice).appendRow([
      new Date(),
      ctx.student.student_id,
      ctx.lesson.lesson_id,
      exerciseId,
      event,
      toInt_(body.check_number, 0),
      event === 'submit' ? '' : Math.max(0, Math.min(100, toInt_(body.score, 0))),
      JSON.stringify(answers),
      revealed.join(','),
      String(body.client_time || '').slice(0, 40),
    ]);
  } finally {
    lock.releaseLock();
  }
  return { ok: true };
}

// ---------------------------------------------------------------- teacher control center

const ADMIN_OPS = ['overview', 'add_student', 'update_student', 'delete_student', 'save_lesson', 'reset_progress'];
const RESET_SCOPES = ['all', 'discovery', 'practice'];

function admin_(body) {
  const teacher = authTeacher_(body.teacher_id);
  const op = String(body.op || '');
  if (ADMIN_OPS.indexOf(op) === -1) throw apiError_('unknown_action', 'Невідома дія.');
  if (op === 'overview') return overview_(teacher);

  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    if (op === 'add_student') addStudent_(body.student || {});
    if (op === 'update_student') updateStudent_(body.student || {});
    if (op === 'delete_student') deleteStudent_(body.student_id);
    if (op === 'save_lesson') saveLesson_(body.lesson || {});
    if (op === 'reset_progress') resetProgress_(body.student_id, body.lesson_id, body.scope);
  } finally {
    lock.releaseLock();
  }
  return overview_(teacher);
}

function authTeacher_(teacherId) {
  const tid = String(teacherId == null ? '' : teacherId).trim();
  if (!tid) throw apiError_('not_teacher', 'Введіть ID вчителя.');
  const teacher = readTable_(SHEETS.teachers).find((row) => row.teacher_id === tid);
  if (!teacher) throw apiError_('not_teacher', 'Невірний ID вчителя.');
  return teacher;
}

/** Everything the control center needs, in one response. */
function overview_(teacher) {
  const hasPractice = Boolean(SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEETS.practice.name));
  const lessons = readTable_(SHEETS.lessons).map((lesson) => {
    const settings = lessonSettings_(lesson);
    return {
      lesson_id: lesson.lesson_id,
      lesson_title: lesson.lesson_title,
      max_attempts: settings.maxAttempts,
      practice_reveal_after: settings.practiceRevealAfter,
      practice_max_checks: settings.practiceMaxChecks,
    };
  });
  const rewards = {};
  lessons.forEach((l) => (rewards[l.lesson_id] = reward_(l.lesson_id)));
  return {
    ok: true,
    teacher: { name: teacher.teacher_name },
    students: readTable_(SHEETS.students),
    lessons: lessons,
    attempts: readTable_(SHEETS.attempts),
    practice: hasPractice ? readTable_(SHEETS.practice) : [],
    answer_key: readTable_(SHEETS.answerKey),
    rewards: rewards,
  };
}

function addStudent_(student) {
  const id = String(student.student_id == null ? '' : student.student_id).trim();
  if (!/^[A-Za-z0-9_-]{1,20}$/.test(id)) {
    throw apiError_('bad_request', 'ID учня: 1–20 символів, лише латинські літери, цифри, «-» або «_».');
  }
  if (readTable_(SHEETS.students).some((row) => row.student_id === id)) {
    throw apiError_('duplicate', 'Учень з таким ID вже існує.');
  }
  if (readTable_(SHEETS.teachers).some((row) => row.teacher_id === id)) {
    throw apiError_('duplicate', 'Цей ID вже використовується.');
  }
  const name = cleanCell_(student.student_name);
  if (!name) throw apiError_('bad_request', "Введіть ім'я учня.");
  writeRow_(SHEETS.students, null, { student_id: id, student_name: name, class: cleanCell_(student.class) });
}

function updateStudent_(student) {
  const row = findRow_(SHEETS.students, 'student_id', student.student_id);
  const name = cleanCell_(student.student_name);
  if (!name) throw apiError_('bad_request', "Введіть ім'я учня.");
  writeRow_(SHEETS.students, row._row, { student_name: name, class: cleanCell_(student.class) });
}

/** Removes the student from the list; their attempts stay in the records. */
function deleteStudent_(studentId) {
  const row = findRow_(SHEETS.students, 'student_id', studentId);
  sheet_(SHEETS.students).deleteRow(row._row);
}

function saveLesson_(lesson) {
  const row = findRow_(SHEETS.lessons, 'lesson_id', lesson.lesson_id);
  const optionalPositive = (v, label) => {
    const text = String(v == null ? '' : v).trim();
    if (text === '') return '';
    if (!/^[0-9]{1,3}$/.test(text) || Number(text) < 1) throw apiError_('bad_request', label + ': ціле число від 1 або порожньо.');
    return Number(text);
  };
  const reveal = String(lesson.practice_reveal_after == null ? '' : lesson.practice_reveal_after).trim().toLowerCase();
  if (reveal !== 'never' && !/^[0-9]{1,3}$/.test(reveal)) {
    throw apiError_('bad_request', 'Показ відповідей: ціле число від 0 або «never».');
  }
  writeRow_(SHEETS.lessons, row._row, {
    max_attempts: optionalPositive(lesson.max_attempts, 'Спроби відкриття правила'),
    practice_max_checks: optionalPositive(lesson.practice_max_checks, 'Ліміт перевірок'),
    practice_reveal_after: reveal === 'never' ? 'never' : Number(reveal),
  });
}

function resetProgress_(studentId, lessonId, scope) {
  const sid = String(studentId == null ? '' : studentId).trim();
  const lid = String(lessonId == null ? '' : lessonId).trim();
  if (RESET_SCOPES.indexOf(scope) === -1) throw apiError_('bad_request', 'Некоректна дія.');
  const tabs = [];
  if (scope !== 'practice') tabs.push(SHEETS.attempts);
  if (scope !== 'practice' && SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEETS.drafts.name)) {
    tabs.push(SHEETS.drafts);
  }
  if (scope !== 'discovery' && SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEETS.practice.name)) {
    tabs.push(SHEETS.practice);
  }
  tabs.forEach((def) => {
    const rows = readTable_(def).filter((r) => r.student_id === sid && r.lesson_id === lid).map((r) => r._row);
    const sheet = sheet_(def);
    rows.sort((a, b) => b - a).forEach((r) => sheet.deleteRow(r)); // bottom-up keeps row numbers valid
  });
}

function findRow_(def, column, value) {
  const v = String(value == null ? '' : value).trim();
  const row = readTable_(def).find((r) => r[column] === v);
  if (!row) throw apiError_('not_found', 'Запис не знайдено. Оновіть сторінку.');
  return row;
}

/** Writes the given fields by header name; rowNumber null appends a new row. */
function writeRow_(def, rowNumber, fields) {
  const sheet = sheet_(def);
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].map((h) => String(h).trim());
  if (rowNumber === null) {
    sheet.appendRow(headers.map((h) => (h in fields ? fields[h] : '')));
    return;
  }
  Object.keys(fields).forEach((k) => {
    const col = headers.indexOf(k) + 1;
    if (col > 0) sheet.getRange(rowNumber, col).setValue(fields[k]);
  });
}

/** Short plain text for a cell; a leading = + - @ is escaped so it can never become a formula. */
function cleanCell_(value) {
  const text = String(value == null ? '' : value).replace(/\s+/g, ' ').trim().slice(0, 100);
  return /^[=+\-@]/.test(text) ? "'" + text : text;
}

// ---------------------------------------------------------------- helpers

function loadContext_(studentId, lessonId) {
  const sid = String(studentId == null ? '' : studentId).trim();
  const lid = String(lessonId == null ? '' : lessonId).trim();
  if (!sid) throw apiError_('student_not_found', 'Введіть ваш ID.');

  const student = readTable_(SHEETS.students).find((row) => row.student_id === sid);
  if (!student) throw apiError_('student_not_found', 'Учня з таким ID не знайдено. Перевірте ID.');

  const lesson = readTable_(SHEETS.lessons).find((row) => row.lesson_id === lid);
  if (!lesson) throw apiError_('lesson_not_found', 'Модуль не знайдено.');

  const attempts = readTable_(SHEETS.attempts).filter((row) => row.student_id === sid && row.lesson_id === lid);
  const passed = attempts.some((row) => row.passed.toUpperCase() === 'TRUE');

  const settings = lessonSettings_(lesson);

  return {
    student: student,
    lesson: lesson,
    attempts: attempts,
    maxAttempts: settings.maxAttempts,
    practiceRevealAfter: settings.practiceRevealAfter,
    practiceMaxChecks: settings.practiceMaxChecks,
    passed: passed,
  };
}

/**
 * Lesson settings from the Lessons tab:
 *   max_attempts          empty = unlimited discovery attempts
 *   practice_reveal_after checks needed before answers can be revealed
 *                         (0 = right away, "never" = never, empty = default 5)
 *   practice_max_checks   empty = unlimited checks per practice exercise
 */
function lessonSettings_(lesson) {
  const positive = (v) => (toInt_(v, 0) > 0 ? toInt_(v, 0) : null);
  const reveal = String(lesson.practice_reveal_after || '').trim().toLowerCase();
  let practiceRevealAfter = DEFAULT_PRACTICE_REVEAL_AFTER;
  if (reveal === 'never') practiceRevealAfter = null;
  else if (reveal !== '' && toInt_(reveal, -1) >= 0) practiceRevealAfter = toInt_(reveal, 0);
  return {
    maxAttempts: positive(lesson.max_attempts),
    practiceRevealAfter: practiceRevealAfter,
    practiceMaxChecks: positive(lesson.practice_max_checks),
  };
}

/** The latest saved state of every practice exercise: { exercise_id: {event, check_number, answers, revealed} }. */
function latestPractice_(studentId, lessonId) {
  const latest = {};
  // Spreadsheets set up before practice recording have no Practice tab until upgrade() is run.
  if (!SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEETS.practice.name)) return latest;
  readTable_(SHEETS.practice).forEach((row) => {
    if (row.student_id !== studentId || row.lesson_id !== lessonId) return;
    let answers = {};
    try {
      answers = JSON.parse(row.answers_json || '{}');
    } catch (err) {
      answers = {};
    }
    latest[row.exercise_id] = {
      event: row.event,
      check_number: toInt_(row.check_number, 0),
      answers: answers,
      revealed: row.revealed_items ? row.revealed_items.split(',') : [],
    };
  });
  return latest;
}

/**
 * Reads a tab into an array of objects keyed by the header row. Values are trimmed strings
 * (dates as ISO strings); _row is the row number in the sheet.
 */
function readTable_(def) {
  const values = sheet_(def).getDataRange().getValues();
  if (values.length < 2) return [];
  const headers = values[0].map((h) => String(h).trim());
  return values.slice(1).map((row, i) => {
    const obj = { _row: i + 2 };
    headers.forEach((h, j) => {
      const v = row[j];
      obj[h] = v instanceof Date ? v.toISOString() : String(v == null ? '' : v).trim();
    });
    return obj;
  });
}

function sheet_(def) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(def.name);
  if (!sheet) throw apiError_('server_setup', 'Таблицю не налаштовано (немає вкладки ' + def.name + ').');
  return sheet;
}

/** Reward files are named reward_<lesson_id>.html in this project. */
function reward_(lessonId) {
  try {
    return HtmlService.createHtmlOutputFromFile('reward_' + lessonId).getContent();
  } catch (err) {
    return '<p>Матеріал для цього модуля ще не додано.</p>';
  }
}

function toInt_(value, fallback) {
  const n = parseInt(value, 10);
  return isNaN(n) ? fallback : n;
}

function normalize_(s) {
  return String(s)
    .toLowerCase()
    .replace(/[’‘`]/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function apiError_(code, message) {
  const err = new Error(message);
  err.apiCode = code;
  return err;
}

function respond_(fn) {
  let result;
  try {
    result = fn();
  } catch (err) {
    if (!err.apiCode) console.error(err);
    result = {
      ok: false,
      error: err.apiCode || 'server_error',
      message: err.apiCode ? err.message : 'Помилка сервера. Спробуйте ще раз.',
    };
  }
  return ContentService.createTextOutput(JSON.stringify(result)).setMimeType(ContentService.MimeType.JSON);
}

// ---------------------------------------------------------------- setup & maintenance

/**
 * Run once from the Apps Script editor (select "setup" and press Run).
 * Creates missing tabs, adds missing columns and fills empty tabs with starter data.
 * Existing data is never overwritten. Safe to run again after an update.
 */
function setup() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  Object.keys(SHEETS).forEach((k) => ensureSheet_(ss, SHEETS[k]));

  seedIfEmpty_(SHEETS.lessons, [
    ['mod1_conditionals', 'Conditionals I & II', '', DEFAULT_PRACTICE_REVEAL_AFTER, ''],
    ['mod2_reported', 'Reported Speech', '', DEFAULT_PRACTICE_REVEAL_AFTER, ''],
  ]);
  seedIfEmpty_(SHEETS.students, [
    [101, 'Test Student', '11-А'],
  ]);
  // The answer key is seeded from Seed.gs, which is uploaded to Apps Script but kept out of the public repo.
  if (typeof ANSWER_KEY_SEED !== 'undefined') seedIfEmpty_(SHEETS.answerKey, ANSWER_KEY_SEED);
  if (typeof TEACHER_SEED !== 'undefined') seedIfEmpty_(SHEETS.teachers, TEACHER_SEED);

  // Remove the blank default tab ("Sheet1" / "Аркуш1") if it is still empty.
  ss.getSheets().forEach((sheet) => {
    const isOurs = Object.keys(SHEETS).some((k) => SHEETS[k].name === sheet.getName());
    if (!isOurs && sheet.getLastRow() === 0 && ss.getSheets().length > 1) ss.deleteSheet(sheet);
  });

  // Keep the key out of sight when the teacher shows the spreadsheet on screen.
  ss.getSheetByName(SHEETS.answerKey.name).hideSheet();
}

/**
 * Upgrade for spreadsheets created with an earlier version. Safe to run more than once:
 * adds new tabs (Practice, Teachers) and columns and refreshes the answer key. Only the
 * first time practice settings are added, it also makes discovery attempts unlimited and
 * sets the practice reveal threshold to 5.
 */
function upgrade() {
  const lessonsSheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEETS.lessons.name);
  const hadPracticeSettings = Boolean(lessonsSheet) && lessonsSheet.getLastColumn() > 0 &&
    lessonsSheet.getRange(1, 1, 1, lessonsSheet.getLastColumn()).getValues()[0].map(String)
      .indexOf('practice_reveal_after') !== -1;
  setup();
  if (typeof ANSWER_KEY_SEED !== 'undefined') syncAnswerKey();
  if (hadPracticeSettings) return;

  const sheet = sheet_(SHEETS.lessons);
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].map(String);
  const maxCol = headers.indexOf('max_attempts') + 1;
  const revealCol = headers.indexOf('practice_reveal_after') + 1;
  const rows = sheet.getLastRow() - 1;
  if (rows > 0) {
    sheet.getRange(2, maxCol, rows, 1).clearContent();
    const reveal = sheet.getRange(2, revealCol, rows, 1);
    reveal.setValues(reveal.getValues().map((r) => [r[0] === '' ? DEFAULT_PRACTICE_REVEAL_AFTER : r[0]]));
  }
}

/**
 * Run from the Apps Script editor after the questions on the lesson pages change.
 * Replaces the whole AnswerKey tab with the rows from ANSWER_KEY_SEED (Seed.gs).
 */
function syncAnswerKey() {
  if (typeof ANSWER_KEY_SEED === 'undefined') throw new Error('Seed.gs with ANSWER_KEY_SEED is missing.');
  const sheet = sheet_(SHEETS.answerKey);
  if (sheet.getLastRow() > 1) sheet.getRange(2, 1, sheet.getLastRow() - 1, sheet.getLastColumn()).clearContent();
  sheet.getRange(2, 1, ANSWER_KEY_SEED.length, ANSWER_KEY_SEED[0].length).setValues(ANSWER_KEY_SEED);
}

/** Creates the tab if needed and appends any header columns that are missing. */
function ensureSheet_(ss, def) {
  let sheet = ss.getSheetByName(def.name);
  if (!sheet) sheet = ss.insertSheet(def.name);
  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, def.headers.length).setValues([def.headers]);
  } else {
    const existing = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].map((h) => String(h).trim());
    const missing = def.headers.filter((h) => existing.indexOf(h) === -1);
    if (missing.length) sheet.getRange(1, existing.length + 1, 1, missing.length).setValues([missing]);
  }
  sheet.getRange(1, 1, 1, sheet.getLastColumn()).setFontWeight('bold');
  sheet.setFrozenRows(1);
}

function seedIfEmpty_(def, rows) {
  const sheet = sheet_(def);
  if (sheet.getLastRow() > 1 || !rows.length) return;
  sheet.getRange(2, 1, rows.length, rows[0].length).setValues(rows);
}
