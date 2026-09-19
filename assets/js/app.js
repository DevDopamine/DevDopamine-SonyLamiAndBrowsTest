/* =====================================================================
   ИНТЕРФЕЙС ТЕСТИРОВАНИЯ
   ===================================================================== */

(function () {
  'use strict';

  var CFG = window.APP_CONFIG;
  var Engine = window.TestEngine;

  var STATE_VERSION = 1;

  var testId = null;
  var test = null;
  var questions = [];          // вопросы в порядке текущей попытки
  var qIndex = {};             // id -> объект вопроса
  var state = null;
  var busy = false;
  var animating = false;
  var openMatchRow = null;
  var memoryStore = {};        // запасное хранилище, если localStorage недоступен

  /* ---------------- helpers ---------------- */

  function $(sel) { return document.querySelector(sel); }
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function show(id) {
    Array.prototype.forEach.call(document.querySelectorAll('.screen'), function (s) { s.hidden = true; });
    var t = document.getElementById(id);
    if (t) t.hidden = false;
    window.scrollTo(0, 0);
  }
  function reduced() {
    return window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }
  function plural(n, one, few, many) {
    var m10 = n % 10, m100 = n % 100;
    if (m10 === 1 && m100 !== 11) return one;
    if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) return few;
    return many;
  }

  /* ---------------- URL ---------------- */

  function getCurrentTest() {
    var raw = '';
    try {
      var params = new URLSearchParams(window.location.search);
      raw = params.get('test') || params.get('t') || '';
    } catch (e) { /* очень старый браузер */ }

    if (!raw && window.location.hash) {
      raw = window.location.hash.replace(/^#\/?/, '');
    }
    if (!raw) {
      var parts = window.location.pathname.split('/').filter(Boolean);
      var last = parts[parts.length - 1] || '';
      last = last.replace(/\.html?$/i, '');
      if (last && Engine.has(last.toLowerCase())) raw = last;
    }
    return String(raw).trim().toLowerCase().replace(/[^a-z0-9_-]/g, '');
  }

  /* ---------------- хранилище ---------------- */

  function storageKey(id) { return 'test_' + id + '_progress'; }

  function readStore(k) {
    try { return window.localStorage.getItem(k); }
    catch (e) { return Object.prototype.hasOwnProperty.call(memoryStore, k) ? memoryStore[k] : null; }
  }
  function writeStore(k, v) {
    try { window.localStorage.setItem(k, v); }
    catch (e) { memoryStore[k] = v; }
  }
  function removeStore(k) {
    try { window.localStorage.removeItem(k); } catch (e) { delete memoryStore[k]; }
  }

  function loadState(id) {
    var raw = readStore(storageKey(id));
    if (!raw) return null;
    try {
      var s = JSON.parse(raw);
      if (!s || s.v !== STATE_VERSION || s.test !== id) return null;
      if (!Array.isArray(s.order) || !s.order.length) return null;
      return s;
    } catch (e) { return null; }
  }

  function persist() {
    if (!state) return;
    try { writeStore(storageKey(state.test), JSON.stringify(state)); } catch (e) { /* игнорируем */ }
  }

  /* ---------------- построение попытки ---------------- */

  function buildQuestionList() {
    qIndex = {};
    test.questions.forEach(function (q) { qIndex[q.id] = q; });
    questions = state.order.map(function (id) { return qIndex[id]; }).filter(Boolean);
  }

  function newAttempt(name) {
    var layout = Engine.buildLayout(testId);
    state = {
      v: STATE_VERSION,
      test: testId,
      attemptId: Engine.makeAttemptId(testId),
      name: name,
      startedAt: Date.now(),
      order: layout.order,
      optOrder: layout.optOrder,
      current: 0,
      answers: {},
      finished: false,
      finishedAt: null,
      result: null,
      sent: false,
      sendError: null
    };
    buildQuestionList();
    persist();
  }

  /* ---------------- модальное окно ---------------- */

  var modalResolve = null;
  function openModal(opts) {
    $('#modal-title').textContent = opts.title;
    $('#modal-text').textContent = opts.text;
    $('#modal-ok').textContent = opts.ok || 'Ок';
    var cancel = $('#modal-cancel');
    if (opts.cancel === false) { cancel.hidden = true; $('.modal-actions').style.gridTemplateColumns = '1fr'; }
    else { cancel.hidden = false; cancel.textContent = opts.cancel || 'Отмена'; $('.modal-actions').style.gridTemplateColumns = '1fr 1fr'; }
    $('#modal').hidden = false;
    setTimeout(function () { $('#modal-ok').focus(); }, 30);
    return new Promise(function (res) { modalResolve = res; });
  }
  function closeModal(value) {
    $('#modal').hidden = true;
    if (modalResolve) { var r = modalResolve; modalResolve = null; r(value); }
  }

  /* ---------------- стартовый экран ---------------- */

  function renderStart() {
    var count = test.questions.length;
    $('#start-brand').textContent = CFG.BRAND_TITLE;
    $('#start-subtitle').textContent = CFG.BRAND_SUBTITLE;
    $('#start-title').textContent = test.title;
    $('#start-count').textContent = count;
    $('#start-time').textContent = '~' + Engine.estimateMinutes(testId) + ' мин';
    $('#start-pass').textContent = CFG.PASS_PERCENT + '%';
    document.title = CFG.BRAND_TITLE + ' · ' + test.title;

    var saved = loadState(testId);
    var box = $('#resume-box');
    if (saved && !saved.finished) {
      var pos = Math.min(saved.current + 1, saved.order.length);
      $('#resume-meta').textContent = saved.name + ' · вопрос ' + pos + ' из ' + saved.order.length;
      box.hidden = false;
      $('#student-name').value = saved.name || '';
    } else {
      box.hidden = true;
    }
    show('screen-start');
  }

  /* ---------------- экран вопроса ---------------- */

  function currentQuestion() { return questions[state.current]; }

  function renderQuizChrome() {
    $('#quiz-test').textContent = test.title;
    $('#quiz-name').textContent = state.name;
    var total = questions.length;
    var n = state.current + 1;
    $('#quiz-counter').textContent = 'Вопрос ' + n + ' из ' + total;
    var pct = Math.round((n / total) * 100);
    $('#progress-fill').style.width = pct + '%';
    $('#progress').setAttribute('aria-valuenow', String(pct));

    $('#btn-prev').disabled = state.current === 0;
    var last = state.current === total - 1;
    $('#btn-next').textContent = last ? 'Завершить тест' : 'Далее';

    var left = questions.filter(function (q) { return Engine.isEmptyAnswer(q, state.answers[q.id]); }).length;
    $('#nav-status').textContent = left ? 'Без ответа: ' + left : '';
  }

  function orderedOptions(q, list, kind) {
    var order = state.optOrder && state.optOrder[q.id];
    if (!order) return list;
    var map = {};
    list.forEach(function (o) { map[o.id] = o; });
    var out = order.map(function (id) { return map[id]; }).filter(Boolean);
    return out.length === list.length ? out : list;
  }

  function buildQuestionCard() {
    var q = currentQuestion();
    var card = $('#question-card');
    card.innerHTML = '';
    openMatchRow = null;

    if (q.type === 'situation') {
      card.appendChild(el('div', 'situation-badge', 'Ситуационная задача'));
      if (q.situation) card.appendChild(el('div', 'situation-box', q.situation));
    } else if (q.block) {
      card.appendChild(el('div', 'q-block', q.block));
    }

    var h = el('h2', 'q-text', q.question);
    card.appendChild(h);

    if (q.input === 'multiple') card.appendChild(el('p', 'q-hint', 'Выберите все подходящие варианты'));
    else if (q.input === 'matching') card.appendChild(el('p', 'q-hint', 'Нажмите на элемент слева и выберите соответствие'));
    else if (q.input === 'order') card.appendChild(el('p', 'q-hint', 'Расставьте пункты в правильном порядке'));
    else if (q.input === 'text' && q.hint) card.appendChild(el('p', 'q-hint', q.hint));

    if (q.input === 'single' || q.input === 'multiple') card.appendChild(buildChoice(q));
    else if (q.input === 'matching') card.appendChild(buildMatching(q));
    else if (q.input === 'order') card.appendChild(buildOrder(q));
    else card.appendChild(buildText(q));
  }

  /* --- single / multiple --- */
  function buildChoice(q) {
    var multi = q.input === 'multiple';
    var wrap = el('div', 'options');
    wrap.setAttribute('role', multi ? 'group' : 'radiogroup');
    wrap.setAttribute('aria-label', 'Варианты ответа');

    orderedOptions(q, q.options).forEach(function (o) {
      var b = el('button', 'option');
      b.type = 'button';
      b.setAttribute('role', multi ? 'checkbox' : 'radio');

      var mark = el('span', 'option-mark ' + (multi ? 'check' : 'radio'), multi ? '✓' : '●');
      mark.setAttribute('aria-hidden', 'true');
      b.appendChild(mark);
      b.appendChild(el('span', 'option-text', o.text));

      var selected = multi
        ? Array.isArray(state.answers[q.id]) && state.answers[q.id].indexOf(o.id) !== -1
        : state.answers[q.id] === o.id;
      setSel(b, selected, multi);

      b.addEventListener('click', function () {
        if (multi) {
          var arr = Array.isArray(state.answers[q.id]) ? state.answers[q.id].slice() : [];
          var i = arr.indexOf(o.id);
          if (i === -1) arr.push(o.id); else arr.splice(i, 1);
          state.answers[q.id] = arr;
          setSel(b, arr.indexOf(o.id) !== -1, true);
        } else {
          state.answers[q.id] = o.id;
          Array.prototype.forEach.call(wrap.children, function (c) { setSel(c, false, false); });
          setSel(b, true, false);
        }
        persist();
        renderQuizChrome();
      });
      wrap.appendChild(b);
    });
    return wrap;
  }

  function setSel(node, on, multi) {
    node.classList.toggle('selected', !!on);
    node.setAttribute(multi ? 'aria-checked' : 'aria-checked', on ? 'true' : 'false');
  }

  /* --- matching --- */
  function buildMatching(q) {
    var wrap = el('div', 'matching');
    if (!state.answers[q.id] || typeof state.answers[q.id] !== 'object') state.answers[q.id] = {};
    var ans = state.answers[q.id];
    var rights = orderedOptions(q, q.right);
    var rmap = {};
    q.right.forEach(function (r) { rmap[r.id] = r.text; });

    q.left.forEach(function (l) {
      var row = el('div', 'match-row');
      var head = el('button', 'match-head');
      head.type = 'button';
      head.setAttribute('aria-expanded', 'false');
      head.appendChild(el('span', 'match-left', l.text));

      var val = el('span', 'match-value');
      var valText = el('span', '', ans[l.id] ? rmap[ans[l.id]] : 'выбрать');
      val.appendChild(valText);
      var caret = el('span', 'match-caret', '▾');
      caret.setAttribute('aria-hidden', 'true');
      val.appendChild(caret);
      head.appendChild(val);
      row.appendChild(head);

      var panel = el('div', 'match-panel');
      panel.hidden = true;

      rights.forEach(function (r) {
        var opt = el('button', 'match-opt', r.text);
        opt.type = 'button';
        opt.dataset.right = r.id;
        opt.addEventListener('click', function () {
          // одна правая часть — одному левому элементу
          Object.keys(ans).forEach(function (k) { if (ans[k] === r.id && k !== l.id) delete ans[k]; });
          ans[l.id] = r.id;
          state.answers[q.id] = ans;
          persist();
          refreshMatching(wrap, q, ans, rmap);
          togglePanel(row, head, panel, false);
          renderQuizChrome();
        });
        panel.appendChild(opt);
      });

      head.addEventListener('click', function () {
        togglePanel(row, head, panel, panel.hidden);
      });

      row.appendChild(panel);
      row._ctx = { left: l.id, head: head, panel: panel, valText: valText };
      wrap.appendChild(row);
    });

    refreshMatching(wrap, q, ans, rmap);
    return wrap;
  }

  function togglePanel(row, head, panel, open) {
    if (open && openMatchRow && openMatchRow !== row) {
      var c = openMatchRow._ctx;
      c.panel.hidden = true;
      c.head.setAttribute('aria-expanded', 'false');
      openMatchRow.classList.remove('open');
    }
    panel.hidden = !open;
    head.setAttribute('aria-expanded', open ? 'true' : 'false');
    row.classList.toggle('open', open);
    openMatchRow = open ? row : null;
  }

  function refreshMatching(wrap, q, ans, rmap) {
    Array.prototype.forEach.call(wrap.children, function (row) {
      var ctx = row._ctx;
      var chosen = ans[ctx.left];
      ctx.valText.textContent = chosen ? rmap[chosen] : 'выбрать';
      ctx.valText.parentNode.classList.toggle('set', !!chosen);
      row.classList.toggle('filled', !!chosen);
      Array.prototype.forEach.call(ctx.panel.children, function (opt) {
        var rid = opt.dataset.right;
        opt.classList.toggle('chosen', chosen === rid);
        var usedElsewhere = Object.keys(ans).some(function (k) { return ans[k] === rid && k !== ctx.left; });
        opt.classList.toggle('used', usedElsewhere);
      });
    });
  }

  /* --- order --- */
  function buildOrder(q) {
    if (!Array.isArray(state.answers[q.id]) || state.answers[q.id].length !== q.items.length) {
      state.answers[q.id] = Engine.buildOrderStart(testId, q);
      persist();
    }
    var wrap = el('div', 'order-list');
    wrap.setAttribute('role', 'list');
    renderOrder(wrap, q);
    return wrap;
  }

  function renderOrder(wrap, q, movedId) {
    wrap.innerHTML = '';
    var arr = state.answers[q.id];
    var map = {};
    q.items.forEach(function (i) { map[i.id] = i.text; });

    arr.forEach(function (id, i) {
      var row = el('div', 'order-item' + (movedId === id ? ' moved' : ''));
      row.setAttribute('role', 'listitem');
      row.appendChild(el('span', 'order-index', String(i + 1)));
      row.appendChild(el('span', 'order-text', map[id]));

      var btns = el('div', 'order-btns');
      var up = el('button', 'icon-btn', '↑');
      up.type = 'button';
      up.setAttribute('aria-label', 'Переместить выше: ' + map[id]);
      up.disabled = i === 0;
      up.addEventListener('click', function () { move(i, -1); });

      var down = el('button', 'icon-btn', '↓');
      down.type = 'button';
      down.setAttribute('aria-label', 'Переместить ниже: ' + map[id]);
      down.disabled = i === arr.length - 1;
      down.addEventListener('click', function () { move(i, 1); });

      btns.appendChild(up); btns.appendChild(down);
      row.appendChild(btns);
      wrap.appendChild(row);
    });

    function move(i, d) {
      var a = state.answers[q.id];
      var j = i + d;
      if (j < 0 || j >= a.length) return;
      var moved = a[i];
      a[i] = a[j]; a[j] = moved;
      state.answers[q.id] = a;
      persist();
      renderOrder(wrap, q, moved);
      var focusIdx = j;
      var rows = wrap.children;
      if (rows[focusIdx]) {
        var btn = rows[focusIdx].querySelectorAll('.icon-btn')[d < 0 ? 0 : 1];
        if (btn && !btn.disabled) btn.focus();
      }
      renderQuizChrome();
    }
  }

  /* --- открытый ответ --- */
  function buildText(q) {
    var wrap = el('div', 'answer-area');
    var ta = el('textarea', 'textarea');
    ta.id = 'answer-text';
    ta.maxLength = CFG.TEXT_MAX_LENGTH;
    ta.placeholder = q.hint || 'Ответьте своими словами';
    ta.setAttribute('aria-label', 'Ваш ответ');
    ta.value = typeof state.answers[q.id] === 'string' ? state.answers[q.id] : '';

    var counter = el('div', 'counter', ta.value.length + ' / ' + CFG.TEXT_MAX_LENGTH);
    ta.addEventListener('input', function () {
      state.answers[q.id] = ta.value;
      counter.textContent = ta.value.length + ' / ' + CFG.TEXT_MAX_LENGTH;
      persist();
    });
    ta.addEventListener('blur', function () { persist(); renderQuizChrome(); });

    wrap.appendChild(ta);
    wrap.appendChild(counter);
    return wrap;
  }

  /* --- показ вопроса с анимацией --- */
  function goTo(index, dir) {
    if (animating) return;
    index = Math.max(0, Math.min(questions.length - 1, index));
    var card = $('#question-card');
    var fast = reduced();

    var paint = function () {
      state.current = index;
      persist();
      buildQuestionCard();
      renderQuizChrome();
      card.classList.remove('anim-out');
      card.classList.remove('anim-in');
      void card.offsetWidth;
      if (!fast) card.classList.add('anim-in');
      animating = false;
      if (dir) window.scrollTo({ top: 0, behavior: fast ? 'auto' : 'smooth' });
    };

    if (fast || !dir) { paint(); return; }
    animating = true;
    card.classList.add('anim-out');
    setTimeout(paint, 150);
  }

  function startQuiz() {
    show('screen-quiz');
    goTo(state.current, 0);
  }

  /* ---------------- завершение ---------------- */

  function attemptFinish() {
    if (busy || state.finished) return;
    var left = questions.filter(function (q) { return Engine.isEmptyAnswer(q, state.answers[q.id]); });
    if (left.length) {
      openModal({
        title: 'Остались без ответа',
        text: 'Без ответа ' + left.length + ' ' + plural(left.length, 'вопрос', 'вопроса', 'вопросов') +
              '. Вернуться к ним или завершить тестирование сейчас?',
        ok: 'Завершить',
        cancel: 'Вернуться'
      }).then(function (ok) {
        if (ok) finish();
        else {
          var first = questions.indexOf(left[0]);
          goTo(first, 1);
        }
      });
      return;
    }
    finish();
  }

  function finish() {
    if (busy || state.finished) return;
    busy = true;
    $('#btn-next').disabled = true;

    state.finished = true;
    state.finishedAt = Date.now();
    state.result = Engine.score(testId, questions, state.answers);
    persist();

    renderResult();
    show('screen-result');
    busy = false;
    $('#btn-next').disabled = false;

    sendToTelegram(false);
  }

  /* ---------------- результат ---------------- */

  function renderResult() {
    var r = state.result;
    var C = 2 * Math.PI * 62;

    $('#result-name').textContent = state.name;
    $('#result-test').textContent = test.title;
    $('#result-fraction').textContent = r.correct + ' из ' + r.scoredTotal;
    $('#stat-correct').textContent = r.correct;
    $('#stat-wrong').textContent = r.incorrect + r.partial;
    $('#stat-percent').textContent = r.percent + '%';

    var manualBox = $('#stat-manual-box');
    if (r.manual > 0) {
      manualBox.hidden = false;
      $('#stat-manual').textContent = r.manual;
      $('.stats-grid').classList.add('has-manual');
    } else {
      manualBox.hidden = true;
      $('.stats-grid').classList.remove('has-manual');
    }

    var badge = $('#result-badge');
    badge.textContent = r.passed ? 'Тестирование пройдено' : 'Требуется дополнительная проработка материала';
    badge.className = 'status-badge ' + (r.passed ? 'pass' : 'fail');

    var ring = $('#ring-value');
    ring.style.strokeDasharray = C;
    ring.classList.toggle('pass', r.passed);
    ring.classList.toggle('fail', !r.passed);

    var pctNode = $('#result-percent');
    if (reduced()) {
      ring.style.strokeDashoffset = C * (1 - r.percent / 100);
      pctNode.textContent = r.percent + '%';
    } else {
      ring.style.strokeDashoffset = C;
      pctNode.textContent = '0%';
      requestAnimationFrame(function () {
        setTimeout(function () {
          ring.style.strokeDashoffset = C * (1 - r.percent / 100);
          countUp(pctNode, r.percent, 1300);
        }, 60);
      });
      if (r.passed && CFG.CONFETTI_ON_PASS) setTimeout(confetti, 550);
    }
  }

  function countUp(node, to, ms) {
    var t0 = performance.now();
    function step(t) {
      var p = Math.min(1, (t - t0) / ms);
      var eased = 1 - Math.pow(1 - p, 3);
      node.textContent = Math.round(to * eased) + '%';
      if (p < 1) requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
  }

  /* ---------------- конфетти ---------------- */

  function confetti() {
    var canvas = document.getElementById('confetti');
    var ctx = canvas.getContext('2d');
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    var W = canvas.width = window.innerWidth * dpr;
    var H = canvas.height = window.innerHeight * dpr;
    canvas.classList.add('on');

    var colors = ['#C9AEA2', '#B08A94', '#8E6F63', '#E3D2C8', '#3F7A63'];
    var parts = [];
    var n = window.innerWidth < 480 ? 70 : 120;
    for (var i = 0; i < n; i++) {
      parts.push({
        x: Math.random() * W,
        y: -Math.random() * H * 0.4,
        w: (5 + Math.random() * 6) * dpr,
        h: (8 + Math.random() * 8) * dpr,
        vy: (1.4 + Math.random() * 2.4) * dpr,
        vx: (Math.random() - 0.5) * 1.6 * dpr,
        rot: Math.random() * Math.PI,
        vr: (Math.random() - 0.5) * 0.18,
        c: colors[Math.floor(Math.random() * colors.length)]
      });
    }

    var start = performance.now();
    function frame(t) {
      var life = t - start;
      ctx.clearRect(0, 0, W, H);
      parts.forEach(function (p) {
        p.x += p.vx; p.y += p.vy; p.rot += p.vr;
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot);
        ctx.globalAlpha = Math.max(0, 1 - life / 4200);
        ctx.fillStyle = p.c;
        ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
        ctx.restore();
      });
      if (life < 4200) requestAnimationFrame(frame);
      else { ctx.clearRect(0, 0, W, H); canvas.classList.remove('on'); }
    }
    requestAnimationFrame(frame);
  }

  /* ---------------- TELEGRAM ---------------- */

  function openAnswers() {
    var out = [];
    questions.forEach(function (q, i) {
      if (q.input !== 'text') return;
      var a = state.answers[q.id];
      if (Engine.isEmptyAnswer(q, a)) return;
      out.push({ n: i + 1, question: q.question, answer: String(a).slice(0, 700), manual: !!q.manualReview });
    });
    return out;
  }

  function buildPayload() {
    var r = state.result;
    var duration = Math.round(((state.finishedAt || Date.now()) - state.startedAt) / 1000);
    var payload = {
      attemptId: state.attemptId,
      test: state.test,
      testName: test.title,
      studentName: state.name,
      score: r.percent,
      correct: r.correct,
      total: r.scoredTotal,
      questionsTotal: r.questionsTotal,
      errors: r.incorrect + r.partial,
      partial: r.partial,
      manual: r.manual,
      unanswered: r.unanswered,
      passed: r.passed,
      passPercent: r.passPercent,
      duration: duration,
      finishedAt: new Date(state.finishedAt || Date.now()).toISOString()
    };
    if (CFG.SEND_OPEN_ANSWERS_TO_TELEGRAM) payload.openAnswers = openAnswers();
    return payload;
  }

  function setSendUI(mode, text, showRetry) {
    var box = $('#send-status');
    box.hidden = false;
    box.className = 'send-status' + (mode ? ' ' + mode : '');
    $('#send-text').textContent = text;
    $('#btn-resend').hidden = !showRetry;
  }

  function sendToTelegram(isRetry) {
    if (!CFG.TELEGRAM_ENDPOINT) { $('#send-status').hidden = true; return; }
    if (state.sent) { setSendUI('ok', 'Результат отправлен преподавателю.', false); return; }

    setSendUI('', 'Отправляем результат…', false);

    var ctrl = null, timer = null;
    try { ctrl = new AbortController(); } catch (e) { ctrl = null; }
    if (ctrl) timer = setTimeout(function () { ctrl.abort(); }, CFG.TELEGRAM_TIMEOUT_MS || 12000);

    var headers = { 'Content-Type': 'application/json' };
    if (CFG.TELEGRAM_CLIENT_KEY) headers['X-Test-Key'] = CFG.TELEGRAM_CLIENT_KEY;

    fetch(CFG.TELEGRAM_ENDPOINT, {
      method: 'POST',
      headers: headers,
      body: JSON.stringify(buildPayload()),
      signal: ctrl ? ctrl.signal : undefined
    }).then(function (res) {
      if (timer) clearTimeout(timer);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      state.sent = true;
      state.sendError = null;
      persist();
      setSendUI('ok', 'Результат отправлен преподавателю.', false);
    }).catch(function (err) {
      if (timer) clearTimeout(timer);
      state.sendError = String(err && err.message || err);
      persist();
      setSendUI('error', 'Результат сохранён. Не удалось отправить уведомление. Попробуйте повторить отправку.', true);
    });
  }

  /* ---------------- разбор ---------------- */

  function renderReview() {
    var list = $('#review-list');
    list.innerHTML = '';
    var r = state.result;
    $('#review-sub').textContent = state.name + ' · ' + test.title + ' · ' + r.percent + '%';

    questions.forEach(function (q, i) {
      var a = state.answers[q.id];
      var res = Engine.evaluate(testId, q, a);
      var rev = Engine.reveal(testId, q);

      var cls = res.status === 'correct' ? 'ok'
        : res.status === 'partial' ? 'part'
        : res.status === 'manual' ? 'man' : 'bad';
      var label = res.status === 'correct' ? '✓ Правильно'
        : res.status === 'partial' ? '≈ Частично' + (res.matched != null ? ' (' + res.matched + '/' + res.of + ')' : '')
        : res.status === 'manual' ? '⏳ Требует проверки' : '✕ Ошибка';

      var item = el('div', 'review-item ' + cls);

      var top = el('div', 'review-top');
      top.appendChild(el('span', 'review-num', 'Вопрос ' + (i + 1)));
      top.appendChild(el('span', 'review-status ' + cls, label));
      item.appendChild(top);

      if (q.type === 'situation' && q.situation) {
        item.appendChild(el('p', 'review-q', q.question));
        item.appendChild(el('p', 'review-sit', q.situation));
      } else {
        item.appendChild(el('p', 'review-q', q.question));
      }

      var rows = el('div', 'review-rows');

      var ansRow = el('div', 'review-row answer');
      ansRow.appendChild(el('span', 'rl', 'Ваш ответ'));
      var userAns = Engine.formatAnswer(q, a);
      ansRow.appendChild(el('span', 'rv', userAns || '— нет ответа —'));
      rows.appendChild(ansRow);

      if (res.status !== 'manual' && rev.text) {
        var cRow = el('div', 'review-row correct');
        cRow.appendChild(el('span', 'rl', 'Правильный ответ'));
        cRow.appendChild(el('span', 'rv', rev.text));
        rows.appendChild(cRow);
      }
      if (res.status === 'manual' && rev.reference) {
        var refRow = el('div', 'review-row correct');
        refRow.appendChild(el('span', 'rl', 'Эталонный ответ'));
        refRow.appendChild(el('span', 'rv', rev.reference));
        rows.appendChild(refRow);
      }
      item.appendChild(rows);

      if (rev.explanation) item.appendChild(el('div', 'review-explain', rev.explanation));
      if (res.status === 'manual') {
        item.appendChild(el('div', 'review-explain', 'Ответ требует ручной проверки преподавателем и не влияет на автоматический процент.'));
      }

      list.appendChild(item);
    });
  }

  /* ---------------- защита от ухода ---------------- */

  function beforeUnload(e) {
    if (!CFG.WARN_ON_LEAVE) return;
    if (!state || state.finished) return;
    if ($('#screen-quiz').hidden) return;
    e.preventDefault();
    e.returnValue = '';
    return '';
  }

  /* ---------------- события ---------------- */

  function bind() {
    $('#name-form').addEventListener('submit', function (e) {
      e.preventDefault();
      var input = $('#student-name');
      var name = input.value.trim().replace(/\s+/g, ' ').slice(0, CFG.NAME_MAX_LENGTH);
      if (name.length < 2) {
        input.classList.add('invalid');
        $('#name-error').hidden = false;
        input.focus();
        return;
      }
      input.classList.remove('invalid');
      $('#name-error').hidden = true;
      newAttempt(name);
      startQuiz();
    });

    $('#student-name').addEventListener('input', function () {
      this.classList.remove('invalid');
      $('#name-error').hidden = true;
    });

    $('#btn-resume').addEventListener('click', function () {
      var saved = loadState(testId);
      if (!saved) { renderStart(); return; }
      state = saved;
      buildQuestionList();
      if (state.finished && state.result) { renderResult(); show('screen-result'); restoreSendUI(); }
      else startQuiz();
    });

    $('#btn-restart').addEventListener('click', function () {
      openModal({
        title: 'Начать заново?',
        text: 'Сохранённые ответы этого тестирования будут удалены.',
        ok: 'Начать заново', cancel: 'Отмена'
      }).then(function (ok) {
        if (!ok) return;
        removeStore(storageKey(testId));
        state = null;
        renderStart();
        $('#student-name').focus();
      });
    });

    $('#btn-prev').addEventListener('click', function () { goTo(state.current - 1, -1); });
    $('#btn-next').addEventListener('click', function () {
      if (state.current === questions.length - 1) attemptFinish();
      else goTo(state.current + 1, 1);
    });

    $('#btn-review').addEventListener('click', function () { renderReview(); show('screen-review'); });
    $('#btn-review-back').addEventListener('click', function () { show('screen-result'); });
    $('#btn-review-back2').addEventListener('click', function () { show('screen-result'); });
    $('#btn-done').addEventListener('click', function () { show('screen-bye'); });
    $('#btn-bye-back').addEventListener('click', function () { show('screen-result'); });
    $('#btn-resend').addEventListener('click', function () { sendToTelegram(true); });

    $('#btn-retake').addEventListener('click', function () {
      openModal({
        title: 'Пройти заново?',
        text: 'Текущий результат останется у преподавателя, но на этой странице будет заменён новой попыткой.',
        ok: 'Пройти заново', cancel: 'Отмена'
      }).then(function (ok) {
        if (!ok) return;
        removeStore(storageKey(testId));
        state = null;
        renderStart();
      });
    });

    $('#notfound-back').addEventListener('click', function () {
      window.location.href = window.location.pathname.replace(/[^/]*$/, '');
    });

    $('#modal-ok').addEventListener('click', function () { closeModal(true); });
    $('#modal-cancel').addEventListener('click', function () { closeModal(false); });
    $('#modal').addEventListener('click', function (e) { if (e.target === this) closeModal(false); });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && !$('#modal').hidden) closeModal(false);
    });

    window.addEventListener('beforeunload', beforeUnload);
    window.addEventListener('resize', function () {
      var c = document.getElementById('confetti');
      if (c.classList.contains('on')) { c.width = window.innerWidth; c.height = window.innerHeight; }
    });
  }

  function restoreSendUI() {
    if (!CFG.TELEGRAM_ENDPOINT) { $('#send-status').hidden = true; return; }
    if (state.sent) setSendUI('ok', 'Результат отправлен преподавателю.', false);
    else sendToTelegram(true);   // предыдущая отправка не удалась — пробуем ещё раз
  }

  /* ---------------- старт ---------------- */

  function init() {
    bind();
    testId = getCurrentTest();

    if (!testId) { show('screen-welcome'); return; }
    if (!Engine.has(testId)) { show('screen-notfound'); return; }

    test = Engine.get(testId);

    var saved = loadState(testId);
    if (saved && saved.finished && saved.result) {
      state = saved;
      buildQuestionList();
      renderResult();
      show('screen-result');
      restoreSendUI();
      return;
    }
    renderStart();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

})();
