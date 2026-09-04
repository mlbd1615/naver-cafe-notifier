// ==UserScript==
// @name         네이버 카페 '내 소식' 데스크톱 알리미 v4
// @namespace    https://section.cafe.naver.com/
// @version      4.0.0
// @description  네이버 카페 '내 소식'(댓글/답글/좋아요)과 카페 채팅을 감지해 데스크톱 알림으로 띄웁니다.
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
        ENABLE_LIKE: false,
        ENABLE_COMMENT: true,
        ENABLE_CHAT: true,

        DOM_READY_DELAY_MS: 3000,
        RESCAN_INTERVAL_SEC: 15,
        MAX_FEED_ITEMS: 20,
        MAX_HISTORY: 50,
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

    const HINTS = {
        RE_LIKE: /좋아해요|좋아합니다|좋아요/,
        RE_COMMENT: /댓글|답글/,

        /* 실제 소식 항목은 반드시 "8시간 전" / "어제" 같은 시간 표기를 갖는다.
         * 팝오버 메뉴("이 카페 댓글알림 설정")에는 없으므로 이걸로 걸러낸다. */
        RE_TIME: /(\d+\s*(초|분|시간|일|주|개월|년)\s*전|어제|그저께|그제|\d{4}\.\s?\d{1,2}\.\s?\d{1,2})/,

        /* 피드에서 제외할 UI 조각 */
        JUNK_CLASS: /popover|pop_over|tooltip|layer|dropdown|modal|gnb_/i,
        JUNK_ANCESTOR: '[class*="popover" i], [class*="pop_over" i], [class*="tooltip" i], [class*="layer" i]',

        /* 채팅에서 제외할 것 — 네이버톡(gnb_talk)은 카페 채팅이 아니다 */
        CHAT_EXCLUDE: /talk|네이버톡|스마트봇|smartbot|mail|메일|쪽지/i
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
                return;
            } catch (e) { log('Notification 실패 → 폴백', e); }
        }
        try {
            GM_notification({ title: title, text: body, tag: CONFIG.NOTIFY_TAG, onclick: onClick });
        } catch (e) { console.error('[카페알리미] 알림 발송 실패', e); }
    }

    /* ============================================================
     * 4. 채팅 감지 — 좌측 사이드바 '채팅' 메뉴 기준
     *    네이버톡(gnb_talk)의 배지를 잡던 v3 버그를 수정
     * ========================================================== */
    function chatCandidates() {
        const found = new Set();

        // 1) 이름이 정확히 '채팅'인 메뉴를 찾아 그 클릭 영역을 후보로
        document.querySelectorAll('span, em, a, li, button').forEach((el) => {
            const t = norm(el.textContent);
            if (t !== '채팅' && !/^채팅\s*\d{1,3}\+?$/.test(t)) return;
            const holder = el.closest('a, li, button') || el.parentElement;
            if (holder) found.add(holder);
        });

        // 2) 클래스나 링크에 chat이 명시된 요소
        document.querySelectorAll('[class*="chat" i], a[href*="/chat"]').forEach((el) => found.add(el));

        return Array.from(found).filter((el) => {
            const sig = cls(el) + ' ' + (el.getAttribute('aria-label') || '') +
                        ' ' + (el.getAttribute('title') || '') + ' ' + (el.getAttribute('href') || '');
            return !HINTS.CHAT_EXCLUDE.test(sig);
        });
    }

    function detectChatCount() {
        const cands = chatCandidates();
        if (!cands.length) return null;

        let max = 0;
        cands.forEach((holder) => {
            // 부모로 올라가지 않는다 — 옆 메뉴(네이버톡)의 배지를 주워오지 않기 위해
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
     * 5. 피드 감지 — 시간 표기가 있는 항목만 인정
     * ========================================================== */
    function collectFeedItems() {
        const picked = [];

        document.querySelectorAll('li, article, [class*="item" i]').forEach((el) => {
            if (HINTS.JUNK_CLASS.test(cls(el))) return;
            if (el.closest(HINTS.JUNK_ANCESTOR)) return;

            const text = norm(el.innerText || '');
            if (text.length < 10 || text.length > 500) return;
            if (!HINTS.RE_LIKE.test(text) && !HINTS.RE_COMMENT.test(text)) return;
            if (!HINTS.RE_TIME.test(text)) return;   // ← 팝오버 메뉴를 걸러내는 핵심 조건
            if (!isVisible(el)) return;

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

    const titleOf = (i) => (i.type === 'like' ? '[네이버 카페] 좋아요' : '[네이버 카페] 새 댓글');
    const bodyOf = (i) => truncate(i.text, 150);

    /* ============================================================
     * 6. 메인 스캔
     * ========================================================== */
    let lastStat = { chat: null, feed: 0, scanned: false };

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
        lastStat.scanned = true;
        const allKeys = items.map((i) => i.key);

        if (!initialized) {
            saveSeen(allKeys);
            store.set(KEY.INIT, true);
            log('최초 실행 — 기존', allKeys.length, '건 등록(알림 미발송)');
            paint();
            return;
        }

        const seenSet = new Set(loadSeen());
        for (const it of items) {
            if (seenSet.has(it.key)) continue;
            if (it.type === 'like' && !CONFIG.ENABLE_LIKE) continue;
            if (it.type === 'comment' && !CONFIG.ENABLE_COMMENT) continue;
            events.push({ kind: it.type, item: it });
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
        out.push('=== 카페 알리미 v4 진단 ===');
        out.push('URL : ' + location.href);
        const N = getNotificationCtor();
        out.push('권한: ' + (N ? N.permission : '없음') + ' / 감시: ' + (running ? '동작' : '정지'));

        out.push('\n--- 채팅 후보 (네이버톡 제외) ---');
        const cands = chatCandidates();
        out.push('총 ' + cands.length + '개');
        cands.slice(0, 10).forEach((el, i) => {
            out.push(`[${i}] <${el.tagName.toLowerCase()} class="${cls(el)}"> "${truncate(el.textContent, 30)}"`);
        });
        out.push('→ 파싱된 채팅 수: ' + detectChatCount());

        out.push('\n--- 피드 ---');
        const feed = collectFeedItems().map(buildItem);
        out.push('총 ' + feed.length + '개 (like:' + feed.filter(f => f.type === 'like').length +
                 ' / comment:' + feed.filter(f => f.type === 'comment').length + ')');
        feed.slice(0, 8).forEach((f, i) => {
            out.push(`[${i}] (${f.type}) class="${cls(f.el)}"`);
            out.push('     ' + truncate(f.text, 90));
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
        lastStat = { chat: null, feed: 0, scanned: false };
        toast('초기화 완료. 다음 스캔에서 현재 목록을 다시 등록합니다.');
    }

    /* ============================================================
     * 8. UI
     * ========================================================== */
    let panel = null, panelInfo = null;

    function toast(msg) {
        const host = document.documentElement;
        if (!host) return;
        const t = document.createElement('div');
        t.textContent = msg;
        t.style.cssText = 'position:fixed;right:16px;bottom:140px;z-index:2147483647;padding:10px 14px;' +
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
        panel.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:2147483647;width:215px;' +
            'padding:10px 12px;border-radius:10px;background:rgba(20,22,26,.9);color:#fff;' +
            'font:12px/1.5 sans-serif;box-shadow:0 4px 14px rgba(0,0,0,.35)';

        const head = document.createElement('div');
        head.textContent = '🔔 카페 알리미 v4';
        head.style.cssText = 'font-weight:700;color:#03c75a;margin-bottom:4px';

        panelInfo = document.createElement('div');
        panelInfo.style.cssText = 'font-size:11px;opacity:.85;white-space:pre-line';

        const row = document.createElement('div');
        row.style.cssText = 'display:flex;gap:5px;margin-top:8px';
        row.appendChild(mkBtn('테스트', () => enqueue('[네이버 카페] 테스트 알림', '알림이 정상 동작합니다.')));
        row.appendChild(mkBtn('진단', diagnose));
        row.appendChild(mkBtn('초기화', reset));

        panel.append(head, panelInfo, row);
        panel.addEventListener('click', requestPermission);
        host.appendChild(panel);
        paint();
    }

    let secLeft = 0;
    function paint() {
        if (!panelInfo) return;
        const N = getNotificationCtor();
        let line2;
        if (!lastStat.scanned) {
            line2 = '첫 스캔 대기 중…';
        } else {
            const chat = lastStat.chat === null ? '감지실패' : lastStat.chat + '건';
            line2 = '채팅: ' + chat + ' · 피드: ' + lastStat.feed + '건';
        }
        panelInfo.textContent =
            '권한: ' + (N ? N.permission : 'N/A') + '\n' + line2 + '\n' +
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
     * 10. 시작
     * ========================================================== */
    console.log('%c[카페알리미 v4] 로드됨', 'background:#03c75a;color:#fff;padding:2px 6px', location.href);

    mountPanel();
    setInterval(mountPanel, 1000);

    function boot() { mountPanel(); ensureState(); }
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot, { once: true });
    } else { boot(); }
    window.addEventListener('load', () => setTimeout(boot, 500));

    try {
        unsafeWindow.__cafeNotifier = { diagnose, reset, scan: safeScan, CONFIG, HINTS, start, stop };
    } catch (e) { log('unsafeWindow 노출 실패', e); }
})();
