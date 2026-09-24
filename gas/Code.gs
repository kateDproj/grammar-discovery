/**
 * Grammar Discovery — backend API (Google Apps Script Web App).
 *
 * GET  ?action=login&student_id=101&lesson_id=mod1_conditionals
 *      -> validates the student, returns name, lesson title and attempt counters.
 *         If the student has already passed the lesson, the reward section is included.
 *
 * POST {"action":"check","student_id":"101","lesson_id":"...","answers":{"q1":"...","r1":"..."}}
 *      (sent as text/plain so the browser skips the CORS preflight)
 *      -> checks the answers against the AnswerKey tab, records the attempt,
 *         returns the ids of wrong answers and, on success, the reward HTML.
 *
 * The correct answers live ONLY in the AnswerKey tab of the spreadsheet,
 * never in this file or in the website code.
 */

const SHEETS = {
  students: { name: 'Students', headers: ['student_id', 'student_name', 'class'] },
  lessons: { name: 'Lessons', headers: ['lesson_id', 'lesson_title', 'max_attempts'] },
  attempts: {
    name: 'Attempts',
    headers: ['timestamp', 'student_id', 'lesson_id', 'attempt_number', 'score', 'answers_json', 'passed'],
  },
  answerKey: { name: 'AnswerKey', headers: ['lesson_id', 'question_id', 'correct_answer'] },
};

const MAX_ANSWER_LENGTH = 200;

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
    throw apiError_('unknown_action', 'Невідома дія.');
  });
}

// ---------------------------------------------------------------- actions

function login_(studentId, lessonId) {
  const ctx = loadContext_(studentId, lessonId);
  return {
    ok: true,
    student: { id: ctx.student.student_id, name: ctx.student.student_name, class: ctx.student.class },
    lesson: { id: ctx.lesson.lesson_id, title: ctx.lesson.lesson_title, max_attempts: ctx.maxAttempts },
    attempts_used: ctx.attempts.length,
    passed: ctx.passed,
    reward: ctx.passed ? reward_(ctx.lesson.lesson_id) : null,
  };
}

function check_(body) {
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const ctx = loadContext_(body.student_id, body.lesson_id);
    const base = {
      ok: true,
      max_attempts: ctx.maxAttempts,
    };

    // Already passed earlier: just hand the reward back, don't burn an attempt.
    if (ctx.passed) {
      return Object.assign(base, {
        passed: true,
        already_passed: true,
        wrong: [],
        attempts_used: ctx.attempts.length,
        reward: reward_(ctx.lesson.lesson_id),
      });
    }

    if (ctx.attempts.length >= ctx.maxAttempts) {
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
    });
  } finally {
    lock.releaseLock();
  }
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
  const maxAttempts = parseInt(lesson.max_attempts, 10) || 3;
  const passed = attempts.some((row) => row.passed.toUpperCase() === 'TRUE');

  return { student: student, lesson: lesson, attempts: attempts, maxAttempts: maxAttempts, passed: passed };
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

// ---------------------------------------------------------------- one-time setup

/**
 * Run once from the Apps Script editor (select "setup" and press Run).
 * Creates missing tabs with headers and fills empty tabs with starter data.
 * Existing data is never overwritten.
 */
function setup() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();

  Object.keys(SHEETS).forEach((k) => {
    const def = SHEETS[k];
    let sheet = ss.getSheetByName(def.name);
    if (!sheet) sheet = ss.insertSheet(def.name);
    if (sheet.getLastRow() === 0) {
      sheet.getRange(1, 1, 1, def.headers.length).setValues([def.headers]).setFontWeight('bold');
      sheet.setFrozenRows(1);
    }
  });

  seedIfEmpty_(SHEETS.lessons, [
    ['mod1_conditionals', 'Conditionals I & II', 3],
    ['mod2_reported', 'Reported Speech', 3],
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

function seedIfEmpty_(def, rows) {
  const sheet = sheet_(def);
  if (sheet.getLastRow() > 1 || !rows.length) return;
  sheet.getRange(2, 1, rows.length, rows[0].length).setValues(rows);
}
