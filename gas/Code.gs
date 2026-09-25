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
 * POST bodies are sent as text/plain so the browser skips the CORS preflight.
 * The correct discovery answers live ONLY in the AnswerKey tab of the spreadsheet,
 * never in this file or in the website code.
 */

const SHEETS = {
  students: { name: 'Students', headers: ['student_id', 'student_name', 'class'] },
  lessons: { name: 'Lessons', headers: ['lesson_id', 'lesson_title', 'max_attempts', 'practice_reveal_after'] },
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
      practice_reveal_after: ctx.practiceRevealAfter,
    },
    attempts_used: ctx.attempts.length,
    passed: ctx.passed,
    reward: ctx.passed ? reward_(ctx.lesson.lesson_id) : null,
    practice: ctx.passed ? latestPractice_(ctx.student.student_id, ctx.lesson.lesson_id) : null,
  };
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

  // An empty (or 0) max_attempts means unlimited attempts.
  const maxAttempts = toInt_(lesson.max_attempts, 0) > 0 ? toInt_(lesson.max_attempts, 0) : null;
  const practiceRevealAfter = toInt_(lesson.practice_reveal_after, 0) > 0
    ? toInt_(lesson.practice_reveal_after, 0)
    : DEFAULT_PRACTICE_REVEAL_AFTER;

  return {
    student: student,
    lesson: lesson,
    attempts: attempts,
    maxAttempts: maxAttempts,
    practiceRevealAfter: practiceRevealAfter,
    passed: passed,
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

/** Reads a tab into an array of objects keyed by the header row. All values are trimmed strings. */
function readTable_(def) {
  const values = sheet_(def).getDataRange().getValues();
  if (values.length < 2) return [];
  const headers = values[0].map((h) => String(h).trim());
  return values.slice(1).map((row) => {
    const obj = {};
    headers.forEach((h, i) => (obj[h] = String(row[i] == null ? '' : row[i]).trim()));
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
    ['mod1_conditionals', 'Conditionals I & II', '', DEFAULT_PRACTICE_REVEAL_AFTER],
    ['mod2_reported', 'Reported Speech', '', DEFAULT_PRACTICE_REVEAL_AFTER],
  ]);
  seedIfEmpty_(SHEETS.students, [
    [101, 'Test Student', '11-А'],
  ]);
  // The answer key is seeded from Seed.gs, which is uploaded to Apps Script but kept out of the public repo.
  if (typeof ANSWER_KEY_SEED !== 'undefined') seedIfEmpty_(SHEETS.answerKey, ANSWER_KEY_SEED);

  // Remove the blank default tab ("Sheet1" / "Аркуш1") if it is still empty.
  ss.getSheets().forEach((sheet) => {
    const isOurs = Object.keys(SHEETS).some((k) => SHEETS[k].name === sheet.getName());
    if (!isOurs && sheet.getLastRow() === 0 && ss.getSheets().length > 1) ss.deleteSheet(sheet);
  });

  // Keep the key out of sight when the teacher shows the spreadsheet on screen.
  ss.getSheetByName(SHEETS.answerKey.name).hideSheet();
}

/**
 * One-time upgrade for spreadsheets created before practice recording existed:
 * adds the Practice tab and new columns, makes discovery attempts unlimited,
 * sets the practice reveal threshold to 5 and refreshes the answer key.
 */
function upgrade() {
  setup();
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
  if (typeof ANSWER_KEY_SEED !== 'undefined') syncAnswerKey();
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
