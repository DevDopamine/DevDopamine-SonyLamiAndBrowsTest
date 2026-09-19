/* =====================================================================
   ДВИЖОК ТЕСТИРОВАНИЯ
   ---------------------------------------------------------------------
   Отвечает за: каталог тестов, изоляцию ключей, перемешивание,
   валидацию ответов и подсчёт результата.
   Здесь нет ни одной строки, связанной с версткой.
   ===================================================================== */

(function (global) {
  'use strict';

  var CFG = global.APP_CONFIG || {};

  /* ------------------------------------------------------------------
     Приватное хранилище ключей.
     Ключи вынимаются из объектов вопросов и живут в замыкании, поэтому
     из консоли (window.*) их достать нельзя и в DOM они не попадают.
     Полной защитой при статическом хостинге это не является — исходный
     файл с вопросами всё равно можно открыть. См. README.
     ------------------------------------------------------------------ */
  var vault = Object.create(null);
  var catalog = Object.create(null);

  function vkey(testId, qid) { return testId + '::' + qid; }

  /* ---------- утилиты ---------- */

  function clone(v) {
    if (Array.isArray(v)) return v.map(clone);
    if (v && typeof v === 'object') {
      var o = {};
      for (var k in v) if (Object.prototype.hasOwnProperty.call(v, k)) o[k] = clone(v[k]);
      return o;
    }
    return v;
  }

  function shuffle(arr) {
    var a = arr.slice();
    for (var i = a.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }

  function normalizeText(s) {
    return String(s == null ? '' : s)
      .toLowerCase()
      .replace(/ё/g, 'е')
      .replace(/[^\wа-я0-9\s%.,-]/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /* ------------------------------------------------------------------
     Тип ввода. Для SITUATION он зависит от того, есть ли варианты.
     ------------------------------------------------------------------ */
  function inputType(q) {
    if (q.type === 'situation') {
      if (q.options && q.options.length) return q.multiple ? 'multiple' : 'single';
      return 'text';
    }
    return q.type;
  }

  /* ------------------------------------------------------------------
     Регистрация тестов: вынимаем ключи, формируем «чистый» каталог.
     ------------------------------------------------------------------ */
  function register(raw) {
    Object.keys(raw).forEach(function (testId) {
      var src = raw[testId];
      var pub = {
        id: src.id || testId,
        title: src.title,
        heading: src.heading || '',
        description: src.description || '',
        questions: []
      };

      src.questions.forEach(function (q, idx) {
        var secret = {
          correct: q.correct,
          acceptedAnswers: q.acceptedAnswers,
          explanation: q.explanation,
          reference: q.reference,
          flagNote: q.flagNote
        };
        vault[vkey(pub.id, q.id)] = secret;

        var safe = {
          id: q.id,
          num: idx + 1,
          block: q.block || '',
          type: q.type,
          input: inputType(q),
          question: q.question,
          situation: q.situation || '',
          hint: q.hint || '',
          manualReview: !!q.manualReview
        };
        if (q.options) safe.options = clone(q.options);
        if (q.left) safe.left = clone(q.left);
        if (q.right) safe.right = clone(q.right);
        if (q.items) safe.items = clone(q.items);
        pub.questions.push(safe);
      });

      catalog[pub.id] = pub;
    });
  }

  /* ------------------------------------------------------------------
     Построение порядка вопросов и вариантов для конкретной попытки.
     ------------------------------------------------------------------ */
  function buildLayout(testId) {
    var test = catalog[testId];
    var ids = test.questions.map(function (q) { return q.id; });
    if (CFG.SHUFFLE_QUESTIONS) ids = shuffle(ids);

    var optOrder = {};
    if (CFG.SHUFFLE_OPTIONS) {
      test.questions.forEach(function (q) {
        // ORDER не перемешиваем как «варианты» — там порядок и есть ответ,
        // он и так задаётся учеником. MATCHING перемешиваем только правую
        // колонку: структура вопроса при этом не ломается.
        if (q.input === 'single' || q.input === 'multiple') {
          optOrder[q.id] = shuffle(q.options.map(function (o) { return o.id; }));
        } else if (q.input === 'matching') {
          optOrder[q.id] = shuffle(q.right.map(function (o) { return o.id; }));
        }
      });
    }
    return { order: ids, optOrder: optOrder };
  }

  /* Порядок стартовых элементов для ORDER — всегда перемешиваем,
     иначе правильный ответ виден сразу. */
  function buildOrderStart(q) {
    var ids = q.items.map(function (i) { return i.id; });
    if (ids.length < 2) return ids;
    var shuffled = ids, guard = 0;
    var key = vault[vkey(q.__testId, q.id)];
    var correct = (key && key.correct) || [];
    do {
      shuffled = shuffle(ids);
      guard++;
    } while (guard < 20 && correct.length && shuffled.join('|') === correct.join('|'));
    return shuffled;
  }

  /* ------------------------------------------------------------------
     Пустой ли ответ
     ------------------------------------------------------------------ */
  function isEmptyAnswer(q, a) {
    var t = q.input;
    if (a == null) return true;
    if (t === 'single') return !a;
    if (t === 'multiple') return !Array.isArray(a) || a.length === 0;
    if (t === 'text') return !String(a).trim();
    if (t === 'order') return !Array.isArray(a) || a.length !== (q.items || []).length;
    if (t === 'matching') {
      if (typeof a !== 'object') return true;
      return (q.left || []).some(function (l) { return !a[l.id]; });
    }
    return true;
  }

  /* ------------------------------------------------------------------
     ОЦЕНКА ОДНОГО ВОПРОСА
     Возвращает { status, score, max }
       status: 'correct' | 'partial' | 'incorrect' | 'manual'
     ------------------------------------------------------------------ */
  function evaluate(testId, q, answer) {
    var key = vault[vkey(testId, q.id)] || {};
    var t = q.input;

    if (q.manualReview) return { status: 'manual', score: 0, max: 1 };

    if (isEmptyAnswer(q, answer)) return { status: 'incorrect', score: 0, max: 1, empty: true };

    if (t === 'single') {
      var ok = (key.correct || [])[0] === answer;
      return { status: ok ? 'correct' : 'incorrect', score: ok ? 1 : 0, max: 1 };
    }

    if (t === 'multiple') {
      var need = (key.correct || []).slice().sort().join('|');
      var got = answer.slice().sort().join('|');
      var ok2 = need === got;
      return { status: ok2 ? 'correct' : 'incorrect', score: ok2 ? 1 : 0, max: 1 };
    }

    if (t === 'matching') {
      var map = key.correct || {};
      var keys = Object.keys(map);
      var hit = 0;
      keys.forEach(function (k) { if (answer[k] === map[k]) hit++; });
      var ratio = keys.length ? hit / keys.length : 0;
      if (ratio === 1) return { status: 'correct', score: 1, max: 1, matched: hit, of: keys.length };
      if (CFG.PARTIAL_MATCHING && hit > 0) {
        return { status: 'partial', score: ratio, max: 1, matched: hit, of: keys.length };
      }
      return { status: 'incorrect', score: 0, max: 1, matched: hit, of: keys.length };
    }

    if (t === 'order') {
      var corr = key.correct || [];
      var exact = corr.length === answer.length && corr.every(function (v, i) { return answer[i] === v; });
      if (exact) return { status: 'correct', score: 1, max: 1 };
      if (CFG.PARTIAL_ORDER) {
        var hits = corr.reduce(function (acc, v, i) { return acc + (answer[i] === v ? 1 : 0); }, 0);
        var r = corr.length ? hits / corr.length : 0;
        if (r > 0) return { status: 'partial', score: r, max: 1, matched: hits, of: corr.length };
      }
      return { status: 'incorrect', score: 0, max: 1 };
    }

    if (t === 'text') {
      var accepted = key.acceptedAnswers;
      if (!accepted || !accepted.length) return { status: 'manual', score: 0, max: 1 };
      var norm = normalizeText(answer);
      var ok3 = accepted.some(function (a) {
        var na = normalizeText(a);
        return na && (norm === na || norm.indexOf(na) !== -1);
      });
      return { status: ok3 ? 'correct' : 'incorrect', score: ok3 ? 1 : 0, max: 1 };
    }

    return { status: 'manual', score: 0, max: 1 };
  }

  /* ------------------------------------------------------------------
     ПОДСЧЁТ ВСЕГО ТЕСТА
     ------------------------------------------------------------------ */
  function scoreAttempt(testId, questions, answers) {
    var mode = CFG.MANUAL_REVIEW_SCORING || 'exclude';
    var details = [];
    var points = 0, maxPoints = 0;
    var correct = 0, partial = 0, incorrect = 0, manual = 0, unanswered = 0;

    questions.forEach(function (q) {
      var a = answers[q.id];
      var res = evaluate(testId, q, a);

      if (res.status === 'manual') {
        manual++;
        if (mode === 'correct') { points += 1; maxPoints += 1; }
        else if (mode === 'incorrect') { maxPoints += 1; }
        // 'exclude' — не влияет на процент
      } else {
        maxPoints += res.max;
        points += res.score;
        if (res.status === 'correct') correct++;
        else if (res.status === 'partial') partial++;
        else incorrect++;
      }
      if (isEmptyAnswer(q, a)) unanswered++;

      details.push({ id: q.id, status: res.status, score: res.score, info: res });
    });

    var percent = maxPoints > 0 ? Math.round((points / maxPoints) * 100) : 0;
    var passPercent = typeof CFG.PASS_PERCENT === 'number' ? CFG.PASS_PERCENT : 80;

    return {
      percent: percent,
      points: Math.round(points * 100) / 100,
      maxPoints: maxPoints,
      correct: correct,
      partial: partial,
      incorrect: incorrect,
      manual: manual,
      unanswered: unanswered,
      scoredTotal: questions.length - (mode === 'exclude' ? manual : 0),
      questionsTotal: questions.length,
      passed: percent >= passPercent,
      passPercent: passPercent,
      details: details
    };
  }

  /* ------------------------------------------------------------------
     Раскрытие ключа — только для экрана разбора (после завершения).
     ------------------------------------------------------------------ */
  function reveal(testId, q) {
    var key = vault[vkey(testId, q.id)] || {};
    var out = { explanation: key.explanation || '', reference: key.reference || '', text: '' };
    var t = q.input;

    if (t === 'single' || t === 'multiple') {
      if (!key.correct) return out;
      var byId = {};
      (q.options || []).forEach(function (o) { byId[o.id] = o.text; });
      out.text = key.correct.map(function (id) { return byId[id] || id; }).join('; ');
    } else if (t === 'matching') {
      if (!key.correct) return out;
      var lmap = {}, rmap = {};
      (q.left || []).forEach(function (o) { lmap[o.id] = o.text; });
      (q.right || []).forEach(function (o) { rmap[o.id] = o.text; });
      out.text = Object.keys(key.correct).map(function (lid) {
        return lmap[lid] + ' → ' + rmap[key.correct[lid]];
      }).join('\n');
    } else if (t === 'order') {
      if (!key.correct) return out;
      var imap = {};
      (q.items || []).forEach(function (o) { imap[o.id] = o.text; });
      out.text = key.correct.map(function (id, i) { return (i + 1) + '. ' + imap[id]; }).join('\n');
    } else if (t === 'text') {
      if (key.acceptedAnswers && key.acceptedAnswers.length) out.text = key.acceptedAnswers[0];
      else out.text = key.reference || '';
    }
    return out;
  }

  /* ------------------------------------------------------------------
     Человекочитаемый ответ ученицы (для разбора и Telegram)
     ------------------------------------------------------------------ */
  function formatAnswer(q, a) {
    var t = q.input;
    if (isEmptyAnswer(q, a)) return '';
    if (t === 'single') {
      var o = (q.options || []).filter(function (x) { return x.id === a; })[0];
      return o ? o.text : String(a);
    }
    if (t === 'multiple') {
      var map = {};
      (q.options || []).forEach(function (x) { map[x.id] = x.text; });
      return a.map(function (id) { return map[id] || id; }).join('; ');
    }
    if (t === 'matching') {
      var lm = {}, rm = {};
      (q.left || []).forEach(function (x) { lm[x.id] = x.text; });
      (q.right || []).forEach(function (x) { rm[x.id] = x.text; });
      return (q.left || []).map(function (l) {
        return l.text + ' → ' + (rm[a[l.id]] || '—');
      }).join('\n');
    }
    if (t === 'order') {
      var im = {};
      (q.items || []).forEach(function (x) { im[x.id] = x.text; });
      return a.map(function (id, i) { return (i + 1) + '. ' + (im[id] || id); }).join('\n');
    }
    return String(a).trim();
  }

  /* ------------------------------------------------------------------
     Оценка времени прохождения (минуты)
     ------------------------------------------------------------------ */
  function estimateMinutes(testId) {
    var per = CFG.TIME_PER_TYPE || {};
    var sum = 0;
    (catalog[testId].questions || []).forEach(function (q) {
      var base = per[q.input];
      if (base == null) base = per[q.type];
      if (base == null) base = 1;
      if (q.situation) base += 0.4;   // ситуацию нужно прочитать
      sum += base;
    });
    return Math.max(5, Math.round(sum / 5) * 5);
  }

  /* ------------------------------------------------------------------
     Уникальный ID попытки: BROWS-20260919-184201-AB12CD
     ------------------------------------------------------------------ */
  function makeAttemptId(testId) {
    var d = new Date();
    var p = function (n) { return String(n).padStart(2, '0'); };
    var stamp = d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) +
      '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
    var chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    var rnd = '';
    var buf;
    if (global.crypto && global.crypto.getRandomValues) {
      buf = new Uint8Array(6);
      global.crypto.getRandomValues(buf);
      for (var i = 0; i < 6; i++) rnd += chars[buf[i] % chars.length];
    } else {
      for (var j = 0; j < 6; j++) rnd += chars[Math.floor(Math.random() * chars.length)];
    }
    return String(testId).toUpperCase() + '-' + stamp + '-' + rnd;
  }

  /* ------------------------------------------------------------------
     Публичный API
     ------------------------------------------------------------------ */
  global.TestEngine = {
    register: register,
    has: function (id) { return !!catalog[id]; },
    ids: function () { return Object.keys(catalog); },
    get: function (id) { return catalog[id]; },
    buildLayout: buildLayout,
    buildOrderStart: function (testId, q) {
      q.__testId = testId;
      var r = buildOrderStart(q);
      delete q.__testId;
      return r;
    },
    inputType: inputType,
    isEmptyAnswer: isEmptyAnswer,
    evaluate: evaluate,
    score: scoreAttempt,
    reveal: reveal,
    formatAnswer: formatAnswer,
    estimateMinutes: estimateMinutes,
    makeAttemptId: makeAttemptId
  };

  /* Подхватываем данные и стираем «сырой» глобальный объект,
     чтобы ключи не лежали в window. */
  if (global.__TESTS__) {
    register(global.__TESTS__);
    try { delete global.__TESTS__; } catch (e) { global.__TESTS__ = undefined; }
  }

})(window);
