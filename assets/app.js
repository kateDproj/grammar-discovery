/*
 * Grammar Discovery — shared logic for lesson pages.
 *
 * A lesson page declares <body data-lesson-id="...">, marks CCQs as
 * <fieldset data-question="q1"> with radio inputs inside a [data-shuffle]
 * container, and rule gaps as <select data-question="r1">.
 * The correct answers are NOT in the page: the API checks them and returns
 * the reward section only after a fully correct attempt.
 */
(function () {
  'use strict';

  const API_URL = (window.APP_CONFIG || {}).API_URL;
  const LESSON_ID = document.body.dataset.lessonId;
  const REQUEST_TIMEOUT_MS = 25000;

  const state = {
    studentId: null,
    maxAttempts: null, // null = unlimited
    attemptsUsed: 0,
    revealAfter: 5, // checks before practice answers can be revealed; null = never
    practiceMaxChecks: null, // checks allowed per practice exercise; null = unlimited
    serverPractice: null,
    passed: false,
    busy: false,
  };

  const els = {};

  // ------------------------------------------------------------ storage (best effort)

  const store = {
    get(key) {
      try { return JSON.parse(localStorage.getItem(key)); } catch (e) { return null; }
    },
    set(key, value) {
      try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* private mode etc. */ }
    },
  };
  const draftKey = () => 'gd:draft:' + LESSON_ID;
  const OUTBOX_KEY = 'gd:outbox';

  // ------------------------------------------------------------ API

  async function api(method, params) {
    if (!API_URL || API_URL.indexOf('http') !== 0) {
      throw new ApiError('not_configured', 'Сайт ще не підключено до сервера (API_URL у assets/config.js).');
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    let res;
    try {
      if (method === 'GET') {
        res = await fetch(API_URL + '?' + new URLSearchParams(params), { signal: controller.signal });
      } else {
        // No Content-Type header → sent as text/plain, which Apps Script accepts without a CORS preflight.
        res = await fetch(API_URL, { method: 'POST', body: JSON.stringify(params), signal: controller.signal });
      }
    } catch (e) {
      throw new ApiError('network', "Немає з'єднання з сервером. Ваші відповіді збережено — спробуйте ще раз, коли з'явиться інтернет.");
    } finally {
      clearTimeout(timer);
    }
    let data;
    try {
      data = await res.json();
    } catch (e) {
      throw new ApiError('bad_response', 'Сервер повернув незрозумілу відповідь. Спробуйте ще раз.');
    }
    if (!data.ok) throw new ApiError(data.error, data.message);
    return data;
  }

  function ApiError(code, message) {
    this.code = code;
    this.message = message;
  }

  // ------------------------------------------------------------ anti-cheating: shuffle

  function shuffle(array) {
    for (let i = array.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [array[i], array[j]] = [array[j], array[i]];
    }
    return array;
  }

  /** Re-orders the options of every CCQ and every rule dropdown on each page load. */
  function shuffleOptions() {
    document.querySelectorAll('[data-shuffle]').forEach((box) => {
      shuffle(Array.from(box.children)).forEach((child) => box.appendChild(child));
    });
    document.querySelectorAll('select[data-question]').forEach((select) => {
      const options = Array.from(select.options).filter((o) => o.value !== '');
      shuffle(options).forEach((o) => select.appendChild(o));
      select.selectedIndex = 0;
    });
  }

  // ------------------------------------------------------------ answers

  function questionIds() {
    return Array.from(document.querySelectorAll('[data-question]')).map((el) => el.dataset.question);
  }

  function readAnswers() {
    const answers = {};
    document.querySelectorAll('[data-question]').forEach((el) => {
      const id = el.dataset.question;
      if (el.tagName === 'SELECT') {
        answers[id] = el.value;
      } else {
        const checked = el.querySelector('input[type="radio"]:checked');
        answers[id] = checked ? checked.value : '';
      }
    });
    return answers;
  }

  function restoreDraft() {
    const draft = store.get(draftKey());
    if (!draft) return;
    Object.keys(draft).forEach((id) => {
      const el = document.querySelector('[data-question="' + id + '"]');
      if (!el || !draft[id]) return;
      if (el.tagName === 'SELECT') {
        el.value = draft[id];
      } else {
        const input = el.querySelector('input[value="' + CSS.escape(draft[id]) + '"]');
        if (input) input.checked = true;
      }
    });
  }

  function saveDraft() {
    store.set(draftKey(), readAnswers());
  }

  function clearMarks() {
    document.querySelectorAll('[data-question]').forEach((el) => {
      el.classList.remove('is-wrong', 'is-right', 'is-missing');
      const fb = feedbackFor(el);
      if (fb) fb.textContent = '';
    });
  }

  function feedbackFor(el) {
    return el.tagName === 'SELECT' ? null : el.querySelector('[data-feedback]');
  }

  function mark(el, cls, message) {
    el.classList.remove('is-wrong', 'is-right', 'is-missing');
    el.classList.add(cls);
    const fb = feedbackFor(el);
    if (fb) fb.textContent = message || '';
    if (cls !== 'is-right') {
      el.classList.remove('shake');
      void el.offsetWidth; // restart animation
      el.classList.add('shake');
    }
  }

  // ------------------------------------------------------------ UI: login modal & header

  function buildChrome() {
    const modal = document.createElement('div');
    modal.id = 'login-modal';
    modal.className = 'fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 backdrop-blur-sm px-4';
    modal.innerHTML =
      '<form class="w-full max-w-sm rounded-2xl bg-white p-6 sm:p-8 shadow-2xl" novalidate>' +
      '  <div class="text-4xl mb-3">🎓</div>' +
      '  <h2 class="text-2xl font-bold text-slate-900">Введіть ваш ID</h2>' +
      '  <p class="mt-1 text-sm text-slate-500">ID видає вчитель. Він потрібен, щоб зберегти ваш результат.</p>' +
      '  <label class="block mt-5">' +
      '    <span class="sr-only">Student ID</span>' +
      '    <input name="student_id" inputmode="numeric" autocomplete="off" required ' +
      '      class="w-full rounded-xl border-2 border-slate-200 px-4 py-3 text-lg font-semibold tracking-wider focus:border-blue-500 focus:outline-none" ' +
      '      placeholder="наприклад, 101">' +
      '  </label>' +
      '  <p data-login-error class="mt-3 min-h-[1.25rem] text-sm font-medium text-red-600" role="alert"></p>' +
      '  <button type="submit" class="mt-2 w-full rounded-xl bg-blue-600 px-4 py-3 font-semibold text-white hover:bg-blue-700 disabled:opacity-60">Увійти</button>' +
      '  <a href="index.html" class="mt-4 block text-center text-sm text-slate-500 hover:text-slate-700">← До списку модулів</a>' +
      '</form>';
    document.body.appendChild(modal);

    const header = document.createElement('header');
    header.className = 'app-header border-b border-slate-200 bg-white/90 backdrop-blur';
    header.hidden = true;
    header.innerHTML =
      '<div class="mx-auto flex max-w-3xl flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3 text-sm sm:text-base">' +
      '  <span class="font-semibold text-slate-900">🎓 Привіт, <span data-h="name"></span></span>' +
      '  <span class="hidden sm:inline text-slate-300">|</span>' +
      '  <span class="text-slate-600">Модуль: <span data-h="lesson" class="font-medium text-slate-800"></span></span>' +
      '  <span class="hidden sm:inline text-slate-300">|</span>' +
      '  <span data-h="attempts" class="rounded-full bg-blue-50 px-3 py-0.5 font-medium text-blue-700"></span>' +
      '</div>';
    document.body.prepend(header);

    els.modal = modal;
    els.form = modal.querySelector('form');
    els.idInput = modal.querySelector('input[name="student_id"]');
    els.loginError = modal.querySelector('[data-login-error]');
    els.loginButton = modal.querySelector('button[type="submit"]');
    els.header = header;
    els.checkButton = document.getElementById('check-button');
    els.checkStatus = document.getElementById('check-status');
    els.reward = document.getElementById('reward');
    els.analysisCards = document.querySelectorAll('[data-analysis]');
  }

  function renderHeader() {
    const a = els.header.querySelector('[data-h="attempts"]');
    if (state.passed) {
      a.textContent = '✅ Пройдено';
      a.className = 'rounded-full bg-emerald-50 px-3 py-0.5 font-medium text-emerald-700';
    } else {
      const current = state.maxAttempts ? Math.min(state.attemptsUsed + 1, state.maxAttempts) : state.attemptsUsed + 1;
      a.textContent = 'Спроба: ' + current + (state.maxAttempts ? ' з ' + state.maxAttempts : '');
      a.className = attemptsExhausted()
        ? 'rounded-full bg-red-50 px-3 py-0.5 font-medium text-red-700'
        : 'rounded-full bg-blue-50 px-3 py-0.5 font-medium text-blue-700';
    }
  }

  function attemptsExhausted() {
    return Boolean(state.maxAttempts) && state.attemptsUsed >= state.maxAttempts;
  }

  async function onLogin(event) {
    event.preventDefault();
    const id = els.idInput.value.trim();
    if (!id) {
      els.loginError.textContent = 'Введіть ваш ID.';
      return;
    }
    els.loginButton.disabled = true;
    els.loginButton.textContent = 'Перевіряємо…';
    els.loginError.textContent = '';
    try {
      const data = await api('GET', { action: 'login', student_id: id, lesson_id: LESSON_ID });
      state.studentId = id;
      state.maxAttempts = data.lesson.max_attempts;
      state.attemptsUsed = data.attempts_used;
      state.passed = data.passed;
      state.revealAfter = data.lesson.practice_reveal_after === undefined ? 5 : data.lesson.practice_reveal_after;
      state.practiceMaxChecks = data.lesson.practice_max_checks || null;
      state.serverPractice = data.practice;
      store.set('gd:student_id', id);

      els.header.querySelector('[data-h="name"]').textContent = data.student.name;
      els.header.querySelector('[data-h="lesson"]').textContent = data.lesson.title;
      renderHeader();
      els.header.hidden = false;
      els.modal.remove();

      if (data.passed && data.reward) {
        unlock(data.reward, false);
        setStatus('Ви вже пройшли цей модуль. Матеріал розблоковано.', 'ok');
      } else if (attemptsExhausted()) {
        lockOut();
      }
      flushOutbox();
    } catch (err) {
      els.loginError.textContent = err.message;
    } finally {
      els.loginButton.disabled = false;
      els.loginButton.textContent = 'Увійти';
    }
  }

  // ------------------------------------------------------------ check

  function setStatus(text, kind) {
    const colors = { ok: 'text-emerald-700', error: 'text-red-600', warn: 'text-amber-700', info: 'text-slate-600' };
    els.checkStatus.className = 'text-sm sm:text-base font-medium ' + (colors[kind] || colors.info);
    els.checkStatus.textContent = text;
  }

  function lockOut() {
    els.checkButton.disabled = true;
    setStatus('Спроби вичерпано. Зверніться до вчителя, щоб отримати додаткову спробу.', 'error');
  }

  async function onCheck() {
    if (state.busy || state.passed) return;
    clearMarks();

    const answers = readAnswers();
    const missing = questionIds().filter((id) => !answers[id]);
    if (missing.length) {
      missing.forEach((id) => mark(document.querySelector('[data-question="' + id + '"]'), 'is-missing', 'Оберіть відповідь.'));
      setStatus('Дайте відповідь на всі питання, перш ніж перевіряти. Це не витрачає спробу.', 'warn');
      return;
    }

    state.busy = true;
    els.checkButton.disabled = true;
    els.checkButton.textContent = 'Перевіряємо…';
    setStatus('', 'info');
    try {
      const data = await api('POST', {
        action: 'check',
        student_id: state.studentId,
        lesson_id: LESSON_ID,
        answers: answers,
      });
      state.attemptsUsed = data.attempts_used;
      state.passed = data.passed;
      renderHeader();

      if (data.passed) {
        questionIds().forEach((id) => mark(document.querySelector('[data-question="' + id + '"]'), 'is-right'));
        state.serverPractice = data.practice || {};
        celebrate();
        unlock(data.reward, true);
        setStatus('Чудово! Усі відповіді правильні — правило розблоковано ⬇️', 'ok');
        return;
      }

      questionIds().forEach((id) => {
        const el = document.querySelector('[data-question="' + id + '"]');
        if (data.wrong.indexOf(id) === -1) mark(el, 'is-right');
        else mark(el, 'is-wrong', 'Ще раз перечитайте приклад у тексті вгорі.');
      });
      if (attemptsExhausted()) {
        lockOut();
      } else if (state.maxAttempts) {
        const left = state.maxAttempts - state.attemptsUsed;
        setStatus('Неправильних відповідей: ' + data.wrong.length + '. Залишилось спроб: ' + left + '.', 'error');
      } else {
        setStatus('Неправильних відповідей: ' + data.wrong.length + '. Виправте їх і перевірте ще раз.', 'error');
      }
    } catch (err) {
      setStatus(err.message, 'error');
      if (err.code === 'no_attempts_left') lockOut();
    } finally {
      state.busy = false;
      els.checkButton.textContent = 'Перевірити';
      if (!state.passed && !attemptsExhausted()) els.checkButton.disabled = false;
    }
  }

  // ------------------------------------------------------------ unlock & celebrate

  function unlock(html, scroll) {
    els.reward.innerHTML = '<div class="unlock-in">' + html + '</div>';
    els.reward.classList.remove('relative');
    initPractice();
    els.checkButton.disabled = true;
    els.checkButton.textContent = '✅ Перевірено';
    els.analysisCards.forEach((card) => {
      card.classList.add('success-glow');
      card.querySelectorAll('input, select').forEach((i) => (i.disabled = true));
    });
    if (scroll) setTimeout(() => els.reward.scrollIntoView({ behavior: 'smooth', block: 'start' }), 600);
  }

  function celebrate() {
    const colors = ['#2563eb', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899'];
    for (let i = 0; i < 90; i++) {
      const piece = document.createElement('span');
      piece.className = 'confetti-piece';
      piece.style.left = Math.random() * 100 + 'vw';
      piece.style.background = colors[i % colors.length];
      piece.style.borderRadius = Math.random() > 0.5 ? '50%' : '2px';
      piece.style.animationDuration = 2.2 + Math.random() * 2 + 's';
      piece.style.animationDelay = Math.random() * 0.6 + 's';
      piece.style.setProperty('--drift', (Math.random() * 30 - 15) + 'vw');
      piece.style.setProperty('--spin', Math.random() * 1080 + 'deg');
      document.body.appendChild(piece);
      setTimeout(() => piece.remove(), 5000);
    }
  }

  // ------------------------------------------------------------ practice exercises (inside the reward)

  function normalize(s) {
    return String(s).toLowerCase().replace(/[’‘`]/g, "'").replace(/\s+/g, ' ').trim();
  }

  // A model answer opens only after the student has written at least this much.
  const MIN_WRITING_LENGTH = 10;
  const GAP_STATES = ['is-right', 'is-wrong', 'is-missing', 'is-revealed'];
  // Errors after which a queued practice record is kept and sent again later.
  const RETRYABLE_ERRORS = ['network', 'bad_response', 'server_error', 'server_setup'];

  const practiceKey = () => 'gd:practice:' + LESSON_ID + ':' + state.studentId;

  function isCorrect(gap) {
    return gap.dataset.answer.split('|').map(normalize).indexOf(normalize(gap.value)) !== -1;
  }

  function setGapState(gap, cls) {
    gap.classList.remove.apply(gap.classList, GAP_STATES);
    if (cls) gap.classList.add(cls);
  }

  function lockRevealedGap(gap) {
    if (gap.tagName === 'SELECT') gap.disabled = true;
    else gap.readOnly = true;
  }

  function exerciseFields(section) {
    return Array.from(section.querySelectorAll('input, select, textarea'));
  }

  /** Answers keyed by the 1-based position of the field inside the exercise. */
  function exerciseAnswers(section) {
    const answers = {};
    const revealed = [];
    exerciseFields(section).forEach((f, i) => {
      answers[i + 1] = f.value;
      if (f.classList.contains('is-revealed')) revealed.push(String(i + 1));
    });
    return { answers: answers, revealed: revealed };
  }

  function exerciseScore(section) {
    const gaps = Array.from(section.querySelectorAll('[data-answer]'));
    if (!gaps.length) return 0;
    return Math.round((gaps.filter((g) => g.classList.contains('is-right')).length / gaps.length) * 100);
  }

  function canReveal(checks) {
    return state.revealAfter !== null && checks >= state.revealAfter;
  }

  function checksLeft(checks) {
    return state.practiceMaxChecks ? Math.max(0, state.practiceMaxChecks - checks) : Infinity;
  }

  function renderExerciseResult(section) {
    const result = section.querySelector('[data-exercise-result]');
    const revealButton = section.querySelector('[data-reveal-exercise]');
    const checkButton = section.querySelector('[data-check-exercise]');
    if (!result || !revealButton || !checkButton) return;
    const gaps = Array.from(section.querySelectorAll('[data-answer]'));
    const checks = Number(section.dataset.checks || 0);
    const revealed = gaps.filter((g) => g.classList.contains('is-revealed')).length;
    const right = gaps.filter((g) => g.classList.contains('is-right')).length;
    const done = right + revealed === gaps.length;
    const left = checksLeft(checks);

    revealButton.hidden = done || !canReveal(checks);
    checkButton.disabled = done || left === 0;
    gaps.forEach((g) => {
      if (left === 0 && !g.classList.contains('is-revealed')) lockRevealedGap(g);
    });

    const parts = [];
    if (checks) parts.push((done && !revealed ? '✅ ' : '') + right + ' / ' + gaps.length);
    if (revealed) parts.push('показано відповідей: ' + revealed);
    if (!done) {
      if (left === 0) {
        parts.push('Ліміт перевірок вичерпано.');
      } else {
        if (checks) parts.push('Виправте червоні пропуски й перевірте ще раз.');
        if (left !== Infinity) parts.push('Залишилось перевірок: ' + left + '.');
        if (state.revealAfter !== null && !canReveal(checks) && state.revealAfter <= checks + left) {
          parts.push('Відповіді можна буде подивитися після ' + state.revealAfter + '-ї перевірки.');
        }
      }
    }
    result.textContent = parts.join(' · ');
    result.className = 'exercise__result ' + (done && !revealed ? 'text-emerald-700' : 'text-amber-700');
  }

  function checkExercise(section) {
    if (checksLeft(Number(section.dataset.checks || 0)) === 0) return;
    const gaps = Array.from(section.querySelectorAll('[data-answer]')).filter((g) => !g.classList.contains('is-revealed'));
    const empty = gaps.filter((g) => !g.value.trim());
    if (empty.length) {
      empty.forEach((g) => setGapState(g, 'is-missing'));
      const result = section.querySelector('[data-exercise-result]');
      result.textContent = 'Спершу заповніть усі пропуски.';
      result.className = 'exercise__result text-amber-700';
      return;
    }
    section.dataset.checks = Number(section.dataset.checks || 0) + 1;
    gaps.forEach((g) => setGapState(g, isCorrect(g) ? 'is-right' : 'is-wrong'));
    renderExerciseResult(section);
    recordPractice(section, 'check');
  }

  /** Reveals only the gaps that are still wrong; correct answers stay the student's own. */
  function revealExercise(section) {
    if (!canReveal(Number(section.dataset.checks || 0))) return;
    section.querySelectorAll('[data-answer]').forEach((gap) => {
      if (gap.classList.contains('is-right') || gap.classList.contains('is-revealed')) return;
      gap.value = gap.dataset.answer.split('|')[0];
      setGapState(gap, 'is-revealed');
      lockRevealedGap(gap);
    });
    renderExerciseResult(section);
    recordPractice(section, 'reveal');
  }

  /** "Send and show the model answer": allowed only after the student has written their own version. */
  function onModelAnswerToggle(event) {
    const summary = event.target.closest('.model-answer > summary');
    if (!summary) return;
    const details = summary.parentElement;
    const writing = details.previousElementSibling;
    if (details.open || !writing || writing.tagName !== 'TEXTAREA') return;
    let note = details.querySelector('[data-writing-note]');
    if (writing.value.trim().length < MIN_WRITING_LENGTH) {
      event.preventDefault();
      if (!note) {
        note = document.createElement('span');
        note.dataset.writingNote = '';
        note.className = 'ml-2 text-sm font-medium text-amber-700';
        summary.after(note);
      }
      note.textContent = 'Спершу напишіть свій варіант.';
      writing.focus();
      return;
    }
    if (note) note.remove();
    const section = details.closest('[data-exercise-id]');
    if (section) recordPractice(section, 'submit');
  }

  // ------------------------------------------------------------ practice recording
  // Every check / reveal / submit is queued in an outbox (kept in the browser) and sent
  // to the Practice tab. If the connection is lost, the queue is sent later.

  let outbox = store.get(OUTBOX_KEY) || [];
  let flushing = false;

  function recordPractice(section, event) {
    const data = exerciseAnswers(section);
    outbox.push({
      action: 'practice',
      student_id: state.studentId,
      lesson_id: LESSON_ID,
      exercise_id: section.dataset.exerciseId,
      event: event,
      check_number: Number(section.dataset.checks || 0),
      score: exerciseScore(section),
      answers: data.answers,
      revealed: data.revealed,
      client_time: new Date().toISOString(),
    });
    store.set(OUTBOX_KEY, outbox);
    savePractice();
    flushOutbox();
  }

  async function flushOutbox() {
    if (flushing) return;
    flushing = true;
    try {
      while (outbox.length) {
        renderSyncStatus('sending');
        try {
          await api('POST', outbox[0]);
        } catch (err) {
          if (RETRYABLE_ERRORS.indexOf(err.code) !== -1) break;
          // Rejected by the server (e.g. unknown student): drop it so it doesn't block the queue.
        }
        outbox.shift();
        store.set(OUTBOX_KEY, outbox);
      }
    } finally {
      flushing = false;
      renderSyncStatus(outbox.length ? 'pending' : 'saved');
    }
  }

  function renderSyncStatus(status) {
    if (!els.syncStatus) return;
    const texts = {
      sending: '⏳ Зберігаємо відповіді…',
      saved: '☁️ Відповіді збережено',
      pending: "📴 Не надіслано: " + outbox.length + ". Надішлемо, коли з'явиться інтернет.",
    };
    els.syncStatus.textContent = texts[status];
    els.syncStatus.className = 'sync-status ' + (status === 'pending' ? 'sync-status--pending' : '');
    els.syncStatus.hidden = false;
  }

  window.addEventListener('online', flushOutbox);

  // ------------------------------------------------------------ practice progress (restore on return)

  function practiceFields() {
    return Array.from(els.reward.querySelectorAll('input, select, textarea'));
  }

  /** Local copy for this browser, so typing that was never checked is kept too. */
  function savePractice() {
    if (!state.studentId) return;
    store.set(practiceKey(), {
      fields: practiceFields().map((f) => ({
        v: f.value,
        s: GAP_STATES.find((c) => f.classList.contains(c)) || '',
      })),
      checks: Array.from(els.reward.querySelectorAll('[data-exercise-id]')).map((s) => Number(s.dataset.checks || 0)),
    });
  }

  function applyLocalPractice(saved) {
    practiceFields().forEach((f, i) => {
      f.value = saved.fields[i].v;
      setGapState(f, saved.fields[i].s);
      if (saved.fields[i].s === 'is-revealed') lockRevealedGap(f);
    });
    els.reward.querySelectorAll('[data-exercise-id]').forEach((s, i) => {
      s.dataset.checks = (saved.checks && saved.checks[i]) || 0;
    });
  }

  /** Server copy (any device): the latest recorded state of each exercise. */
  function applyServerPractice(server) {
    els.reward.querySelectorAll('[data-exercise-id]').forEach((section) => {
      const entry = server[section.dataset.exerciseId];
      if (!entry) return;
      const checks = entry.check_number || 0;
      section.dataset.checks = checks;
      exerciseFields(section).forEach((f, i) => {
        const value = entry.answers[i + 1];
        if (value != null) f.value = value;
        if (!f.matches('[data-answer]')) return;
        if (entry.revealed.indexOf(String(i + 1)) !== -1) {
          setGapState(f, 'is-revealed');
          lockRevealedGap(f);
        } else if (checks && f.value.trim()) {
          setGapState(f, isCorrect(f) ? 'is-right' : 'is-wrong');
        }
      });
    });
  }

  function restorePractice() {
    const local = store.get(practiceKey());
    const localFits = local && local.fields && local.fields.length === practiceFields().length;
    const server = state.serverPractice || {};
    const hasServer = Object.keys(server).length > 0;
    const pendingHere = outbox.some((o) => o.lesson_id === LESSON_ID && o.student_id === state.studentId);
    // Prefer this browser's copy while it has unsent records; otherwise the server is the source of truth.
    if (localFits && (pendingHere || !hasServer)) applyLocalPractice(local);
    else if (hasServer) applyServerPractice(server);
    els.reward.querySelectorAll('[data-exercise-id]').forEach(renderExerciseResult);
  }

  function initPractice() {
    els.syncStatus = document.createElement('div');
    els.syncStatus.hidden = true;
    els.syncStatus.setAttribute('role', 'status');
    document.body.appendChild(els.syncStatus);

    restorePractice();
    els.reward.addEventListener('input', (event) => {
      const f = event.target;
      if (f.matches('[data-answer]') && !f.classList.contains('is-revealed')) setGapState(f, '');
      savePractice();
    });
    els.reward.addEventListener('change', savePractice);
    if (outbox.length) flushOutbox();
  }

  document.addEventListener('click', (event) => {
    const check = event.target.closest('[data-check-exercise]');
    const reveal = event.target.closest('[data-reveal-exercise]');
    if (check) checkExercise(check.closest('[data-exercise]'));
    if (reveal) revealExercise(reveal.closest('[data-exercise]'));
    onModelAnswerToggle(event);
  });

  // ------------------------------------------------------------ boot

  function init() {
    buildChrome();
    shuffleOptions();
    restoreDraft();

    document.querySelectorAll('[data-question]').forEach((el) => {
      el.addEventListener('change', () => {
        saveDraft();
        el.classList.remove('is-wrong', 'is-right', 'is-missing');
        const fb = feedbackFor(el);
        if (fb) fb.textContent = '';
      });
    });

    els.form.addEventListener('submit', onLogin);
    els.checkButton.addEventListener('click', onCheck);

    const savedId = store.get('gd:student_id');
    if (savedId) els.idInput.value = savedId;
    els.idInput.focus();
  }

  init();
})();
