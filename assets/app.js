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
    maxAttempts: 0,
    attemptsUsed: 0,
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
      const current = Math.min(state.attemptsUsed + 1, state.maxAttempts);
      a.textContent = 'Спроба: ' + current + ' з ' + state.maxAttempts;
      a.className = state.attemptsUsed >= state.maxAttempts
        ? 'rounded-full bg-red-50 px-3 py-0.5 font-medium text-red-700'
        : 'rounded-full bg-blue-50 px-3 py-0.5 font-medium text-blue-700';
    }
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
      store.set('gd:student_id', id);

      els.header.querySelector('[data-h="name"]').textContent = data.student.name;
      els.header.querySelector('[data-h="lesson"]').textContent = data.lesson.title;
      renderHeader();
      els.header.hidden = false;
      els.modal.remove();

      if (data.passed && data.reward) {
        unlock(data.reward, false);
        setStatus('Ви вже пройшли цей модуль. Матеріал розблоковано.', 'ok');
      } else if (state.attemptsUsed >= state.maxAttempts) {
        lockOut();
      }
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
      const left = state.maxAttempts - state.attemptsUsed;
      if (left <= 0) {
        lockOut();
      } else {
        setStatus('Неправильних відповідей: ' + data.wrong.length + '. Залишилось спроб: ' + left + '.', 'error');
      }
    } catch (err) {
      setStatus(err.message, 'error');
      if (err.code === 'no_attempts_left') lockOut();
    } finally {
      state.busy = false;
      els.checkButton.textContent = 'Перевірити';
      if (!state.passed && state.attemptsUsed < state.maxAttempts) els.checkButton.disabled = false;
    }
  }

  // ------------------------------------------------------------ unlock & celebrate

  function unlock(html, scroll) {
    els.reward.innerHTML = '<div class="unlock-in">' + html + '</div>';
    els.reward.classList.remove('relative');
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

  function checkExercise(section) {
    const gaps = section.querySelectorAll('[data-answer]');
    let right = 0;
    gaps.forEach((gap) => {
      const accepted = gap.dataset.answer.split('|').map(normalize);
      const ok = accepted.indexOf(normalize(gap.value)) !== -1;
      gap.classList.toggle('is-right', ok);
      gap.classList.toggle('is-wrong', !ok);
      if (ok) right++;
    });
    const result = section.querySelector('[data-exercise-result]');
    result.textContent = right + ' / ' + gaps.length;
    result.className = 'exercise__result ' + (right === gaps.length ? 'text-emerald-700' : 'text-amber-700');
  }

  function revealExercise(section) {
    section.querySelectorAll('[data-answer]').forEach((gap) => {
      gap.value = gap.dataset.answer.split('|')[0];
      gap.classList.remove('is-wrong');
      gap.classList.add('is-right');
    });
  }

  document.addEventListener('click', (event) => {
    const check = event.target.closest('[data-check-exercise]');
    const reveal = event.target.closest('[data-reveal-exercise]');
    if (check) checkExercise(check.closest('[data-exercise]'));
    if (reveal) revealExercise(reveal.closest('[data-exercise]'));
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
