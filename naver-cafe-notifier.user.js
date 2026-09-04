// ==UserScript==
// @name         네이버 카페 '내 소식' 데스크톱 알리미 v12
// @namespace    https://section.cafe.naver.com/
// @version      12.0.0
// @description  네이버 카페 '내 소식'의 안 읽은 댓글·답글·채팅을 하나의 알림으로 모아 띄웁니다.
// @author       -
// @match        https://section.cafe.naver.com/*
// @match        https://talk.cafe.naver.com/*
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

    const VERSION = 'v12';

    /* ============================================================
     * 1. 설정
     * ========================================================== */
    const CONFIG = {
        RELOAD_INTERVAL_SEC: 30,   // 15초 밑으로는 페이지 로딩 시간과 겹쳐 권장하지 않음

        ENABLE_REPLY: true,
        ENABLE_COMMENT: true,
        ENABLE_LIKE_COMMENT: false,
        ENABLE_LIKE_POST: false,

        /* 채팅
         * 좌측 사이드바 뱃지는 네이버가 몇 분 늦게 갱신한다.
         * 더 빠른 감지가 필요하면 채팅 창을 띄우고 ON_TALK을 켜되,
         * 두 개를 동시에 켜면 같은 메시지로 두 번 알릴 수 있으니 하나만 쓸 것. */
        ENABLE_CHAT_ON_NEWS: true,
        ENABLE_CHAT_ON_TALK: false,
        TALK_SCAN_INTERVAL_SEC: 10,

        ONLY_UNREAD: true,
        SHOW_SUBJECT: false,

        /* --- 알림 방식 ---
         * 'summary' : 안 읽은 것을 전부 하나의 알림에 모아 계속 갱신 (카톡 방식)
         *             알림 센터에 항상 1건만 있고 펼칠 필요가 없다.
         * 'each'    : 새 항목이 생길 때마다 개별 알림을 쌓는다. */
        NOTIFY_MODE: 'summary',
        NOTIFY_LINE_WIDTH: 52,
        MERGE_MAX_ITEMS: 3,
        CONTENT_PREFIX: '└ ',

        NOTIFY_ICON: '',
        DOM_READY_DELAY_MS: 3000,
        RESCAN_INTERVAL_SEC: 12,
        MAX_FEED_ITEMS: 30,
        MAX_HISTORY: 150,
        BASE_TAG: 'naver-cafe-notify',
        REQUIRE_INTERACTION: false,
        OPEN_LINK_ON_CLICK: false,
        NOTIFY_STAGGER_MS: 700,
        REFRESH_TIMESTAMP: true,
        SHOW_PANEL: true,
        DEBUG: false
    };

    const SUMMARY_TAG = CONFIG.BASE_TAG + '-summary';
    const NEWS_PATH_RE = /\/ca-fe\/home\/my-news/;
    const IS_TALK = /talk\.cafe\.naver\.com$/.test(location.hostname);

    const TYPES = [
        { id: 'reply',        re: /내\s*(댓글|글)의\s*답글/, label: '새 답글',        short: '답글',   cfg: 'ENABLE_REPLY' },
        { id: 'comment',      re: /내\s*(글|댓글)의\s*댓글/, label: '새 댓글',        short: '댓글',   cfg: 'ENABLE_COMMENT' },
        { id: 'like_comment', re: /좋아해요/,                label: '내 댓글 좋아요', short: '댓글♡', cfg: 'ENABLE_LIKE_COMMENT' },
        { id: 'like_post',    re: /좋아합니다/,              label: '내 글 좋아요',   short: '글♡',   cfg: 'ENABLE_LIKE_POST' }
    ];

    const HINTS = {
        RE_ANY: /좋아해요|좋아합니다|댓글|답글/,
        RE_TIME: /(방금\s*전|\d+\s*(초|분|시간|일|주|개월|년)\s*전|어제|그저께|그제|\d{4}\.\s?\d{1,2}\.\s?\d{1,2})/,
        RE_TIME_G: /방금\s*전|\d+\s*(초|분|시간|일|주|개월|년)\s*전|어제|그저께|그제|\d{4}\.\s?\d{1,2}\.\s?\d{1,2}\.?/g,
        SEP: /\s*[·・ㆍ•∙‧|]\s*/,
        JUNK_CLASS: /popover|pop_over|tooltip|layer|dropdown|modal|gnb_/i,
        JUNK_ANCESTOR: '[class*="popover" i], [class*="pop_over" i], [class*="tooltip" i], [class*="layer" i]',
        CHAT_EXCLUDE: /네이버톡|스마트봇|smartbot|mail|메일|쪽지/i
    };

    const KEY = {
        CHAT_NEWS: 'ncn_chat_news',
        CHAT_TALK: 'ncn_chat_talk',
        SEEN: 'ncn_seen_keys',
        INIT: 'ncn_initialized'
    };

    /* ============================================================
     * 2. 유틸
     * ========================================================== */
    const log = (...a) => { if (CONFIG.DEBUG) console.log('%c[카페알리미]', 'color:#03c75a;font-weight:700', ...a); };
    const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
    const cls = (el) => {
        const c = el.className;
        return typeof c === 'string' ? c : (c && c.baseVal) || '';
    };
    const truncate = (s, n) => { s = norm(s); return s.length > n ? s.slice(0, n - 1) + '…' : s; };

    function charWidth(ch) { return ch.charCodeAt(0) < 0x1100 ? 1 : 2; }
    function clipWidth(s, maxW) {
        s = norm(s);
        let w = 0, out = '';
        for (const ch of s) {
            const cw = charWidth(ch);
            if (w + cw > maxW - 1) return out + '…';
            out += ch; w += cw;
        }
        return out;
    }

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

    function parseRGB(s) {
        const m = /rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)(?:[,\s/]+([\d.]+))?/.exec(s || '');
        if (!m) return null;
        return { r: +m[1], g: +m[2], b: +m[3], a: m[4] === undefined ? 1 : +m[4] };
    }
    const isGreen = (c) => c && c.a >= 0.3 && c.g > c.r && c.g > c.b;

    /* ============================================================
     * 3. 알림 발송
     * ========================================================== */
    const queue = [];
    let sending = false;
    let tagSeq = 0;

    function enqueue(title, body, url, tag) { queue.push({ title, body, url, tag }); drain(); }

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

    function send({ title, body, url, tag }) {
        const onClick = () => {
            try { window.focus(); } catch (e) { log('focus 실패', e); }
            if (CONFIG.OPEN_LINK_ON_CLICK && url) window.open(url, '_blank');
        };

        /* 요약 모드는 고정 tag를 써서 이전 알림을 갱신(대체)한다.
         * 개별 모드는 매번 다른 tag를 줘서 쌓이게 한다. */
        const useTag = tag || (CONFIG.BASE_TAG + '-' + Date.now() + '-' + (tagSeq++));

        const N = getNotificationCtor();
        if (N && N.permission === 'granted') {
            try {
                const opts = {
                    body: body,
                    tag: useTag,
                    renotify: true,      // 같은 tag여도 다시 소리·팝업이 뜨게 한다
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
            GM_notification({ title: title, text: body, tag: useTag, onclick: onClick });
        } catch (e) { console.error('[카페알리미] 알림 발송 실패', e); }
    }

    /* ============================================================
     * 4. 채팅 감지
     * ========================================================== */
    function talkUnreadCount() {
        let total = 0;
        document.querySelectorAll('em, span, i, b, strong, div').forEach((node) => {
            if (node.children.length) return;
            const t = norm(node.textContent);
            if (!/^\d{1,3}\+?$/.test(t)) return;
            let bg = '';
            try { bg = getComputedStyle(node).backgroundColor; } catch (e) { return; }
            if (!isGreen(parseRGB(bg))) return;
            total += parseInt(t, 10) || 0;
        });
        return total;
    }

    function newsChatCandidates() {
        const found = new Set();
        document.querySelectorAll('span, em, a, li, button').forEach((el) => {
            const t = norm(el.textContent);
            if (!/^채팅/.test(t) || t.length > 20) return;
            const holder = el.closest('a, li, button') || el.parentElement;
            if (holder) found.add(holder);
        });
        document.querySelectorAll('[class*="chat" i], a[href*="/chat"]').forEach((el) => found.add(el));
        return Array.from(found).filter((el) => {
            const sig = cls(el) + ' ' + (el.textContent || '') + ' ' + (el.getAttribute('href') || '');
            return !HINTS.CHAT_EXCLUDE.test(sig);
        });
    }

    function newsChatCount() {
        const cands = newsChatCandidates();
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
     * 5. 피드 감지 및 파싱
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

    function classify(lines, text) {
        for (let li = 0; li < lines.length; li++) {
            for (const t of TYPES) if (t.re.test(lines[li])) return { type: t, ti: li };
        }
        for (const t of TYPES) if (t.re.test(text)) return { type: t, ti: 0 };
        return { type: null, ti: -1 };
    }

    function parseFooter(lines) {
        let tIdx = -1;
        for (let i = lines.length - 1; i >= 0; i--) {
            if (HINTS.RE_TIME.test(lines[i])) { tIdx = i; break; }
        }
        if (tIdx < 0) return { cafe: '', time: '', footStart: lines.length };

        const parts = lines[tIdx].split(HINTS.SEP).map(norm).filter(Boolean);
        if (parts.length >= 2) {
            return { cafe: parts.slice(0, -1).join(' · '), time: parts[parts.length - 1], footStart: tIdx };
        }
        const prev = tIdx > 0 ? lines[tIdx - 1] : '';
        const looksLikeCafe = prev && prev.length <= 40 && !HINTS.RE_TIME.test(prev);
        return {
            cafe: looksLikeCafe ? prev : '',
            time: norm(lines[tIdx]),
            footStart: looksLikeCafe ? tIdx - 1 : tIdx
        };
    }

    function buildItem({ el, raw, text }) {
        const lines = raw.split('\n').map(norm).filter(Boolean);
        const { type, ti } = classify(lines, text);
        const { cafe, time, footStart } = parseFooter(lines);

        let author = '';
        if (ti >= 0) {
            const m = /^(.+?)\s*(?:님이)?\s*내\s*(?:글|댓글)(?:을|의)/.exec(lines[ti]);
            if (m && m[1]) author = norm(m[1]);
            else if (ti > 0) author = lines[ti - 1];
        }
        if (/^\d+명$/.test(author)) author = '';

        const body = ti >= 0 ? lines.slice(ti + 1, Math.max(ti + 1, footStart)) : [];
        const content = body[0] || '';
        const subject = body[1] || '';

        const link = el.querySelector('a[href]');
        const href = link ? link.href : '';
        const sig = norm(text.replace(HINTS.RE_TIME_G, ''));
        const key = (href ? href.split('?')[0] : 'nolink') + '::' + hashText(sig);

        let unread = false, color = '';
        let node = el;
        for (let i = 0; i < 4 && node && node !== document.body; i++, node = node.parentElement) {
            let bg = '';
            try { bg = getComputedStyle(node).backgroundColor; } catch (e) { continue; }
            const c = parseRGB(bg);
            if (!c || c.a < 0.05) continue;
            if (Math.abs(c.r - c.g) <= 2 && Math.abs(c.g - c.b) <= 2) continue;
            if (c.g > c.r && c.g > c.b) { unread = true; color = bg; break; }
        }

        return { key, type, lines, text, cafe, time, author, content, subject, href, el, unread, color };
    }

    const W = () => CONFIG.NOTIFY_LINE_WIDTH;

    function entryLines(i, withLabel) {
        const who = [i.cafe, i.author].filter(Boolean).join(' · ');
        const head = clipWidth((withLabel ? '[' + i.type.label + '] ' : '') + who, W());
        const out = [head || clipWidth(i.text, W())];
        if (i.content) {
            const pad = CONFIG.CONTENT_PREFIX.length + 1;
            out.push(CONFIG.CONTENT_PREFIX + clipWidth(i.content, W() - pad));
        }
        if (CONFIG.SHOW_SUBJECT && i.subject) out.push('  ' + clipWidth(i.subject, W() - 3));
        return out.join('\n');
    }

    /* 안 읽은 것 전부를 하나의 알림으로. 고정 tag라 이전 알림을 갱신한다. */
    function sendSummary(items, chatCount) {
        const total = items.length + (chatCount || 0);
        if (!total) return;

        if (items.length === 1 && !chatCount) {
            const i = items[0];
            enqueue('[네이버 카페] ' + i.type.label, entryLines(i, false), i.href, SUMMARY_TAG);
            return;
        }

        const parts = [];
        if (chatCount) parts.push('💬 안 읽은 채팅 ' + chatCount + '건');
        const n = CONFIG.MERGE_MAX_ITEMS;
        items.slice(0, n).forEach((i) => parts.push(entryLines(i, true)));
        if (items.length > n) parts.push('… 외 ' + (items.length - n) + '건');

        enqueue('[네이버 카페] 안 읽은 소식 ' + total + '건',
                parts.join('\n'),
                items[0] ? items[0].href : '',
                SUMMARY_TAG);
    }

    /* ============================================================
     * 6. 스캔 — 내 소식
     * ========================================================== */
    let lastStat = { chat: null, counts: {}, scanned: false };

    function scanNews() {
        const initialized = store.get(KEY.INIT, false);

        /* 채팅 */
        let chatCur = null, chatIncreased = false;
        if (CONFIG.ENABLE_CHAT_ON_NEWS) {
            chatCur = newsChatCount();
            lastStat.chat = chatCur;
            if (chatCur !== null) {
                const prev = Number(store.get(KEY.CHAT_NEWS, 0)) || 0;
                if (initialized && chatCur > prev) chatIncreased = true;
                if (chatCur !== prev) store.set(KEY.CHAT_NEWS, chatCur);
            }
        } else if (CONFIG.ENABLE_CHAT_ON_TALK) {
            lastStat.chat = Number(store.get(KEY.CHAT_TALK, 0)) || 0;
        }

        /* 피드 */
        const items = collectFeedItems().map(buildItem).filter((i) => i.type);
        const unreadItems = items.filter((i) => i.unread);

        const counts = {};
        TYPES.forEach((t) => { counts[t.id] = 0; });
        unreadItems.forEach((i) => { counts[i.type.id] += 1; });
        lastStat.counts = counts;
        lastStat.scanned = true;

        const allKeys = items.map((i) => i.key);
        if (!initialized) {
            saveSeen(allKeys);
            store.set(KEY.INIT, true);
            log('최초 실행 —', allKeys.length, '건 등록');
            paint();
            return;
        }

        const pool = CONFIG.ONLY_UNREAD ? unreadItems : items;
        const enabled = pool.filter((i) => CONFIG[i.type.cfg]);
        const seenSet = new Set(loadSeen());
        const fresh = enabled.filter((i) => !seenSet.has(i.key));

        saveSeen(allKeys.concat(loadSeen()));

        if (CONFIG.NOTIFY_MODE === 'summary') {
            // 새 항목이 있거나 채팅이 늘었을 때만 알림을 갱신한다
            if (fresh.length || chatIncreased) {
                sendSummary(enabled, CONFIG.ENABLE_CHAT_ON_NEWS ? (chatCur || 0) : 0);
            }
        } else {
            if (chatIncreased) {
                enqueue('[네이버 카페] 채팅 알림', '새로운 채팅 메시지가 도착했습니다.');
            }
            fresh.slice().reverse().forEach((i) =>
                enqueue('[네이버 카페] ' + i.type.label, entryLines(i, false), i.href));
        }
        paint();
    }

    /* ============================================================
     * 7. 스캔 — 채팅 창
     * ========================================================== */
    let talkInitialized = false;

    function scanTalk() {
        const cur = talkUnreadCount();
        lastStat.chat = cur;
        lastStat.scanned = true;
        const prev = Number(store.get(KEY.CHAT_TALK, 0)) || 0;
        if (!talkInitialized) {
            talkInitialized = true;
        } else if (cur > prev) {
            enqueue('[네이버 카페] 채팅 알림',
                    '새로운 채팅 메시지가 도착했습니다.' + (cur > 1 ? ' (안 읽음 ' + cur + ')' : ''));
        }
        if (cur !== prev) store.set(KEY.CHAT_TALK, cur);
        paint();
    }

    function safeScan() {
        try { IS_TALK ? scanTalk() : scanNews(); }
        catch (e) { console.error('[카페알리미] 스캔 오류', e); }
    }

    /* ============================================================
     * 8. 진단
     * ========================================================== */
    function diagnose() {
        const out = [];
        out.push('=== 카페 알리미 ' + VERSION + ' 진단 ===');
        out.push('모드: ' + (IS_TALK ? '채팅 창' : '내 소식') + ' / 알림방식: ' + CONFIG.NOTIFY_MODE);
        const N = getNotificationCtor();
        out.push('권한: ' + (N ? N.permission : '없음') + ' / 감시: ' + (running ? '동작' : '정지'));

        if (IS_TALK) {
            out.push('\n--- 채팅 배지 ---');
            let n = 0;
            document.querySelectorAll('em, span, i, b, strong, div').forEach((node) => {
                if (node.children.length) return;
                const t = norm(node.textContent);
                if (!/^\d{1,3}\+?$/.test(t)) return;
                let bg = '';
                try { bg = getComputedStyle(node).backgroundColor; } catch (e) { return; }
                if (n < 10) out.push(`  "${t}" bg=${bg} 초록=${isGreen(parseRGB(bg))}`);
                n++;
            });
            out.push('  합산 안읽음 = ' + talkUnreadCount());
        } else {
            out.push('\n채팅 뱃지 = ' + newsChatCount() + ' (사이드바 기준, 네이버 갱신이 몇 분 늦을 수 있음)');
            const items = collectFeedItems().map(buildItem);
            const un = items.filter((i) => i.unread);
            out.push('스캔 ' + items.length + '건 / 안읽음 ' + un.length + '건');
            const enabled = un.filter((i) => i.type && CONFIG[i.type.cfg]);
            out.push('\n--- 지금 보낼 알림 미리보기 ---');
            if (enabled.length || newsChatCount()) {
                const c = CONFIG.ENABLE_CHAT_ON_NEWS ? (newsChatCount() || 0) : 0;
                const total = enabled.length + c;
                if (enabled.length === 1 && !c) {
                    out.push('  제목: [네이버 카페] ' + enabled[0].type.label);
                    out.push(entryLines(enabled[0], false).split('\n').map(l => '  ' + l).join('\n'));
                } else {
                    out.push('  제목: [네이버 카페] 안 읽은 소식 ' + total + '건');
                    if (c) out.push('  💬 안 읽은 채팅 ' + c + '건');
                    enabled.slice(0, CONFIG.MERGE_MAX_ITEMS).forEach((i) =>
                        out.push(entryLines(i, true).split('\n').map(l => '  ' + l).join('\n')));
                }
            } else out.push('  (없음)');

            items.slice(0, 3).forEach((f, i) => {
                out.push('\n[' + i + '] ' + (f.unread ? '● 안읽음' : '○ 읽음') + ' (' + (f.type ? f.type.id : '?') + ')');
                out.push('  RAW줄: ' + JSON.stringify(f.lines));
                out.push('  카페=[' + f.cafe + '] 작성자=[' + f.author + '] 내용=[' + truncate(f.content, 40) + ']');
            });
        }

        const text = out.join('\n');
        console.log(text);
        try { navigator.clipboard.writeText(text); toast('진단 결과 복사 완료'); }
        catch (e) { toast('진단 결과를 콘솔에 출력했습니다'); }
        return text;
    }

    function reset() {
        store.set(KEY.INIT, false);
        store.set(KEY.SEEN, '[]');
        store.set(KEY.CHAT_NEWS, 0);
        store.set(KEY.CHAT_TALK, 0);
        talkInitialized = false;
        lastStat = { chat: null, counts: {}, scanned: false };
        toast('초기화 완료');
    }

    /* ============================================================
     * 9. UI
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
        panel.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:2147483647;width:' +
            (IS_TALK ? '180px' : '235px') + ';' +
            'padding:9px 11px;border-radius:10px;background:rgba(20,22,26,.9);color:#fff;' +
            'font:12px/1.5 sans-serif;box-shadow:0 4px 14px rgba(0,0,0,.35)';

        const head = document.createElement('div');
        head.textContent = (IS_TALK ? '💬 채팅 감시 ' : '🔔 카페 알리미 ') + VERSION;
        head.style.cssText = 'font-weight:700;color:#03c75a;margin-bottom:3px;font-size:12px';

        panelMain = document.createElement('div');
        panelMain.style.cssText = 'font-size:13px;font-weight:600';
        panelSub = document.createElement('div');
        panelSub.style.cssText = 'font-size:11px;opacity:.5';
        panelFoot = document.createElement('div');
        panelFoot.style.cssText = 'font-size:10px;opacity:.45;margin-top:2px';

        const row = document.createElement('div');
        row.style.cssText = 'display:flex;gap:4px;margin-top:8px';
        if (!IS_TALK) row.appendChild(mkBtn('즉시', () => { stop(); reloadPage(); }));
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
            panelFoot.textContent = '';
            return;
        }

        if (IS_TALK) {
            panelMain.textContent = '안 읽은 채팅 ' + (lastStat.chat || 0);
            panelSub.textContent = '이 창을 열어두세요';
            panelFoot.textContent = CONFIG.TALK_SCAN_INTERVAL_SEC + '초마다 확인';
            return;
        }

        const on = [], off = [];
        TYPES.forEach((t) => {
            const s = t.short + ' ' + (lastStat.counts[t.id] || 0);
            (CONFIG[t.cfg] ? on : off).push(s);
        });
        if (CONFIG.ENABLE_CHAT_ON_NEWS || CONFIG.ENABLE_CHAT_ON_TALK) {
            on.push('채팅 ' + (lastStat.chat === null ? '?' : lastStat.chat));
        }

        panelMain.textContent = on.join(' · ');
        panelSub.textContent = off.length ? off.join(' · ') + '  (알림 꺼짐)' : '';
        panelFoot.textContent = running ? '새로고침 ' + secLeft + '초 전' : '대기 중';
    }

    /* ============================================================
     * 10. 루프
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

        if (IS_TALK) {
            scanTimer = setTimeout(safeScan, CONFIG.DOM_READY_DELAY_MS);
            rescanTimer = setInterval(safeScan, CONFIG.TALK_SCAN_INTERVAL_SEC * 1000);
            paint();
            return;
        }

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

    function onTargetPage() {
        if (IS_TALK) return CONFIG.ENABLE_CHAT_ON_TALK;
        return NEWS_PATH_RE.test(location.pathname);
    }

    function ensureState() {
        if (onTargetPage() && !running) {
            const N = getNotificationCtor();
            if (N && N.permission === 'granted') start();
            else requestPermission();
        } else if (!onTargetPage() && running) {
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
    console.log('%c[카페알리미 ' + VERSION + '] ' + (IS_TALK ? '채팅 모드' : '소식 모드'),
                'background:#03c75a;color:#fff;padding:2px 6px', location.href);

    if (onTargetPage()) {
        mountPanel();
        setInterval(mountPanel, 1000);
    }

    function boot() { if (onTargetPage()) mountPanel(); ensureState(); }
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot, { once: true });
    } else { boot(); }
    window.addEventListener('load', () => setTimeout(boot, 500));

    try {
        unsafeWindow.__cafeNotifier = { VERSION, IS_TALK, diagnose, reset, scan: safeScan, CONFIG, TYPES, start, stop };
    } catch (e) { log('unsafeWindow 노출 실패', e); }
})();
