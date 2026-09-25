/*
 * Grammar Discovery — teacher control center.
 *
 * Reads everything through the admin API (one "overview" call) and renders three views:
 * overview per module, the student list, and module settings. A student's page shows every
 * discovery attempt and every practice event with the real question texts, which are read
 * from the lesson pages (LESSON_PAGES in config.js) and from the reward sections.
 */
(function () {
  'use strict';

  const CONFIG = window.APP_CONFIG || {};
  const API_URL = CONFIG.API_URL;
  const LESSON_PAGES = CONFIG.LESSON_PAGES || {};
  const REQUEST_TIMEOUT_MS = 30000;
  const SESSION_KEY = 'gd:teacher_id';

  const T = {
    teacherId: null,
    data: null,
    meta: {}, // lesson_id -> { questions: {id: {...}}, questionOrder: [], exercises: {id: {...}}, exerciseOrder: [] }
    view: 'overview',
    studentId: null,
    filterClass: '',
    search: '',
  };

  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  // ------------------------------------------------------------ helpers

  function esc(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function normalize(s) {
    return String(s).toLowerCase().replace(/[’‘`]/g, "'").replace(/\s+/g, ' ').trim();
  }

  function accepts(key, value) {
    return String(key).split('|').map(normalize).indexOf(normalize(value)) !== -1;
  }

  function fmtDate(iso) {
    const d = new Date(iso);
    if (isNaN(d)) return esc(iso);
    return d.toLocaleString('uk-UA', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  }

  function parseJson(text) {
    try { return JSON.parse(text || '{}'); } catch (e) { return {}; }
  }

  function text(el) {
    return el ? el.textContent.replace(/\s+/g, ' ').trim() : '';
  }

  function plural(n, one, few, many) {
    const m10 = n % 10;
    const m100 = n % 100;
    if (m10 === 1 && m100 !== 11) return one;
    if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
    return many;
  }

  let toastTimer = null;
  function toast(message, isError) {
    const el = $('#t-toast');
    el.textContent = message;
    el.className = 't-toast' + (isError ? ' t-toast--error' : '');
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (el.hidden = true), isError ? 6000 : 3000);
  }

  function session(value) {
    try {
      if (value === undefined) return sessionStorage.getItem(SESSION_KEY);
      if (value === null) sessionStorage.removeItem(SESSION_KEY);
      else sessionStorage.setItem(SESSION_KEY, value);
    } catch (e) { /* storage unavailable */ }
    return null;
  }

  // ------------------------------------------------------------ API

  async function api(op, params) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    let res;
    try {
      res = await fetch(API_URL, {
        method: 'POST',
        body: JSON.stringify(Object.assign({ action: 'admin', teacher_id: T.teacherId, op: op }, params || {})),
        signal: controller.signal,
      });
    } catch (e) {
      throw { code: 'network', message: "Немає з'єднання з сервером. Спробуйте ще раз." };
    } finally {
      clearTimeout(timer);
    }
    let data;
    try { data = await res.json(); } catch (e) {
      throw { code: 'bad_response', message: 'Сервер повернув незрозумілу відповідь.' };
    }
    if (!data.ok) throw { code: data.error, message: data.message };
    return data;
  }

  async function run(op, params, successMessage) {
    try {
      T.data = await api(op, params);
      if (successMessage) toast(successMessage);
      render();
      return true;
    } catch (err) {
      toast(err.message, true);
      if (err.code === 'not_teacher') logout();
      return false;
    }
  }

  // ------------------------------------------------------------ lesson metadata (question texts)

  async function loadMeta() {
    const parser = new DOMParser();
    await Promise.all(T.data.lessons.map(async (lesson) => {
      const meta = { questions: {}, questionOrder: [], exercises: {}, exerciseOrder: [] };
      T.meta[lesson.lesson_id] = meta;

      const stored = (T.data.contents || {})[lesson.lesson_id];
      const page = LESSON_PAGES[lesson.lesson_id];
      if (stored || page) {
        try {
          const html = stored ? window.LessonRender.steps(stored.content) : await (await fetch(page)).text();
          const doc = parser.parseFromString(html, 'text/html');
          $$('[data-question]', doc).forEach((el) => {
            const id = el.dataset.question;
            const q = { id: id, prompt: '', options: {} };
            if (el.tagName === 'SELECT') {
              const li = el.closest('li').cloneNode(true);
              $$('select', li).forEach((s) => s.replaceWith(s === $('[data-question="' + id + '"]', li) ? ' ___ ' : ' … '));
              q.prompt = text(li);
              $$('option', el).forEach((o) => { if (o.value) q.options[o.value] = text(o); });
            } else {
              const legend = $('legend', el).cloneNode(true);
              q.quote = text($('.ccq-quote', legend));
              $$('.ccq-quote', legend).forEach((n) => n.remove());
              q.prompt = text(legend).replace(/^\d+\.\s*/, '');
              $$('input[type="radio"]', el).forEach((i) => (q.options[i.value] = text(i.parentElement)));
            }
            meta.questions[id] = q;
            meta.questionOrder.push(id);
          });
        } catch (e) { /* page unavailable: ids are shown instead */ }
      }

      const rewardHtml = stored ? window.LessonRender.reward(stored.content.reward) : T.data.rewards[lesson.lesson_id] || '';
      const reward = parser.parseFromString(rewardHtml, 'text/html');
      $$('[data-exercise-id]', reward).forEach((section) => {
        const ex = { id: section.dataset.exerciseId, title: text($('.exercise__title', section)), fields: [] };
        $$('input, select, textarea', section).forEach((f) => {
          const li = f.closest('li');
          let prompt = '';
          if (li) {
            const clone = li.cloneNode(true);
            $$('details, .text-emerald-700', clone).forEach((n) => n.remove());
            $$('input, select, textarea', clone).forEach((n) => n.replaceWith(' ___ '));
            prompt = text(clone);
          }
          ex.fields.push({ answer: f.dataset.answer || null, writing: f.tagName === 'TEXTAREA', prompt: prompt });
        });
        ex.gapCount = ex.fields.filter((f) => f.answer).length;
        meta.exercises[ex.id] = ex;
        meta.exerciseOrder.push(ex.id);
      });
    }));
  }

  // ------------------------------------------------------------ derived data

  function lessonTitle(id) {
    const l = T.data.lessons.find((x) => x.lesson_id === id);
    return l ? l.lesson_title : id;
  }

  function studentAttempts(sid, lid) {
    return T.data.attempts.filter((a) => a.student_id === sid && a.lesson_id === lid);
  }

  function studentPractice(sid, lid) {
    return T.data.practice.filter((p) => p.student_id === sid && p.lesson_id === lid);
  }

  function isPassed(row) {
    return String(row.passed).toUpperCase() === 'TRUE';
  }

  /** Discovery + practice summary for one student in one lesson. */
  function progress(sid, lid) {
    const attempts = studentAttempts(sid, lid);
    const passIndex = attempts.findIndex(isPassed);
    const practice = studentPractice(sid, lid);
    const meta = T.meta[lid] || { exerciseOrder: [], exercises: {} };
    const latest = {};
    practice.forEach((p) => { if (p.event !== 'submit') latest[p.exercise_id] = p; });
    const gapExercises = meta.exerciseOrder.filter((id) => meta.exercises[id].gapCount);
    const scores = gapExercises.filter((id) => latest[id]).map((id) => Number(latest[id].score) || 0);
    const writingDone = new Set(practice.filter((p) => p.event === 'submit').map((p) => p.exercise_id)).size;
    return {
      attempts: attempts.length,
      passed: passIndex !== -1,
      attemptsToPass: passIndex + 1,
      practiceStarted: practice.length > 0,
      exercisesChecked: scores.length,
      gapExerciseCount: gapExercises.length,
      writingDone: writingDone,
      writingCount: meta.exerciseOrder.length - gapExercises.length,
      avgScore: scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : null,
      revealed: practice.filter((p) => p.event === 'reveal').length,
    };
  }

  function statusChip(p) {
    if (!p.attempts) return '<span class="t-chip t-chip--none">не розпочато</span>';
    if (!p.passed) {
      return '<span class="t-chip t-chip--progress">🔄 ' + p.attempts + ' ' + plural(p.attempts, 'спроба', 'спроби', 'спроб') + '</span>';
    }
    let html = '<span class="t-chip t-chip--done">✅ з ' + p.attemptsToPass + '-ї спроби</span>';
    if (p.practiceStarted) {
      html += ' <span class="t-chip t-chip--info">вправи ' + p.exercisesChecked + '/' + p.gapExerciseCount +
        (p.avgScore !== null ? ' · ' + p.avgScore + '%' : '') + '</span>';
    }
    return html;
  }

  function classes() {
    return Array.from(new Set(T.data.students.map((s) => s.class).filter(Boolean))).sort();
  }

  function visibleStudents() {
    const q = normalize(T.search);
    return T.data.students
      .filter((s) => !T.filterClass || s.class === T.filterClass)
      .filter((s) => !q || normalize(s.student_name + ' ' + s.student_id).indexOf(q) !== -1)
      .sort((a, b) => (a.class + a.student_name).localeCompare(b.class + b.student_name, 'uk'));
  }

  // ------------------------------------------------------------ views

  function render() {
    $$('.t-tab').forEach((b) => {
      const current = b.dataset.view === T.view || (T.view === 'student' && b.dataset.view === 'students') ||
        (T.view === 'editor' && b.dataset.view === 'builder');
      if (current) b.setAttribute('aria-current', 'page');
      else b.removeAttribute('aria-current');
    });
    $('[data-teacher-name]').textContent = T.data.teacher.name;
    const views = Object.assign(
      { overview: viewOverview, students: viewStudents, student: viewStudent, lessons: viewLessons },
      (window.TeacherEditor && window.TeacherEditor.views) || {});
    $('#t-main').innerHTML = views[T.view]();
    if (window.TeacherEditor && window.TeacherEditor.afterRender) window.TeacherEditor.afterRender();
  }

  function viewOverview() {
    const total = T.data.students.length;
    const cards = T.data.lessons.map((lesson) => {
      const lid = lesson.lesson_id;
      const all = T.data.students.map((s) => progress(s.student_id, lid));
      const started = all.filter((p) => p.attempts).length;
      const passed = all.filter((p) => p.passed);
      const avgToPass = passed.length
        ? (passed.reduce((a, p) => a + p.attemptsToPass, 0) / passed.length).toFixed(1).replace('.', ',')
        : '—';
      const scored = all.filter((p) => p.avgScore !== null);
      const avgPractice = scored.length ? Math.round(scored.reduce((a, p) => a + p.avgScore, 0) / scored.length) + '%' : '—';

      return '<section class="t-card space-y-5">' +
        '<div class="flex flex-wrap items-baseline justify-between gap-2">' +
        '  <h2 class="text-xl font-bold text-slate-900">' + esc(lesson.lesson_title) + '</h2>' +
        '  <span class="text-sm text-slate-500">' + settingsSummary(lesson) + '</span>' +
        '</div>' +
        '<div class="t-kpis">' +
        kpi(started + ' / ' + total, 'розпочали') +
        kpi(passed.length + ' / ' + total, 'відкрили правило') +
        kpi(avgToPass, 'сер. спроб до успіху') +
        kpi(avgPractice, 'сер. результат вправ') +
        '</div>' +
        hardestQuestions(lid) +
        exerciseStats(lid) +
        '</section>';
    }).join('');
    return '<h1 class="sr-only">Огляд</h1><div class="grid gap-6 lg:grid-cols-2">' + cards + '</div>';
  }

  function kpi(value, label) {
    return '<div class="t-kpi"><div class="t-kpi__value">' + esc(value) + '</div><div class="t-kpi__label">' + esc(label) + '</div></div>';
  }

  function settingsSummary(lesson) {
    const parts = [
      lesson.max_attempts ? 'спроб: ' + lesson.max_attempts : 'спроби без обмежень',
      lesson.practice_max_checks ? 'перевірок у вправі: ' + lesson.practice_max_checks : 'перевірки без обмежень',
      lesson.practice_reveal_after === null ? 'відповіді не показуються'
        : lesson.practice_reveal_after === 0 ? 'відповіді одразу' : 'відповіді після ' + lesson.practice_reveal_after + '-ї перевірки',
    ];
    return esc(parts.join(' · '));
  }

  /** Share of wrong answers per discovery question across all attempts. */
  function hardestQuestions(lid) {
    const attempts = T.data.attempts.filter((a) => a.lesson_id === lid);
    const key = T.data.answer_key.filter((k) => k.lesson_id === lid);
    if (!attempts.length || !key.length) return '';
    const meta = T.meta[lid] || { questions: {} };
    const rows = key.map((k) => {
      const wrong = attempts.filter((a) => !accepts(k.correct_answer, parseJson(a.answers_json)[k.question_id] || '')).length;
      return { id: k.question_id, rate: wrong / attempts.length };
    }).sort((a, b) => b.rate - a.rate).slice(0, 4).filter((r) => r.rate > 0);
    if (!rows.length) return '';
    return '<div><h3 class="text-sm font-semibold text-slate-700 mb-2">Найскладніші питання (частка помилок у всіх спробах)</h3><div class="space-y-2">' +
      rows.map((r) => {
        const q = meta.questions[r.id];
        const label = q ? (q.quote ? q.quote + ' — ' : '') + q.prompt : r.id;
        return '<div class="grid grid-cols-[1fr_auto] items-center gap-3 text-sm">' +
          '<span class="truncate" title="' + esc(label) + '">' + esc(label) + '</span>' +
          '<span class="t-num font-semibold w-12">' + Math.round(r.rate * 100) + '%</span>' +
          '<div class="t-bar col-span-2"><span style="width:' + Math.round(r.rate * 100) + '%"></span></div></div>';
      }).join('') + '</div></div>';
  }

  function exerciseStats(lid) {
    const meta = T.meta[lid];
    if (!meta || !meta.exerciseOrder.length) return '';
    const rows = meta.exerciseOrder.map((id) => {
      const ex = meta.exercises[id];
      const events = T.data.practice.filter((p) => p.lesson_id === lid && p.exercise_id === id);
      const students = new Set(events.map((e) => e.student_id));
      if (!ex.gapCount) {
        return '<tr><td>' + esc(ex.title) + '</td><td class="t-num">' + students.size + '</td><td class="t-num">—</td><td class="t-num">—</td></tr>';
      }
      const latest = {};
      events.forEach((e) => { if (e.event !== 'submit') latest[e.student_id] = e; });
      const scores = Object.keys(latest).map((k) => Number(latest[k].score) || 0);
      const avg = scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) + '%' : '—';
      const revealed = new Set(events.filter((e) => e.event === 'reveal').map((e) => e.student_id)).size;
      return '<tr><td>' + esc(ex.title) + '</td><td class="t-num">' + students.size + '</td><td class="t-num">' + avg +
        '</td><td class="t-num">' + revealed + '</td></tr>';
    }).join('');
    return '<div><h3 class="text-sm font-semibold text-slate-700 mb-2">Вправи після правила</h3><div class="t-table-wrap"><table class="t-table">' +
      '<thead><tr><th>Вправа</th><th class="t-num">Учнів</th><th class="t-num">Сер. результат</th><th class="t-num">Дивились відповіді</th></tr></thead>' +
      '<tbody>' + rows + '</tbody></table></div></div>';
  }

  function viewStudents() {
    const list = visibleStudents();
    const classOptions = classes().map((c) => '<option' + (c === T.filterClass ? ' selected' : '') + '>' + esc(c) + '</option>').join('');
    const head = T.data.lessons.map((l) => '<th>' + esc(l.lesson_title) + '</th>').join('');
    const rows = list.map((s) => '<tr data-student="' + esc(s.student_id) + '">' +
      '<td class="font-mono text-slate-500">' + esc(s.student_id) + '</td>' +
      '<td class="font-semibold text-slate-900">' + esc(s.student_name) + '</td>' +
      '<td>' + esc(s.class) + '</td>' +
      T.data.lessons.map((l) => '<td>' + statusChip(progress(s.student_id, l.lesson_id)) + '</td>').join('') +
      '</tr>').join('');

    return '<div class="flex flex-wrap items-end gap-3 mb-4">' +
      '<h1 class="text-2xl font-bold text-slate-900 mr-auto">Учні <span class="text-slate-400 font-medium">' + list.length + '</span></h1>' +
      '<label class="t-label">Пошук<input class="t-input" data-search value="' + esc(T.search) + '" placeholder="ім\'я або ID"></label>' +
      '<label class="t-label">Клас<select class="t-input" data-class-filter><option value="">Усі класи</option>' + classOptions + '</select></label>' +
      '</div>' +
      addStudentForm() +
      (list.length
        ? '<div class="t-table-wrap mt-4"><table class="t-table"><thead><tr><th>ID</th><th>Учень</th><th>Клас</th>' + head +
          '</tr></thead><tbody>' + rows + '</tbody></table></div>' +
          '<p class="mt-2 text-sm text-slate-500">Натисніть на учня, щоб побачити всі спроби.</p>'
        : '<div class="t-card t-empty mt-4">Учнів не знайдено.</div>');
  }

  function nextStudentId() {
    const numbers = T.data.students.map((s) => parseInt(s.student_id, 10)).filter((n) => !isNaN(n));
    return numbers.length ? String(Math.max.apply(null, numbers) + 1) : '101';
  }

  function addStudentForm() {
    return '<details class="t-card"><summary class="cursor-pointer font-semibold text-blue-700">+ Додати учня</summary>' +
      '<form data-add-student class="mt-4 grid gap-3 sm:grid-cols-[8rem_1fr_8rem_auto] items-end">' +
      '<label class="t-label">ID<input class="t-input" name="student_id" value="' + esc(nextStudentId()) + '" required></label>' +
      '<label class="t-label">Ім\'я та прізвище<input class="t-input" name="student_name" required></label>' +
      '<label class="t-label">Клас<input class="t-input" name="class" value="' + esc(T.filterClass || classes()[0] || '') + '"></label>' +
      '<button class="t-btn" type="submit">Додати</button>' +
      '</form><p class="t-help mt-2">ID учень вводить на сторінці модуля. Повідомте його учневі.</p></details>';
  }

  function viewStudent() {
    const s = T.data.students.find((x) => x.student_id === T.studentId);
    if (!s) {
      T.view = 'students';
      return viewStudents();
    }
    const lessons = T.data.lessons.map((l) => studentLesson(s, l)).join('');
    return '<button type="button" class="t-btn t-btn--ghost mb-3" data-view="students">← Усі учні</button>' +
      '<div class="t-card mb-6"><form data-edit-student class="flex flex-wrap items-end gap-3">' +
      '<div class="mr-auto"><div class="text-sm text-slate-500">ID <span class="font-mono">' + esc(s.student_id) + '</span></div>' +
      '<h1 class="text-2xl font-bold text-slate-900">' + esc(s.student_name) + '</h1></div>' +
      '<label class="t-label">Ім\'я<input class="t-input" name="student_name" value="' + esc(s.student_name) + '" required></label>' +
      '<label class="t-label">Клас<input class="t-input w-24" name="class" value="' + esc(s.class) + '"></label>' +
      '<button class="t-btn t-btn--soft" type="submit">Зберегти</button>' +
      '<button class="t-btn t-btn--danger" type="button" data-confirm="delete-student">Видалити учня</button>' +
      '</form></div>' +
      '<div class="space-y-6">' + lessons + '</div>';
  }

  function studentLesson(s, lesson) {
    const lid = lesson.lesson_id;
    const p = progress(s.student_id, lid);
    const attempts = studentAttempts(s.student_id, lid);
    const practice = studentPractice(s.student_id, lid);
    const reset = (scope, label) => '<button type="button" class="t-btn t-btn--danger" data-confirm="reset" data-lesson="' +
      esc(lid) + '" data-scope="' + scope + '">' + label + '</button>';

    return '<section class="t-card space-y-5">' +
      '<div class="flex flex-wrap items-center gap-3"><h2 class="text-xl font-bold text-slate-900 mr-auto">' + esc(lesson.lesson_title) + '</h2>' +
      statusChip(p) + '</div>' +
      '<div><h3 class="font-semibold text-slate-800 mb-2">Відкриття правила (кроки 2–4) · ' + attempts.length + ' ' +
      plural(attempts.length, 'спроба', 'спроби', 'спроб') + '</h3>' +
      (attempts.length ? '<div class="space-y-2">' + attempts.map((a, i) => discoveryAttempt(lid, a, i === attempts.length - 1)).join('') + '</div>'
        : '<p class="text-sm text-slate-500">Ще немає спроб.</p>') + '</div>' +
      '<div><h3 class="font-semibold text-slate-800 mb-2">Вправи після правила</h3>' + practiceBlock(lid, practice) + '</div>' +
      '<div class="flex flex-wrap gap-2 border-t border-slate-100 pt-4">' +
      reset('discovery', 'Скинути спроби відкриття') + reset('practice', 'Скинути вправи') + reset('all', 'Скинути весь модуль') +
      '</div></section>';
  }

  function discoveryAttempt(lid, a, open) {
    const meta = T.meta[lid] || { questions: {}, questionOrder: [] };
    const key = {};
    T.data.answer_key.filter((k) => k.lesson_id === lid).forEach((k) => (key[k.question_id] = k.correct_answer));
    const answers = parseJson(a.answers_json);
    const order = meta.questionOrder.length ? meta.questionOrder : Object.keys(answers);
    const items = order.filter((id) => id in answers || id in key).map((id) => {
      const q = meta.questions[id] || { prompt: id, options: {} };
      const given = answers[id] || '';
      const right = key[id] !== undefined && accepts(key[id], given);
      const optionText = (v) => q.options[v] || v || '—';
      const expected = key[id] !== undefined ? key[id].split('|').map(optionText).join(' / ') : '';
      return answerRow(right ? 'right' : 'wrong', (q.quote ? q.quote + ' ' : '') + q.prompt, optionText(given), right ? '' : expected);
    }).join('');
    const passed = isPassed(a);
    return '<details class="t-attempt"' + (open ? ' open' : '') + '><summary>' +
      '<span class="font-semibold">Спроба ' + esc(a.attempt_number) + '</span>' +
      '<span class="text-slate-500">' + fmtDate(a.timestamp) + '</span>' +
      '<span class="t-chip ' + (passed ? 't-chip--done' : 't-chip--bad') + '">' + esc(a.score) + '%' + (passed ? ' · правило відкрито' : '') + '</span>' +
      '</summary><div class="t-attempt__body"><div class="t-answer-list">' + items + '</div></div></details>';
  }

  function answerRow(kind, prompt, given, expected) {
    const marks = { right: '✓', wrong: '✗', revealed: '👁', writing: '✎' };
    return '<div class="t-answer t-answer--' + kind + '"><span class="t-answer__mark">' + marks[kind] + '</span><div>' +
      (prompt ? '<div class="t-answer__prompt">' + esc(prompt) + '</div>' : '') +
      '<div class="' + (kind === 'writing' ? 't-writing' : 't-answer__given') + '">' + esc(given || '—') + '</div>' +
      (expected ? '<div class="t-answer__expected">Правильно: ' + esc(expected) + '</div>' : '') +
      '</div></div>';
  }

  function practiceBlock(lid, practice) {
    if (!practice.length) return '<p class="text-sm text-slate-500">Ще не виконував(ла) вправ.</p>';
    const meta = T.meta[lid] || { exercises: {}, exerciseOrder: [] };
    const ids = meta.exerciseOrder.filter((id) => practice.some((p) => p.exercise_id === id));
    return '<div class="space-y-4">' + ids.map((id) => {
      const ex = meta.exercises[id];
      const events = practice.filter((p) => p.exercise_id === id);
      const checks = events.filter((e) => e.event === 'check').length;
      const last = events.filter((e) => e.event !== 'submit').pop();
      const summary = ex.gapCount
        ? checks + ' ' + plural(checks, 'перевірка', 'перевірки', 'перевірок') + (last ? ' · останній результат ' + esc(last.score) + '%' : '')
        : events.length + ' ' + plural(events.length, 'відповідь', 'відповіді', 'відповідей');
      return '<div><div class="flex flex-wrap items-baseline gap-2 mb-1"><span class="font-semibold text-slate-800">' + esc(ex.title) +
        '</span><span class="text-sm text-slate-500">' + summary + '</span></div><div class="space-y-2">' +
        events.map((e, i) => practiceEvent(ex, e, i === events.length - 1)).join('') + '</div></div>';
    }).join('') + '</div>';
  }

  function practiceEvent(ex, e, open) {
    const answers = parseJson(e.answers_json);
    const revealed = e.revealed_items ? e.revealed_items.split(',') : [];
    const labels = { check: 'Перевірка ' + e.check_number, reveal: 'Показав(ла) відповіді', submit: 'Надіслав(ла) письмову відповідь' };
    const items = ex.fields.map((f, i) => {
      const key = String(i + 1);
      const given = answers[key] || '';
      if (f.writing) return given ? answerRow('writing', f.prompt, given, '') : '';
      if (!f.answer) return '';
      if (revealed.indexOf(key) !== -1) return answerRow('revealed', f.prompt, given + ' (показано)', '');
      const right = accepts(f.answer, given);
      return answerRow(right ? 'right' : 'wrong', f.prompt, given, right ? '' : f.answer.split('|')[0]);
    }).join('');
    const chip = e.event === 'submit' ? '' : '<span class="t-chip ' + (Number(e.score) === 100 ? 't-chip--done' : 't-chip--progress') + '">' + esc(e.score) + '%</span>';
    return '<details class="t-attempt"' + (open ? ' open' : '') + '><summary><span class="font-semibold">' + labels[e.event] + '</span>' +
      '<span class="text-slate-500">' + fmtDate(e.timestamp) + '</span>' + chip + '</summary>' +
      '<div class="t-attempt__body"><div class="t-answer-list">' + (items || '<p class="text-sm text-slate-500">—</p>') + '</div></div></details>';
  }

  function viewLessons() {
    return '<h1 class="text-2xl font-bold text-slate-900 mb-4">Налаштування модулів</h1><div class="grid gap-6 lg:grid-cols-2">' +
      T.data.lessons.map((l) => {
        const reveal = l.practice_reveal_after;
        const mode = reveal === null ? 'never' : reveal === 0 ? 'now' : 'after';
        const opt = (v, label) => '<option value="' + v + '"' + (mode === v ? ' selected' : '') + '>' + label + '</option>';
        return '<form class="t-card space-y-4" data-lesson-form="' + esc(l.lesson_id) + '">' +
          '<h2 class="text-xl font-bold text-slate-900">' + esc(l.lesson_title) + '</h2>' +
          '<fieldset class="space-y-3"><legend class="font-semibold text-slate-800">Відкриття правила (кроки 2–4)</legend>' +
          '<label class="t-label">Максимум спроб<input class="t-input w-44" name="max_attempts" type="number" min="1" value="' + (l.max_attempts || '') + '" placeholder="без обмежень">' +
          '<span class="t-help">Порожньо — без обмежень.</span></label></fieldset>' +
          '<fieldset class="space-y-3"><legend class="font-semibold text-slate-800">Вправи після правила</legend>' +
          '<label class="t-label">Максимум перевірок у кожній вправі<input class="t-input w-44" name="practice_max_checks" type="number" min="1" value="' + (l.practice_max_checks || '') + '" placeholder="без обмежень">' +
          '<span class="t-help">Порожньо — без обмежень. Коли ліміт вичерпано, вправу не можна перевірити знову.</span></label>' +
          '<div class="flex flex-wrap items-end gap-3"><label class="t-label">Кнопка «Показати відповіді»<select class="t-input" name="reveal_mode">' +
          opt('after', 'після певної кількості перевірок') + opt('now', 'доступна одразу') + opt('never', 'ніколи') + '</select></label>' +
          '<label class="t-label" data-reveal-count' + (mode === 'after' ? '' : ' hidden') + '>Кількість перевірок<input class="t-input w-24" name="reveal_after" type="number" min="1" value="' + (mode === 'after' ? reveal : 5) + '"></label></div>' +
          '</fieldset><button class="t-btn" type="submit">Зберегти</button></form>';
      }).join('') + '</div>' +
      '<p class="mt-4 text-sm text-slate-500">Зміни діють для учнів одразу після збереження (після оновлення їхньої сторінки).</p>';
  }

  // ------------------------------------------------------------ events

  function armConfirm(button) {
    if (button.classList.contains('is-armed')) return true;
    const label = button.textContent;
    button.classList.add('is-armed');
    button.textContent = 'Точно? Натисніть ще раз';
    setTimeout(() => {
      button.classList.remove('is-armed');
      button.textContent = label;
    }, 4000);
    return false;
  }

  document.addEventListener('click', async (event) => {
    const viewButton = event.target.closest('[data-view]');
    if (viewButton && window.TeacherEditor && !window.TeacherEditor.canLeave(viewButton.dataset.view)) return;
    if (viewButton) {
      T.view = viewButton.dataset.view;
      render();
      window.scrollTo(0, 0);
      return;
    }
    const row = event.target.closest('tr[data-student]');
    if (row) {
      T.view = 'student';
      T.studentId = row.dataset.student;
      render();
      window.scrollTo(0, 0);
      return;
    }
    const confirmButton = event.target.closest('[data-confirm]');
    if (confirmButton && armConfirm(confirmButton)) {
      confirmButton.disabled = true;
      if (confirmButton.dataset.confirm === 'delete-student') {
        if (await run('delete_student', { student_id: T.studentId }, 'Учня видалено зі списку.')) {
          T.view = 'students';
          render();
        }
      } else {
        await run('reset_progress', { student_id: T.studentId, lesson_id: confirmButton.dataset.lesson, scope: confirmButton.dataset.scope }, 'Прогрес скинуто.');
      }
      return;
    }
    if (event.target.closest('[data-refresh]')) {
      await run('overview', null, 'Дані оновлено.');
      return;
    }
    if (event.target.closest('[data-logout]')) logout();
  });

  document.addEventListener('input', (event) => {
    if (event.target.matches('[data-search]')) {
      T.search = event.target.value;
      const pos = event.target.selectionStart;
      render();
      const input = $('[data-search]');
      input.focus();
      input.setSelectionRange(pos, pos);
    }
  });

  document.addEventListener('change', (event) => {
    if (event.target.matches('[data-class-filter]')) {
      T.filterClass = event.target.value;
      render();
    }
    if (event.target.matches('[name="reveal_mode"]')) {
      event.target.closest('form').querySelector('[data-reveal-count]').hidden = event.target.value !== 'after';
    }
  });

  document.addEventListener('submit', async (event) => {
    const form = event.target;
    if (form.closest('#t-login')) return;
    event.preventDefault();
    const button = form.querySelector('button[type="submit"]');
    const f = new FormData(form);
    if (button) button.disabled = true;
    try {
      if (form.matches('[data-add-student]')) {
        const ok = await run('add_student', { student: { student_id: f.get('student_id'), student_name: f.get('student_name'), class: f.get('class') } }, 'Учня додано.');
        if (ok) $('details.t-card').open = true;
      } else if (form.matches('[data-edit-student]')) {
        await run('update_student', { student: { student_id: T.studentId, student_name: f.get('student_name'), class: f.get('class') } }, 'Збережено.');
      } else if (form.matches('[data-lesson-form]')) {
        const mode = f.get('reveal_mode');
        await run('save_lesson', {
          lesson: {
            lesson_id: form.dataset.lessonForm,
            max_attempts: f.get('max_attempts'),
            practice_max_checks: f.get('practice_max_checks'),
            practice_reveal_after: mode === 'never' ? 'never' : mode === 'now' ? '0' : f.get('reveal_after'),
          },
        }, 'Налаштування збережено.');
      }
    } finally {
      const again = form.isConnected && form.querySelector('button[type="submit"]');
      if (again) again.disabled = false;
    }
  });

  // Shared with the lesson editor (teacher-editor.js).
  window.TeacherApp = {
    state: T,
    api: api,
    run: run,
    render: render,
    loadMeta: loadMeta,
    toast: toast,
    esc: esc,
    fmtDate: fmtDate,
  };

  // ------------------------------------------------------------ login

  async function login(id) {
    T.teacherId = id;
    T.data = await api('overview');
    await loadMeta();
    session(id);
    $('#t-login').hidden = true;
    $('#t-header').hidden = false;
    render();
  }

  function logout() {
    session(null);
    T.teacherId = null;
    T.data = null;
    $('#t-main').innerHTML = '';
    $('#t-header').hidden = true;
    $('#t-login').hidden = false;
    $('#t-login input').value = '';
  }

  const loginForm = $('#t-login form');

  $('[data-toggle-id]', loginForm).addEventListener('click', (event) => {
    const button = event.currentTarget;
    const input = $('input', loginForm);
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    button.textContent = show ? '🙈' : '👁';
    button.setAttribute('aria-pressed', String(show));
    button.setAttribute('aria-label', show ? 'Сховати ID' : 'Показати ID');
    button.title = button.getAttribute('aria-label');
    input.focus();
  });
  loginForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const input = $('input', loginForm);
    const error = $('[data-login-error]', loginForm);
    const button = $('button', loginForm);
    if (!input.value.trim()) {
      error.textContent = 'Введіть ID вчителя.';
      return;
    }
    button.disabled = true;
    button.textContent = 'Перевіряємо…';
    error.textContent = '';
    try {
      await login(input.value.trim());
    } catch (err) {
      error.textContent = err.message;
      T.teacherId = null;
    } finally {
      button.disabled = false;
      button.textContent = 'Увійти';
    }
  });

  const saved = session();
  if (saved) {
    login(saved).catch(() => { session(null); });
  } else {
    $('#t-login input').focus();
  }
})();
