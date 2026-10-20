/* =========================================================
 * 四级词汇训练营 —— 记忆循环引擎
 * 学习 → 测试 → 错题二次学习 → 艾宾浩斯间隔复习
 * ========================================================= */
(function () {
  'use strict';

  /* ---------------- 基础数据 ---------------- */
  // words.js（核心词，带例句）优先，words-cet4.js（完整词库）补充
  var RAW = (window.WORD_BANK || []).concat(window.WORD_BANK_CET4 || []);
  var WORDS = [];
  var MAP = {};
  var SEEN_WORD = {};
  RAW.forEach(function (r) {
    var w = (r[0] || '').trim();
    var key = w.toLowerCase();
    if (!w || SEEN_WORD[key]) return;
    SEEN_WORD[key] = 1;
    var item = {
      w: w, ph: r[1] || '', pos: r[2] || '', cn: r[3] || '',
      en: r[4] || '', cnEn: r[5] || ''
    };
    WORDS.push(item);
    MAP[w] = item;
  });

  var KEY = 'cet4_trainer_v1';
  var INTERVALS = [1, 2, 4, 7, 15, 30]; // 艾宾浩斯间隔（天）
  var MAX_STAGE = INTERVALS.length - 1;
  var DAY_MS = 86400000;

  /* ---------------- 工具 ---------------- */
  function $(s, r) { return (r || document).querySelector(s); }
  function $$(s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); }
  function pad(n) { return n < 10 ? '0' + n : '' + n; }
  function todayStr() {
    var d = new Date();
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }
  function parseDate(s) {
    var p = s.split('-');
    return new Date(+p[0], +p[1] - 1, +p[2]);
  }
  function addDays(s, n) {
    var d = parseDate(s);
    d.setDate(d.getDate() + n);
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }
  function diffDays(a, b) {
    return Math.round((parseDate(b) - parseDate(a)) / DAY_MS);
  }
  function shortDate(s) { return s.slice(5).replace('-', '/'); }
  function uniq(arr) {
    var seen = {};
    return arr.filter(function (x) { if (seen[x]) return false; seen[x] = 1; return true; });
  }
  function shuffle(arr) {
    var a = arr.slice();
    for (var i = a.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }
  function escHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function clamp(n, a, b) { return Math.max(a, Math.min(b, n)); }
  function fmtTime(ms) {
    var s = Math.round(ms / 1000);
    return Math.floor(s / 60) + ':' + pad(s % 60);
  }
  var toastTimer = null;
  function toast(msg) {
    var el = $('#toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.classList.remove('show'); }, 1900);
  }

  /* ---------------- 状态 ---------------- */
  function defaultState() {
    return {
      cfg: {
        days: 90,
        autoPerDay: true,
        perDay: 50,
        testMode: 'mix',
        showPhonetic: true,
        autoNext: true,
        autoSpeak: false,
        startDate: todayStr()
      },
      learned: [],
      recs: {},
      days: {},
      favorites: [],
      notes: {},
      wrong: [],
      sessions: []
    };
  }

  var state = defaultState();

  function load() {
    try {
      var raw = localStorage.getItem(KEY);
      if (!raw) return;
      var data = JSON.parse(raw);
      var base = defaultState();
      state = {
        cfg: Object.assign(base.cfg, data.cfg || {}),
        learned: Array.isArray(data.learned) ? data.learned.filter(function (w) { return !!MAP[w]; }) : [],
        recs: data.recs || {},
        days: data.days || {},
        favorites: Array.isArray(data.favorites) ? data.favorites : [],
        notes: data.notes || {},
        wrong: Array.isArray(data.wrong) ? data.wrong : [],
        sessions: Array.isArray(data.sessions) ? data.sessions : []
      };
      // 词库从 298 词扩展到 3800+ 后，给旧数据一个更合理的默认节奏
      if (!state.cfg._pace) {
        if (state.cfg.autoPerDay && WORDS.length > 1000 && state.learned.length < 80 && Math.ceil(WORDS.length / state.cfg.days) > 90) {
          state.cfg.days = 90;
          state.cfg.perDay = Math.ceil(WORDS.length / 90);
        }
        state.cfg._pace = 1;
        save();
      }
    } catch (e) {
      console.warn('读取本地数据失败，已重置', e);
      state = defaultState();
    }
  }
  function save() {
    try {
      localStorage.setItem(KEY, JSON.stringify(state));
    } catch (e) {
      toast('本地存储写入失败');
    }
  }

  function ensureDay(date) {
    var d = date || todayStr();
    if (!state.days[d]) {
      state.days[d] = {
        learned: [],
        reviewed: [],
        test: { total: 0, correct: 0 },
        targets: null
      };
    }
    var rec = state.days[d];
    if (!rec.learned) rec.learned = [];
    if (!rec.reviewed) rec.reviewed = [];
    if (!rec.test) rec.test = { total: 0, correct: 0 };
    if (!rec.targets) {
      var p = getPlan();
      rec.targets = { new: p.target, due: getDueWords().length };
      save();
    }
    return rec;
  }

  /* ---------------- 计划与调度 ---------------- */
  function getPerDay() {
    if (state.cfg.autoPerDay) {
      return Math.max(1, Math.ceil(WORDS.length / state.cfg.days));
    }
    return Math.max(1, state.cfg.perDay | 0);
  }

  function getPlan() {
    var total = WORDS.length;
    var per = getPerDay();
    var dayNo = Math.max(1, diffDays(state.cfg.startDate, todayStr()) + 1);
    var unlearned = WORDS.map(function (x) { return x.w; }).filter(function (w) { return !state.recs[w]; });
    // 截至昨天"本应完成"的词量，用于计算落后多少
    var planDone = Math.max(0, Math.min(dayNo - 1, state.cfg.days)) * per;
    var behind = Math.max(0, planDone - state.learned.length);
    var carry = Math.min(behind, per);
    var target = Math.min(unlearned.length, per + carry);
    var needDays = Math.ceil(unlearned.length / per) || 0;
    var dayRec = state.days[todayStr()];
    var learnedToday = dayRec && dayRec.learned ? dayRec.learned.length : 0;
    var targetToday = dayRec && dayRec.targets ? dayRec.targets.new : target;
    return {
      total: total, per: per, days: state.cfg.days, dayNo: dayNo,
      unlearned: unlearned, carry: carry, target: target,
      remainNew: Math.max(0, targetToday - learnedToday),
      todayWords: unlearned.slice(0, target),
      endDate: needDays ? addDays(todayStr(), needDays - 1) : todayStr()
    };
  }

  function getDueWords() {
    var t = todayStr();
    return state.learned.filter(function (w) {
      var r = state.recs[w];
      return r && r.next && r.next <= t;
    }).sort(function (a, b) {
      return (state.recs[a].next || '').localeCompare(state.recs[b].next || '');
    });
  }

  function isWrong(w) {
    return state.wrong.some(function (x) { return x.w === w; });
  }
  function addWrong(w, reason) {
    var rec = state.wrong.filter(function (x) { return x.w === w; })[0];
    if (rec) { rec.count++; rec.at = todayStr(); }
    else state.wrong.push({ w: w, count: 1, at: todayStr(), reason: reason || 'test' });
  }
  function removeWrong(w) {
    state.wrong = state.wrong.filter(function (x) { return x.w !== w; });
  }

  /* 评级：ok=true 前进一阶，false 回到第一阶段 */
  function applyGrade(word, ok, source) {
    var t = todayStr();
    var d = ensureDay();
    var r = state.recs[word];
    var first = !r;

    if (first) {
      r = state.recs[word] = {
        stage: 0, next: t, correct: 0, wrong: 0,
        learned: t, graded: '', seen: 0
      };
      if (state.learned.indexOf(word) < 0) state.learned.push(word);
      if (d.learned.indexOf(word) < 0) d.learned.push(word);
    }

    r.seen = (r.seen || 0) + 1;
    var sameDay = r.graded === t;

    if (ok) {
      r.correct++;
      if (!first && !sameDay) r.stage = Math.min(MAX_STAGE, r.stage + 1);
      r.next = addDays(t, INTERVALS[Math.min(r.stage, MAX_STAGE)]);
      removeWrong(word);
      if (!first && d.reviewed.indexOf(word) < 0) d.reviewed.push(word);
    } else {
      r.wrong++;
      if (!first) r.stage = 0;
      r.next = addDays(t, 1);
      addWrong(word, source || 'test');
      if (d.learned.indexOf(word) < 0 && first) d.learned.push(word);
    }
    r.graded = t;
    save();
    return r;
  }

  function nextText(dateStr) {
    if (!dateStr) return '明天';
    var t = todayStr();
    if (dateStr <= t) return '今天（待复习）';
    if (dateStr === addDays(t, 1)) return '明天';
    if (dateStr === addDays(t, 2)) return '后天';
    var p = dateStr.split('-');
    return (+p[1]) + '月' + (+p[2]) + '日';
  }

  function computeStreak() {
    var d = todayStr();
    var has = function (k) {
      var r = state.days[k];
      return r && ((r.learned && r.learned.length) || (r.test && r.test.total));
    };
    if (!has(d)) d = addDays(d, -1);
    var n = 0;
    while (has(d) && n < 3650) { n++; d = addDays(d, -1); }
    return n;
  }

  /* ---------------- 视图切换 ---------------- */
  var VIEW_META = {
    dashboard: { t: '学习概览', s: '每天一点，循环到记住为止' },
    learn: { t: '单词学习', s: '先回忆，再翻卡，主动回忆记得更牢' },
    test: { t: '今日测试', s: '当日新词 + 历史复习词，即时判分' },
    review: { t: '复习计划', s: '艾宾浩斯间隔曲线自动排期' },
    notebook: { t: '收藏与笔记', s: '你的私人词本与错题本' },
    stats: { t: '数据统计', s: '看见进步，才有动力坚持' },
    settings: { t: '学习设置', s: '调整周期、题型与数据' }
  };
  var currentView = 'dashboard';

  function go(view) {
    currentView = view;
    var meta = VIEW_META[view];
    $('#viewTitle').textContent = meta.t;
    $('#viewSub').textContent = meta.s;
    $$('.nav-item').forEach(function (b) {
      b.classList.toggle('active', b.getAttribute('data-view') === view);
    });
    $$('.view').forEach(function (v) {
      v.classList.toggle('active', v.id === 'view-' + view);
    });
    renderView(view);
    renderTopbar();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function renderView(view) {
    if (view === 'dashboard') renderDashboard();
    else if (view === 'learn') renderLearnIntro();
    else if (view === 'test') renderTestIntro();
    else if (view === 'review') renderReview();
    else if (view === 'notebook') renderNotebook();
    else if (view === 'stats') renderStats();
    else if (view === 'settings') renderSettings();
  }

  /* ---------------- 顶栏 / 侧栏 ---------------- */
  function renderTopbar() {
    var due = getDueWords().length;
    var chip = $('#chipDue');
    chip.classList.toggle('alert', due > 0);
    $('#chipDueText').textContent = '待复习 ' + due;
    var d = new Date();
    var wd = ['日', '一', '二', '三', '四', '五', '六'][d.getDay()];
    $('#chipDate').textContent = (d.getMonth() + 1) + '月' + d.getDate() + '日 · 周' + wd;

    var plan = getPlan();
    var pct = Math.round(state.learned.length / plan.total * 100);
    $('#sideStreak').textContent = computeStreak();
    $('#sideFlame').classList.toggle('on', computeStreak() > 0);
    $('#sidePlanPct').textContent = pct + '%';
    $('#sidePlanBar').style.width = pct + '%';

    $('#badgeLearn').textContent = plan.remainNew ? plan.remainNew : '';
    $('#badgeReview').textContent = due ? due : '';
    $('#badgeTest').textContent = '';
  }

  /* ---------------- 概览 ---------------- */
  function renderDashboard() {
    var plan = getPlan();
    var due = getDueWords();
    var d = state.days[todayStr()] || { learned: [], reviewed: [], test: { total: 0, correct: 0 }, targets: null };
    var learnedToday = (d.learned || []).length;
    var target = plan.target;

    var targets = d.targets || { new: target, due: due.length };
    var doneNew = Math.min(learnedToday, targets.new || target);
    var doneRev = Math.min((d.reviewed || []).length, targets.due || 0);
    var denom = (targets.new || target) + (targets.due || 0);
    var pct = denom ? Math.round((doneNew + doneRev) / denom * 100) : 0;
    pct = clamp(pct, 0, 100);

    $('#heroDay').textContent = 'DAY ' + plan.dayNo + ' / ' + plan.days;
    $('#heroPhase').textContent = plan.dayNo >= plan.days
      ? '冲刺阶段 · 全面复习'
      : (learnedToday >= target ? '今日任务已完成 · 保持复习' : '第 ' + Math.min(plan.days, Math.ceil(plan.dayNo / (plan.days / 4)) || 1) + ' 阶段 · 新词输入');

    var remainNew = plan.remainNew;
    if (remainNew === 0 && due.length === 0) {
      $('#heroTitle').innerHTML = '今日任务已全部完成 🎉';
      $('#heroDesc').textContent = '所有单词都学完了，继续保持间隔复习即可。';
    } else {
      $('#heroTitle').innerHTML = '今天还有 <b>' + remainNew + '</b> 个新词和 <b>' + due.length + '</b> 个复习词';
      var desc = plan.carry > 0
        ? '已落后计划 ' + plan.carry + ' 词，今日已自动加入补学内容，加油追上。'
        : '系统已按你的 ' + plan.days + ' 天计划分配好今日词汇，学完立刻测试巩固。';
      if (plan.per > 80) desc += '（每天 ' + plan.per + ' 词强度偏高，可在设置里延长周期）';
      $('#heroDesc').textContent = desc;
    }

    $('#heroNew').textContent = remainNew;
    $('#heroDue').textContent = due.length;
    $('#heroDone').textContent = learnedToday;
    $('#heroRingPct').textContent = pct + '%';
    var C = 2 * Math.PI * 52;
    $('#heroRing').style.strokeDashoffset = C * (1 - pct / 100);
    $('#heroBarMobile').style.width = pct + '%';

    var totalTest = state.sessions.filter(function (s) { return s.type === 'test'; });
    var tTotal = 0, tCorrect = 0;
    state.sessions.forEach(function (s) { if (s.type === 'test') { tTotal += s.n; tCorrect += s.correct; } });
    var mastered = state.learned.filter(function (w) { return state.recs[w] && state.recs[w].stage >= MAX_STAGE; }).length;

    $('#statLearned').textContent = state.learned.length;
    $('#statAcc').textContent = tTotal ? Math.round(tCorrect / tTotal * 100) + '%' : '—';
    $('#statAccSub').textContent = tTotal ? '累计 ' + tTotal + ' 题' : '暂无测试';
    $('#statMastery').textContent = state.learned.length ? Math.round(mastered / state.learned.length * 100) + '%' : '0%';
    $('#statMasterySub').textContent = '已掌握 ' + mastered + ' 词';
    $('#statWrong').textContent = state.wrong.length;

    // 今日复习提醒
    var list = due.slice(0, 5);
    var box = $('#dueList');
    if (!list.length) {
      box.innerHTML = '<div class="empty"><div class="e-ico">🫧</div><div>今天没有到期复习的单词</div><div>去学几个新词，明天它们就会出现在这里</div></div>';
    } else {
      box.innerHTML = list.map(function (w) {
        var r = state.recs[w];
        var late = diffDays(r.next, todayStr());
        return '<div class="due-item">' +
          '<div class="due-word">' + w + '</div>' +
          '<div class="due-cn">' + MAP[w].cn + '</div>' +
          '<span class="due-stage' + (late > 0 ? ' due-over' : '') + '">' +
          (late > 0 ? '逾期 ' + late + ' 天' : '今日到期') + '</span>' +
          '</div>';
      }).join('');
    }

    // 近 7 日
    var week = [];
    for (var i = 6; i >= 0; i--) {
      var key = addDays(todayStr(), -i);
      var rec = state.days[key];
      week.push({ label: shortDate(key), value: rec ? (rec.learned || []).length : 0 });
    }
    var weekTotal = week.reduce(function (a, b) { return a + b.value; }, 0);
    $('#weekTotal').textContent = '共 ' + weekTotal + ' 词';
    $('#miniWeekChart').innerHTML = weekTotal
      ? barSVG(week, { height: 150, target: plan.per, labelEvery: 1, thin: true })
      : '<div class="empty" style="height:150px"><div class="e-ico">🌱</div><div>还没有学习记录</div><div>完成第一组单词后，这里会出现你的学习曲线</div></div>';
  }

  /* ---------------- 学习 ---------------- */
  var learn = null;

  function renderLearnIntro() {
    var plan = getPlan();
    var due = getDueWords();
    $('#learnIntroTitle').textContent = plan.remainNew
      ? '今天还要学 ' + plan.remainNew + ' 个新词'
      : (plan.unlearned.length ? '今日新词已完成' : '今日没有新词任务');
    $('#learnIntroDesc').textContent = plan.remainNew
      ? '建议先看单词回忆意思，翻卡后立刻自评。认不出的词会进入复习队列，明天再次出现。'
      : (plan.unlearned.length
        ? '今天的计划量已经完成，可以继续学习下一批新词，也可以先做测试和复习巩固。'
        : '所有单词都已学过，建议做一组复习测试巩固记忆，或去收藏本中挑词重学。');
    $('#learnNewCount').textContent = plan.remainNew;
    $('#learnReviewCount').textContent = due.length;
    $('#learnCarryCount').textContent = plan.carry;
  }

  function startLearn(extra) {
    var wantNew = $('#optNew').checked;
    var wantRev = $('#optReview').checked;
    var plan = getPlan();
    var words = [];
    var cap = plan.remainNew > 0 ? plan.remainNew : plan.per;
    if (wantNew && (plan.remainNew > 0 || extra)) words = words.concat(plan.todayWords.slice(0, cap));
    if (wantRev) words = words.concat(getDueWords());
    words = uniq(words);
    if (!words.length) {
      toast(plan.remainNew === 0 && !getDueWords().length
        ? '今日任务已完成，想加练可以点「再学一轮」'
        : '今天没有待学习的单词，试试复习或测试');
      return;
    }
    startLearnWith(words, 'daily');
  }

  function startLearnWith(words, mode) {
    var list = uniq(words.filter(function (w) { return !!MAP[w]; }));
    if (!list.length) { toast('没有可学习的单词'); return; }
    learn = {
      words: list, idx: 0, flipped: false,
      known: 0, weak: [], start: Date.now(), mode: mode || 'daily'
    };
    go('learn');
    $('#learnIntro').classList.add('hidden');
    $('#learnDone').classList.add('hidden');
    $('#learnSession').classList.remove('hidden');
    renderCard();
  }

  function currentWord() { return learn ? learn.words[learn.idx] : null; }

  function renderCard() {
    var w = currentWord();
    if (!w) return;
    var item = MAP[w];
    var rec = state.recs[w];
    var isNew = !rec;
    var due = rec && rec.next <= todayStr();

    learn.flipped = false;
    $('#flashcard').classList.remove('flipped');
    $('#fcWord').textContent = item.w;
    $('#fcWordBack').textContent = item.w;
    $('#fcPhonetic').textContent = state.cfg.showPhonetic ? '/' + item.ph + '/' : '';
    $('#fcPos').textContent = item.pos;
    $('#fcMeaning').textContent = item.cn;
    var exBox = $('#fcExampleBox');
    if (item.en || item.cnEn) {
      exBox.style.display = '';
      exBox.innerHTML = '<p>' + escHtml(item.en) + '</p><p class="ex-cn">' + escHtml(item.cnEn) + '</p>';
    } else {
      exBox.style.display = '';
      exBox.innerHTML = '<p class="ex-empty">这个词还没有例句，试试用下面的笔记写下你的联想或搭配 ✍️</p>';
    }
    $('#fcTag').textContent = learn.mode === 'retry' ? '错题重练' : (isNew ? '新词' : '复习');
    $('#fcTag').className = 'fc-tag' + (isNew ? '' : ' tag-alt');
    $('#fcTagBack').textContent = isNew ? '释义' : '复习检查';
    var stage = rec ? rec.stage : 0;
    var dots = '';
    for (var si = 0; si <= MAX_STAGE; si++) {
      dots += '<i class="' + (rec && si <= stage ? 'on' : '') + '"></i>';
    }
    $('#fcMeta').innerHTML = '<span class="stage-dots">' + dots + '</span>' +
      '<span>' + (rec ? '记忆阶段 ' + (stage + 1) + ' / ' + (MAX_STAGE + 1) : '新词 · 尚未进入记忆曲线') + '</span>';
    $('#fcStage').textContent = rec
      ? '下次复习 ' + nextText(rec.next) + ' · 累计答对 ' + rec.correct + ' 次'
      : '下次复习：明天（首次复习）';
    $('#fcNoteInput').value = state.notes[w] || '';
    var favOn = state.favorites.indexOf(w) >= 0;
    $('#btnFav').textContent = favOn ? '★' : '☆';
    $('#btnFav').style.color = favOn ? '#f0a500' : '';

    $('#learnIdx').textContent = learn.idx + 1;
    $('#learnTotal').textContent = learn.words.length;
    $('#learnProgress').style.width = (learn.idx / learn.words.length * 100) + '%';
    $('#learnMode').textContent = learn.mode === 'retry' ? '错题二次学习'
      : (isNew ? '新词学习' : '间隔复习');
    $('#btnFlip').innerHTML = '显示释义 <kbd>空格</kbd>';

    if (state.cfg.autoSpeak) speak(item.w);
    $('#fcNoteInput').blur();
  }

  function flipCard() {
    if (!learn) return;
    learn.flipped = !learn.flipped;
    $('#flashcard').classList.toggle('flipped', learn.flipped);
    if (learn.flipped) $('#btnFlip').innerHTML = '返回正面 <kbd>空格</kbd>';
    else $('#btnFlip').innerHTML = '显示释义 <kbd>空格</kbd>';
  }

  function gradeLearn(known) {
    if (!learn) return;
    if (!learn.flipped) { flipCard(); return; }
    var w = currentWord();
    applyGrade(w, known, 'learn');
    if (known) learn.known++;
    else learn.weak.push(w);
    nextCard();
  }

  function nextCard() {
    learn.idx++;
    if (learn.idx >= learn.words.length) { finishLearn(); return; }
    renderCard();
  }

  function finishLearn() {
    var total = learn.words.length;
    var done = Math.min(learn.idx, total);
    $('#learnSession').classList.add('hidden');
    $('#learnDone').classList.remove('hidden');
    $('#doneKnown').textContent = learn.known;
    $('#doneWeak').textContent = learn.weak.length;
    $('#doneTime').textContent = fmtTime(Date.now() - learn.start);
    var isRetry = learn.mode === 'retry';
    $('#learnDoneDesc').textContent = isRetry
      ? '错词已重新过了一遍，接下来只测这些词，直到全部答对。'
      : '本轮学习了 ' + done + ' 个词，趁热打铁做一次测试，把短期记忆变成长期记忆。';
    $('#btnGoTest').textContent = isRetry ? '测试这些错词' : '开始今日测试';
    $('#btnLearnAgain').textContent = isRetry ? '再学一遍错词' : '再学一轮';
    state.sessions.push({ d: todayStr(), type: 'learn', n: done, correct: learn.known });
    save();
    renderTopbar();
  }

  /* ---------------- 测试 ---------------- */
  var quiz = null;

  function buildPool(onlyWrong) {
    if (onlyWrong) {
      return state.wrong.map(function (x) { return x.w; }).filter(function (w) { return !!MAP[w]; });
    }
    var t = todayStr();
    var d = state.days[t];
    var pool = [];
    if (d && d.learned) pool = pool.concat(d.learned);
    pool = pool.concat(getDueWords());
    if (pool.length < 4) pool = pool.concat(state.learned.slice(-20));
    return uniq(pool);
  }

  function renderTestIntro() {
    var pool = buildPool(false);
    var due = getDueWords().length;
    var d = state.days[todayStr()];
    var todayNew = d ? (d.learned || []).length : 0;
    $('#testPoolCount').textContent = pool.length;
    $('#testTodayNew').textContent = todayNew;
    $('#testDueCount').textContent = due;
    $('#testIntroTitle').textContent = state.wrong.length && $('#optWrongOnly').checked
      ? '错题专项测试'
      : '今日测试';
    $('#testIntroDesc').textContent = pool.length
      ? '测试范围：今日新学单词 + 艾宾浩斯到期的复习词，共 ' + pool.length + ' 个词可选。'
      : '还没有可测试的单词，先去学习几个新词吧。';

    var radios = $$('input[name="testMode"]');
    radios.forEach(function (r) { r.checked = r.value === state.cfg.testMode; });
  }

  function pickType(mode, i) {
    if (mode === 'choice') return 'choice';
    if (mode === 'fill') return 'fill';
    return Math.random() < 0.55 ? 'choice' : 'fill';
  }

  function buildQuestion(word, type) {
    var item = MAP[word];
    if (type === 'fill') {
      return { word: word, type: 'fill', dir: 'zh2en' };
    }
    var dir = Math.random() < 0.58 ? 'en2zh' : 'zh2en';
    var pool = WORDS.filter(function (x) {
      return x.w !== word && (dir === 'en2zh' ? x.cn !== item.cn : x.w !== word);
    });
    var samePos = shuffle(pool.filter(function (x) { return x.pos === item.pos; }));
    var others = shuffle(pool.filter(function (x) { return x.pos !== item.pos; }));
    var cands = samePos.concat(others);
    var opts = [];
    var seen = {};
    seen[dir === 'en2zh' ? item.cn : item.w] = 1;
    for (var i = 0; i < cands.length && opts.length < 3; i++) {
      var key = dir === 'en2zh' ? cands[i].cn : cands[i].w;
      if (seen[key]) continue;
      seen[key] = 1;
      opts.push({ text: key, ok: false });
    }
    opts.push({ text: dir === 'en2zh' ? item.cn : item.w, ok: true });
    opts = shuffle(opts);
    return { word: word, type: 'choice', dir: dir, options: opts };
  }

  function startQuiz(words, opts) {
    opts = opts || {};
    var list = uniq(words.filter(function (w) { return !!MAP[w]; }));
    if (!list.length) { toast('没有可测试的单词'); return; }
    list = shuffle(list);
    var count = opts.count && opts.count > 0 ? Math.min(opts.count, list.length) : list.length;
    list = list.slice(0, count);

    quiz = {
      items: list.map(function (w, i) { return buildQuestion(w, pickType(opts.mode || state.cfg.testMode, i)); }),
      idx: 0, correct: 0, wrong: [], answered: false,
      retry: !!opts.retry, start: Date.now(), mode: opts.mode || state.cfg.testMode
    };
    go('test');
    $('#testIntro').classList.add('hidden');
    $('#testResult').classList.add('hidden');
    $('#testQuiz').classList.remove('hidden');
    renderQuiz();
  }

  function renderQuiz() {
    var it = quiz.items[quiz.idx];
    var item = MAP[it.word];
    var phonetic = state.cfg.showPhonetic ? '/' + item.ph + '/' : '';
    quiz.answered = false;

    $('#quizIdx').textContent = quiz.idx + 1;
    $('#quizTotal').textContent = quiz.items.length;
    $('#quizScore').textContent = quiz.correct;
    $('#quizProgress').style.width = (quiz.idx / quiz.items.length * 100) + '%';
    $('#quizFeedback').classList.add('hidden');
    $('#btnNextQ').disabled = true;
    $('#btnNextQ').textContent = quiz.idx === quiz.items.length - 1 ? '查看结果' : '下一题';
    $('#quizType').textContent = it.type === 'fill' ? '填空题' : (it.dir === 'en2zh' ? '英译中 · 选择' : '中译英 · 选择');

    var optsBox = $('#quizOptions');
    var fillBox = $('#quizFill');

    if (it.type === 'fill') {
      optsBox.innerHTML = '';
      optsBox.classList.add('hidden');
      fillBox.classList.remove('hidden');
      $('#quizPrompt').textContent = '根据中文释义拼写单词';
      $('#quizWord').textContent = item.cn;
      $('#quizWord').className = 'quiz-word cn';
      $('#quizPhonetic').textContent = state.cfg.showPhonetic ? item.pos + ' · 共 ' + item.w.length + ' 个字母' : '';
      $('#fillHint').textContent = fillHint(item.w);
      var fi = $('#fillInput');
      fi.value = '';
      fi.disabled = false;
      setTimeout(function () { fi.focus(); }, 60);
      $('#quizTip').textContent = '回车提交 · 不区分大小写';
    } else {
      fillBox.classList.add('hidden');
      optsBox.classList.remove('hidden');
      $('#quizPrompt').textContent = it.dir === 'en2zh' ? '选择正确的中文释义' : '选择对应的英文单词';
      $('#quizWord').textContent = it.dir === 'en2zh' ? item.w : item.cn;
      $('#quizWord').className = 'quiz-word' + (it.dir === 'en2zh' ? '' : ' cn');
      $('#quizPhonetic').textContent = it.dir === 'en2zh' ? phonetic : item.pos;
      optsBox.innerHTML = it.options.map(function (o, i) {
        return '<button class="opt" data-i="' + i + '">' +
          '<span class="opt-key">' + 'ABCD'[i] + '</span><span>' + o.text + '</span></button>';
      }).join('');
      $$('.opt', optsBox).forEach(function (b) {
        b.addEventListener('click', function () { answerChoice(+b.getAttribute('data-i')); });
      });
      $('#quizTip').textContent = '按键 1-4 快速作答';
    }
  }

  function fillHint(word) {
    return word.split('').map(function (c, i) {
      if (i === 0) return c;
      return /[a-zA-Z]/.test(c) ? '_' : c;
    }).join(' ');
  }

  function answerChoice(i) {
    if (!quiz || quiz.answered) return;
    var it = quiz.items[quiz.idx];
    var chosen = it.options[i];
    $$('.opt').forEach(function (b, k) {
      b.disabled = true;
      if (it.options[k].ok) b.classList.add('correct');
      else if (k === i) b.classList.add('wrong');
    });
    resolveAnswer(!!chosen.ok, chosen.text);
  }

  function answerFill() {
    if (!quiz || quiz.answered) return;
    var it = quiz.items[quiz.idx];
    var val = $('#fillInput').value.trim().toLowerCase();
    if (!val) { toast('请先输入答案'); return; }
    var ok = val === it.word.toLowerCase();
    $('#fillInput').disabled = true;
    var fb = $('#quizFeedback');
    fb.innerHTML = (ok ? '✅ 拼写正确' : '❌ 正确拼写是 <b>' + it.word + '</b>') +
      '<span class="fb-ex">' + it.word + ' ' + (state.cfg.showPhonetic ? '/' + MAP[it.word].ph + '/ ' : '') +
      MAP[it.word].pos + ' ' + MAP[it.word].cn + '</span>';
    fb.className = 'quiz-feedback ' + (ok ? 'ok' : 'no');
    fb.classList.remove('hidden');
    resolveAnswer(ok, val);
  }

  function resolveAnswer(ok, given) {
    var it = quiz.items[quiz.idx];
    quiz.answered = true;

    var d = ensureDay();
    d.test.total++;
    if (ok) {
      d.test.correct++;
      quiz.correct++;
    } else {
      quiz.wrong.push(it.word);
      addWrong(it.word, 'test');
    }
    applyGrade(it.word, ok, 'test');
    save();

    $('#quizScore').textContent = quiz.correct;

    if (it.type === 'choice') {
      var fb = $('#quizFeedback');
      var meta = MAP[it.word];
      fb.innerHTML = (ok ? '✅ 答对了' : '❌ 答错了') +
        '<span class="fb-ex">' + it.word + ' ' + meta.pos + ' ' + meta.cn +
        (meta.en ? ' — ' + meta.en : '') + '</span>';
      fb.className = 'quiz-feedback ' + (ok ? 'ok' : 'no');
      fb.classList.remove('hidden');
    }

    $('#btnNextQ').disabled = false;
    $('#quizTip').textContent = ok ? '已加入记忆曲线，下次复习间隔延长' : '已加入错题本，稍后二次学习';

    if (ok && state.cfg.autoNext) {
      var myIdx = quiz.idx;
      setTimeout(function () {
        if (quiz && quiz.idx === myIdx && quiz.answered) nextQuestion();
      }, 800);
    }
  }

  function nextQuestion() {
    if (!quiz) return;
    if (quiz.idx >= quiz.items.length - 1) { finishQuiz(); return; }
    quiz.idx++;
    renderQuiz();
  }

  function finishQuiz() {
    var total = quiz.items.length;
    var acc = total ? quiz.correct / total : 0;
    var pct = Math.round(acc * 100);

    state.sessions.push({ d: todayStr(), type: 'test', n: total, correct: quiz.correct });
    save();

    $('#testQuiz').classList.add('hidden');
    $('#testResult').classList.remove('hidden');

    var C = 2 * Math.PI * 52;
    var ring = $('#resultRing');
    ring.style.strokeDasharray = C;
    ring.style.strokeDashoffset = C * (1 - acc);
    ring.style.stroke = acc >= 0.9 ? 'var(--green)' : acc >= 0.65 ? 'var(--amber)' : 'var(--rose)';
    $('#resultPct').textContent = pct + '%';

    $('#resultTitle').textContent = quiz.retry
      ? (quiz.wrong.length ? '还有 ' + quiz.wrong.length + ' 个词没拿下' : '错词全部攻克 🎉')
      : (pct >= 90 ? '记忆力很棒，继续保持' : pct >= 70 ? '基础不错，再巩固一下' : '别急，错词会带你进步');
    $('#resultDesc').textContent = '共 ' + total + ' 题，答对 ' + quiz.correct + ' 题，答错 ' + (total - quiz.correct) + ' 题。';
    $('#resultTags').innerHTML =
      '<span class="tag">用时 ' + fmtTime(Date.now() - quiz.start) + '</span>' +
      '<span class="tag tag-alt">正确率 ' + pct + '%</span>' +
      '<span class="tag ' + (quiz.wrong.length ? 'tag-danger' : 'tag-alt') + '">错题 ' + quiz.wrong.length + '</span>';

    var wrongBox = $('#resultWrong');
    if (!quiz.wrong.length) {
      wrongBox.innerHTML = '<div class="empty" style="padding:14px"><div>本组全部答对，这些词的下次复习间隔已延长。</div></div>';
    } else {
      wrongBox.innerHTML = quiz.wrong.map(function (w) {
        return '<div class="wrong-item"><b>' + w + '</b><span>' + MAP[w].cn + '</span><em>待重练</em></div>';
      }).join('');
    }

    var btnSecond = $('#btnSecondLearn');
    var btnRetest = $('#btnRetestWrong');
    btnSecond.classList.toggle('hidden', !quiz.wrong.length);
    btnRetest.classList.toggle('hidden', !quiz.wrong.length);
    btnSecond.textContent = quiz.wrong.length ? '错题二次学习' : '再测一组';
    btnRetest.textContent = '只测错题';

    renderTopbar();
  }

  /* ---------------- 复习页 ---------------- */
  function renderReview() {
    var due = getDueWords();
    var future = [];
    for (var i = 0; i < 7; i++) {
      var d = addDays(todayStr(), i);
      var n = state.learned.filter(function (w) {
        var r = state.recs[w];
        if (!r) return false;
        if (i === 0) return r.next <= d;
        return r.next === d;
      }).length;
      future.push({ label: i === 0 ? '今天' : shortDate(d), value: n });
    }
    var weekTotal = state.learned.filter(function (w) {
      var r = state.recs[w];
      return r && r.next <= addDays(todayStr(), 6);
    }).length;
    var mastered = state.learned.filter(function (w) { return state.recs[w].stage >= MAX_STAGE; }).length;

    $('#revDue').textContent = due.length;
    $('#revWeek').textContent = weekTotal;
    $('#revMastered').textContent = mastered;
    $('#revListSub').textContent = '共 ' + due.length + ' 个词待复习，按逾期天数排序';

    $('#ebbinghausChart').innerHTML = ebbinghausSVG();
    $('#futureChart').innerHTML = barSVG(future, { height: 180, labelEvery: 1, target: 0 });

    renderRevList(due, '');
    $('#revSearch').oninput = function () { renderRevList(getDueWords(), this.value); };
  }

  function renderRevList(due, kw) {
    var list = due.filter(function (w) {
      if (!kw) return true;
      var k = kw.toLowerCase();
      return w.toLowerCase().indexOf(k) >= 0 || MAP[w].cn.indexOf(kw) >= 0;
    });
    var box = $('#revList');
    if (!list.length) {
      box.innerHTML = '<div class="empty" style="grid-column:1/-1"><div class="e-ico">🌿</div><div>没有符合条件的待复习单词</div></div>';
      return;
    }
    box.innerHTML = list.map(function (w) {
      var r = state.recs[w];
      var late = diffDays(r.next, todayStr());
      return '<div class="rev-item">' +
        '<div class="rv-main"><b>' + w + '</b><span>' + MAP[w].cn + '</span></div>' +
        '<span class="rv-days' + (late > 0 ? ' late' : '') + '">' +
        (late > 0 ? '逾期' + late + '天' : '今日') + '</span>' +
        '</div>';
    }).join('');
  }

  /* ---------------- 收藏 / 笔记 ---------------- */
  var nbTab = 'fav';
  function renderNotebook() {
    $('#favCount').textContent = state.favorites.length;
    $('#noteCount').textContent = Object.keys(state.notes).filter(function (k) { return state.notes[k]; }).length;
    $('#wrongCount').textContent = state.wrong.length;
    $$('#nbTabs .tab').forEach(function (t) { t.classList.toggle('active', t.getAttribute('data-tab') === nbTab); });
    renderNbList($('#nbSearch').value);
    $('#nbSearch').oninput = function () { renderNbList(this.value); };
  }

  function renderNbList(kw) {
    var list = [];
    if (nbTab === 'fav') list = state.favorites.slice();
    else if (nbTab === 'note') list = Object.keys(state.notes).filter(function (k) { return !!state.notes[k]; });
    else list = state.wrong.map(function (x) { return x.w; });

    if (kw) {
      var k = kw.toLowerCase();
      list = list.filter(function (w) {
        return MAP[w] && (w.toLowerCase().indexOf(k) >= 0 || MAP[w].cn.indexOf(kw) >= 0);
      });
    }
    var box = $('#nbList');
    if (!list.length) {
      var tips = {
        fav: ['⭐', '还没有收藏的单词', '学习时点击卡片右上角的星标即可收藏'],
        note: ['📝', '还没有添加笔记', '在卡片背面输入你的记忆方法或联想，之后随时回看'],
        wrong: ['❌', '错题本是空的', '测试中答错的单词会自动归类到这里']
      }[nbTab];
      box.innerHTML = '<div class="empty" style="grid-column:1/-1"><div class="e-ico">' + tips[0] + '</div><div>' + tips[1] + '</div><div>' + tips[2] + '</div></div>';
      return;
    }

    box.innerHTML = list.map(function (w) {
      var it = MAP[w];
      var r = state.recs[w];
      var fav = state.favorites.indexOf(w) >= 0;
      var wrec = state.wrong.filter(function (x) { return x.w === w; })[0];
      return '<div class="nb-card">' +
        '<div class="nb-head"><div><b>' + it.w + '</b><div class="ph">/' + it.ph + '/ ' + it.pos + '</div></div>' +
        '<button class="nb-star' + (fav ? ' on' : '') + '" data-fav="' + w + '">' + (fav ? '★' : '☆') + '</button></div>' +
        '<div class="nb-cn">' + it.cn + '</div>' +
        (it.en ? '<div class="nb-ex">' + it.en + '</div>' : '') +
        '<div class="nb-note-box"><input type="text" data-note="' + w + '" placeholder="添加笔记…" value="' +
        (state.notes[w] || '').replace(/"/g, '&quot;') + '" /><button class="btn btn-mini" data-savenote="' + w + '">保存</button></div>' +
        '<div class="nb-foot">' +
        '<span class="mini-tag">' + (r ? '阶段 ' + (r.stage + 1) + '/6' : '未学习') + '</span>' +
        (wrec ? '<span class="mini-tag" style="background:var(--rose-soft);color:var(--rose)">错 ' + wrec.count + ' 次</span>' : '') +
        '<span class="spacer"></span>' +
        '<button class="link-btn" data-study="' + w + '">单独学习</button>' +
        '</div></div>';
    }).join('');

    $$('[data-fav]', box).forEach(function (b) {
      b.onclick = function () {
        var w = b.getAttribute('data-fav');
        var i = state.favorites.indexOf(w);
        if (i >= 0) state.favorites.splice(i, 1); else state.favorites.push(w);
        save();
        renderNbList($('#nbSearch').value);
        renderNotebook();
        toast(i >= 0 ? '已取消收藏' : '已收藏');
      };
    });
    $$('[data-savenote]', box).forEach(function (b) {
      b.onclick = function () {
        var w = b.getAttribute('data-savenote');
        var input = $('[data-note="' + w + '"]', box);
        var v = input.value.trim();
        if (v) state.notes[w] = v; else delete state.notes[w];
        save();
        renderNotebook();
        toast('笔记已保存');
      };
    });
    $$('[data-study]', box).forEach(function (b) {
      b.onclick = function () { startLearnWith([b.getAttribute('data-study')], 'single'); };
    });
  }

  /* ---------------- 统计 ---------------- */
  var statsRange = 14;
  function renderStats() {
    var mastered = state.learned.filter(function (w) { return state.recs[w] && state.recs[w].stage >= MAX_STAGE; }).length;
    var tTotal = 0, tCorrect = 0;
    state.sessions.forEach(function (s) { if (s.type === 'test') { tTotal += s.n; tCorrect += s.correct; } });

    $('#sLearned').textContent = state.learned.length;
    $('#sLearnedSub').textContent = '共 ' + WORDS.length + ' 词 · 计划进度 ' + Math.round(state.learned.length / WORDS.length * 100) + '%';
    $('#sAcc').textContent = tTotal ? Math.round(tCorrect / tTotal * 100) + '%' : '—';
    $('#sAccSub').textContent = tCorrect + ' / ' + tTotal + ' 题';
    $('#sMastery').textContent = state.learned.length ? Math.round(mastered / state.learned.length * 100) + '%' : '0%';
    $('#sMasterySub').textContent = '掌握 ' + mastered + ' 词';
    $('#sStreak').textContent = computeStreak();

    // 每日完成量
    var days = [];
    for (var i = statsRange - 1; i >= 0; i--) {
      var key = addDays(todayStr(), -i);
      var rec = state.days[key];
      days.push({
        label: shortDate(key),
        value: rec ? (rec.learned || []).length : 0,
        key: key
      });
    }
    var every = statsRange > 14 ? 5 : 2;
    $('#dailyChart').innerHTML = barSVG(days, {
      height: 220, target: getPerDay(), labelEvery: every, width: 1000
    });

    // 正确率
    var accData = [];
    for (var j = statsRange - 1; j >= 0; j--) {
      var k2 = addDays(todayStr(), -j);
      var rr = state.days[k2];
      accData.push({
        label: shortDate(k2),
        value: rr && rr.test && rr.test.total ? rr.test.correct / rr.test.total : null,
        key: k2
      });
    }
    $('#accChart').innerHTML = lineSVG(accData, { height: 200, width: 520 });

    // 阶段分布
    var counts = [0, 0, 0, 0, 0, 0];
    state.learned.forEach(function (w) {
      var r = state.recs[w];
      counts[clamp(r.stage | 0, 0, MAX_STAGE)]++;
    });
    var maxC = Math.max.apply(null, counts.concat([1]));
    var labels = ['刚学会', '1天', '2天', '4天', '7天', '15天+'];
    $('#stageChart').innerHTML = counts.map(function (c, idx) {
      return '<div class="bar-row"><span class="bar-label">' + labels[idx] + '</span>' +
        '<span class="bar-track"><i style="width:' + (c ? (c / maxC * 100).toFixed(1) : 0) + '%;background:' +
        ['#c7c2ff', '#a99fff', '#8b7ffb', '#7161f5', '#5c4bf0', '#4f46e5'][idx] + '"></i></span>' +
        '<b class="bar-num">' + c + '</b></div>';
    }).join('') || '<div class="empty">暂无数据</div>';

    // 热力图：最近 12 周
    var today = parseDate(todayStr());
    var dow = (today.getDay() + 6) % 7; // 周一=0
    var start = new Date(today.getTime() - (dow + 7 * 11) * DAY_MS);
    var hm = '';
    for (var c = 0; c < 12; c++) {
      hm += '<div class="hm-col">';
      for (var r2 = 0; r2 < 7; r2++) {
        var dt = new Date(start.getTime() + (c * 7 + r2) * DAY_MS);
        var kk = dt.getFullYear() + '-' + pad(dt.getMonth() + 1) + '-' + pad(dt.getDate());
        var nn = state.days[kk] ? (state.days[kk].learned || []).length : 0;
        var lv = nn === 0 ? 0 : nn <= 3 ? 1 : nn <= 6 ? 2 : nn <= 9 ? 3 : 4;
        hm += '<div class="hm-cell" data-l="' + lv + '" title="' + kk + ' · ' + nn + ' 词"></div>';
      }
      hm += '</div>';
    }
    $('#heatmap').innerHTML = hm +
      '</div><div class="hm-legend">少 <span class="hm-cell"></span><span class="hm-cell" data-l="1"></span>' +
      '<span class="hm-cell" data-l="2"></span><span class="hm-cell" data-l="3"></span>' +
      '<span class="hm-cell" data-l="4"></span> 多</div>';

    // 明细表
    var rows = '';
    for (var m = 0; m < 14; m++) {
      var dk = addDays(todayStr(), -m);
      var rec2 = state.days[dk];
      var ln = rec2 ? (rec2.learned || []).length : 0;
      var tt = rec2 && rec2.test ? rec2.test.total : 0;
      var tc = rec2 && rec2.test ? rec2.test.correct : 0;
      var ac = tt ? Math.round(tc / tt * 100) : null;
      var cls = ac === null ? '' : ac >= 80 ? 'ok' : ac >= 60 ? 'mid' : 'bad';
      rows += '<tr><td>' + dk + (dk === todayStr() ? ' <span class="mini-tag">今天</span>' : '') + '</td>' +
        '<td><b>' + ln + '</b></td><td>' + tt + '</td><td>' + tc + '</td>' +
        '<td class="' + cls + '">' + (ac === null ? '—' : ac + '%') + '</td>' +
        '<td>' + (ln || tt ? '<span class="tag tag-alt">已学习</span>' : '<span class="tag">未学习</span>') + '</td></tr>';
    }
    $('#dailyTable').querySelector('tbody').innerHTML = rows;

    $$('#rangeSeg button').forEach(function (b) {
      b.classList.toggle('active', +b.getAttribute('data-range') === statsRange);
      b.onclick = function () { statsRange = +b.getAttribute('data-range'); renderStats(); };
    });
  }

  /* ---------------- 设置 ---------------- */
  function renderSettings() {
    var c = state.cfg;
    var sel = $('#setDays');
    var has = false;
    for (var i = 0; i < sel.options.length; i++) {
      if (sel.options[i].value === String(c.days)) { has = true; break; }
    }
    if (!has) {
      var op = document.createElement('option');
      op.value = String(c.days);
      op.textContent = c.days + ' 天';
      sel.appendChild(op);
    }
    sel.value = String(c.days);
    $('#setAuto').value = c.autoPerDay ? '1' : '0';
    $('#setPerDay').value = c.autoPerDay ? getPerDay() : c.perDay;
    $('#setPerDay').disabled = !!c.autoPerDay;
    $('#setTestMode').value = c.testMode;
    $('#setPhonetic').checked = !!c.showPhonetic;
    $('#setAutoNext').checked = !!c.autoNext;
    $('#setAutoSpeak').checked = !!c.autoSpeak;

    var per = getPerDay();
    var plan = getPlan();
    $('#planPreview').innerHTML =
      '词库总量 <b>' + WORDS.length + '</b> 词，每日 <b>' + per + '</b> 词<br>' +
      '计划周期 <b>' + c.days + '</b> 天（开始于 ' + c.startDate + '，今天第 <b>' + plan.dayNo + '</b> 天）<br>' +
      '按当前进度预计 <b>' + (plan.unlearned.length ? Math.ceil(plan.unlearned.length / per) : 0) + '</b> 天后学完';

    $('#aboutGrid').innerHTML =
      '<div class="about-item"><span>词库总量</span><b>' + WORDS.length + ' 词</b></div>' +
      '<div class="about-item"><span>已学习</span><b>' + state.learned.length + ' 词</b></div>' +
      '<div class="about-item"><span>已掌握</span><b>' + state.learned.filter(function (w) { return state.recs[w].stage >= MAX_STAGE; }).length + ' 词</b></div>' +
      '<div class="about-item"><span>复习算法</span><b>1/2/4/7/15/30 天</b></div>' +
      '<div class="about-item"><span>收藏 / 笔记</span><b>' + state.favorites.length + ' / ' + Object.keys(state.notes).filter(function (k) { return state.notes[k]; }).length + '</b></div>' +
      '<div class="about-item"><span>数据存储</span><b>本地浏览器</b></div>';
  }

  /* =========================================================
   * 图表（纯 SVG 手绘，无外部依赖）
   * ========================================================= */
  var uid = 0;
  function barSVG(data, opts) {
    opts = opts || {};
    var W = opts.width || 680;
    var H = opts.height || 160;
    var padL = 26, padR = 8, padT = 14, padB = 24;
    var plotW = W - padL - padR;
    var plotH = H - padT - padB;
    var maxV = Math.max.apply(null, data.map(function (d) { return d.value; }).concat([1, opts.target || 0]));
    var n = data.length || 1;
    var step = plotW / n;
    var bw = Math.min(opts.thin ? 20 : 34, step * 0.5);
    var id = 'bg' + (++uid);
    var s = '<svg viewBox="0 0 ' + W + ' ' + H + '">';
    s += '<defs><linearGradient id="' + id + '" x1="0" y1="0" x2="0" y2="1">' +
      '<stop offset="0%" stop-color="#7c6cf7"/><stop offset="100%" stop-color="#b7aefc"/></linearGradient></defs>';

    for (var g = 0; g <= 3; g++) {
      var y = padT + plotH - (plotH * g / 3);
      s += '<line class="grid-line" x1="' + padL + '" y1="' + y + '" x2="' + (W - padR) + '" y2="' + y + '"/>';
    }

    data.forEach(function (d, i) {
      var h = d.value / maxV * plotH;
      var x = padL + step * i + step / 2 - bw / 2;
      var y2 = padT + plotH - Math.max(h, d.value ? 2 : 0);
      if (d.value > 0) {
        s += '<rect x="' + x.toFixed(1) + '" y="' + y2.toFixed(1) + '" width="' + bw.toFixed(1) +
          '" height="' + Math.max(h, 2).toFixed(1) + '" rx="' + Math.min(5, bw / 2) + '" fill="url(#' + id + ')"/>';
      } else {
        s += '<rect x="' + x.toFixed(1) + '" y="' + (padT + plotH - 2) + '" width="' + bw.toFixed(1) +
          '" height="2" rx="1" fill="#eceff7"/>';
      }
      if (i % (opts.labelEvery || 1) === 0) {
        s += '<text class="axis-text" x="' + (padL + step * i + step / 2).toFixed(1) + '" y="' + (H - 7) +
          '" text-anchor="middle">' + d.label + '</text>';
      }
    });

    if (opts.target) {
      var ty = padT + plotH - opts.target / maxV * plotH;
      s += '<line class="dash-line" x1="' + padL + '" y1="' + ty.toFixed(1) + '" x2="' + (W - padR) + '" y2="' + ty.toFixed(1) + '"/>';
    }
    s += '<line class="axis-line" x1="' + padL + '" y1="' + (padT + plotH) + '" x2="' + (W - padR) + '" y2="' + (padT + plotH) + '"/>';
    s += '</svg>';
    return s;
  }

  function lineSVG(data, opts) {
    opts = opts || {};
    var W = opts.width || 520, H = opts.height || 200;
    var padL = 30, padR = 10, padT = 14, padB = 26;
    var plotW = W - padL - padR, plotH = H - padT - padB;
    var pts = [];
    data.forEach(function (d, i) {
      if (d.value === null) return;
      var x = padL + (data.length <= 1 ? plotW / 2 : plotW * i / (data.length - 1));
      var y = padT + plotH - clamp(d.value, 0, 1) * plotH;
      pts.push({ x: x, y: y, d: d });
    });
    var s = '<svg viewBox="0 0 ' + W + ' ' + H + '">';
    for (var g = 0; g <= 4; g++) {
      var y = padT + plotH - plotH * g / 4;
      s += '<line class="grid-line" x1="' + padL + '" y1="' + y + '" x2="' + (W - padR) + '" y2="' + y + '"/>';
      s += '<text class="axis-text" x="' + (padL - 6) + '" y="' + (y + 3) + '" text-anchor="end">' + (g * 25) + '%</text>';
    }
    if (pts.length > 1) {
      var line = pts.map(function (p, i) { return (i ? 'L' : 'M') + p.x.toFixed(1) + ' ' + p.y.toFixed(1); }).join(' ');
      var area = line + ' L' + pts[pts.length - 1].x.toFixed(1) + ' ' + (padT + plotH) +
        ' L' + pts[0].x.toFixed(1) + ' ' + (padT + plotH) + ' Z';
      s += '<path d="' + area + '" fill="rgba(109,94,252,.10)"/>';
      s += '<path d="' + line + '" fill="none" stroke="#6d5efc" stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round"/>';
    }
    pts.forEach(function (p) {
      s += '<circle cx="' + p.x.toFixed(1) + '" cy="' + p.y.toFixed(1) + '" r="3.6" fill="#fff" stroke="#6d5efc" stroke-width="2.2"/>';
    });
    if (!pts.length) {
      s += '<text x="' + (W / 2) + '" y="' + (H / 2) + '" text-anchor="middle" class="axis-text">还没有测试数据</text>';
    }
    data.forEach(function (d, i) {
      if (i % (data.length > 16 ? 4 : 2) !== 0) return;
      var x = padL + (data.length <= 1 ? plotW / 2 : plotW * i / (data.length - 1));
      s += '<text class="axis-text" x="' + x.toFixed(1) + '" y="' + (H - 8) + '" text-anchor="middle">' + d.label + '</text>';
    });
    s += '</svg>';
    return s;
  }

  function ebbinghausSVG() {
    var W = 680, H = 190, padL = 42, padR = 16, padT = 16, padB = 40;
    var plotW = W - padL - padR, plotH = H - padT - padB;
    var markers = [0, 1, 2, 4, 7, 15, 30, 60];
    var labels = ['学习', '1天', '2天', '4天', '7天', '15天', '30天', '60天'];
    var segW = plotW / (markers.length - 1);
    var xOf = function (i) { return padL + segW * i; };
    var yOf = function (ret) { return padT + plotH - ret * plotH; };
    var s = '<svg viewBox="0 0 ' + W + ' ' + H + '">';

    for (var g = 0; g <= 4; g++) {
      var y = padT + plotH - plotH * g / 4;
      s += '<line class="grid-line" x1="' + padL + '" y1="' + y + '" x2="' + (W - padR) + '" y2="' + y + '"/>';
      s += '<text class="axis-text" x="' + (padL - 8) + '" y="' + (y + 3) + '" text-anchor="end">' + (g * 25) + '%</text>';
    }

    // 每两个复习节点之间画一段遗忘衰减，复习时曲线回升
    var pts = [];
    for (var i = 0; i < markers.length - 1; i++) {
      var steps = 14;
      for (var k = 0; k <= steps; k++) {
        var ratio = k / steps;
        var ret = 1 - 0.54 * Math.pow(ratio, 0.75);
        pts.push([xOf(i) + segW * ratio, yOf(ret)]);
      }
    }
    var path = pts.map(function (p, idx) { return (idx ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1); }).join(' ');
    var area = path + ' L' + xOf(markers.length - 1).toFixed(1) + ' ' + yOf(0) + ' L' + padL + ' ' + yOf(0) + ' Z';
    s += '<path d="' + area + '" fill="rgba(109,94,252,.07)"/>';
    s += '<path d="' + path + '" fill="none" stroke="#6d5efc" stroke-width="2.4" stroke-linejoin="round"/>';

    markers.forEach(function (m, i) {
      var x = xOf(i);
      s += '<line x1="' + x.toFixed(1) + '" y1="' + padT + '" x2="' + x.toFixed(1) + '" y2="' + (padT + plotH) +
        '" stroke="#ece9ff" stroke-width="1" stroke-dasharray="3 3"/>';
      s += '<circle cx="' + x.toFixed(1) + '" cy="' + yOf(1) + '" r="3.2" fill="#fff" stroke="#6d5efc" stroke-width="2"/>';
      s += '<text class="axis-text" x="' + x.toFixed(1) + '" y="' + (H - 18) + '" text-anchor="middle">' + labels[i] + '</text>';
    });
    s += '<text class="axis-text" x="' + padL + '" y="' + (H - 4) + '">每次复习后遗忘曲线被重置，间隔逐次拉长，最终进入长期记忆</text>';
    s += '</svg>';
    return s;
  }

  /* ---------------- 交互绑定 ---------------- */
  function bind() {
    $$('.nav-item').forEach(function (b) {
      b.addEventListener('click', function () { go(b.getAttribute('data-view')); });
    });
    $$('[data-goto]').forEach(function (b) {
      b.addEventListener('click', function () { go(b.getAttribute('data-goto')); });
    });

    $('#heroStartLearn').onclick = function () { go('learn'); startLearn(); };
    $('#heroStartTest').onclick = function () {
      if (!state.learned.length) { toast('先去学习几个单词吧'); go('learn'); return; }
      go('test');
      var pool = buildPool(false);
      startQuiz(pool, { count: pool.length > 20 ? 20 : pool.length });
    };
    $('#btnQuick').onclick = function () {
      var plan = getPlan();
      if (plan.target) { go('learn'); startLearn(); }
      else if (getDueWords().length) go('review');
      else go('test');
    };

    // 学习
    $('#btnStartLearn').onclick = function () { startLearn(); };
    $('#btnExitLearn').onclick = function () {
      if (learn && learn.idx > 0) {
        state.sessions.push({ d: todayStr(), type: 'learn', n: learn.idx, correct: learn.known });
        save();
      }
      learn = null;
      $('#learnSession').classList.add('hidden');
      $('#learnDone').classList.add('hidden');
      $('#learnIntro').classList.remove('hidden');
      renderLearnIntro();
      renderTopbar();
    };
    $('#flashcard').onclick = function (e) {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'BUTTON') return;
      flipCard();
    };
    $('#btnFlip').onclick = flipCard;
    $('#btnKnown').onclick = function () { gradeLearn(true); };
    $('#btnUnknown').onclick = function () { gradeLearn(false); };
    $('#btnSpeak').onclick = function (e) {
      e.stopPropagation();
      speak(currentWord());
    };
    $('#btnSpeak2').onclick = function (e) {
      e.stopPropagation();
      speak(currentWord());
    };
    $('#btnFav').onclick = function (e) {
      e.stopPropagation();
      var w = currentWord();
      var i = state.favorites.indexOf(w);
      if (i >= 0) state.favorites.splice(i, 1); else state.favorites.push(w);
      save();
      $('#btnFav').textContent = i >= 0 ? '☆' : '★';
      $('#btnFav').style.color = i >= 0 ? '' : '#f0a500';
      toast(i >= 0 ? '已取消收藏' : '已收藏 ' + w);
    };
    $('#btnSaveNote').onclick = function (e) {
      e.stopPropagation();
      var w = currentWord();
      var v = $('#fcNoteInput').value.trim();
      if (v) state.notes[w] = v; else delete state.notes[w];
      save();
      toast(v ? '笔记已保存' : '笔记已清空');
    };
    $('#fcNoteInput').addEventListener('click', function (e) { e.stopPropagation(); });
    $('#btnGoTest').onclick = function () {
      if (learn && learn.mode === 'retry') {
        startQuiz(learn.words, { retry: true, mode: state.cfg.testMode, count: learn.words.length });
      } else {
        var pool = buildPool(false);
        startQuiz(pool, { count: pool.length > 20 ? 20 : pool.length });
      }
    };
    $('#btnLearnAgain').onclick = function () {
      if (learn && learn.mode === 'retry') startLearnWith(learn.words, 'retry');
      else startLearn(true);
    };

    // 测试
    $('#btnStartTest').onclick = function () {
      var modeEl = $('input[name="testMode"]:checked');
      var mode = modeEl ? modeEl.value : 'mix';
      var onlyWrong = $('#optWrongOnly').checked;
      var pool = buildPool(onlyWrong);
      if (!pool.length) {
        toast(onlyWrong ? '错题本还是空的' : '还没有可测试的单词，先去学习吧');
        return;
      }
      startQuiz(pool, { mode: mode, count: +$('#testCount').value, retry: onlyWrong });
    };
    $('#optWrongOnly').onchange = function () { renderTestIntro(); };
    $$('input[name="testMode"]').forEach(function (r) {
      r.onchange = function () { state.cfg.testMode = r.value; save(); };
    });
    $('#btnFillSubmit').onclick = answerFill;
    $('#fillInput').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); if (quiz && quiz.answered) nextQuestion(); else answerFill(); }
    });
    $('#btnNextQ').onclick = nextQuestion;
    $('#btnExitQuiz').onclick = function () {
      if (quiz && quiz.idx > 0) {
        state.sessions.push({ d: todayStr(), type: 'test', n: quiz.idx, correct: quiz.correct });
        save();
      }
      quiz = null;
      $('#testQuiz').classList.add('hidden');
      $('#testResult').classList.add('hidden');
      $('#testIntro').classList.remove('hidden');
      renderTestIntro();
      renderTopbar();
    };
    $('#btnSecondLearn').onclick = function () {
      if (!quiz) return;
      if (quiz.wrong.length) startLearnWith(quiz.wrong.slice(), 'retry');
      else {
        var pool = buildPool(false);
        startQuiz(pool, { count: pool.length > 20 ? 20 : pool.length });
      }
    };
    $('#btnRetestWrong').onclick = function () {
      if (!quiz) return;
      startQuiz(quiz.wrong.slice(), { retry: true, mode: state.cfg.testMode, count: quiz.wrong.length });
    };
    $('#btnBackDash').onclick = function () {
      quiz = null;
      $('#testResult').classList.add('hidden');
      $('#testIntro').classList.remove('hidden');
      go('dashboard');
    };

    // 复习
    $('#btnReviewNow').onclick = function () {
      var due = getDueWords();
      if (!due.length) { toast('目前没有到期的复习词'); return; }
      startQuiz(due, { count: due.length, mode: state.cfg.testMode });
    };

    // 笔记
    $$('#nbTabs .tab').forEach(function (t) {
      t.onclick = function () {
        nbTab = t.getAttribute('data-tab');
        renderNotebook();
      };
    });
    $('#btnStudyNb').onclick = function () {
      var kw = $('#nbSearch').value;
      var list = [];
      if (nbTab === 'fav') list = state.favorites.slice();
      else if (nbTab === 'note') list = Object.keys(state.notes).filter(function (k) { return !!state.notes[k]; });
      else list = state.wrong.map(function (x) { return x.w; });
      if (kw) {
        var k = kw.toLowerCase();
        list = list.filter(function (w) {
          return MAP[w] && (w.toLowerCase().indexOf(k) >= 0 || MAP[w].cn.indexOf(kw) >= 0);
        });
      }
      if (!list.length) { toast('列表为空'); return; }
      startLearnWith(list, 'retry');
    };

    // 设置
    $('#setAuto').onchange = function () {
      $('#setPerDay').disabled = this.value === '1';
    };
    $('#btnSavePlan').onclick = function () {
      var days = +$('#setDays').value;
      var auto = $('#setAuto').value === '1';
      var per = +$('#setPerDay').value;
      if (!auto && (!per || per < 3)) { toast('每日词量至少 3 个'); return; }
      state.cfg.days = days;
      state.cfg.autoPerDay = auto;
      state.cfg.perDay = auto ? Math.ceil(WORDS.length / days) : per;
      // 目标变了，重置今日目标（保留已学）
      var d = ensureDay();
      d.targets = { new: getPlan().target, due: getDueWords().length };
      save();
      renderSettings();
      renderTopbar();
      toast('计划已更新：每天 ' + getPerDay() + ' 词');
    };
    $('#setTestMode').onchange = function () { state.cfg.testMode = this.value; save(); toast('默认题型已更新'); };
    $('#setPhonetic').onchange = function () { state.cfg.showPhonetic = this.checked; save(); };
    $('#setAutoNext').onchange = function () { state.cfg.autoNext = this.checked; save(); };
    $('#setAutoSpeak').onchange = function () { state.cfg.autoSpeak = this.checked; save(); };

    $('#btnExport').onclick = function () {
      var blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'cet4-progress-' + todayStr() + '.json';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      toast('已导出学习数据');
    };
    $('#importFile').onchange = function (e) {
      var f = e.target.files[0];
      if (!f) return;
      var fr = new FileReader();
      fr.onload = function () {
        try {
          var data = JSON.parse(fr.result);
          if (!data.cfg || !data.recs) throw new Error('格式不符');
          localStorage.setItem(KEY, JSON.stringify(data));
          load();
          renderTopbar();
          renderView(currentView);
          toast('数据导入成功');
        } catch (err) {
          toast('导入失败：文件格式不正确');
        }
      };
      fr.readAsText(f);
    };
    $('#btnReset').onclick = function () {
      if (!confirm('确定要清空全部学习进度吗？此操作不可撤销，建议先导出备份。')) return;
      localStorage.removeItem(KEY);
      state = defaultState();
      save();
      learn = null; quiz = null;
      $('#learnSession').classList.add('hidden');
      $('#learnDone').classList.add('hidden');
      $('#learnIntro').classList.remove('hidden');
      $('#testQuiz').classList.add('hidden');
      $('#testResult').classList.add('hidden');
      $('#testIntro').classList.remove('hidden');
      renderTopbar();
      renderView(currentView);
      toast('已重置全部进度');
    };

    // 快捷键
    document.addEventListener('keydown', function (e) {
      var tag = (e.target.tagName || '').toLowerCase();
      var typing = tag === 'input' || tag === 'textarea' || tag === 'select';
      if (currentView === 'learn' && learn && !$('#learnSession').classList.contains('hidden')) {
        if (typing) return;
        if (e.code === 'Space') { e.preventDefault(); flipCard(); }
        else if (e.key === '1') { e.preventDefault(); gradeLearn(false); }
        else if (e.key === '2') { e.preventDefault(); gradeLearn(true); }
      }
      if (currentView === 'test' && quiz && !$('#testQuiz').classList.contains('hidden')) {
        if (typing) return;
        if (/^[1-4]$/.test(e.key) && !quiz.answered) {
          var it = quiz.items[quiz.idx];
          if (it.type === 'choice') { e.preventDefault(); answerChoice(+e.key - 1); }
        } else if (e.key === 'Enter' && quiz.answered) {
          e.preventDefault(); nextQuestion();
        }
      }
    });
  }

  function speak(text) {
    if (!text) return;
    if (!('speechSynthesis' in window)) { toast('当前浏览器不支持朗读'); return; }
    try {
      var u = new SpeechSynthesisUtterance(text);
      u.lang = 'en-US';
      u.rate = 0.92;
      window.speechSynthesis.cancel();
      window.speechSynthesis.speak(u);
    } catch (e) { /* ignore */ }
  }

  /* ---------------- 启动 ---------------- */
  function init() {
    if (!WORDS.length) {
      document.body.innerHTML = '<div style="padding:40px;font-family:sans-serif">词库加载失败，请确认 words.js 与 index.html 在同一目录。</div>';
      return;
    }
    load();
    ensureDay();
    bind();
    renderTopbar();
    renderView('dashboard');
    // 进入时提示待复习
    var due = getDueWords().length;
    if (due > 0) {
      setTimeout(function () {
        toast('有 ' + due + ' 个单词到了复习时间');
      }, 700);
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
