/*
 * Grammar Discovery — lesson renderer.
 *
 * Builds the HTML of a lesson from its data (the format saved by the lesson editor), using
 * the same markup the rest of the app expects (data-question, data-exercise-id, data-answer…).
 * Used by lesson.html (students), app.js (the unlocked reward) and teacher.js (preview and
 * question texts).
 *
 * Inline markup in lesson texts:
 *   **text**  bold (in the observation text: highlighted target form)
 *   *text*    italic (in rule sentences: example from the text)
 *   ==text==  accent colour
 *   new line  line break
 */
(function () {
  'use strict';

  function esc(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /** Inline markup → HTML. ctx.highlight: ** is a target form; ctx.example: * is a rule example. */
  function inline(text, ctx) {
    ctx = ctx || {};
    return esc(text)
      .replace(/==(.+?)==/g, '<span class="gl-accent">$1</span>')
      .replace(/\*\*(.+?)\*\*/g, ctx.highlight ? '<strong class="font-bold text-blue-600">$1</strong>' : '<b>$1</b>')
      .replace(/\*(.+?)\*/g, ctx.example ? '<span class="rule-example">$1</span>' : '<i>$1</i>')
      .replace(/\n/g, '<br>');
  }

  /** Markup removed, for places that can only hold plain text (dropdown options, labels). */
  function plain(text) {
    return String(text == null ? '' : text).replace(/==|\*\*|\*/g, '');
  }

  // ------------------------------------------------------------ discovery steps

  function stepCard(badge, title, hint, body, analysis) {
    return '<section class="step-card"' + (analysis ? ' data-analysis' : '') + '>' +
      '<span class="step-badge">' + esc(badge) + '</span>' +
      '<h2 class="mt-3 text-xl sm:text-2xl font-bold text-slate-900">' + inline(title) + '</h2>' +
      (hint ? '<p class="mt-1 text-sm text-slate-500">' + inline(hint) + '</p>' : '') +
      body + '</section>';
  }

  function observationBody(obs) {
    if (obs.layout === 'pairs') {
      const p = obs.pairs || {};
      const items = p.items || [];
      const col = (title, note, key, soft) =>
        '<div class="rounded-xl ' + (soft ? 'bg-blue-50/60' : 'bg-slate-50') + ' p-4">' +
        '<h3 class="text-sm font-semibold uppercase tracking-wide ' + (soft ? 'text-blue-700' : 'text-slate-500') + '">' + esc(title) + '</h3>' +
        (note ? '<p class="text-xs ' + (soft ? 'text-blue-400' : 'text-slate-400') + '">' + esc(note) + '</p>' : '') +
        '<ul class="mt-3 space-y-3 text-base sm:text-lg leading-relaxed">' +
        items.map((it) => '<li>' + inline(it[key], { highlight: true }) + '</li>').join('') + '</ul></div>';
      return '<div class="mt-4 grid gap-4 sm:grid-cols-2">' +
        col(p.leftTitle || 'Before', p.leftNote, 'left', false) +
        col(p.rightTitle || 'After', p.rightNote, 'right', true) + '</div>';
    }
    const lines = String(obs.text || '').split('\n').filter((l) => l.trim());
    return '<div class="mt-4 space-y-3 text-base sm:text-lg leading-relaxed">' + lines.map((line) => {
      const m = line.match(/^([A-Za-zА-Яа-яІіЇїЄєҐґ' .-]{1,24}):\s+(.*)$/);
      return m
        ? '<p><span class="font-semibold text-slate-500">' + esc(m[1]) + ':</span> ' + inline(m[2], { highlight: true }) + '</p>'
        : '<p>' + inline(line, { highlight: true }) + '</p>';
    }).join('') + '</div>';
  }

  function questionHtml(num, q) {
    const quote = q.quote ? '<span class="ccq-quote">' + inline(q.quote) + '</span>' : '';
    const options = (q.options || []).map((o) =>
      '<label class="option"><input type="radio" name="' + esc(q.id) + '" value="' + esc(o.value) + '"><span>' + inline(o.text) + '</span></label>'
    ).join('');
    return '<fieldset class="ccq" data-question="' + esc(q.id) + '">' +
      '<legend class="font-medium">' + num + '. ' + quote + inline(q.question) + '</legend>' +
      '<div class="options" data-shuffle>' + options + '</div>' +
      '<p class="mt-2 text-sm font-medium text-red-600" data-feedback></p></fieldset>';
  }

  function ruleItemHtml(item) {
    let gapIndex = 0;
    const parts = String(item.text || '').split('___');
    return parts.map((part, i) => {
      let html = inline(part, { example: true });
      if (i < parts.length - 1) {
        const gap = (item.gaps || [])[gapIndex++];
        if (gap) {
          html += '<select class="rule-select" data-question="' + esc(gap.id) + '" aria-label="' + esc(gap.id) + '">' +
            '<option value="">оберіть…</option>' +
            (gap.options || []).map((o) => '<option value="' + esc(o.value) + '">' + esc(plain(o.text)) + '</option>').join('') +
            '</select>';
        } else {
          html += '___';
        }
      }
      return html;
    }).join('');
  }

  /** The discovery part of the page: title, steps, check button and the locked reward. */
  function steps(lesson) {
    const meaning = (lesson.meaning && lesson.meaning.questions) || [];
    const form = (lesson.form && lesson.form.questions) || [];
    const rule = (lesson.rule && lesson.rule.items) || [];
    let step = 1;
    let num = 0;
    let html = '<div>' +
      '<a href="index.html" class="text-sm text-slate-500 hover:text-slate-700">← Усі модулі</a>' +
      '<h1 class="mt-2 text-3xl sm:text-4xl font-extrabold tracking-tight text-slate-900">' + inline(lesson.title) + '</h1>' +
      (lesson.intro ? '<p class="mt-2 text-slate-600">' + inline(lesson.intro) + '</p>' : '') +
      '</div>';

    const obs = lesson.observation || {};
    html += stepCard('Крок ' + step++ + ' · Спостереження', obs.title || '', obs.hint, observationBody(obs), false);

    if (meaning.length) {
      const m = lesson.meaning;
      html += stepCard('Крок ' + step++ + ' · Аналіз значення', m.title || 'What do the sentences mean?', m.hint,
        '<div class="mt-5 space-y-5">' + meaning.map((q) => questionHtml(++num, q)).join('') + '</div>', true);
    }
    if (form.length) {
      const f = lesson.form;
      html += stepCard('Крок ' + step++ + ' · Аналіз форми', f.title || 'Look at the form', f.hint,
        '<div class="mt-5 space-y-5">' + form.map((q) => questionHtml(++num, q)).join('') + '</div>', true);
    }
    if (rule.length) {
      const r = lesson.rule;
      html += stepCard('Крок ' + step++ + ' · Формулюємо правило', r.title || 'Complete the rule', r.hint,
        '<ol class="mt-5 list-decimal space-y-5 pl-6 text-base sm:text-lg leading-loose">' +
        rule.map((item) => '<li>' + ruleItemHtml(item) + '</li>').join('') + '</ol>', true);
    }
    const lastAnalysis = step - 1;

    html += '<div class="flex flex-col items-center gap-3 py-2 text-center">' +
      '<button id="check-button" type="button" class="rounded-2xl bg-blue-600 px-10 py-4 text-lg font-bold text-white shadow-lg shadow-blue-600/20 transition hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-60">Перевірити</button>' +
      '<p id="check-status" class="text-sm sm:text-base font-medium text-slate-600" role="status" aria-live="polite"></p></div>';

    html += '<section id="reward" class="relative overflow-hidden rounded-2xl">' +
      '<div class="locked-preview step-card space-y-3" aria-hidden="true">' +
      '<div class="h-7 w-2/3 rounded bg-emerald-200"></div><div class="h-4 w-full rounded bg-slate-200"></div>' +
      '<div class="h-4 w-5/6 rounded bg-slate-200"></div><div class="grid grid-cols-3 gap-2 pt-2">' +
      '<div class="h-8 rounded bg-blue-100"></div><div class="h-8 rounded bg-blue-100"></div><div class="h-8 rounded bg-blue-100"></div>' +
      '<div class="h-8 rounded bg-slate-100"></div><div class="h-8 rounded bg-slate-100"></div><div class="h-8 rounded bg-slate-100"></div></div>' +
      '<div class="h-4 w-3/4 rounded bg-slate-200"></div></div>' +
      '<div class="lock-overlay"><div><div class="text-5xl">🔒</div>' +
      '<p class="mt-2 text-lg font-bold text-slate-800">Крок ' + step + ' · Правило та вправи</p>' +
      '<p class="mt-1 text-sm text-slate-600">Відкриється після правильного аналізу у ' +
      (lastAnalysis > 2 ? 'кроках 2–' + lastAnalysis : 'кроці 2') + '.</p></div></div></section>';
    return html;
  }

  // ------------------------------------------------------------ reward (rule + practice)

  function tagHtml(show) {
    return show ? '<div class="grammar-links__tag"><span>Grammar<br>Links</span></div>' : '';
  }

  /**
   * Box text: blocks separated by blank lines.
   *   "# Title"   centred title
   *   "- text"    bullet (the following lines of the block belong to it)
   *   "> text"    example line (italic)
   *   other       paragraph
   */
  function boxText(text) {
    const blocks = String(text || '').split(/\n\s*\n/).map((b) => b.split('\n').filter((l) => l.trim())).filter((b) => b.length);
    let html = '';
    let bullets = [];
    const flush = () => {
      if (bullets.length) html += '<ul class="gl-bullets">' + bullets.join('') + '</ul>';
      bullets = [];
    };
    const line = (l, indent) => l.startsWith('> ')
      ? '<div class="italic' + (indent ? ' pl-5' : '') + '">' + inline(l.slice(2)) + '</div>'
      : '<div>' + inline(l) + '</div>';
    blocks.forEach((b) => {
      if (b[0].startsWith('# ')) {
        flush();
        html += '<h3 class="gl-title text-lg">' + inline(b[0].slice(2)) + '</h3>' + b.slice(1).map((l) => line(l, true)).join('');
      } else if (b[0].startsWith('- ')) {
        bullets.push('<li>' + inline(b[0].slice(2)) + b.slice(1).map((l) => line(l, false)).join('') + '</li>');
      } else {
        flush();
        html += '<div>' + line(b[0], false).replace(/^<div>|<\/div>$/g, '') + b.slice(1).map((l) => line(l, true)).join('') + '</div>';
      }
    });
    flush();
    return html;
  }

  function boxBlock(b) {
    return '<section class="grammar-links' + (b.tag === false ? ' grammar-links--plain' : '') + '">' +
      '<div class="grammar-links__body space-y-3 text-sm sm:text-base leading-relaxed">' + boxText(b.text) + '</div>' +
      tagHtml(b.tag !== false) + '</section>';
  }

  function tableBlock(b) {
    const header = (b.header || []).filter((h) => String(h).trim());
    const rows = (b.rows || []).filter((r) => r.some((c) => String(c).trim()));
    return '<section class="grammar-links' + (b.tag === false ? ' grammar-links--plain' : '') + '"><div class="grammar-links__body">' +
      (b.title ? '<h3 class="text-lg font-semibold text-slate-800 mb-3">' + inline(b.title) + '</h3>' : '') +
      (b.intro ? '<p class="font-semibold text-slate-800 mb-3">' + inline(b.intro) + '</p>' : '') +
      '<div class="overflow-x-auto"><table class="w-full text-left text-sm sm:text-base">' +
      (header.length ? '<thead class="bg-blue-50 text-blue-900"><tr>' + header.map((h) => '<th class="p-3 font-semibold">' + inline(h) + '</th>').join('') + '</tr></thead>' : '') +
      '<tbody class="divide-y divide-slate-200">' + rows.map((r) => '<tr>' + r.map((c, i) =>
        '<td class="p-3' + (i === 0 ? ' font-semibold text-blue-800' : '') + '">' + inline(c) + '</td>').join('') + '</tr>').join('') +
      '</tbody></table></div></div>' + tagHtml(b.tag !== false) + '</section>';
  }

  const ACTIONS = '<div class="exercise__actions">' +
    '<button type="button" class="btn-check" data-check-exercise>Перевірити</button>' +
    '<button type="button" class="btn-reveal" data-reveal-exercise>Показати відповіді</button>' +
    '<span class="exercise__result" data-exercise-result></span></div>';

  /** Gap-fill item: "David will come [if] you invite him." — [a|b] accepted answers; in choose mode [right*|wrong]. */
  function gapItem(text, mode, n) {
    let gap = 0;
    let html = esc(text).replace(/\[([^\]]+)\]/g, (whole, inner) => {
      gap++;
      const parts = inner.split('|').map((p) => p.trim()).filter(Boolean);
      if (mode === 'choose') {
        const correct = parts.filter((p) => p.endsWith('*')).map((p) => p.slice(0, -1));
        const options = parts.map((p) => p.replace(/\*$/, ''));
        return '<select class="gap-select" data-answer="' + (correct.length ? correct : options.slice(0, 1)).join('|') + '" aria-label="gap ' + n + '.' + gap + '">' +
          '<option value="">…</option>' + options.map((o) => '<option>' + o + '</option>').join('') + '</select>';
      }
      const wide = parts.some((p) => p.length > 8) ? ' gap-input--wide' : '';
      return '<input class="gap-input' + wide + '" data-answer="' + parts.join('|') + '" aria-label="gap ' + n + '.' + gap + '">';
    });
    html = html.replace(/\s\(([^()]+)\)\s*$/, ' <span class="hint">($1)</span>')
      .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/\*(.+?)\*/g, '<i>$1</i>');
    return html;
  }

  function gapfillBlock(b, number) {
    return '<section class="exercise" data-exercise-id="' + esc(b.id) + '" data-exercise>' +
      '<h3 class="exercise__title">' + number + '. ' + inline(b.title) + '</h3>' +
      '<ol class="exercise__list">' + (b.items || []).filter((t) => String(t).trim())
        .map((t, i) => '<li>' + gapItem(t, b.mode, i + 1) + '</li>').join('') + '</ol>' + ACTIONS + '</section>';
  }

  function modelAnswer(text) {
    return '<details class="model-answer"><summary>Надіслати й показати зразок</summary>' + inline(text) + '</details>';
  }

  function writingBlock(b, number) {
    const items = (b.items || []).filter((it) => String(it.prompt || '').trim() || String(it.answer || '').trim());
    let body = '';
    if (b.context) {
      body += '<div class="rounded-lg bg-slate-50 p-4 text-sm sm:text-base space-y-1 mb-3">' +
        String(b.context).split('\n').filter((l) => l.trim()).map((l) => '<div>' + inline(l) + '</div>').join('') + '</div>';
    }
    if (items.length === 1 && !String(items[0].prompt || '').trim()) {
      body += '<textarea class="write-input" rows="5" aria-label="your answer"></textarea>' + modelAnswer(items[0].answer);
    } else {
      body += '<ol class="exercise__list">' + items.map((it, i) => '<li><div>' + inline(it.prompt) + '</div>' +
        (it.example
          ? '<div class="text-emerald-700 italic">→ ' + inline(it.answer) + '</div>'
          : '<textarea class="write-input" rows="2" aria-label="your answer ' + (i + 1) + '"></textarea>' + modelAnswer(it.answer)) +
        '</li>').join('') + '</ol>';
    }
    return '<section class="exercise" data-exercise-id="' + esc(b.id) + '">' +
      '<h3 class="exercise__title">' + number + '. ' + inline(b.title) + '</h3>' +
      '<p class="text-sm text-slate-500 mb-3">' + inline(b.hint || 'Напишіть свій варіант і надішліть його — після цього відкриється зразок.') + '</p>' +
      body + '</section>';
  }

  function reward(data) {
    data = data || {};
    let exercise = 0;
    const blocks = (data.blocks || []).map((b) => {
      if (b.type === 'heading') return '<h2 class="text-xl sm:text-2xl font-bold text-slate-800 pt-4">' + inline(b.text) + '</h2>';
      if (b.type === 'box') return boxBlock(b);
      if (b.type === 'table') return tableBlock(b);
      if (b.type === 'gapfill') return gapfillBlock(b, ++exercise);
      if (b.type === 'writing') return writingBlock(b, ++exercise);
      return '';
    }).join('');
    return '<div class="space-y-8">' +
      (data.heading ? '<h2 class="text-2xl sm:text-3xl font-bold text-emerald-700">' + inline(data.heading) + '</h2>' : '') +
      blocks + '</div>';
  }

  window.LessonRender = { steps: steps, reward: reward, inline: inline, plain: plain, esc: esc };
})();
