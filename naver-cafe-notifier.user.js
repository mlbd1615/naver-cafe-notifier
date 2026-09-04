// ==UserScript==
// @name         네이버 카페 '내 소식' 데스크톱 알리미 v2
// @namespace    https://section.cafe.naver.com/
// @version      2.0.0
// @description  네이버 카페 '내 소식'(댓글/답글/좋아해요)과 1:1 채팅을 감지해 데스크톱 알림으로 띄웁니다. SPA 라우팅 대응 + 진단 패널 포함.
// @author       -
// @match        https://section.cafe.naver.com/*
// @icon         https://cafe.naver.com/favicon.ico
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_notification
// @grant        window.focus
// @grant        unsafeWindow
// @run-at       document-idle
// @noframes
// ==/UserScript==

(function () {
    'use strict';

    /* ============================================================
     * 1. 설정
     * ========================================================== */
    const CONFIG = {
        RELOAD_INTERVAL_SEC: 60,
        ENABLE_LIKE: false,
        ENABLE_COMMENT: true,
        ENABLE_CHAT: true,

        /* --- 세부 튜닝 --- */
        DOM_READY_DELAY_MS: 3000,
        RESCAN_INTERVAL_SEC: 15,
        MAX_FEED_ITEMS: 15,
        MAX_HISTORY: 50,
        NOTIFY_TAG: 'naver-cafe-group-notification',
        MERGE_FEED_NOTIFICATIONS: true,
        REQUIRE_INTERACTION: false,
        OPEN_LINK_ON_CLICK: false,
        NOTIFY_STAGGER_MS: 700,
        REFRESH_TIMESTAMP: true,  // 새로고침 시 ?t= 값을 현재 시각으로 갱신 (캐시 회피)
        SHOW_PANEL: true,         // 우측 하단 상태/진단 패널
        DEBUG: false
    };

    /* '내 소식' 페이지 판별 — cafe-activity 등 하위 탭 전부 포함 */
    const PATH_RE = /\/ca-fe\/home\/my-news/;

    /* 선택자 / 키워드 후보 — DOM이 바뀌면 여기만 수정 */
    const HINTS = {
        SCOPE: ['header', '[class*="Gnb" i]', '[id*="gnb" i]', '[class*="Header" i]'],
        CHAT: ['[class*="chat" i]', '[class*="talk" i]', 'a[href*="chat"]', 'a[href*="talk"]'],
        FEED_ROOT: ['main', '[class*="MyNews" i]', '[class*="my_news" i]', '[class*="activity" i]', '#content', '.content'],
        FEED_ITEM: 'li, article, [class*="item" i]',
        AUTHOR: '[class*="nick" i], [class*="writer" i], [class*="name" i], [class*="user" i], strong',
        CONTENT: '[class*="comment" i], [class*="content" i], [class*="desc" i], [class*="text" i], p',
        RE_LIKE: /좋아해요/,
        RE_COMMENT: /댓글|답글/
    };

    const KEY = { CHAT: 'ncn_chat_count', SEEN: 'ncn_seen_keys', INIT: 'ncn_initialized' };

    /* ============================================================
     * 2. 유틸
     * ========================================================== */
    const log = (...a) => { if (CONFIG.DEBUG) console.log('%c[카페알리미]', 'color:#03c75a;font-weight:700', ...a); };
    const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
    const truncate = (s, n) => { s = norm(s); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
    const cls = (el) => {
        const c = el.className;
        return typeof c === 'string' ? c : (c && c.baseVal) || '';
    };

    const store = {
        get(k, d) { try { return GM_getValue(k, d); } catch (e) { return d; } },
        set(k, v) { try { GM_setValue(k, v); } catch (e) { log('저장 실패', e); } }
    };

    function hashText(str) {
        let h = 5381;
        for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
        return (h >>> 0).toString(36);
    }

    function loadSeen() {
        const raw = store.get(KEY.SEEN, '[]');
        try {
            const arr = typeof raw === 'string' ? JSON.parse(raw) : raw;
            return Array.isArray(arr) ? arr : [];
        } catch (e) { return []; }
    }

    function saveSeen(keys) {
        store.set(KEY.SEEN, JSON.stringify(Array.from(new Set(keys.filter(Boolean))).slice(0, CONFIG.MAX_HISTORY)));
    }

    /* ============================================================
     * 3. 알림 발송
     * ========================================================== */
    const queue = [];
    let sending = false;

    function enqueue(title, body, url) { queue.push({ title, body, url }); drain(); }

    function drain() {
        if (sending) return;
        const job = queue.shift();
        if (!job) return;
        sending = true;
        send(job);
        setTimeout(() => { sending = false; drain(); }, CONFIG.NOTIFY_STAGGER_MS);
    }

    /* 샌드박스 문제 대비: 여러 경로로 Notification 생성자 확보 */
    function getNotificationCtor() {
        try { if (typeof Notification !== 'undefined') return Notification; } catch (e) {}
        try { if (typeof unsafeWindow !== 'undefined' && unsafeWindow.Notification) return unsafeWindow.Notification; } catch (e) {}
        return null;
    }

    function send({ title, body, url }) {
        const onClick = () => {
            try { window.focus(); } catch (e) { log('focus 실패', e); }
            if (CONFIG.OPEN_LINK_ON_CLICK && url) window.open(url, '_blank');
        };

        const N = getNotificationCtor();
        if (N && N.permission === 'granted') {
            try {
                const n = new N(title, {
                    body: body,
                    tag: CONFIG.NOTIFY_TAG,
                    renotify: true,
                    requireInteraction: CONFIG.REQUIRE_INTERACTION,
                    silent: false,
                    icon: 'https://cafe.naver.com/favicon.ico'
                });
                n.onclick = () => { onClick(); n.close(); };
                log('알림 발송(Notification)', title);
                return;
            } catch (e) {
                log('Notification 실패 → GM_notification 폴백', e);
            }
        }

        try {
            GM_notification({ title: title, text: body, tag: CONFIG.NOTIFY_TAG, onclick: onClick });
            log('알림 발송(GM_notification)', title);
        } catch (e) {
            console.error('[카페알리미] 알림 발송 실패', e);
        }
    }

    /* ============================================================
     * 4. 채팅 뱃지 감지
     * ========================================================== */
    function findScope() {
        for (const sel of HINTS.SCOPE) {
            const el = document.querySelector(sel);
            if (el) return el;
        }
        return document;
    }

    function detectChatCount() {
        const selector = HINTS.CHAT.join(',');
        let chatEls = Array.from(findScope().querySelectorAll(selector));
        if (!chatEls.length) chatEls = Array.from(document.querySelectorAll(selector));
        if (!chatEls.length) return null;

        let max = 0;
        for (const el of chatEls) {
            const nodes = [el].concat(Array.from(el.querySelectorAll('em, span, i, b, strong, div')));
            for (const node of nodes) {
                const t = norm(node.textContent);
                if (!t || t.length > 4) continue;
                if (!/^\d{1,3}\+?$/.test(t)) continue;
                const n = parseInt(t, 10);
                if (!isNaN(n) && n > max) max = n;
            }
        }
        return max;
    }

    /* ============================================================
     * 5. 피드 감지
     * ========================================================== */
    function findFeedRoot() {
        for (const sel of HINTS.FEED_ROOT) {
            const el = document.querySelector(sel);
            if (el && norm(el.innerText).length > 30) return el;
        }
        return document.body;
    }

    function collectFeedItems() {
        const root = findFeedRoot();
        const picked = [];
        root.querySelectorAll(HINTS.FEED_ITEM).forEach((el) => {
            const text = norm(el.innerText || '');
            if (text.length < 5 || text.length > 400) return;
            if (!HINTS.RE_LIKE.test(text) && !HINTS.RE_COMMENT.test(text)) return;
            picked.push({ el, text });
        });
        const leaves = picked.filter((p) => !picked.some((q) => q.el !== p.el && p.el.contains(q.el)));
        return leaves.slice(0, CONFIG.MAX_FEED_ITEMS);
    }

    function buildItem({ el, text }) {
        const link = el.querySelector('a[href]');
        const href = link ? link.href : '';
        const key = (href ? href.split('?')[0] : 'nolink') + '::' + hashText(text);
        let type = null;
        if (HINTS.RE_LIKE.test(text)) type = 'like';
        else if (HINTS.RE_COMMENT.test(text)) type = 'comment';
        return { key, type, text, href, el };
    }

    function extractDetail(el) {
        const pick = (sel) => {
            const n = el.querySelector(sel);
            const t = n ? norm(n.innerText) : '';
            return t.length > 0 && t.length < 200 ? t : '';
        };
        return { author: pick(HINTS.AUTHOR), content: pick(HINTS.CONTENT) };
    }

    const titleOf = (i) => (i.type === 'like' ? '[네이버 카페] 좋아해요' : '[네이버 카페] 새 댓글');

    function bodyOf(item) {
        if (item.type === 'comment') {
            const { author, content } = extractDetail(item.el);
            if (author && content && content !== author && !content.includes(author)) {
                return truncate(author + ': ' + content, 150);
            }
        }
        return truncate(item.text, 150);
    }

    /* ============================================================
     * 6. 메인 스캔
     * ========================================================== */
    let lastStat = { chat: null, feed: 0 };

    function scan() {
        const initialized = store.get(KEY.INIT, false);
        const events = [];

        if (CONFIG.ENABLE_CHAT) {
            const cur = detectChatCount();
            lastStat.chat = cur;
            if (cur !== null) {
                const prev = Number(store.get(KEY.CHAT, 0)) || 0;
                if (initialized && cur > prev) events.push({ kind: 'chat' });
                if (cur !== prev) store.set(KEY.CHAT, cur);
            }
        }

        const items = collectFeedItems().map(buildItem).filter((i) => i.type);
        lastStat.feed = items.length;
        const allKeys = items.map((i) => i.key);

        if (!initialized) {
            saveSeen(allKeys);
            store.set(KEY.INIT, true);
            log('최초 실행 — 기존', allKeys.length, '건 등록(알림 미발송)');
            paint();
            return;
        }

        const seen = loadSeen();
        const seenSet = new Set(seen);
        for (const it of items) {
            if (seenSet.has(it.key)) continue;
            if (it.type === 'like' && !CONFIG.ENABLE_LIKE) continue;
            if (it.type === 'comment' && !CONFIG.ENABLE_COMMENT) continue;
            events.push({ kind: it.type, item: it });
        }

        saveSeen(allKeys.concat(seen));
        dispatch(events);
        paint();
    }

    function dispatch(events) {
        if (!events.length) return;

        if (events.some((e) => e.kind === 'chat')) {
            enqueue('[네이버 카페] 채팅 알림', '새로운 채팅 메시지가 도착했습니다.');
        }

        const feed = events.filter((e) => e.kind !== 'chat').map((e) => e.item);
        if (!feed.length) return;

        if (CONFIG.MERGE_FEED_NOTIFICATIONS && feed.length > 1) {
            const lines = feed.slice(0, 5).map((i) => '· ' + truncate(bodyOf(i), 60));
            if (feed.length > 5) lines.push('… 외 ' + (feed.length - 5) + '건');
            enqueue('[네이버 카페] 새 소식 ' + feed.length + '건', lines.join('\n'), feed[0].href);
        } else {
            feed.slice().reverse().forEach((i) => enqueue(titleOf(i), bodyOf(i), i.href));
        }
    }

    function safeScan() {
        try { scan(); } catch (e) { console.error('[카페알리미] 스캔 오류', e); }
    }

    /* ============================================================
     * 7. 진단
     * ========================================================== */
    function diagnose() {
        const out = [];
        out.push('=== 네이버 카페 알리미 진단 ===');
        out.push('URL       : ' + location.href);
        out.push('대상 페이지: ' + PATH_RE.test(location.pathname));
        const N = getNotificationCtor();
        out.push('알림 권한 : ' + (N ? N.permission : 'Notification 사용 불가'));
        out.push('감시 상태 : ' + (running ? '동작 중' : '정지'));

        out.push('\n--- 채팅 아이콘 후보 (' + HINTS.CHAT.join(', ') + ') ---');
        const chatEls = Array.from(document.querySelectorAll(HINTS.CHAT.join(',')));
        out.push('총 ' + chatEls.length + '개');
        chatEls.slice(0, 15).forEach((el, i) => {
            out.push(`[${i}] <${el.tagName.toLowerCase()} class="${cls(el)}"> "${truncate(el.innerText, 40)}"`);
        });
        out.push('→ 파싱된 채팅 카운트: ' + detectChatCount());

        out.push('\n--- 피드 루트 ---');
        const root = findFeedRoot();
        out.push(`<${root.tagName.toLowerCase()} class="${cls(root)}">`);

        out.push('\n--- 피드 항목 후보 ---');
        const feed = collectFeedItems();
        out.push('총 ' + feed.length + '개');
        feed.slice(0, 5).forEach((f, i) => {
            out.push(`[${i}] <${f.el.tagName.toLowerCase()} class="${cls(f.el)}">`);
            out.push('    text: ' + truncate(f.text, 120));
        });

        if (feed.length) {
            out.push('\n--- 첫 항목 HTML (앞 800자) ---');
            out.push(feed[0].el.outerHTML.slice(0, 800));
        } else {
            out.push('\n--- 피드 미검출: "좋아해요/댓글/답글" 텍스트가 있는 노드 샘플 ---');
            const raw = Array.from(document.querySelectorAll('li, article, div'))
                .filter((el) => {
                    const t = norm(el.innerText || '');
                    return t.length > 5 && t.length < 300 && (HINTS.RE_LIKE.test(t) || HINTS.RE_COMMENT.test(t));
                }).slice(0, 5);
            out.push('총 ' + raw.length + '개');
            raw.forEach((el, i) => out.push(`[${i}] <${el.tagName.toLowerCase()} class="${cls(el)}"> "${truncate(el.innerText, 80)}"`));
        }

        const text = out.join('\n');
        console.log(text);
        try {
            navigator.clipboard.writeText(text);
            toast('진단 결과를 콘솔에 출력하고 클립보드에 복사했습니다.');
        } catch (e) {
            toast('진단 결과를 콘솔(F12)에 출력했습니다.');
        }
        return text;
    }

    function reset() {
        store.set(KEY.INIT, false);
        store.set(KEY.SEEN, '[]');
        store.set(KEY.CHAT, 0);
        toast('저장된 상태를 초기화했습니다.');
    }

    /* ============================================================
     * 8. UI 패널
     * ========================================================== */
    let panel, panelInfo;

    function toast(msg) {
        const t = document.createElement('div');
        t.textContent = msg;
        t.style.cssText = 'position:fixed;right:16px;bottom:130px;z-index:2147483647;padding:10px 14px;' +
            'border-radius:8px;background:rgba(0,0,0,.85);color:#fff;font:12px/1.4 "Malgun Gothic",sans-serif;max-width:280px';
        document.body.appendChild(t);
        setTimeout(() => t.remove(), 4000);
    }

    function mkBtn(label, fn) {
        const b = document.createElement('button');
        b.textContent = label;
        b.style.cssText = 'flex:1;padding:5px 0;border:0;border-radius:5px;cursor:pointer;' +
            'background:rgba(255,255,255,.18);color:#fff;font:11px "Malgun Gothic",sans-serif';
        b.addEventListener('click', (e) => { e.stopPropagation(); fn(); });
        return b;
    }

    function buildPanel() {
        if (panel || !CONFIG.SHOW_PANEL) return;
        panel = document.createElement('div');
        panel.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:2147483647;width:210px;' +
            'padding:10px 12px;border-radius:10px;background:rgba(20,22,26,.88);color:#fff;' +
            'font:12px/1.5 "Malgun Gothic",-apple-system,sans-serif;box-shadow:0 4px 14px rgba(0,0,0,.35)';

        const head = document.createElement('div');
        head.textContent = '🔔 카페 알리미';
        head.style.cssText = 'font-weight:700;color:#03c75a;margin-bottom:4px';

        panelInfo = document.createElement('div');
        panelInfo.style.cssText = 'font-size:11px;opacity:.85;white-space:pre-line';

        const row = document.createElement('div');
        row.style.cssText = 'display:flex;gap:5px;margin-top:8px';
        row.appendChild(mkBtn('테스트', () => enqueue('[네이버 카페] 테스트 알림', '알림이 정상적으로 동작합니다.')));
        row.appendChild(mkBtn('진단', diagnose));
        row.appendChild(mkBtn('초기화', reset));

        panel.append(head, panelInfo, row);
        document.body.appendChild(panel);
    }

    let secLeft = 0;
    function paint() {
        if (!panelInfo) return;
        const N = getNotificationCtor();
        const perm = N ? N.permission : 'N/A';
        const chat = lastStat.chat === null ? '감지실패' : lastStat.chat + '건';
        panelInfo.textContent =
            '권한: ' + perm + '\n' +
            '채팅: ' + chat + ' · 피드: ' + lastStat.feed + '건\n' +
            (running ? '새로고침 ' + secLeft + '초 전' : '대기 중');
    }

    /* ============================================================
     * 9. 루프 / 라우팅
     * ========================================================== */
    let running = false;
    let scanTimer = null, rescanTimer = null, tickTimer = null;

    function reloadPage() {
        if (CONFIG.REFRESH_TIMESTAMP) {
            try {
                const url = new URL(location.href);
                url.searchParams.set('t', String(Date.now()));
                location.replace(url.toString());
                return;
            } catch (e) { log('URL 갱신 실패', e); }
        }
        location.reload();
    }

    function start() {
        if (running) return;
        running = true;
        const interval = Math.max(15, CONFIG.RELOAD_INTERVAL_SEC);
        secLeft = interval;
        log('감시 시작', location.href);

        scanTimer = setTimeout(() => {
            safeScan();
            if (CONFIG.RESCAN_INTERVAL_SEC > 0) {
                rescanTimer = setInterval(safeScan, CONFIG.RESCAN_INTERVAL_SEC * 1000);
            }
        }, CONFIG.DOM_READY_DELAY_MS);

        tickTimer = setInterval(() => {
            secLeft -= 1;
            paint();
            if (secLeft <= 0) { stop(); reloadPage(); }
        }, 1000);

        paint();
    }

    function stop() {
        running = false;
        clearTimeout(scanTimer);
        clearInterval(rescanTimer);
        clearInterval(tickTimer);
        paint();
    }

    function ensureState() {
        const onTarget = PATH_RE.test(location.pathname);
        if (onTarget && !running) {
            const N = getNotificationCtor();
            if (N && N.permission === 'granted') start();
            else requestPermission();
        } else if (!onTarget && running) {
            stop();
        }
    }

    function requestPermission() {
        const N = getNotificationCtor();
        if (!N) { toast('이 브라우저는 알림을 지원하지 않습니다.'); return; }

        if (N.permission === 'denied') {
            toast('알림이 차단되어 있습니다.\n일반 탭에서 주소창 자물쇠 → 알림 → 허용 후 다시 여세요.');
            paint();
            return;
        }
        N.requestPermission().then((p) => {
            paint();
            if (p === 'granted') ensureState();
            else toast('알림 권한이 아직 없습니다.\n일반 탭에서 이 페이지를 열고 허용해 주세요.');
        }).catch(() => {
            toast('권한 요청 실패. 패널을 클릭해 다시 시도하세요.');
        });
    }

    /* SPA 라우팅 감지 */
    (function hookHistory() {
        ['pushState', 'replaceState'].forEach((m) => {
            const orig = history[m];
            if (typeof orig !== 'function') return;
            history[m] = function () {
                const r = orig.apply(this, arguments);
                setTimeout(ensureState, 500);
                return r;
            };
        });
        window.addEventListener('popstate', () => setTimeout(ensureState, 500));
    })();

    /* ============================================================
     * 10. 시작
     * ========================================================== */
    buildPanel();
    if (panel) panel.addEventListener('click', requestPermission); // 패널 클릭 = 권한 재요청
    paint();
    ensureState();

    try {
        unsafeWindow.__cafeNotifier = { diagnose, reset, scan: safeScan, CONFIG, HINTS, start, stop };
    } catch (e) { log('unsafeWindow 노출 실패', e); }
})();