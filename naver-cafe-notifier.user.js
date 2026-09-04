// ==UserScript==
// @name         네이버 카페 '내 소식' 데스크톱 알리미 v6
// @namespace    https://section.cafe.naver.com/
// @version      6.0.0
// @description  네이버 카페 '내 소식'의 안 읽은 댓글·답글·채팅을 감지해 데스크톱 알림을 띄웁니다.
// @author       -
// @match        https://section.cafe.naver.com/*
// @icon         https://cafe.naver.com/favicon.ico
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_notification
// @grant        window.focus
// @grant        unsafeWindow
// @run-at       document-start
// @noframes
// ==/UserScript==

(function () {
    'use strict';

    /* ============================================================
     * 1. 설정
     * ========================================================== */
    const CONFIG = {
        RELOAD_INTERVAL_SEC: 60,

        /* 알림을 띄울 종류. 좋아요는 의사소통이 아니라 기본 꺼둠 */
        ENABLE_REPLY: true,         // "OOO 내 댓글의 답글"
        ENABLE_COMMENT: true,       // "OOO 내 글의 댓글"
        ENABLE_CHAT: true,          // 좌측 사이드바 채팅 뱃지
        ENABLE_LIKE_COMMENT: false, // "내 댓글을 N명이 좋아해요"
        ENABLE_LIKE_POST: false,    // "OOO 님이 내 글을 좋아합니다"

        /* 안 읽은 항목(은은한 초록 배경)만 알림 대상으로 삼는다 */
        ONLY_UNREAD: true,

        NOTIFY_ICON: '',            // 비워두면 알림에 큰 이미지가 안 붙는다
        DOM_READY_DELAY_MS: 3000,
        RESCAN_INTERVAL_SEC: 15,
        MAX_FEED_ITEMS: 30,
        MAX_HISTORY: 100,
        NOTIFY_TAG: 'naver-cafe-group-notification',
        MERGE_FEED_NOTIFICATIONS: true,
        REQUIRE_INTERACTION: false,
        OPEN_LINK_ON_CLICK: false,
        NOTIFY_STAGGER_MS: 700,
        REFRESH_TIMESTAMP: true,
        SHOW_PANEL: true,
        DEBUG: false
    };

    const PATH_RE = /\/ca-fe\/home\/my-news/;

    /* 첫 줄(헤드라인) 기준 판정. 순서 중요:
     * "내 댓글의 답글"은 '댓글'을 포함하므로 답글을 먼저 본다. */
    const TYPES = [
        { id: 'reply',        re: /내\s*(댓글|글)의\s*답글/, label: '새 답글',        short: '답글',   cfg: 'ENABLE_REPLY' },
        { id: 'comment',      re: /내\s*(글|댓글)의\s*댓글/, label: '새 댓글',        short: '댓글',   cfg: 'ENABLE_COMMENT' },
        { id: 'like_comment', re: /좋아해요/,                label: '내 댓글 좋아요', short: '댓글♡', cfg: 'ENABLE_LIKE_COMMENT' },
        { id: 'like_post',    re: /좋아합니다/,              label: '내 글 좋아요',   short: '글♡',   cfg: 'ENABLE_LIKE_POST' }
    ];

    const HINTS = {
        RE_ANY: /좋아해요|좋아합니다|댓글|답글/,
        RE_TIME: /(\d+\s*(초|분|시간|일|주|개월|년)\s*전|어제|그저께|그제|\d{4}\.\s?\d{1,2}\.\s?\d{1,2})/,
        JUNK_CLASS: /popover|pop_over|tooltip|layer|dropdown|modal|gnb_/i,
        JUNK_ANCESTOR: '[class*="popover" i], [class*="pop_over" i], [class*="tooltip" i], [class*="layer" i]',
        CHAT_EXCLUDE: /네이버톡|스마트봇|smartbot|mail|메일|쪽지/i
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

    function isVisible(el) {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
    }

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
     * 3. 읽음/안읽음 — 실제 렌더링 배경색으로 판정
     * ========================================================== */
    function parseRGB(s) {
        const m = /rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)(?:[,\s/]+([\d.]+))?/.exec(s || '');
        if (!m) return null;
        return { r: +m[1], g: +m[2], b: +m[3], a: m[4] === undefined ? 1 : +m[4] };
    }

    function unreadInfo(el) {
        let node = el;
        for (let i = 0; i < 4 && node && node !== document.body; i++, node = node.parentElement) {
            let bg = '';
            try { bg = getComputedStyle(node).backgroundColor; } catch (e) { continue; }
            const c = parseRGB(bg);
            if (!c || c.a < 0.05) continue;
            if (Math.abs(c.r - c.g) <= 2 && Math.abs(c.g - c.b) <= 2) continue; // 무채색 = 읽음
            if (c.g > c.r && c.g > c.b) return { unread: true, color: bg };      // 초록 우세 = 안읽음
        }
        return { unread: false, color: '' };
    }

    /* ============================================================
     * 4. 알림 발송
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
                const opts = {
                    body: body,
                    tag: CONFIG.NOTIFY_TAG,
                    renotify: true,
                    requireInteraction: CONFIG.REQUIRE_INTERACTION,
                    silent: false
                };
                if (CONFIG.NOTIFY_ICON) opts.icon = CONFIG.NOTIFY_ICON;
                const n = new N(title, opts);
                n.onclick = () => { onClick(); n.close(); };
                return;
            } catch (e) { log('Notification 실패 → 폴백', e); }
        }
        try {
            GM_notification({ title: title, text: body, tag: CONFIG.NOTIFY_TAG, onclick: onClick });
        } catch (e) { console.error('[카페알리미] 알림 발송 실패', e); }
    }

    /* ============================================================
     * 5. 채팅 감지
     * ========================================================== */
    function chatCandidates() {
        const found = new Set();

        document.querySelectorAll('span, em, a, li, button').forEach((el) => {
            const t = norm(el.textContent);
            if (!/^채팅/.test(t) || t.length > 20) return;
            const holder = el.closest('a, li, button') || el.parentElement;
            if (holder) found.add(holder);
        });
        document.querySelectorAll('[class*="chat" i], a[href*="/chat"]').forEach((el) => found.add(el));

        return Array.from(found).filter((el) => {
            const sig = cls(el) + ' ' + (el.textContent || '') + ' ' +
                        (el.getAttribute('aria-label') || '') + ' ' + (el.getAttribute('href') || '');
            return !HINTS.CHAT_EXCLUDE.test(sig);
        });
    }

    function detectChatCount() {
        const cands = chatCandidates();
        if (!cands.length) return null;

        let max = 0;
        cands.forEach((holder) => {
            [holder].concat(Array.from(holder.querySelectorAll('em, span, i, b, strong'))).forEach((node) => {
                const t = norm(node.textContent);
                if (!t || t.length > 4) return;
                if (!/^\d{1,3}\+?$/.test(t)) return;
                const n = parseInt(t, 10);
                if (!isNaN(n) && n > max) max = n;
            });
        });
        return max;
    }

    /* ============================================================
     * 6. 피드 감지
     * ========================================================== */
    function collectFeedItems() {
        const picked = [];

        document.querySelectorAll('li, article, [class*="item" i]').forEach((el) => {
            if (HINTS.JUNK_CLASS.test(cls(el))) return;
            if (el.closest(HINTS.JUNK_ANCESTOR)) return;

            const raw = el.innerText || '';
            const text = norm(raw);
            if (text.length < 10 || text.length > 500) return;
            if (!HINTS.RE_ANY.test(text)) return;
            if (!HINTS.RE_TIME.test(text)) return;
            if (!isVisible(el)) return;

            picked.push({ el, raw, text });
        });

        const leaves = picked.filter((p) => !picked.some((q) => q.el !== p.el && p.el.contains(q.el)));
        return leaves.slice(0, CONFIG.MAX_FEED_ITEMS);
    }

    function buildItem({ el, raw, text }) {
        const lines = raw.split('\n').map(norm).filter(Boolean);
        const head = lines[0] || text;

        let type = null;
        for (const t of TYPES) { if (t.re.test(head)) { type = t; break; } }
        if (!type) { for (const t of TYPES) { if (t.re.test(text)) { type = t; break; } } }

        const link = el.querySelector('a[href]');
        const href = link ? link.href : '';
        const key = (href ? href.split('?')[0] : 'nolink') + '::' + hashText(text);
        const ur = unreadInfo(el);

        return { key, type, head, lines, text, href, el, unread: ur.unread, color: ur.color };
    }

    function bodyOf(item) {
        const parts = [truncate(item.head, 80)];
        if (item.lines[1]) parts.push(truncate(item.lines[1], 80));
        return parts.join('\n');
    }

    /* ============================================================
     * 7. 메인 스캔
     * ========================================================== */
    let lastStat = { chat: null, counts: {}, scanned: false };

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
        const unreadItems = items.filter((i) => i.unread);

        // 안 읽은 항목만 종류별로 집계
        const counts = {};
        TYPES.forEach((t) => { counts[t.id] = 0; });
        unreadItems.forEach((i) => { counts[i.type.id] += 1; });
        lastStat.counts = counts;
        lastStat.scanned = true;

        const targets = CONFIG.ONLY_UNREAD ? unreadItems : items;
        const allKeys = items.map((i) => i.key);

        if (!initialized) {
            saveSeen(allKeys);
            store.set(KEY.INIT, true);
            log('최초 실행 — 기존', allKeys.length, '건 등록(알림 미발송)');
            paint();
            return;
        }

        const seenSet = new Set(loadSeen());
        for (const it of targets) {
            if (seenSet.has(it.key)) continue;
            if (!CONFIG[it.type.cfg]) continue;
            events.push({ kind: 'feed', item: it });
        }

        saveSeen(allKeys.concat(loadSeen()));
        dispatch(events);
        paint();
    }

    function dispatch(events) {
        if (!events.length) return;

        if (events.some((e) => e.kind === 'chat')) {
            enqueue('[네이버 카페] 채팅 알림', '새로운 채팅 메시지가 도착했습니다.');
        }

        const feed = events.filter((e) => e.kind === 'feed').map((e) => e.item);
        if (!feed.length) return;

        if (CONFIG.MERGE_FEED_NOTIFICATIONS && feed.length > 1) {
            const lines = feed.slice(0, 5).map((i) => '· [' + i.type.label + '] ' + truncate(i.head, 50));
            if (feed.length > 5) lines.push('… 외 ' + (feed.length - 5) + '건');
            enqueue('[네이버 카페] 새 소식 ' + feed.length + '건', lines.join('\n'), feed[0].href);
        } else {
            feed.slice().reverse().forEach((i) =>
                enqueue('[네이버 카페] ' + i.type.label, bodyOf(i), i.href));
        }
    }

    function safeScan() {
        try { scan(); } catch (e) { console.error('[카페알리미] 스캔 오류', e); }
    }

    /* ============================================================
     * 8. 진단
     * ========================================================== */
    function diagnose() {
        const out = [];
        out.push('=== 카페 알리미 v6 진단 ===');
        const N = getNotificationCtor();
        out.push('권한: ' + (N ? N.permission : '없음') + ' / 감시: ' + (running ? '동작' : '정지'));

        out.push('\n--- 채팅 ---');
        chatCandidates().slice(0, 8).forEach((el, i) =>
            out.push(`[${i}] <${el.tagName.toLowerCase()} class="${cls(el)}"> "${truncate(el.textContent, 30)}"`));
        out.push('→ 채팅 수: ' + detectChatCount());

        out.push('\n--- 피드 ---');
        const items = collectFeedItems().map(buildItem);
        const un = items.filter((i) => i.unread);
        out.push('스캔 ' + items.length + '건 중 안읽음 ' + un.length + '건');
        TYPES.forEach((t) => {
            out.push('  ' + t.short + ' : 안읽음 ' + un.filter(i => i.type && i.type.id === t.id).length +
                     ' (전체 ' + items.filter(i => i.type && i.type.id === t.id).length + ')' +
                     (CONFIG[t.cfg] ? '' : '  [알림 꺼짐]'));
        });
        items.slice(0, 10).forEach((f, i) => {
            out.push(`[${i}] ${f.unread ? '● 안읽음' : '○ 읽음'} (${f.type ? f.type.id : '?'}) bg=${f.color || '-'}`);
            out.push('     ' + truncate(f.head, 70));
        });

        const text = out.join('\n');
        console.log(text);
        try { navigator.clipboard.writeText(text); toast('진단 결과 복사 완료'); }
        catch (e) { toast('진단 결과를 콘솔에 출력했습니다'); }
        return text;
    }

    function reset() {
        store.set(KEY.INIT, false);
        store.set(KEY.SEEN, '[]');
        store.set(KEY.CHAT, 0);
        lastStat = { chat: null, counts: {}, scanned: false };
        toast('초기화 완료');
    }

    /* ============================================================
     * 9. UI — 안 읽은 것만, 종류별로
     * ========================================================== */
    let panel = null, panelMain = null, panelSub = null, panelFoot = null;

    function toast(msg) {
        const host = document.documentElement;
        if (!host) return;
        const t = document.createElement('div');
        t.textContent = msg;
        t.style.cssText = 'position:fixed;right:16px;bottom:150px;z-index:2147483647;padding:10px 14px;' +
            'border-radius:8px;background:rgba(0,0,0,.85);color:#fff;font:12px/1.4 sans-serif;max-width:280px';
        host.appendChild(t);
        setTimeout(() => t.remove(), 4000);
    }

    function mkBtn(label, fn) {
        const b = document.createElement('button');
        b.textContent = label;
        b.style.cssText = 'flex:1;padding:5px 0;border:0;border-radius:5px;cursor:pointer;' +
            'background:rgba(255,255,255,.18);color:#fff;font:11px sans-serif';
        b.addEventListener('click', (e) => { e.stopPropagation(); fn(); });
        return b;
    }

    function mountPanel() {
        if (!CONFIG.SHOW_PANEL) return;
        const host = document.documentElement;
        if (!host) return;
        if (panel && host.contains(panel)) return;

        panel = document.createElement('div');
        panel.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:2147483647;width:220px;' +
            'padding:10px 12px;border-radius:10px;background:rgba(20,22,26,.9);color:#fff;' +
            'font:12px/1.5 sans-serif;box-shadow:0 4px 14px rgba(0,0,0,.35)';

        const head = document.createElement('div');
        head.textContent = '🔔 카페 알리미';
        head.style.cssText = 'font-weight:700;color:#03c75a;margin-bottom:3px;font-size:12px';

        panelMain = document.createElement('div');   // 알림 켜진 종류 — 크게
        panelMain.style.cssText = 'font-size:13px;font-weight:600';

        panelSub = document.createElement('div');    // 알림 꺼진 종류 — 흐리게
        panelSub.style.cssText = 'font-size:11px;opacity:.5';

        panelFoot = document.createElement('div');
        panelFoot.style.cssText = 'font-size:10px;opacity:.45;margin-top:2px';

        const row = document.createElement('div');
        row.style.cssText = 'display:flex;gap:5px;margin-top:8px';
        row.appendChild(mkBtn('테스트', () => enqueue('[네이버 카페] 테스트 알림', '알림이 정상 동작합니다.')));
        row.appendChild(mkBtn('진단', diagnose));
        row.appendChild(mkBtn('초기화', reset));

        panel.append(head, panelMain, panelSub, panelFoot, row);
        panel.addEventListener('click', requestPermission);
        host.appendChild(panel);
        paint();
    }

    let secLeft = 0;
    function paint() {
        if (!panelMain) return;

        const N = getNotificationCtor();
        if (N && N.permission !== 'granted') {
            panelMain.textContent = '알림 권한 필요';
            panelSub.textContent = '패널을 클릭해 허용';
            panelFoot.textContent = '';
            return;
        }

        if (!lastStat.scanned) {
            panelMain.textContent = '첫 스캔 대기 중…';
            panelSub.textContent = '';
            panelFoot.textContent = running ? '새로고침 ' + secLeft + '초 전' : '';
            return;
        }

        const on = [], off = [];
        TYPES.forEach((t) => {
            const s = t.short + ' ' + (lastStat.counts[t.id] || 0);
            (CONFIG[t.cfg] ? on : off).push(s);
        });

        const chat = lastStat.chat === null ? '?' : lastStat.chat;
        (CONFIG.ENABLE_CHAT ? on : off).push('채팅 ' + chat);

        panelMain.textContent = on.join(' · ');
        panelSub.textContent = off.length ? off.join(' · ') + '  (알림 꺼짐)' : '';
        panelFoot.textContent = running ? '새로고침 ' + secLeft + '초 전' : '대기 중';
    }

    /* ============================================================
     * 10. 루프 / 라우팅
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
        secLeft = Math.max(15, CONFIG.RELOAD_INTERVAL_SEC);

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
        if (!N) { toast('이 브라우저는 알림을 지원하지 않습니다'); return; }
        if (N.permission === 'granted') { ensureState(); return; }
        if (N.permission === 'denied') { toast('알림 차단됨.\n주소창 자물쇠 → 알림 → 허용'); paint(); return; }
        N.requestPermission().then((p) => {
            paint();
            if (p === 'granted') ensureState();
            else toast('패널을 클릭해 알림을 허용해 주세요');
        }).catch(() => toast('권한 요청 실패. 패널을 다시 클릭해 주세요'));
    }

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
     * 11. 시작
     * ========================================================== */
    console.log('%c[카페알리미 v6] 로드됨', 'background:#03c75a;color:#fff;padding:2px 6px', location.href);

    mountPanel();
    setInterval(mountPanel, 1000);

    function boot() { mountPanel(); ensureState(); }
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot, { once: true });
    } else { boot(); }
    window.addEventListener('load', () => setTimeout(boot, 500));

    try {
        unsafeWindow.__cafeNotifier = { diagnose, reset, scan: safeScan, CONFIG, TYPES, start, stop };
    } catch (e) { log('unsafeWindow 노출 실패', e); }
})();
