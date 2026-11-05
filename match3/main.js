'use strict';

// ===== 配置 =====
const N = 8;                 // 棋盘边长
const MAX_TYPES = 6;
const MIN_TYPES = 3;
const DEFAULT_EMOJI = ['🍎', '🍇', '🍋', '🍏', '🫐', '🍊'];
const SWAP_MS = 160;
const REMOVE_MS = 220;
const FALL_BASE_MS = 120;
const FALL_PER_ROW_MS = 45;
const HINT_DELAY_MS = 5000;
const BEST_KEY = 'match3-best';
const TIME_LIMIT_MS = 60000;
const COMBO_BONUS_FROM = 3;      // 第几次连锁开始加时
const COMBO_BONUS_MS = 2000;     // 每次加时

// ===== DOM =====
const $ = (id) => document.getElementById(id);
const boardEl = $('game-board');
const overlayEl = $('overlay');
const scoreEl = $('score');
const bestEl = $('best');
const movesEl = $('moves');
const uploadEl = $('image-upload');
const previewsEl = $('previews');
const msgEl = $('setup-msg');
const startBtn = $('start-game');
const muteBtn = $('mute');
const baseAudio = $('remove-audio');
const timerStat = $('timer-stat');
const timerEl = $('timer');
const overlayContent = $('overlay-content');

// ===== 状态 =====
let uploadedUrls = [];       // 上传图片的 objectURL
let faces = [];              // 当前游戏使用的方块外观（图片 URL 或 emoji）
let useImages = false;
let grid = [];               // grid[r][c] = { type, el } | null
let mode = 'endless';         // 'endless' | 'timed'
let score = 0, moves = 0, best = loadBest(mode);
let bestAtStart = 0;
let busy = false;            // 动画进行中时锁定输入
let selected = null;         // { r, c }
let muted = false;
let hintTimer = 0;
let hintTiles = [];
let playing = false;
let gameId = 0;              // 每开一局 +1，用来让上一局残留的异步流程自动作废
// 限时模式
let timeLeft = 0;
let timerId = 0;
let lastTick = 0;
let timeUp = false;
let gameOver = false;

bestEl.textContent = best;

// ===== 工具 =====
const wait = (ms) => new Promise((res) => setTimeout(res, ms));
const inBounds = (r, c) => r >= 0 && r < N && c >= 0 && c < N;
const typeAt = (r, c) => (inBounds(r, c) && grid[r][c] ? grid[r][c].type : -1);

// 两种模式的最高分分开记；无尽模式兼容旧版本存的 key
function loadBest(m) {
    try {
        const v = localStorage.getItem(`${BEST_KEY}-${m}`) ?? (m === 'endless' ? localStorage.getItem(BEST_KEY) : null);
        return parseInt(v, 10) || 0;
    } catch { return 0; }
}
function saveBest() {
    try { localStorage.setItem(`${BEST_KEY}-${mode}`, String(best)); } catch { /* 忽略 */ }
}

function setMsg(text, isError = false) {
    msgEl.textContent = text;
    msgEl.classList.toggle('error', isError);
}

// ===== 图片上传 =====
uploadEl.addEventListener('change', () => {
    uploadedUrls.forEach((u) => URL.revokeObjectURL(u));
    const files = Array.from(uploadEl.files).filter((f) => f.type.startsWith('image/'));
    if (files.length > MAX_TYPES) setMsg(`最多使用 ${MAX_TYPES} 张，已取前 ${MAX_TYPES} 张`);
    uploadedUrls = files.slice(0, MAX_TYPES).map((f) => URL.createObjectURL(f));

    previewsEl.innerHTML = '';
    uploadedUrls.forEach((u) => {
        const img = document.createElement('img');
        img.src = u;
        img.alt = '';
        previewsEl.appendChild(img);
    });

    if (uploadedUrls.length === 0) setMsg('不上传图片也可以，直接用默认水果开始');
    else if (uploadedUrls.length < MIN_TYPES) setMsg(`还差 ${MIN_TYPES - uploadedUrls.length} 张（至少 ${MIN_TYPES} 张）`, true);
    else if (files.length <= MAX_TYPES) setMsg(`已选择 ${uploadedUrls.length} 张图片，图片越少越容易连消`);
});

startBtn.addEventListener('click', () => {
    if (uploadedUrls.length > 0 && uploadedUrls.length < MIN_TYPES) {
        setMsg(`请至少选择 ${MIN_TYPES} 张图片（当前 ${uploadedUrls.length} 张）`, true);
        return;
    }
    useImages = uploadedUrls.length >= MIN_TYPES;
    faces = useImages ? uploadedUrls.slice() : DEFAULT_EMOJI.slice();
    mode = document.querySelector('input[name="mode"]:checked').value;
    startGame();
});

// 切换模式时同步显示对应模式的最高分（不影响正在进行的局）
document.querySelectorAll('input[name="mode"]').forEach((el) => el.addEventListener('change', () => {
    if (!playing) bestEl.textContent = loadBest(el.value);
}));

overlayEl.addEventListener('click', (e) => {
    if (e.target.closest('[data-action="replay"]')) startGame();
});

muteBtn.addEventListener('click', () => {
    muted = !muted;
    muteBtn.textContent = muted ? '🔇' : '🔊';
});

// ===== 游戏流程 =====
function startGame() {
    gameId++;
    stopTimer();
    clearHint();
    score = 0;
    moves = 0;
    busy = false;
    selected = null;
    timeUp = false;
    gameOver = false;
    best = loadBest(mode);
    bestAtStart = best;
    bestEl.textContent = best;
    updateStats();
    generateBoard();
    renderAll();
    overlayEl.classList.add('hidden');
    startBtn.textContent = '重新开始';
    playing = true;

    timerStat.hidden = mode !== 'timed';
    if (mode === 'timed') startTimer();
    resetHint();
}

// ===== 限时模式计时 =====
function startTimer() {
    timeLeft = TIME_LIMIT_MS;
    lastTick = performance.now();
    renderTimer();
    timerId = setInterval(tick, 100);
}

function stopTimer() {
    clearInterval(timerId);
    timerId = 0;
    timerStat.classList.remove('low', 'bonus');
}

function tick() {
    const now = performance.now();
    const dt = now - lastTick;
    lastTick = now;
    if (document.hidden) return; // 切到后台时暂停
    timeLeft = Math.max(0, timeLeft - dt);
    renderTimer();
    if (timeLeft === 0) onTimeUp();
}

// 从后台切回来时，不把离开的这段时间算进去
document.addEventListener('visibilitychange', () => { lastTick = performance.now(); });

function renderTimer() {
    const s = Math.ceil(timeLeft / 1000);
    timerEl.textContent = s;
    timerStat.classList.toggle('low', s <= 10 && timeLeft > 0);
}

function addTime(ms) {
    timeLeft += ms;
    renderTimer();
    timerStat.classList.add('bonus');
    setTimeout(() => timerStat.classList.remove('bonus'), 600);
}

function onTimeUp() {
    stopTimer();
    timeUp = true;
    playing = false;      // 不再接受新操作
    drag = null;
    clearSelection();
    clearHint();
    if (!busy) endGame(); // 正在连消的话，等连消结束再结算
}

function endGame() {
    if (gameOver) return;
    gameOver = true;
    const record = score > bestAtStart && score > 0;
    overlayContent.innerHTML = `
        <div class="result">
            <h2>时间到！</h2>
            <div class="big">${score}</div>
            <div class="sub">共 ${moves} 步 · 最高 ${best}</div>
            ${record ? '<div class="record">🎉 新纪录！</div>' : ''}
            <button class="primary" data-action="replay">再来一局</button>
        </div>`;
    overlayEl.classList.remove('hidden');
}

// 一步操作（包括连消）全部结束后调用
function finishTurn() {
    busy = false;
    if (timeUp) endGame();
    else resetHint();
}

function updateStats() {
    scoreEl.textContent = score;
    movesEl.textContent = moves;
    if (score > best) {
        best = score;
        bestEl.textContent = best;
        saveBest();
    }
}

// 生成一个没有初始消除且至少有一步可走的棋盘
function generateBoard() {
    const k = faces.length;
    for (let attempt = 0; attempt < 100; attempt++) {
        grid = [];
        for (let r = 0; r < N; r++) {
            grid.push([]);
            for (let c = 0; c < N; c++) {
                let t;
                do {
                    t = Math.floor(Math.random() * k);
                } while (
                    (c >= 2 && grid[r][c - 1].type === t && grid[r][c - 2].type === t) ||
                    (r >= 2 && grid[r - 1][c].type === t && grid[r - 2][c].type === t)
                );
                grid[r].push({ type: t, el: null });
            }
        }
        if (findMove()) return;
    }
}

// ===== 渲染 =====
function createTileEl(type) {
    const el = document.createElement('div');
    el.className = `tile t${type}`;
    if (useImages) {
        const img = document.createElement('img');
        img.src = faces[type];
        img.alt = '';
        img.draggable = false;
        el.appendChild(img);
    } else {
        const face = document.createElement('span');
        face.className = 'face';
        face.textContent = faces[type];
        el.appendChild(face);
    }
    return el;
}

function placeEl(el, r, c, durationMs) {
    if (durationMs !== undefined) el.style.transitionDuration = `${durationMs}ms`;
    el.style.setProperty('--x', c);
    el.style.setProperty('--y', r);
}

function renderAll() {
    boardEl.querySelectorAll('.tile, .popup').forEach((e) => e.remove());
    for (let r = 0; r < N; r++) {
        for (let c = 0; c < N; c++) {
            const tile = grid[r][c];
            tile.el = createTileEl(tile.type);
            placeEl(tile.el, r, c, 0);
            boardEl.appendChild(tile.el);
        }
    }
}

// ===== 输入：点击 + 拖动/滑动 =====
let drag = null; // { r, c, x, y, done }

function cellFromEvent(e) {
    const rect = boardEl.getBoundingClientRect();
    const c = Math.floor(((e.clientX - rect.left) / rect.width) * N);
    const r = Math.floor(((e.clientY - rect.top) / rect.height) * N);
    return inBounds(r, c) ? { r, c } : null;
}

boardEl.addEventListener('pointerdown', (e) => {
    if (!playing || busy) return;
    const cell = cellFromEvent(e);
    if (!cell) return;
    drag = { ...cell, x: e.clientX, y: e.clientY, done: false };
    boardEl.setPointerCapture(e.pointerId);
});

boardEl.addEventListener('pointermove', (e) => {
    if (!drag || drag.done || busy) return;
    const dx = e.clientX - drag.x;
    const dy = e.clientY - drag.y;
    const threshold = boardEl.getBoundingClientRect().width / N * 0.35;
    if (Math.max(Math.abs(dx), Math.abs(dy)) < threshold) return;
    drag.done = true;
    const target = Math.abs(dx) > Math.abs(dy)
        ? { r: drag.r, c: drag.c + Math.sign(dx) }
        : { r: drag.r + Math.sign(dy), c: drag.c };
    clearSelection();
    if (inBounds(target.r, target.c)) attemptSwap({ r: drag.r, c: drag.c }, target);
});

boardEl.addEventListener('pointerup', () => {
    if (!drag) return;
    const { r, c, done } = drag;
    drag = null;
    if (done || busy) return;
    onTap({ r, c });
});
boardEl.addEventListener('pointercancel', () => { drag = null; });

function onTap(cell) {
    if (!selected) return select(cell);
    if (selected.r === cell.r && selected.c === cell.c) return clearSelection();
    if (isAdjacent(selected, cell)) {
        const from = selected;
        clearSelection();
        attemptSwap(from, cell);
    } else {
        select(cell); // 点了不相邻的方块：改选它
    }
}

function select(cell) {
    clearSelection();
    selected = cell;
    grid[cell.r][cell.c].el.classList.add('selected');
}

function clearSelection() {
    if (selected) grid[selected.r][selected.c]?.el.classList.remove('selected');
    selected = null;
}

const isAdjacent = (a, b) => Math.abs(a.r - b.r) + Math.abs(a.c - b.c) === 1;

// ===== 交换 =====
function swapInGrid(a, b) {
    const t = grid[a.r][a.c];
    grid[a.r][a.c] = grid[b.r][b.c];
    grid[b.r][b.c] = t;
    placeEl(grid[a.r][a.c].el, a.r, a.c, SWAP_MS);
    placeEl(grid[b.r][b.c].el, b.r, b.c, SWAP_MS);
}

async function attemptSwap(a, b) {
    if (busy || !playing) return;
    const id = gameId;
    busy = true;
    clearHint();
    swapInGrid(a, b);
    await wait(SWAP_MS);
    if (id !== gameId) return;

    if (findMatches().cells.length === 0) {
        // 无效交换：换回去并抖动提示
        swapInGrid(a, b);
        await wait(SWAP_MS);
        if (id !== gameId) return;
        [a, b].forEach(({ r, c }) => shake(grid[r][c].el));
        finishTurn();
        return;
    }

    moves++;
    updateStats();
    await resolveBoard(id);
    if (id !== gameId) return;

    if (!timeUp && !findMove()) {
        showPopup('没有可走的步了，洗牌！', N / 2, N / 2);
        await wait(600);
        if (id !== gameId) return;
        await shuffleBoard();
        if (id !== gameId) return;
    }
    finishTurn();
}

function shake(el) {
    el.classList.remove('shake');
    void el.offsetWidth; // 重启动画
    el.classList.add('shake');
    setTimeout(() => el.classList.remove('shake'), 300);
}

// ===== 消除 / 下落 / 补充 =====
// 返回所有需要消除的格子，以及每条连线（用于计分）
function findMatches() {
    const marked = new Set();
    const runs = [];
    const scan = (horizontal) => {
        for (let i = 0; i < N; i++) {
            let start = 0;
            for (let j = 1; j <= N; j++) {
                const cur = j < N ? (horizontal ? typeAt(i, j) : typeAt(j, i)) : -2;
                const prev = horizontal ? typeAt(i, start) : typeAt(start, i);
                if (cur !== prev) {
                    const len = j - start;
                    if (len >= 3 && prev >= 0) {
                        const cells = [];
                        for (let k = start; k < j; k++) {
                            const cell = horizontal ? { r: i, c: k } : { r: k, c: i };
                            cells.push(cell);
                            marked.add(cell.r * N + cell.c);
                        }
                        runs.push(cells);
                    }
                    start = j;
                }
            }
        }
    };
    scan(true);
    scan(false);
    const cells = [...marked].map((k) => ({ r: Math.floor(k / N), c: k % N }));
    return { cells, runs };
}

function runPoints(len) {
    if (len >= 5) return 100;
    if (len === 4) return 60;
    return 30;
}

async function resolveBoard(id) {
    let combo = 0;
    for (;;) {
        const { cells, runs } = findMatches();
        if (cells.length === 0) break;
        combo++;

        // 计分：每条连线按长度给分，乘以连击倍数
        const gained = runs.reduce((s, run) => s + runPoints(run.length), 0) * combo;
        score += gained;
        updateStats();

        // 限时模式：连击达到一定次数加时（时间已到则不再加）
        let bonusText = '';
        if (mode === 'timed' && !timeUp && combo >= COMBO_BONUS_FROM) {
            addTime(COMBO_BONUS_MS);
            bonusText = `  ⏱+${COMBO_BONUS_MS / 1000}秒`;
        }

        const cr = cells.reduce((s, p) => s + p.r, 0) / cells.length + 0.5;
        const cc = cells.reduce((s, p) => s + p.c, 0) / cells.length + 0.5;
        showPopup((combo > 1 ? `连击 x${combo}  +${gained}` : `+${gained}`) + bonusText, cr, cc);
        playPop(combo);

        cells.forEach(({ r, c }) => grid[r][c].el.classList.add('removing'));
        await wait(REMOVE_MS);
        if (id !== gameId) return;
        cells.forEach(({ r, c }) => {
            grid[r][c].el.remove();
            grid[r][c] = null;
        });

        await collapse();
        if (id !== gameId) return;
    }
}

// 方块下落并从顶部补充新方块，带真实位移动画
async function collapse() {
    let maxMs = 0;
    const k = faces.length;
    const fresh = [];

    for (let c = 0; c < N; c++) {
        let write = N - 1;
        for (let r = N - 1; r >= 0; r--) {
            const tile = grid[r][c];
            if (!tile) continue;
            if (write !== r) {
                grid[write][c] = tile;
                grid[r][c] = null;
                const ms = FALL_BASE_MS + FALL_PER_ROW_MS * (write - r);
                placeEl(tile.el, write, c, ms);
                maxMs = Math.max(maxMs, ms);
            }
            write--;
        }
        // write 及以上全部为空，生成新方块，从棋盘上方落下
        const missing = write + 1;
        for (let r = write; r >= 0; r--) {
            const type = Math.floor(Math.random() * k);
            const el = createTileEl(type);
            placeEl(el, r - missing, c, 0);
            boardEl.appendChild(el);
            grid[r][c] = { type, el };
            fresh.push({ el, r, c, dist: missing });
        }
    }

    if (fresh.length) {
        void boardEl.offsetWidth; // 让起始位置先生效
        fresh.forEach(({ el, r, c, dist }) => {
            const ms = FALL_BASE_MS + FALL_PER_ROW_MS * dist;
            placeEl(el, r, c, ms);
            maxMs = Math.max(maxMs, ms);
        });
    }
    await wait(maxMs + 20);
}

// ===== 死局检测 / 洗牌 / 提示 =====
// 判断 (r,c) 处在当前 grid 上是否构成三连
function makesLineAt(r, c) {
    const t = typeAt(r, c);
    if (t < 0) return false;
    let h = 1, v = 1;
    for (let i = c - 1; typeAt(r, i) === t; i--) h++;
    for (let i = c + 1; typeAt(r, i) === t; i++) h++;
    for (let i = r - 1; typeAt(i, c) === t; i--) v++;
    for (let i = r + 1; typeAt(i, c) === t; i++) v++;
    return h >= 3 || v >= 3;
}

// 找到一步可行的交换，没有则返回 null
function findMove() {
    for (let r = 0; r < N; r++) {
        for (let c = 0; c < N; c++) {
            for (const [dr, dc] of [[0, 1], [1, 0]]) {
                const r2 = r + dr, c2 = c + dc;
                if (!inBounds(r2, c2)) continue;
                const a = grid[r][c], b = grid[r2][c2];
                if (a.type === b.type) continue;
                grid[r][c] = b; grid[r2][c2] = a;
                const ok = makesLineAt(r, c) || makesLineAt(r2, c2);
                grid[r][c] = a; grid[r2][c2] = b;
                if (ok) return [{ r, c }, { r: r2, c: c2 }];
            }
        }
    }
    return null;
}

async function shuffleBoard() {
    const tiles = grid.flat();
    for (let attempt = 0; attempt < 200; attempt++) {
        for (let i = tiles.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [tiles[i], tiles[j]] = [tiles[j], tiles[i]];
        }
        for (let i = 0; i < tiles.length; i++) grid[Math.floor(i / N)][i % N] = tiles[i];
        if (findMatches().cells.length === 0 && findMove()) break;
    }
    // 极端情况下仍无解：直接重新生成
    if (findMatches().cells.length > 0 || !findMove()) {
        generateBoard();
        renderAll();
        return;
    }
    for (let r = 0; r < N; r++) {
        for (let c = 0; c < N; c++) placeEl(grid[r][c].el, r, c, 400);
    }
    await wait(420);
}

function clearHint() {
    clearTimeout(hintTimer);
    hintTiles.forEach((el) => el.classList.remove('hint'));
    hintTiles = [];
}

function resetHint() {
    clearHint();
    if (!playing) return;
    hintTimer = setTimeout(() => {
        if (busy) return resetHint();
        const move = findMove();
        if (!move) return;
        hintTiles = move.map(({ r, c }) => grid[r][c].el);
        hintTiles.forEach((el) => el.classList.add('hint'));
    }, HINT_DELAY_MS);
}

boardEl.addEventListener('pointerdown', () => { if (playing && !busy) resetHint(); }, true);

// ===== 特效 =====
function showPopup(text, r, c) {
    const el = document.createElement('div');
    el.className = 'popup';
    el.textContent = text;
    el.style.left = `${(c / N) * 100}%`;
    el.style.top = `${(r / N) * 100}%`;
    boardEl.appendChild(el);
    el.addEventListener('animationend', () => el.remove());
}

function playPop(combo) {
    if (muted || !baseAudio) return;
    const a = baseAudio.cloneNode();
    a.volume = 0.7;
    a.playbackRate = Math.min(1 + (combo - 1) * 0.12, 2);
    a.play().catch(() => { /* 浏览器阻止自动播放时忽略 */ });
}
