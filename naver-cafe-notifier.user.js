// ==UserScript==
// @name         네이버 카페 '내 소식' 데스크톱 알리미
// @namespace    https://section.cafe.naver.com/
// @version      1.0.0
// @description  네이버 카페 '내 소식'(댓글/답글/좋아해요)과 1:1 채팅을 주기적으로 감지해 윈도우 데스크톱 알림으로 띄웁니다. 백그라운드 모니터링 창 전용.
// @author       -
// @match        https://section.cafe.naver.com/ca-fe/home/my-news*
// @icon         https://cafe.naver.com/favicon.ico
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_notification
// @grant        window.focus
// @run-at       document-idle
// @noframes
// ==/UserScript==

(function () {
    'use strict';

    /* ============================================================
     * 1. 설정
     * ========================================================== */
    const CONFIG = {
        RELOAD_INTERVAL_SEC: 60,   // 새로고침 주기 (초)
        ENABLE_LIKE: false,        // 게시글/댓글 '좋아해요' 알림
        ENABLE_COMMENT: true,      // 댓글 / 답글 알림
        ENABLE_CHAT: true,         // 1:1 채팅 뱃지 감지

        /* --- 세부 튜닝 (필요할 때만 손대면 됩니다) --- */
        DOM_READY_DELAY_MS: 2500,  // 새로고침 직후 파싱까지 대기 시간
        RESCAN_INTERVAL_SEC: 15,   // 새로고침 전까지 추가 스캔 주기 (0이면 비활성)
        MAX_FEED_ITEMS: 15,        // 한 번에 훑을 피드 상위 항목 수
        MAX_HISTORY: 50,           // 중복 방지용 키 보관 개수
        NOTIFY_TAG: 'naver-cafe-group-notification',
        MERGE_FEED_NOTIFICATIONS: true, // 한 번에 여러 건이면 하나로 합쳐서 발송
        REQUIRE_INTERACTION: false,     // true면 클릭 전까지 토스트가 안 사라짐
        OPEN_LINK_ON_CLICK: false,      // true면 클릭 시 새 탭으로 해당 글 열기 (감시 창은 유지)
        NOTIFY_STAGGER_MS: 700,         // 연속 알림 사이 간격
        SHOW_STATUS_CHIP: true,         // 우측 하단 상태 표시
        DEBUG: false
    };

    /* 선택자 / 키워드 후보 — 카페 DOM이 바뀌면 여기만 수정 */
    const HINTS = {
        SCOPE: ['header', '[class*="Gnb" i]', '[id*="gnb" i]', '[class*="Header" i]'],
        CHAT: ['[class*="chat" i]', '[class*="talk" i]', 'a[href*="chat"]', 'a[href*="talk"]'],
        FEED_ROOT: ['main', '[class*="MyNews" i]', '[class*="my_news" i]', '#content', '.content'],
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
        const uniq = Array.from(new Set(keys.filter(Boolean))).slice(0, CONFIG.MAX_HISTORY);
        store.set(KEY.SEEN, JSON.stringify(uniq));
    }

    /* ============================================================
     * 3. 알림 발송 (동일 tag + renotify 로 알림 센터에서 하나로 접힘)
     * ========================================================== */
    const queue = [];
    let sending = false;

    function enqueue(title, body, url) {
        queue.push({ title, body, url });
        drain();
    }

    function drain() {
        if (sending) return;
        const job = queue.shift();
        if (!job) return;
        sending = true;
        send(job);
        setTimeout(() => { sending = false; drain(); }, CONFIG.NOTIFY_STAGGER_MS);
    }

    function send({ title, body, url }) {
        const onClick = () => {
            try { window.focus(); } catch (e) { log('focus 실패', e); }
            if (CONFIG.OPEN_LINK_ON_CLICK && url) window.open(url, '_blank');
        };

        // 1순위: 표준 Notification API (tag + renotify 지원)
        try {
            if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
                const n = new Notification(title, {
                    body: body,
                    tag: CONFIG.NOTIFY_TAG,
                    renotify: true,
                    requireInteraction: CONFIG.REQUIRE_INTERACTION,
                    silent: false,
                    icon: 'https://cafe.naver.com/favicon.ico'
                });
                n.onclick = () => { onClick(); n.close(); };
                log('알림 발송', title, body);
                return;
            }
        } catch (e) {
            log('Notification 실패 → GM_notification 폴백', e);
        }

        // 2순위: GM_notification
        try {
            GM_notification({ title: title, text: body, tag: CONFIG.NOTIFY_TAG, onclick: onClick });
        } catch (e) {
            log('GM_notification도 실패', e);
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
        if (!chatEls.length) return null; // 채팅 아이콘 자체를 못 찾음 = 감지 실패

        let max = 0; // 아이콘은 있는데 뱃지가 없으면 0건
        for (const el of chatEls) {
            const nodes = [el].concat(Array.from(el.querySelectorAll('em, span, i, b, strong, div')));
            for (const node of nodes) {
                const t = norm(node.textContent);
                if (!t || t.length > 4) continue;      // 뱃지 텍스트는 짧다
                if (!/^\d{1,3}\+?$/.test(t)) continue; // "3", "99+" 형태만
                const n = parseInt(t, 10);
                if (!isNaN(n) && n > max) max = n;
            }
        }
        return max;
    }

    /* ============================================================
     * 5. '내 소식' 피드 감지
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

        // 중첩 제거: 다른 후보를 품고 있는 조상 노드는 버리고 말단만 남김
        const leaves = picked.filter((p) => !picked.some((q) => q.el !== p.el && p.el.contains(q.el)));
        return leaves.slice(0, CONFIG.MAX_FEED_ITEMS);
    }

    function buildItem({ el, text }) {
        const link = el.querySelector('a[href]');
        const href = link ? link.href : '';
        const key = (href ? href.split('?')[0] : 'nolink') + '::' + hashText(text);

        // 우선순위: '좋아해요'가 있으면 좋아요("댓글을 좋아해요"도 좋아요로 취급)
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

    function titleOf(item) {
        return item.type === 'like' ? '[네이버 카페] 좋아해요' : '[네이버 카페] 새 댓글';
    }

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
    function scan() {
        const initialized = store.get(KEY.INIT, false);
        const events = [];

        /* --- 채팅 --- */
        if (CONFIG.ENABLE_CHAT) {
            const cur = detectChatCount();
            if (cur !== null) {
                const prev = Number(store.get(KEY.CHAT, 0)) || 0;
                log('채팅 뱃지', prev, '→', cur);
                if (initialized && cur > prev) events.push({ kind: 'chat' });
                if (cur !== prev) store.set(KEY.CHAT, cur); // 줄어든 경우도 갱신(다음 증가 감지용)
            } else {
                log('채팅 아이콘 감지 실패 — HINTS.CHAT 선택자 확인 필요');
            }
        }

        /* --- 피드 --- */
        const items = collectFeedItems().map(buildItem).filter((i) => i.type);
        const allKeys = items.map((i) => i.key);
        log('피드 항목', items.length, '건');

        // 최초 실행: 기존 목록은 알림 없이 '이미 본 것'으로 등록
        if (!initialized) {
            saveSeen(allKeys);
            store.set(KEY.INIT, true);
            log('최초 실행 — 기존', allKeys.length, '건 등록 (알림 미발송)');
            return;
        }

        const seen = loadSeen();
        const seenSet = new Set(seen);
        const fresh = items.filter((i) => !seenSet.has(i.key));

        for (const it of fresh) {
            if (it.type === 'like' && !CONFIG.ENABLE_LIKE) continue;   // 꺼둔 종류는 조용히 스킵
            if (it.type === 'comment' && !CONFIG.ENABLE_COMMENT) continue;
            events.push({ kind: it.type, item: it });
        }

        // 이번에 본 항목은 발송 여부와 무관하게 전부 기록 (설정 토글 시 과거 알림 폭탄 방지)
        saveSeen(allKeys.concat(seen));

        dispatch(events);
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
            // 같은 tag는 뒤에 온 알림이 앞을 대체하므로, 최신 항목이 마지막에 남도록 역순 발송
            feed.slice().reverse().forEach((i) => enqueue(titleOf(i), bodyOf(i), i.href));
        }
    }

    function safeScan() {
        try { scan(); } catch (e) { console.error('[카페알리미] 스캔 오류', e); }
    }

    /* ============================================================
     * 7. UI (권한 배너 / 상태 칩)
     * ========================================================== */
    function makeBox(text, bottom) {
        const box = document.createElement('div');
        box.textContent = text;
        box.style.cssText = [
            'position:fixed', 'right:16px', 'bottom:' + bottom + 'px', 'z-index:2147483647',
            'padding:10px 14px', 'border-radius:8px', 'font:13px/1.4 -apple-system,"Malgun Gothic",sans-serif',
            'color:#fff', 'background:rgba(3,199,90,.92)', 'box-shadow:0 2px 10px rgba(0,0,0,.25)',
            'max-width:300px', 'white-space:pre-wrap'
        ].join(';');
        document.body.appendChild(box);
        return box;
    }

    let chip = null;
    function updateChip(secLeft) {
        if (!CONFIG.SHOW_STATUS_CHIP) return;
        if (!chip) {
            chip = makeBox('', 16);
            chip.style.background = 'rgba(0,0,0,.55)';
            chip.style.pointerEvents = 'none';
            chip.style.padding = '6px 10px';
            chip.style.fontSize = '12px';
        }
        chip.textContent = '🔔 감시 중 · 새로고침 ' + secLeft + '초 전';
    }

    /* ============================================================
     * 8. 루프 시작
     * ========================================================== */
    function startLoop() {
        const intervalSec = Math.max(15, CONFIG.RELOAD_INTERVAL_SEC); // 과도한 새로고침 방지
        let rescanTimer = null;

        setTimeout(() => {
            safeScan();
            if (CONFIG.RESCAN_INTERVAL_SEC > 0) {
                rescanTimer = setInterval(safeScan, CONFIG.RESCAN_INTERVAL_SEC * 1000);
            }
        }, CONFIG.DOM_READY_DELAY_MS);

        let left = intervalSec;
        const tick = setInterval(() => {
            left -= 1;
            updateChip(Math.max(0, left));
            if (left <= 0) {
                clearInterval(tick);
                if (rescanTimer) clearInterval(rescanTimer);
                location.reload();
            }
        }, 1000);

        updateChip(left);
        log('감시 시작 — 새로고침 주기', intervalSec, '초');
    }

    function boot() {
        if (typeof Notification === 'undefined') {
            console.warn('[카페알리미] 이 브라우저는 Notification API를 지원하지 않습니다.');
            return;
        }

        if (Notification.permission === 'granted') { startLoop(); return; }

        if (Notification.permission === 'denied') {
            makeBox('알림이 차단되어 있습니다.\n주소창 자물쇠 → 알림 → 허용 으로 바꾼 뒤 새로고침하세요.', 16)
                .style.background = 'rgba(220,70,70,.92)';
            return; // 권한 없이 새로고침 루프를 돌릴 이유가 없음
        }

        // permission === 'default' — 자동 요청 후, 실패하면 클릭 유도 배너
        const ask = () => Notification.requestPermission().then((p) => {
            if (p === 'granted') {
                if (banner) banner.remove();
                startLoop();
            }
        }).catch((e) => log('권한 요청 실패', e));

        const banner = makeBox('데스크톱 알림 권한이 필요합니다.\n이 상자를 클릭해 허용해 주세요.', 16);
        banner.style.cursor = 'pointer';
        banner.addEventListener('click', ask);
        ask(); // 제스처 없이도 되는 환경에서는 바로 통과
    }

    boot();
})();