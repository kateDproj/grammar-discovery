/*
 * Grammar Discovery — lesson editor (part of the teacher control center).
 *
 * Views: "builder" (list of lessons) and "editor" (one lesson). The lesson is edited as data
 * (the format LessonRender draws) and saved through the admin API ("save_content"); the server
 * then builds the answer key from the ticked answers.
 *
 * Form fields are bound to the lesson with data-bind="path.to.value"; buttons use data-ed="action"
 * with data-path (an array in the lesson) and data-index.
 */
(function () {
  'use strict';

  const R = window.LessonRender;
  const esc = R.esc;
  const AUTOSAVE_PREFIX = 'gd:editor:';

  const E = {
    lesson: null, // the lesson being edited
    isNew: false,
    status: 'draft',
    dirty: false,
    leaveArmed: null,
    restore: null, // unsaved local copy found when opening
    showAnswers: true,
  };

  const app = () => window.TeacherApp;

  // ------------------------------------------------------------ paths

  function getPath(obj, path) {
    return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
  }

  function setPath(obj, path, value) {
    const keys = path.split('.');
    const last = keys.pop();
    const target = keys.reduce((o, k) => {
      if (o[k] == null) o[k] = /^\d+$/.test(k) ? [] : {};
      return o[k];
    }, obj);
    target[last] = value;
  }

  function clone(o) {
    return JSON.parse(JSON.stringify(o));
  }

  // ------------------------------------------------------------ ids that stay stable when editing

  function allQuestions(l) {
    const list = [];
    ((l.meaning && l.meaning.questions) || []).forEach((q) => list.push(q));
    ((l.form && l.form.questions) || []).forEach((q) => list.push(q));
    ((l.rule && l.rule.items) || []).forEach((it) => (it.gaps || []).forEach((g) => list.push(g)));
    return list;
  }

  function nextId(prefix, taken) {
    let n = 1;
    while (taken.indexOf(prefix + n) !== -1) n++;
    return prefix + n;
  }

  function newQuestionId(prefix) {
    return nextId(prefix, allQuestions(E.lesson).map((q) => q.id));
  }

  function newOptionValue(options) {
    return nextId('o', options.map((o) => o.value));
  }

  function newExerciseId() {
    return nextId('ex', (E.lesson.reward.blocks || []).map((b) => b.id).filter(Boolean));
  }

  function slug(text) {
    return String(text || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 36);
  }

  // ------------------------------------------------------------ templates

  function option(options, text, correct) {
    const o = { value: newOptionValue(options), text: text || '' };
    if (correct) o.correct = true;
    return o;
  }

  function newQuestion(prefix) {
    const q = { id: newQuestionId(prefix), quote: '', question: '', options: [] };
    q.options.push(option(q.options, '', true));
    q.options.push(option(q.options, ''));
    return q;
  }

  function newGap() {
    const g = { id: newQuestionId('r'), options: [] };
    g.options.push(option(g.options, '', true));
    g.options.push(option(g.options, ''));
    return g;
  }

  const BLOCK_TYPES = {
    box: { label: 'Рамка з правилом', make: () => ({ type: 'box', tag: true, text: '' }) },
    table: { label: 'Таблиця', make: () => ({ type: 'table', tag: true, title: '', intro: '', header: ['', ''], rows: [['', ''], ['', '']] }) },
    heading: { label: 'Заголовок', make: () => ({ type: 'heading', text: '✍️ Practice' }) },
    gapfill: { label: 'Вправа з пропусками', make: () => ({ type: 'gapfill', id: newExerciseId(), mode: 'type', title: '', items: [''] }) },
    writing: { label: 'Письмове завдання', make: () => ({ type: 'writing', id: newExerciseId(), title: '', hint: '', context: '', items: [{ prompt: '', answer: '', example: false }] }) },
  };

  function blankLesson() {
    E.lesson = { reward: { blocks: [] } };
    const l = E.lesson;
    Object.assign(l, {
      id: '',
      title: '',
      summary: '',
      source: '',
      intro: 'Спершу прочитайте текст і самі знайдіть закономірність. Правило відкриється, коли ви правильно проаналізуєте приклади.',
      observation: { title: '', hint: 'Прочитайте текст. Зверніть увагу на виділені фрагменти.', layout: 'text', text: '', pairs: { leftTitle: 'Direct Speech', leftNote: '', rightTitle: 'Reported Speech', rightNote: '', items: [{ left: '', right: '' }] } },
      meaning: { title: 'What do the sentences mean?', hint: 'Перечитайте речення з тексту й дайте відповідь на кожне питання.', questions: [] },
      form: { title: 'Look at the form', hint: 'Тепер уважно подивіться на форму.', questions: [] },
      rule: { title: 'Complete the rule', hint: 'Оберіть правильний варіант у кожному пропуску. Підказки — у ваших відповідях вище.', items: [] },
      reward: { heading: '🏆 Great Job! Here is your Grammar Reference.', blocks: [] },
    });
    l.meaning.questions.push(newQuestion('q'));
    l.rule.items.push({ text: '', gaps: [] });
    l.reward.blocks.push(BLOCK_TYPES.box.make(), BLOCK_TYPES.heading.make(), BLOCK_TYPES.gapfill.make());
    return l;
  }

  /** Fills in parts that older or partial lessons may lack, so every form field has a place. */
  function normalizeLesson(l) {
    l.observation = l.observation || { layout: 'text', text: '' };
    l.observation.pairs = l.observation.pairs || { leftTitle: 'Direct Speech', leftNote: '', rightTitle: 'Reported Speech', rightNote: '', items: [] };
    l.observation.pairs.items = l.observation.pairs.items || [];
    ['meaning', 'form'].forEach((k) => {
      l[k] = l[k] || { title: '', hint: '', questions: [] };
      l[k].questions = l[k].questions || [];
    });
    l.rule = l.rule || { title: '', hint: '', items: [] };
    l.rule.items = l.rule.items || [];
    l.reward = l.reward || { heading: '', blocks: [] };
    l.reward.blocks = l.reward.blocks || [];
    return l;
  }

  // ------------------------------------------------------------ checks shown to the teacher

  const STOP_WORDS = ['the', 'and', 'for', 'with', 'clause', 'form', 'like', 'same', 'word'];

  function words(text) {
    return R.plain(text).toLowerCase().replace(/[^a-z' ]/g, ' ').split(/\s+/)
      .map((w) => w.replace(/^'+|'+$/g, '')).filter((w) => w.length > 2);
  }

  /** Problems that block saving (errors) and things worth checking (warnings). */
  function checks() {
    const l = E.lesson;
    const errors = [];
    const warnings = [];
    if (!String(l.title).trim()) errors.push('Введіть назву уроку.');
    if (!/^[a-z0-9_]{3,40}$/.test(l.id)) errors.push('ID уроку: 3–40 символів — малі латинські літери, цифри та «_».');

    const obsText = l.observation.layout === 'pairs'
      ? l.observation.pairs.items.map((p) => p.left + ' ' + p.right).join(' ')
      : l.observation.text;
    if (!String(obsText).trim()) errors.push('Крок 1: додайте текст для спостереження.');
    else if (obsText.indexOf('**') === -1) warnings.push('Крок 1: виділіть цільові форми в тексті (**так**), щоб учні їх помітили.');

    const label = (q, i, step) => step + ', питання ' + (i + 1);
    const checkQuestion = (q, name, isGap) => {
      if (!isGap && !String(q.question || '').trim() && !String(q.quote || '').trim()) errors.push(name + ': введіть питання.');
      const filled = q.options.filter((o) => String(o.text).trim());
      if (filled.length < 2 || filled.length !== q.options.length) errors.push(name + ': потрібно щонайменше два заповнені варіанти (без порожніх).');
      if (!q.options.some((o) => o.correct)) errors.push(name + ': позначте правильну відповідь.');
    };
    l.meaning.questions.forEach((q, i) => checkQuestion(q, label(q, i, 'Крок 2')));
    l.form.questions.forEach((q, i) => checkQuestion(q, label(q, i, 'Крок 3')));
    if (!l.meaning.questions.length) warnings.push('Крок 2: немає жодного питання на значення (CCQ).');

    const evidence = words(obsText + ' ' + allQuestions(l).filter((q) => q.question !== undefined)
      .map((q) => q.quote + ' ' + q.question + ' ' + q.options.map((o) => o.text).join(' ')).join(' '));
    l.rule.items.forEach((item, i) => {
      const name = 'Правило, речення ' + (i + 1);
      if (String(item.text).indexOf('___') === -1) warnings.push(name + ': немає пропуску ___.');
      (item.gaps || []).forEach((g, j) => {
        checkQuestion(g, name + ', пропуск ' + (j + 1), true);
        const correct = g.options.find((o) => o.correct);
        if (!correct) return;
        const keyWords = words(correct.text).filter((w) => STOP_WORDS.indexOf(w) === -1);
        if (keyWords.length && !keyWords.some((w) => evidence.indexOf(w) !== -1)) {
          warnings.push(name + ': відповідь «' + R.plain(correct.text) + '» не трапляється ні в тексті, ні в питаннях. ' +
            'Чи зможе учень вивести її з прикладів? Можливо, варто додати питання, яке веде до неї.');
        }
      });
    });
    if (!allQuestions(l).length) errors.push('Додайте хоча б одне питання або пропуск у правилі.');

    let exercises = 0;
    l.reward.blocks.forEach((b, i) => {
      const name = 'Нагорода, блок ' + (i + 1);
      if (b.type === 'gapfill') {
        exercises++;
        b.items.forEach((t, j) => {
          if (!String(t).trim()) return;
          if (!/\[[^\]]+\]/.test(t)) warnings.push(name + ', речення ' + (j + 1) + ': немає пропуску в [дужках].');
          if (b.mode === 'choose' && /\[[^\]]+\]/.test(t) && !/\[[^\]]*\*[^\]]*\]/.test(t)) {
            warnings.push(name + ', речення ' + (j + 1) + ': позначте правильний варіант зірочкою, напр. [had been*|was].');
          }
        });
      }
      if (b.type === 'writing') {
        exercises++;
        b.items.forEach((it, j) => { if (!String(it.answer).trim()) warnings.push(name + ', завдання ' + (j + 1) + ': додайте правильну відповідь.'); });
      }
    });
    if (!exercises) warnings.push('Нагорода: немає жодної вправи для практики.');
    return { errors: errors, warnings: warnings };
  }

  // ------------------------------------------------------------ small form helpers

  const field = (path, labelText, opts) => {
    opts = opts || {};
    const value = getPath(E.lesson, path);
    const help = opts.help ? '<span class="t-help">' + opts.help + '</span>' : '';
    const input = opts.rows
      ? '<textarea class="t-input w-full" rows="' + opts.rows + '" data-bind="' + path + '"' + (opts.placeholder ? ' placeholder="' + esc(opts.placeholder) + '"' : '') + '>' + esc(value) + '</textarea>'
      : '<input class="t-input w-full" data-bind="' + path + '" value="' + esc(value) + '"' + (opts.placeholder ? ' placeholder="' + esc(opts.placeholder) + '"' : '') + (opts.readonly ? ' readonly' : '') + '>';
    return '<label class="t-label' + (opts.className ? ' ' + opts.className : '') + '">' + labelText + input + help + '</label>';
  };

  const btn = (action, path, index, label, cls, extra) =>
    '<button type="button" class="t-btn ' + (cls || 't-btn--soft') + '" data-ed="' + action + '" data-path="' + path + '"' +
    (index !== undefined && index !== null ? ' data-index="' + index + '"' : '') + (extra || '') + '>' + label + '</button>';

  const moveButtons = (path, i, count) =>
    '<div class="flex gap-1">' +
    btn('up', path, i, '↑', 't-btn--ghost', i === 0 ? ' disabled title="Вгору"' : ' title="Вгору"') +
    btn('down', path, i, '↓', 't-btn--ghost', i === count - 1 ? ' disabled title="Вниз"' : ' title="Вниз"') +
    btn('remove', path, i, '✕', 't-btn--danger', ' title="Видалити"') + '</div>';

  function optionsEditor(path, options) {
    return '<div class="space-y-2"><div class="t-help">Позначте правильну відповідь. Учні бачитимуть варіанти в довільному порядку.</div>' +
      options.map((o, i) =>
        '<div class="flex items-center gap-2">' +
        '<input type="radio" name="correct-' + path + '" data-correct="' + path + '" data-index="' + i + '"' + (o.correct ? ' checked' : '') + ' aria-label="Правильна відповідь" class="h-5 w-5 accent-emerald-600">' +
        '<input class="t-input flex-1" data-bind="' + path + '.' + i + '.text" value="' + esc(o.text) + '" placeholder="Варіант ' + (i + 1) + '">' +
        (options.length > 2 ? btn('remove', path, i, '✕', 't-btn--ghost', ' title="Видалити варіант"') : '') +
        '</div>').join('') +
      (options.length < 6 ? btn('add', path, null, '+ варіант', 't-btn--ghost', ' data-tpl="option"') : '') + '</div>';
  }

  function questionCard(path, q, i, count, number) {
    return '<div class="rounded-xl border border-slate-200 p-4 space-y-3">' +
      '<div class="flex items-center justify-between gap-2"><span class="font-semibold text-slate-700">Питання ' + number + '</span>' + moveButtons(path, i, count) + '</div>' +
      field(path + '.' + i + '.quote', 'Цитата з тексту (необов\'язково)', { rows: 2, help: 'Речення, про яке питаєте. Новий рядок — перенос.' }) +
      field(path + '.' + i + '.question', 'Питання', { placeholder: 'напр. Does David have the money now?' }) +
      optionsEditor(path + '.' + i + '.options', q.options) + '</div>';
  }

  function section(title, body, note) {
    return '<section class="t-card space-y-4"><div><h2 class="text-lg font-bold text-slate-900">' + title + '</h2>' +
      (note ? '<p class="t-help mt-1">' + note + '</p>' : '') + '</div>' + body + '</section>';
  }

  const MARKUP_HELP = '<b>**жирний**</b> — виділення, <i>*курсив*</i>, ==колір== — акцент. ' +
    '<a class="underline" href="teacher-help.html#format" target="_blank" rel="noopener">Докладніше</a>';

  // ------------------------------------------------------------ editor sections

  function basicsSection() {
    const l = E.lesson;
    return section('Основне',
      '<div class="grid gap-3 sm:grid-cols-2">' +
      field('title', 'Назва уроку', { placeholder: 'напр. The Passive Voice' }) +
      field('id', 'ID уроку', { readonly: !E.isNew, help: E.isNew ? 'Латиницею, без пробілів. Не змінюється після створення.' : 'Не змінюється.' }) +
      field('summary', 'Короткий опис для головної сторінки', { placeholder: 'напр. Коли важлива дія, а не той, хто її виконує.' }) +
      field('source', 'Джерело', { placeholder: 'напр. Підручник, с. 40–42' }) +
      '</div>' + field('intro', 'Вступ для учня', { rows: 2 }) +
      (l.id && !E.isNew ? '<p class="t-help">Посилання для учнів: <span class="font-mono">lesson.html?id=' + esc(l.id) + '</span></p>' : ''));
  }

  function observationSection() {
    const o = E.lesson.observation;
    let body = '<div class="grid gap-3 sm:grid-cols-2">' + field('observation.title', 'Заголовок тексту') + field('observation.hint', 'Підказка для учня') + '</div>' +
      '<label class="t-label">Вигляд<select class="t-input w-64" data-bind="observation.layout">' +
      '<option value="text"' + (o.layout !== 'pairs' ? ' selected' : '') + '>Текст або діалог</option>' +
      '<option value="pairs"' + (o.layout === 'pairs' ? ' selected' : '') + '>Пари речень (напр. пряма → непряма мова)</option></select></label>';
    if (o.layout === 'pairs') {
      const p = o.pairs;
      body += '<div class="grid gap-3 sm:grid-cols-2">' +
        field('observation.pairs.leftTitle', 'Ліва колонка') + field('observation.pairs.rightTitle', 'Права колонка') +
        field('observation.pairs.leftNote', 'Підпис ліворуч') + field('observation.pairs.rightNote', 'Підпис праворуч') + '</div>' +
        '<div class="space-y-2">' + p.items.map((it, i) =>
          '<div class="grid gap-2 sm:grid-cols-[1fr_1fr_auto] items-start">' +
          '<textarea class="t-input" rows="2" data-bind="observation.pairs.items.' + i + '.left" placeholder="Ліворуч">' + esc(it.left) + '</textarea>' +
          '<textarea class="t-input" rows="2" data-bind="observation.pairs.items.' + i + '.right" placeholder="Праворуч">' + esc(it.right) + '</textarea>' +
          moveButtons('observation.pairs.items', i, p.items.length) + '</div>').join('') +
        btn('add', 'observation.pairs.items', null, '+ пара', 't-btn--ghost', ' data-tpl="pair"') + '</div>';
    } else {
      body += field('observation.text', 'Текст', {
        rows: 7,
        placeholder: 'Emma: Are you coming to the party tonight?\nDavid: I will come **if you invite me**.',
        help: 'Кожен рядок — окремий абзац. «Ім\'я: текст» — репліка персонажа. Виділіть цільову форму: **if you invite me**.',
      });
    }
    body += '<div><button type="button" class="t-btn t-btn--ghost" data-ed="highlight">Виділити позначений текст **…**</button>' +
      '<span class="t-help ml-2">Позначте слова в полі тексту й натисніть.</span></div>';
    return section('Крок 1 · Спостереження', body, 'Текст із прикладами, де учень помічає цільову граматику. ' + MARKUP_HELP);
  }

  function questionsSection(key, title, note, prefix, offset) {
    const block = E.lesson[key];
    const path = key + '.questions';
    return section(title,
      '<div class="grid gap-3 sm:grid-cols-2">' + field(key + '.title', 'Заголовок') + field(key + '.hint', 'Підказка для учня') + '</div>' +
      '<div class="space-y-3">' + block.questions.map((q, i) => questionCard(path, q, i, block.questions.length, offset + i + 1)).join('') + '</div>' +
      btn('add', path, null, '+ питання', 't-btn', ' data-tpl="question" data-prefix="' + prefix + '"'), note);
  }

  function ruleSection() {
    const items = E.lesson.rule.items;
    return section('Крок 4 · Формулюємо правило',
      '<div class="grid gap-3 sm:grid-cols-2">' + field('rule.title', 'Заголовок') + field('rule.hint', 'Підказка для учня') + '</div>' +
      '<div class="space-y-3">' + items.map((item, i) =>
        '<div class="rounded-xl border border-slate-200 p-4 space-y-3">' +
        '<div class="flex items-center justify-between gap-2"><span class="font-semibold text-slate-700">Речення ' + (i + 1) + '</span>' + moveButtons('rule.items', i, items.length) + '</div>' +
        field('rule.items.' + i + '.text', 'Речення правила', {
          rows: 2,
          placeholder: 'Sentences like *I will come if you invite me* are called **First Conditionals**. They are used for ___ situations.',
          help: '___ — пропуск (можна кілька). *приклад з тексту* — буде виділено синім курсивом.',
        }) +
        (item.gaps || []).map((g, j) => '<div class="rounded-lg bg-slate-50 p-3"><div class="text-sm font-semibold text-slate-600 mb-2">Пропуск ' + (j + 1) + '</div>' +
          optionsEditor('rule.items.' + i + '.gaps.' + j + '.options', g.options) + '</div>').join('') +
        '</div>').join('') + '</div>' +
      btn('add', 'rule.items', null, '+ речення', 't-btn', ' data-tpl="ruleItem"'),
      'Учень заповнює пропуски у правилі, спираючись на свої відповіді у кроках 2–3.');
  }

  function blockEditor(b, i, count) {
    const path = 'reward.blocks.' + i;
    const head = '<div class="flex items-center justify-between gap-2"><span class="font-semibold text-slate-700">' +
      (i + 1) + '. ' + BLOCK_TYPES[b.type].label + (b.id ? ' <span class="font-mono text-xs text-slate-400">' + esc(b.id) + '</span>' : '') +
      '</span>' + moveButtons('reward.blocks', i, count) + '</div>';
    const tag = '<label class="flex items-center gap-2 text-sm"><input type="checkbox" data-bind="' + path + '.tag" data-type="checkbox"' + (b.tag !== false ? ' checked' : '') + '> Позначка «Grammar Links» у куті</label>';
    let body = '';
    if (b.type === 'heading') body = field(path + '.text', 'Текст заголовка');
    if (b.type === 'box') {
      body = tag + field(path + '.text', 'Текст', {
        rows: 8,
        help: 'Порожній рядок — новий абзац. «# Заголовок» — заголовок по центру. «- …» — пункт списку. «> …» — приклад курсивом. ' + MARKUP_HELP,
      });
    }
    if (b.type === 'table') {
      const cols = Math.max(b.header.length, ...b.rows.map((r) => r.length), 1);
      const cell = (p, v, ph) => '<td class="p-1"><input class="t-input w-full" data-bind="' + p + '" value="' + esc(v) + '" placeholder="' + ph + '"></td>';
      body = tag + '<div class="grid gap-3 sm:grid-cols-2">' + field(path + '.title', 'Заголовок таблиці (необов\'язково)') +
        field(path + '.intro', 'Правило над таблицею (необов\'язково)') + '</div>' +
        '<div class="overflow-x-auto"><table class="w-full"><thead><tr>' +
        Array.from({ length: cols }, (_, c) => cell(path + '.header.' + c, b.header[c] || '', 'Заголовок ' + (c + 1))).join('') + '<td></td></tr></thead><tbody>' +
        b.rows.map((r, ri) => '<tr>' + Array.from({ length: cols }, (_, c) => cell(path + '.rows.' + ri + '.' + c, r[c] || '', c === 0 ? 'Рядок ' + (ri + 1) : '')).join('') +
          '<td class="p-1">' + btn('remove', path + '.rows', ri, '✕', 't-btn--ghost', ' title="Видалити рядок"') + '</td></tr>').join('') +
        '</tbody></table></div><div class="flex flex-wrap gap-2">' +
        btn('add', path + '.rows', null, '+ рядок', 't-btn--ghost', ' data-tpl="row"') +
        btn('add-col', path, null, '+ стовпець', 't-btn--ghost') +
        (cols > 1 ? btn('remove-col', path, null, '− стовпець', 't-btn--ghost') : '') + '</div>' +
        '<p class="t-help">Перший стовпець виділяється. У клітинках: ' + MARKUP_HELP + '</p>';
    }
    if (b.type === 'gapfill') {
      body = field(path + '.title', 'Завдання', { placeholder: 'напр. Fill in the blanks with if, even if or unless.' }) +
        '<label class="t-label">Тип пропусків<select class="t-input w-72" data-bind="' + path + '.mode">' +
        '<option value="type"' + (b.mode !== 'choose' ? ' selected' : '') + '>Учень вписує відповідь</option>' +
        '<option value="choose"' + (b.mode === 'choose' ? ' selected' : '') + '>Учень обирає зі списку</option></select></label>' +
        '<label class="t-label">Речення (кожне з нового рядка)<textarea class="t-input w-full font-mono text-sm" rows="6" data-bind="' + path + '.items" data-type="lines">' + esc(b.items.join('\n')) + '</textarea>' +
        '<span class="t-help">' + (b.mode === 'choose'
          ? 'Варіанти в дужках через «|», правильний — із зірочкою: <span class="font-mono">Jane said she [had been*|was] there.</span>'
          : 'Відповідь у квадратних дужках, кілька правильних — через «|»: <span class="font-mono">I won\'t disturb you if you [are working|\'re working]. (work)</span>') +
        ' Підказка в дужках у кінці речення буде сірою.</span></label>';
    }
    if (b.type === 'writing') {
      body = '<div class="grid gap-3 sm:grid-cols-2">' + field(path + '.title', 'Завдання') + field(path + '.hint', 'Підказка (необов\'язково)') + '</div>' +
        field(path + '.context', 'Текст до завдання, напр. діалог (необов\'язково)', { rows: 3 }) +
        '<div class="space-y-2">' + b.items.map((it, j) =>
          '<div class="rounded-lg bg-slate-50 p-3 space-y-2"><div class="flex items-center justify-between"><span class="text-sm font-semibold text-slate-600">Завдання ' + (j + 1) + '</span>' +
          moveButtons(path + '.items', j, b.items.length) + '</div>' +
          field(path + '.items.' + j + '.prompt', 'Завдання для учня (речення або підказка)', { rows: 2, help: 'Залиште порожнім, якщо це одне завдання до всього тексту вище (напр. переказати діалог).' }) +
          field(path + '.items.' + j + '.answer', 'Правильна відповідь (ключ)', { rows: 2, help: 'Учень побачить її після того, як надішле свій варіант. Ви бачите її в панелі поруч із відповіддю учня. Письмові відповіді не перевіряються автоматично.' }) +
          '<label class="flex items-center gap-2 text-sm"><input type="checkbox" data-bind="' + path + '.items.' + j + '.example" data-type="checkbox"' + (it.example ? ' checked' : '') +
          '> Це зразок виконання: показати учням правильну відповідь одразу (як приклад у підручнику)</label></div>').join('') +
        btn('add', path + '.items', null, '+ завдання', 't-btn--ghost', ' data-tpl="writingItem"') + '</div>';
    }
    return '<div class="rounded-xl border border-slate-200 p-4 space-y-3">' + head + body + '</div>';
  }

  function rewardSection() {
    const blocks = E.lesson.reward.blocks;
    return section('Крок 5 · Правило та вправи (відкривається після правильного аналізу)',
      field('reward.heading', 'Заголовок') +
      '<div class="space-y-3">' + blocks.map((b, i) => blockEditor(b, i, blocks.length)).join('') + '</div>' +
      '<div class="flex flex-wrap items-end gap-2"><label class="t-label">Додати блок<select class="t-input" data-ed-new-block>' +
      Object.keys(BLOCK_TYPES).map((k) => '<option value="' + k + '">' + BLOCK_TYPES[k].label + '</option>').join('') + '</select></label>' +
      '<button type="button" class="t-btn" data-ed="add-block">+ Додати</button></div>',
      'Правило з підручника (рамки, таблиці) і вправи. Відповіді вправ бачить лише учень, який відкрив правило.');
  }

  function checksPanel() {
    const c = checks();
    if (!c.errors.length && !c.warnings.length) {
      return '<div class="t-card border-emerald-200 bg-emerald-50 text-emerald-800 text-sm font-medium">✅ Перевірку пройдено: помилок і зауважень немає.</div>';
    }
    return '<div class="t-card space-y-2 text-sm">' +
      (c.errors.length ? '<div class="font-semibold text-red-700">Потрібно виправити перед збереженням:</div><ul class="list-disc pl-5 text-red-700 space-y-1">' +
        c.errors.map((e) => '<li>' + esc(e) + '</li>').join('') + '</ul>' : '') +
      (c.warnings.length ? '<div class="font-semibold text-amber-800">Варто перевірити:</div><ul class="list-disc pl-5 text-amber-800 space-y-1">' +
        c.warnings.map((w) => '<li>' + esc(w) + '</li>').join('') + '</ul>' : '') + '</div>';
  }

  // ------------------------------------------------------------ views

  function viewBuilder() {
    const T = app().state;
    const contents = T.data.contents || {};
    const rows = T.data.lessons.map((l) => {
      const c = contents[l.lesson_id];
      const status = !c ? '<span class="t-chip t-chip--none">створено вручну</span>'
        : c.status === 'published' ? '<span class="t-chip t-chip--done">опубліковано</span>' : '<span class="t-chip t-chip--progress">чернетка</span>';
      const actions = c
        ? '<button type="button" class="t-btn t-btn--soft" data-ed="open" data-lesson="' + esc(l.lesson_id) + '">Редагувати</button> ' +
          '<button type="button" class="t-btn t-btn--ghost" data-ed="copy" data-lesson="' + esc(l.lesson_id) + '">Копіювати</button> ' +
          (c.status === 'published' ? '<a class="t-btn t-btn--ghost" href="lesson.html?id=' + encodeURIComponent(l.lesson_id) + '" target="_blank" rel="noopener">Відкрити ↗</a>' : '')
        : '<span class="t-help">Не редагується в редакторі</span>';
      return '<tr><td class="font-semibold text-slate-900">' + R.inline(l.lesson_title) + '</td><td class="font-mono text-slate-500">' + esc(l.lesson_id) + '</td><td>' + status +
        '</td><td class="text-slate-500">' + (c && c.updated_at ? app().fmtDate(c.updated_at) : '—') + '</td><td class="whitespace-nowrap">' + actions + '</td></tr>';
    }).join('');
    return '<div class="flex flex-wrap items-center gap-3 mb-4"><h1 class="text-2xl font-bold text-slate-900 mr-auto">Уроки</h1>' +
      '<a class="t-btn t-btn--ghost" href="teacher-help.html" target="_blank" rel="noopener">❓ Як створити урок</a>' +
      '<button type="button" class="t-btn" data-ed="new">+ Новий урок</button></div>' +
      '<div class="t-table-wrap"><table class="t-table"><thead><tr><th>Урок</th><th>ID</th><th>Статус</th><th>Змінено</th><th></th></tr></thead><tbody>' + rows + '</tbody></table></div>' +
      '<p class="mt-3 text-sm text-slate-500">Чернетки бачите лише ви. Опубліковані уроки з\'являються на головній сторінці для учнів. ' +
      'Обмеження спроб налаштовуються у розділі «Налаштування модулів».</p>';
  }

  function viewEditor() {
    const l = E.lesson;
    const statusChip = E.isNew ? '<span class="t-chip t-chip--info">новий</span>'
      : E.status === 'published' ? '<span class="t-chip t-chip--done">опубліковано</span>' : '<span class="t-chip t-chip--progress">чернетка</span>';
    const restore = E.restore
      ? '<div class="t-card border-amber-300 bg-amber-50 flex flex-wrap items-center gap-3 text-sm"><span class="mr-auto text-amber-900">Знайдено незбережені зміни цього уроку від ' +
        app().fmtDate(E.restore.t) + '.</span><button type="button" class="t-btn" data-ed="restore">Відновити</button>' +
        '<button type="button" class="t-btn t-btn--ghost" data-ed="discard-restore">Відкинути</button></div>'
      : '';
    const offset = l.meaning.questions.length;
    return '<button type="button" class="t-btn t-btn--ghost mb-3" data-view="builder">← Усі уроки</button>' +
      '<div class="ed-bar"><div class="flex flex-wrap items-center gap-2">' +
      '<h1 class="text-xl font-bold text-slate-900 mr-auto">' + (l.title ? R.inline(l.title) : 'Новий урок') + ' ' + statusChip +
      (E.dirty ? ' <span class="t-chip t-chip--bad">є незбережені зміни</span>' : '') + '</h1>' +
      '<a class="t-btn t-btn--ghost" href="teacher-help.html" target="_blank" rel="noopener" title="Довідка про редактор і форматування">❓ Довідка</a>' +
      '<button type="button" class="t-btn t-btn--soft" data-ed="preview">👁 Попередній перегляд</button>' +
      '<button type="button" class="t-btn t-btn--soft" data-ed="save" data-status="draft">Зберегти як чернетку</button>' +
      '<button type="button" class="t-btn" data-ed="save" data-status="published">' + (E.status === 'published' && !E.isNew ? 'Зберегти й опублікувати' : 'Опублікувати') + '</button>' +
      '</div></div>' +
      '<div class="space-y-5 mt-4">' + restore + '<div data-ed-checks>' + checksPanel() + '</div>' +
      basicsSection() + observationSection() +
      questionsSection('meaning', 'Крок 2 · Аналіз значення (CCQ)', 'Короткі конкретні питання про ситуацію, по одному поняттю в кожному.', 'q', 0) +
      questionsSection('form', 'Крок 3 · Аналіз форми (необов\'язково)', 'Питання, що звертають увагу на форму. Якщо питань немає, крок не показується.', 'f', offset) +
      ruleSection() + rewardSection() +
      (!E.isNew && E.status === 'published'
        ? '<div class="t-card text-sm text-slate-600">Щоб сховати урок від учнів, збережіть його як чернетку.</div>' : '') +
      '</div>';
  }

  // ------------------------------------------------------------ preview

  function openPreview() {
    const l = E.lesson;
    const overlay = document.createElement('div');
    overlay.className = 'ed-preview';
    overlay.innerHTML = '<div class="ed-preview__bar"><span class="font-bold">Попередній перегляд — так урок бачить учень</span>' +
      '<label class="flex items-center gap-2 text-sm"><input type="checkbox" data-preview-answers' + (E.showAnswers ? ' checked' : '') + '> Показати правильні відповіді</label>' +
      '<button type="button" class="t-btn" data-preview-close>Закрити</button></div>' +
      '<div class="ed-preview__body"><main class="mx-auto max-w-3xl px-4 py-8 space-y-6">' + R.steps(l) +
      '<div class="rounded-xl border-2 border-dashed border-emerald-300 bg-emerald-50 p-3 text-center text-sm font-semibold text-emerald-800">⬇️ Після правильного аналізу учень побачить:</div>' +
      R.reward(l.reward) + '</main></div>';
    document.body.appendChild(overlay);
    document.body.style.overflow = 'hidden';
    const main = overlay.querySelector('main');
    main.querySelector('#reward').remove();
    main.querySelector('#check-button').disabled = true;
    const mark = () => {
      allQuestions(l).forEach((q) => {
        const correct = (q.options || []).find((o) => o.correct);
        if (!correct) return;
        const el = main.querySelector('[data-question="' + q.id + '"]');
        if (!el) return;
        if (el.tagName === 'SELECT') {
          el.value = E.showAnswers ? correct.value : '';
          el.classList.toggle('is-right', E.showAnswers);
        } else {
          el.querySelectorAll('input').forEach((i) => (i.checked = E.showAnswers && i.value === correct.value));
          el.classList.toggle('is-right', E.showAnswers);
        }
      });
      main.querySelectorAll('[data-answer]').forEach((g) => {
        g.value = E.showAnswers ? g.dataset.answer.split('|')[0] : '';
        g.classList.toggle('is-right', E.showAnswers);
      });
      main.querySelectorAll('.model-answer').forEach((d) => (d.open = E.showAnswers));
    };
    mark();
    overlay.addEventListener('change', (e) => {
      if (e.target.matches('[data-preview-answers]')) {
        E.showAnswers = e.target.checked;
        mark();
      }
    });
    overlay.addEventListener('click', (e) => {
      if (e.target.closest('[data-preview-close]')) {
        overlay.remove();
        document.body.style.overflow = '';
      }
    });
    overlay.querySelector('[data-preview-close]').focus();
  }

  // ------------------------------------------------------------ autosave (in this browser, in case of a blackout)

  function autosaveKey() {
    return AUTOSAVE_PREFIX + (E.isNew ? '__new__' : E.lesson.id);
  }

  let autosaveTimer = null;
  function scheduleAutosave() {
    clearTimeout(autosaveTimer);
    autosaveTimer = setTimeout(() => {
      try { localStorage.setItem(autosaveKey(), JSON.stringify({ t: new Date().toISOString(), lesson: E.lesson })); } catch (e) { /* storage unavailable */ }
    }, 800);
  }

  function clearAutosave() {
    try { localStorage.removeItem(autosaveKey()); } catch (e) { /* storage unavailable */ }
  }

  function findAutosave(serverUpdated) {
    try {
      const saved = JSON.parse(localStorage.getItem(autosaveKey()));
      if (saved && (!serverUpdated || saved.t > serverUpdated)) return saved;
    } catch (e) { /* storage unavailable */ }
    return null;
  }

  // ------------------------------------------------------------ open / save

  function openLesson(id, copy) {
    const T = app().state;
    const stored = T.data.contents[id];
    E.lesson = normalizeLesson(clone(stored.content));
    E.isNew = Boolean(copy);
    E.idTouched = true;
    E.status = copy ? 'draft' : stored.status;
    if (copy) {
      E.lesson.id = slug(E.lesson.id + '_copy');
      E.lesson.title = E.lesson.title + ' (копія)';
    }
    E.dirty = Boolean(copy);
    E.restore = copy ? null : findAutosave(stored.updated_at);
    T.view = 'editor';
    app().render();
    window.scrollTo(0, 0);
  }

  function newLesson() {
    E.idTouched = false;
    E.isNew = true;
    E.status = 'draft';
    E.dirty = false;
    blankLesson();
    E.restore = findAutosave(null);
    app().state.view = 'editor';
    app().render();
    window.scrollTo(0, 0);
  }

  async function save(status) {
    const c = checks();
    if (c.errors.length) {
      app().toast('Спершу виправте помилки, позначені червоним угорі.', true);
      window.scrollTo({ top: 0, behavior: 'smooth' });
      return;
    }
    const wasNew = E.isNew;
    const payload = clone(E.lesson);
    if (payload.observation.layout === 'pairs') delete payload.observation.text;
    else delete payload.observation.pairs;
    const ok = await app().run('save_content', { content: payload, status: status, is_new: wasNew },
      status === 'published' ? 'Урок опубліковано.' : 'Чернетку збережено.');
    if (!ok) return;
    if (wasNew) {
      try { localStorage.removeItem(AUTOSAVE_PREFIX + '__new__'); } catch (e) { /* storage unavailable */ }
    }
    E.isNew = false;
    E.status = status;
    E.dirty = false;
    E.restore = null;
    clearAutosave();
    await app().loadMeta();
    app().state.view = 'editor';
    app().render();
  }

  // ------------------------------------------------------------ events

  function refresh() {
    const active = document.activeElement;
    const bind = active && active.dataset && active.dataset.bind;
    const start = active && active.selectionStart;
    const end = active && active.selectionEnd;
    const y = window.scrollY;
    app().render();
    window.scrollTo(0, y);
    if (bind) {
      const el = document.querySelector('[data-bind="' + bind + '"]');
      if (el) {
        el.focus();
        try { el.setSelectionRange(start, end); } catch (e) { /* not a text field */ }
      }
    }
  }

  function changed() {
    E.dirty = true;
    scheduleAutosave();
    const panel = document.querySelector('[data-ed-checks]');
    if (panel) panel.innerHTML = checksPanel();
  }

  /** Keeps one gap editor per ___ in a rule sentence. */
  function syncGaps(itemPath) {
    const item = getPath(E.lesson, itemPath);
    const count = (String(item.text).match(/___/g) || []).length;
    item.gaps = item.gaps || [];
    let structural = false;
    while (item.gaps.length < count) { item.gaps.push(newGap()); structural = true; }
    while (item.gaps.length > count) { item.gaps.pop(); structural = true; }
    return structural;
  }

  document.addEventListener('input', (event) => {
    const el = event.target;
    if (!E.lesson || !el.dataset || !el.dataset.bind || app().state.view !== 'editor') return;
    const path = el.dataset.bind;
    let value = el.value;
    if (el.dataset.type === 'checkbox') value = el.checked;
    if (el.dataset.type === 'lines') value = el.value.split('\n');
    setPath(E.lesson, path, value);
    const ruleText = path.match(/^(rule\.items\.\d+)\.text$/);
    if (path === 'id' || path === 'title') {
      if (E.isNew && path === 'title' && !E.idTouched) {
        E.lesson.id = slug(value);
        const idField = document.querySelector('[data-bind="id"]');
        if (idField) idField.value = E.lesson.id;
      }
      if (path === 'id') E.idTouched = true;
    }
    changed();
    if (ruleText && syncGaps(ruleText[1])) refresh();
  });

  document.addEventListener('change', (event) => {
    const el = event.target;
    if (!E.lesson || app().state.view !== 'editor') return;
    if (el.dataset.correct) {
      getPath(E.lesson, el.dataset.correct).forEach((o, i) => {
        if (i === Number(el.dataset.index)) o.correct = true;
        else delete o.correct;
      });
      changed();
      return;
    }
    if (el.dataset.bind === 'observation.layout' || (el.dataset.bind && /\.mode$/.test(el.dataset.bind)) || el.dataset.type === 'checkbox') {
      setPath(E.lesson, el.dataset.bind, el.dataset.type === 'checkbox' ? el.checked : el.value);
      changed();
      refresh();
    }
  });

  document.addEventListener('click', (event) => {
    const b = event.target.closest('[data-ed]');
    if (!b || !app() || !app().state.data) return;
    const action = b.dataset.ed;
    if (action === 'new') return newLesson();
    if (action === 'open') return openLesson(b.dataset.lesson, false);
    if (action === 'copy') return openLesson(b.dataset.lesson, true);
    if (!E.lesson) return;
    if (action === 'preview') return openPreview();
    if (action === 'save') return save(b.dataset.status);
    if (action === 'restore') {
      E.lesson = normalizeLesson(E.restore.lesson);
      E.restore = null;
      E.dirty = true;
      return refresh();
    }
    if (action === 'discard-restore') {
      E.restore = null;
      clearAutosave();
      return refresh();
    }
    if (action === 'highlight') {
      const ta = document.querySelector('[data-bind="observation.text"]');
      if (!ta || ta.selectionStart === ta.selectionEnd) {
        app().toast('Спершу позначте слова в полі «Текст».', true);
        return;
      }
      const v = ta.value;
      ta.value = v.slice(0, ta.selectionStart) + '**' + v.slice(ta.selectionStart, ta.selectionEnd) + '**' + v.slice(ta.selectionEnd);
      E.lesson.observation.text = ta.value;
      changed();
      return;
    }

    const path = b.dataset.path;
    const list = path ? getPath(E.lesson, path) : null;
    const i = Number(b.dataset.index);
    if (action === 'up' && i > 0) [list[i - 1], list[i]] = [list[i], list[i - 1]];
    if (action === 'down' && i < list.length - 1) [list[i + 1], list[i]] = [list[i], list[i + 1]];
    if (action === 'remove') list.splice(i, 1);
    if (action === 'add') {
      const tpl = b.dataset.tpl;
      if (tpl === 'option') list.push(option(list, ''));
      if (tpl === 'question') list.push(newQuestion(b.dataset.prefix));
      if (tpl === 'pair') list.push({ left: '', right: '' });
      if (tpl === 'ruleItem') list.push({ text: '', gaps: [] });
      if (tpl === 'writingItem') list.push({ prompt: '', answer: '', example: false });
      if (tpl === 'row') {
        const block = getPath(E.lesson, path.replace(/\.rows$/, ''));
        list.push(Array.from({ length: Math.max(block.header.length, 1) }, () => ''));
      }
    }
    if (action === 'add-col' || action === 'remove-col') {
      const block = list;
      const cols = Math.max(block.header.length, ...block.rows.map((r) => r.length), 1);
      if (action === 'add-col') {
        block.header.length = cols;
        block.header.push('');
        block.rows.forEach((r) => { r.length = cols; r.push(''); });
      } else if (cols > 1) {
        block.header.length = cols - 1;
        block.rows.forEach((r) => (r.length = cols - 1));
      }
      for (let c = 0; c < block.header.length; c++) if (block.header[c] == null) block.header[c] = '';
      block.rows.forEach((r) => { for (let c = 0; c < r.length; c++) if (r[c] == null) r[c] = ''; });
    }
    if (action === 'add-block') {
      const type = document.querySelector('[data-ed-new-block]').value;
      E.lesson.reward.blocks.push(BLOCK_TYPES[type].make());
    }
    changed();
    refresh();
  });

  window.addEventListener('beforeunload', (event) => {
    if (E.dirty && app() && app().state.view === 'editor') {
      event.preventDefault();
      event.returnValue = '';
    }
  });

  window.TeacherEditor = {
    views: { builder: viewBuilder, editor: viewEditor },
    afterRender: function () {},
    /** Leaving the editor with unsaved changes needs a second click on the same tab. */
    canLeave: function (target) {
      if (!E.dirty || !app() || app().state.view !== 'editor' || target === 'editor') return true;
      if (E.leaveArmed === target) {
        E.leaveArmed = null;
        E.dirty = false;
        return true;
      }
      E.leaveArmed = target;
      app().toast('Є незбережені зміни. Натисніть ще раз, щоб вийти без збереження (копія лишиться в цьому браузері).', true);
      setTimeout(() => { if (E.leaveArmed === target) E.leaveArmed = null; }, 5000);
      return false;
    },
  };
})();
