// ==UserScript==
// @name         네이버 카페 '내 소식' 데스크톱 알리미 v15
// @namespace    https://section.cafe.naver.com/
// @version      15.0.0
// @description  네이버 카페 '내 소식'의 안 읽은 댓글·답글·채팅을 데스크톱 알림으로 띄웁니다.
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

    const VERSION = 'v15';

    /* ============================================================
     *  설정
     * ========================================================== */
    const CONFIG = {

        /* ── 알림 켜기/끄기 ────────────────────────────── */
        ALERT_COMMENT: true,      // 댓글  ("OOO 내 글의 댓글")
        ALERT_REPLY:   true,      // 답글  ("OOO 내 댓글의 답글")
        ALERT_CHAT:    true,      // 채팅
        ALERT_LIKE_COMMENT: false,// 내 댓글 좋아요
        ALERT_LIKE_POST:    false,// 내 글 좋아요

        /* ── 내용 비공개 ───────────────────────────────
         * 회사 등 화면이 노출되는 곳에서 쓸 때.
         * 둘 다 켜면 "새 소식 3건이 도착했습니다" 정도만 나온다. */
        HIDE_CONTENT: false,      // 댓글·답글 본문 숨김
        HIDE_SOURCE:  false,      // 카페명·작성자 숨김

        /* ── 화면 표시 ────────────────────────────────── */
        SHOW_PANEL: false,        // 페이지 우측 하단 상태 패널 (Alt+N 으로 여닫기)

        /* ── 동작 ─────────────────────────────────────── */
        RELOAD_INTERVAL_SEC: 30,  // 15초 미만은 권장하지 않음
        CHAT_SOURCE: 'news',      // 'news' = 내 소식 사이드바 뱃지(네이버 갱신이 몇 분 느림)
                                  // 'talk' = 채팅 창을 띄워두고 감지(빠름)
        ONLY_UNREAD: true,        // 안 읽은 항목(초록 배경)만 알림

        /* ── 알림 본문 구성 ────────────────────────────
         *  'latest'  : 최신 항목 하나만 (건수는 제목에)  ← 기본
         *  'compact' : 한 항목 한 줄로 나열
         *  'detail'  : 한 항목 두 줄로 나열
         * 윈도우가 본문을 4줄 안팎에서 잘라내는 건 코드로 못 바꾼다. */
        LIST_STYLE: 'latest',
        TITLE_PREFIX: '[네이버 카페]',

        /* ── 세부 튜닝 ────────────────────────────────── */
        NOTIFY_MODE: 'summary',   // 'summary' | 'each'
        MERGE_MAX_ITEMS: 5,
        NOTIFY_LINE_WIDTH: 52,
        CONTENT_PREFIX: '└ ',
        SHOW_SUBJECT: false,
        TALK_SCAN_INTERVAL_SEC: 10,
        DOM_READY_DELAY_MS: 3000,
        RESCAN_INTERVAL_SEC: 12,
        MAX_FEED_ITEMS: 30,
        MAX_HISTORY: 150,
        NOTIFY_ICON: '',
        BASE_TAG: 'naver-cafe-notify',
        REQUIRE_INTERACTION: false,
        OPEN_LINK_ON_CLICK: false,
        NOTIFY_STAGGER_MS: 700,
        REFRESH_TIMESTAMP: true,
        DEBUG: false
    };

    /* ============================================================ */
    const SUMMARY_TAG = CONFIG.BASE_TAG + '-summary';
    const NEWS_PATH_RE = /\/ca-fe\/home\/my-news/;
    const IS_TALK = /talk\.cafe\.naver\.com$/.test(location.hostname);
    const CHAT_ON_NEWS = CONFIG.ALERT_CHAT && CONFIG.CHAT_SOURCE === 'news';
    const CHAT_ON_TALK = CONFIG.ALERT_CHAT && CONFIG.CHAT_SOURCE === 'talk';

    const TYPES = [
        { id: 'reply', re: /내\s*(댓글|글)의\s*답글/, label: '새 답글', tag: '답글',
          msg: '새 답글이 도착했습니다.', cfg: 'ALERT_REPLY' },
        { id: 'comment', re: /내\s*(글|댓글)의\s*댓글/, label: '새 댓글', tag: '댓글',
          msg: '새 댓글이 도착했습니다.', cfg: 'ALERT_COMMENT' },
        { id: 'like_comment', re: /좋아해요/, label: '내 댓글 좋아요', tag: '댓글♡',
          msg: '내 댓글에 좋아요가 눌렸습니다.', cfg: 'ALERT_LIKE_COMMENT' },
        { id: 'like_post', re: /좋아합니다/, label: '내 글 좋아요', tag: '글♡',
          msg: '내 글에 좋아요가 눌렸습니다.', cfg: 'ALERT_LIKE_POST' }
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
        CHAT_NEWS: 'ncn_chat_news', CHAT_TALK: 'ncn_chat_talk',
        SEEN: 'ncn_seen_keys', INIT: 'ncn_initialized'
    };

    /* ============================================================
     *  유틸
     * ========================================================== */
    const log = (...a) => { if (CONFIG.DEBUG) console.log('%c[카페알리미]', 'color:#03c75a;font-weight:700', ...a); };
    const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
    const cls = (el) => { const c = el.className; return typeof c === 'string' ? c : (c && c.baseVal) || ''; };
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
    function isVisible(el) { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; }

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
        try { const a = typeof raw === 'string' ? JSON.parse(raw) : raw; return Array.isArray(a) ? a : []; }
        catch (e) { return []; }
    }
    function saveSeen(keys) {
        store.set(KEY.SEEN, JSON.stringify(Array.from(new Set(keys.filter(Boolean))).slice(0, CONFIG.MAX_HISTORY)));
    }
    function parseRGB(s) {
        const m = /rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)(?:[,\s/]+([\d.]+))?/.exec(s || '');
        return m ? { r: +m[1], g: +m[2], b: +m[3], a: m[4] === undefined ? 1 : +m[4] } : null;
    }
    const isGreen = (c) => c && c.a >= 0.3 && c.g > c.r && c.g > c.b;

    /* ============================================================
     *  알림 발송
     * ========================================================== */
    const queue = [];
    let sending = false, tagSeq = 0;

    function enqueue(title, body, url, tag) { queue.push({ title, body, url, tag }); drain(); }
    function drain() {
        if (sending) return;
        const job = queue.shift();
        if (!job) return;
        sending = true; send(job);
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
        const useTag = tag || (CONFIG.BASE_TAG + '-' + Date.now() + '-' + (tagSeq++));
        const N = getNotificationCtor();
        if (N && N.permission === 'granted') {
            try {
                const opts = { body, tag: useTag, renotify: true,
                               requireInteraction: CONFIG.REQUIRE_INTERACTION, silent: false };
                if (CONFIG.NOTIFY_ICON) opts.icon = CONFIG.NOTIFY_ICON;
                const n = new N(title, opts);
                n.onclick = () => { onClick(); n.close(); };
                return;
            } catch (e) { log('Notification 실패 → 폴백', e); }
        }
        try { GM_notification({ title, text: body, tag: useTag, onclick: onClick }); }
        catch (e) { console.error('[카페알리미] 알림 발송 실패', e); }
    }

    /* ============================================================
     *  채팅 감지
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

    function newsChatCount() {
        const found = new Set();
        document.querySelectorAll('span, em, a, li, button').forEach((el) => {
            const t = norm(el.textContent);
            if (!/^채팅/.test(t) || t.length > 20) return;
            const holder = el.closest('a, li, button') || el.parentElement;
            if (holder) found.add(holder);
        });
        document.querySelectorAll('[class*="chat" i], a[href*="/chat"]').forEach((el) => found.add(el));
        const cands = Array.from(found).filter((el) => {
            const sig = cls(el) + ' ' + (el.textContent || '') + ' ' + (el.getAttribute('href') || '');
            return !HINTS.CHAT_EXCLUDE.test(sig);
        });
        if (!cands.length) return null;
        let max = 0;
        cands.forEach((holder) => {
            [holder].concat(Array.from(holder.querySelectorAll('em, span, i, b, strong'))).forEach((node) => {
                const t = norm(node.textContent);
                if (!t || t.length > 4 || !/^\d{1,3}\+?$/.test(t)) return;
                const n = parseInt(t, 10);
                if (!isNaN(n) && n > max) max = n;
            });
        });
        return max;
    }

    /* ============================================================
     *  피드 감지 및 파싱
     * ========================================================== */
    function collectFeedItems() {
        const picked = [];
        document.querySelectorAll('li, article, [class*="item" i]').forEach((el) => {
            if (HINTS.JUNK_CLASS.test(cls(el))) return;
            if (el.closest(HINTS.JUNK_ANCESTOR)) return;
            const raw = el.innerText || '';
            const text = norm(raw);
            if (text.length < 10 || text.length > 500) return;
            if (!HINTS.RE_ANY.test(text) || !HINTS.RE_TIME.test(text)) return;
            if (!isVisible(el)) return;
            picked.push({ el, raw, text });
        });
        const leaves = picked.filter((p) => !picked.some((q) => q.el !== p.el && p.el.contains(q.el)));
        return leaves.slice(0, CONFIG.MAX_FEED_ITEMS);
    }

    function classify(lines, text) {
        for (let li = 0; li < lines.length; li++)
            for (const t of TYPES) if (t.re.test(lines[li])) return { type: t, ti: li };
        for (const t of TYPES) if (t.re.test(text)) return { type: t, ti: 0 };
        return { type: null, ti: -1 };
    }

    function parseFooter(lines) {
        let tIdx = -1;
        for (let i = lines.length - 1; i >= 0; i--)
            if (HINTS.RE_TIME.test(lines[i])) { tIdx = i; break; }
        if (tIdx < 0) return { cafe: '', time: '', footStart: lines.length };

        const parts = lines[tIdx].split(HINTS.SEP).map(norm).filter(Boolean);
        if (parts.length >= 2)
            return { cafe: parts.slice(0, -1).join(' · '), time: parts[parts.length - 1], footStart: tIdx };

        const prev = tIdx > 0 ? lines[tIdx - 1] : '';
        const ok = prev && prev.length <= 40 && !HINTS.RE_TIME.test(prev);
        return { cafe: ok ? prev : '', time: norm(lines[tIdx]), footStart: ok ? tIdx - 1 : tIdx };
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
        const content = body[0] || '', subject = body[1] || '';

        const link = el.querySelector('a[href]');
        const href = link ? link.href : '';
        const sig = norm(text.replace(HINTS.RE_TIME_G, ''));
        const key = (href ? href.split('?')[0] : 'nolink') + '::' + hashText(sig);

        let unread = false, color = '', node = el;
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

    /* ============================================================
     *  알림 문구
     * ========================================================== */
    const W = () => CONFIG.NOTIFY_LINE_WIDTH;
    const PAD = () => CONFIG.CONTENT_PREFIX.length + 1;
    const P = () => CONFIG.TITLE_PREFIX ? CONFIG.TITLE_PREFIX + ' ' : '';

    function whoLine(i, withLabel) {
        const label = withLabel ? '[' + i.type.label + ']' : '';
        const who = CONFIG.HIDE_SOURCE ? '' : [i.cafe, i.author].filter(Boolean).join(' · ');
        const s = [label, who].filter(Boolean).join(' ');
        return s ? clipWidth(s, W()) : '';
    }
    function contentLine(i) {
        if (CONFIG.HIDE_CONTENT || !i.content) return '';
        return CONFIG.CONTENT_PREFIX + clipWidth(i.content, W() - PAD());
    }

    /* 단건 알림 본문 */
    function detailBody(i) {
        const out = [];
        const w = whoLine(i, false);
        if (w) out.push(w);
        const c = contentLine(i);
        if (c) out.push(c);
        if (CONFIG.SHOW_SUBJECT && !CONFIG.HIDE_CONTENT && i.subject) out.push('  ' + clipWidth(i.subject, W() - 3));
        if (!out.length) out.push(i.type.msg);   // 전부 숨김일 때
        return out.join('\n');
    }

    /* "답글 1 · 댓글 2 · 채팅 1" — 0인 종류는 생략 */
    function countsLine(items, chatCount) {
        const parts = [];
        TYPES.forEach((t) => {
            const n = items.filter((i) => i.type.id === t.id).length;
            if (n) parts.push(t.tag + ' ' + n);
        });
        if (chatCount) parts.push('채팅 ' + chatCount);
        return parts.join(' · ');
    }

    function compactLine(i, showCafe) {
        const who = CONFIG.HIDE_SOURCE ? '' : [showCafe ? i.cafe : '', i.author].filter(Boolean).join('·');
        const head = '[' + i.type.tag + ']' + (who ? ' ' + who : '');
        const c = CONFIG.HIDE_CONTENT ? '' : i.content;
        return clipWidth(head + (c ? ' ' + c : ''), W());
    }

    function buildSummary(items, chatCount) {
        const total = items.length + (chatCount || 0);
        if (!total) return null;

        if (!items.length) {   // 채팅만
            return { title: P() + '채팅 ' + chatCount,
                     body: '새로운 채팅 메시지가 도착했습니다.', url: '' };
        }
        if (items.length === 1 && !chatCount) {   // 소식 1건
            return { title: P() + items[0].type.label, body: detailBody(items[0]), url: items[0].href };
        }

        /* 건수는 제목으로 — 굵게 나와서 한눈에 들어온다 */
        const title = P() + countsLine(items, chatCount);

        if (CONFIG.HIDE_CONTENT && CONFIG.HIDE_SOURCE) {
            return { title, body: '새 소식 ' + total + '건이 도착했습니다.', url: items[0].href };
        }

        const parts = [];
        if (CONFIG.LIST_STYLE === 'latest') {
            const i = items[0];
            const w = whoLine(i, true); if (w) parts.push(w);
            const c = contentLine(i);   if (c) parts.push(c);
        } else {
            const cafes = new Set(items.map((i) => i.cafe).filter(Boolean));
            const showCafe = cafes.size > 1;
            const n = CONFIG.MERGE_MAX_ITEMS;
            items.slice(0, n).forEach((i) => {
                if (CONFIG.LIST_STYLE === 'detail') {
                    const w = whoLine(i, true); if (w) parts.push(w);
                    const c = contentLine(i);   if (c) parts.push(c);
                } else parts.push(compactLine(i, showCafe));
            });
            if (items.length > n) parts.push('… 외 ' + (items.length - n) + '건');
        }
        if (!parts.length) parts.push('새 소식 ' + total + '건이 도착했습니다.');
        return { title, body: parts.join('\n'), url: items[0].href };
    }

    /* ============================================================
     *  스캔
     * ========================================================== */
    let lastStat = { chat: null, counts: {}, scanned: false };

    function scanNews() {
        const initialized = store.get(KEY.INIT, false);

        let chatCur = null, chatIncreased = false;
        if (CHAT_ON_NEWS) {
            chatCur = newsChatCount();
            lastStat.chat = chatCur;
            if (chatCur !== null) {
                const prev = Number(store.get(KEY.CHAT_NEWS, 0)) || 0;
                if (initialized && chatCur > prev) chatIncreased = true;
                if (chatCur !== prev) store.set(KEY.CHAT_NEWS, chatCur);
            }
        } else if (CHAT_ON_TALK) {
            lastStat.chat = Number(store.get(KEY.CHAT_TALK, 0)) || 0;
        }

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
            if (fresh.length || chatIncreased) {
                const s = buildSummary(enabled, CHAT_ON_NEWS ? (chatCur || 0) : 0);
                if (s) enqueue(s.title, s.body, s.url, SUMMARY_TAG);
            }
        } else {
            if (chatIncreased) enqueue(P() + '채팅 알림', '새로운 채팅 메시지가 도착했습니다.');
            fresh.slice().reverse().forEach((i) => enqueue(P() + i.type.label, detailBody(i), i.href));
        }
        paint();
    }

    let talkInitialized = false;
    function scanTalk() {
        const cur = talkUnreadCount();
        lastStat.chat = cur; lastStat.scanned = true;
        const prev = Number(store.get(KEY.CHAT_TALK, 0)) || 0;
        if (!talkInitialized) talkInitialized = true;
        else if (cur > prev) {
            enqueue(P() + '채팅 ' + cur, '새로운 채팅 메시지가 도착했습니다.');
        }
        if (cur !== prev) store.set(KEY.CHAT_TALK, cur);
        paint();
    }

    function safeScan() {
        try { IS_TALK ? scanTalk() : scanNews(); }
        catch (e) { console.error('[카페알리미] 스캔 오류', e); }
    }

    /* ============================================================
     *  진단 / 초기화
     * ========================================================== */
    function diagnose() {
        const out = [];
        out.push('=== 카페 알리미 ' + VERSION + ' 진단 ===');
        out.push('모드: ' + (IS_TALK ? '채팅 창' : '내 소식') + ' / 본문: ' + CONFIG.LIST_STYLE +
                 ' / 비공개: 내용=' + CONFIG.HIDE_CONTENT + ' 출처=' + CONFIG.HIDE_SOURCE);
        const N = getNotificationCtor();
        out.push('권한: ' + (N ? N.permission : '없음') + ' / 감시: ' + (running ? '동작' : '정지'));

        if (IS_TALK) {
            out.push('\n합산 안읽음 = ' + talkUnreadCount());
        } else {
            out.push('\n채팅 뱃지 = ' + newsChatCount());
            const items = collectFeedItems().map(buildItem);
            const un = items.filter((i) => i.unread);
            out.push('스캔 ' + items.length + '건 / 안읽음 ' + un.length + '건');
            const enabled = un.filter((i) => i.type && CONFIG[i.type.cfg]);
            const s = buildSummary(enabled, CHAT_ON_NEWS ? (newsChatCount() || 0) : 0);
            out.push('\n--- 지금 보낼 알림 ---');
            if (s) {
                out.push('  ' + s.title);
                out.push(s.body.split('\n').map((l) => '  ' + l).join('\n'));
            } else out.push('  (없음)');
            items.slice(0, 3).forEach((f, i) => {
                out.push('\n[' + i + '] ' + (f.unread ? '● 안읽음' : '○ 읽음') + ' (' + (f.type ? f.type.id : '?') + ')');
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
        store.set(KEY.INIT, false); store.set(KEY.SEEN, '[]');
        store.set(KEY.CHAT_NEWS, 0); store.set(KEY.CHAT_TALK, 0);
        talkInitialized = false;
        lastStat = { chat: null, counts: {}, scanned: false };
        toast('초기화 완료');
    }

    /* ============================================================
     *  UI — 기본 숨김, Alt+N 으로 여닫기
     * ========================================================== */
    let panel = null, panelMain = null, panelSub = null, panelFoot = null;
    let panelVisible = CONFIG.SHOW_PANEL;

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
        if (!panelVisible) return;
        const host = document.documentElement;
        if (!host || (panel && host.contains(panel))) return;

        panel = document.createElement('div');
        panel.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:2147483647;width:' +
            (IS_TALK ? '180px' : '235px') + ';padding:9px 11px;border-radius:10px;' +
            'background:rgba(20,22,26,.9);color:#fff;font:12px/1.5 sans-serif;box-shadow:0 4px 14px rgba(0,0,0,.35)';

        const head = document.createElement('div');
        head.textContent = (IS_TALK ? '💬 채팅 감시 ' : '🔔 카페 알리미 ') + VERSION;
        head.style.cssText = 'font-weight:700;color:#03c75a;margin-bottom:3px;font-size:12px';

        panelMain = document.createElement('div'); panelMain.style.cssText = 'font-size:13px;font-weight:600';
        panelSub = document.createElement('div');  panelSub.style.cssText = 'font-size:11px;opacity:.5';
        panelFoot = document.createElement('div'); panelFoot.style.cssText = 'font-size:10px;opacity:.45;margin-top:2px';

        const row = document.createElement('div');
        row.style.cssText = 'display:flex;gap:4px;margin-top:8px';
        if (!IS_TALK) row.appendChild(mkBtn('즉시', () => { stop(); reloadPage(); }));
        row.appendChild(mkBtn('테스트', () => enqueue(P() + '테스트 알림', '알림이 정상 동작합니다.')));
        row.appendChild(mkBtn('진단', diagnose));
        row.appendChild(mkBtn('숨기기', togglePanel));

        panel.append(head, panelMain, panelSub, panelFoot, row);
        panel.addEventListener('click', requestPermission);
        host.appendChild(panel);
        paint();
    }

    function togglePanel() {
        panelVisible = !panelVisible;
        if (panelVisible) mountPanel();
        else if (panel) { panel.remove(); panel = null; panelMain = null; }
    }

    let secLeft = 0;
    function paint() {
        if (!panelMain) return;
        const N = getNotificationCtor();
        if (N && N.permission !== 'granted') {
            panelMain.textContent = '알림 권한 필요';
            panelSub.textContent = '패널을 클릭해 허용';
            panelFoot.textContent = ''; return;
        }
        if (!lastStat.scanned) {
            panelMain.textContent = '첫 스캔 대기 중…';
            panelSub.textContent = ''; panelFoot.textContent = ''; return;
        }
        if (IS_TALK) {
            panelMain.textContent = '안 읽은 채팅 ' + (lastStat.chat || 0);
            panelSub.textContent = '이 창을 열어두세요';
            panelFoot.textContent = CONFIG.TALK_SCAN_INTERVAL_SEC + '초마다 확인'; return;
        }
        const on = [], off = [];
        TYPES.forEach((t) => {
            const s = t.tag + ' ' + (lastStat.counts[t.id] || 0);
            (CONFIG[t.cfg] ? on : off).push(s);
        });
        if (CONFIG.ALERT_CHAT) on.push('채팅 ' + (lastStat.chat === null ? '?' : lastStat.chat));
        panelMain.textContent = on.join(' · ');
        panelSub.textContent = off.length ? off.join(' · ') + '  (알림 꺼짐)' : '';
        panelFoot.textContent = running ? '새로고침 ' + secLeft + '초 전' : '대기 중';
    }

    /* ============================================================
     *  루프
     * ========================================================== */
    let running = false, scanTimer = null, rescanTimer = null, tickTimer = null;

    function reloadPage() {
        if (CONFIG.REFRESH_TIMESTAMP) {
            try {
                const url = new URL(location.href);
                url.searchParams.set('t', String(Date.now()));
                location.replace(url.toString()); return;
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
            paint(); return;
        }
        secLeft = Math.max(15, CONFIG.RELOAD_INTERVAL_SEC);
        scanTimer = setTimeout(() => {
            safeScan();
            if (CONFIG.RESCAN_INTERVAL_SEC > 0)
                rescanTimer = setInterval(safeScan, CONFIG.RESCAN_INTERVAL_SEC * 1000);
        }, CONFIG.DOM_READY_DELAY_MS);
        tickTimer = setInterval(() => {
            secLeft -= 1; paint();
            if (secLeft <= 0) { stop(); reloadPage(); }
        }, 1000);
        paint();
    }

    function stop() {
        running = false;
        clearTimeout(scanTimer); clearInterval(rescanTimer); clearInterval(tickTimer);
        paint();
    }

    function onTargetPage() {
        if (IS_TALK) return CHAT_ON_TALK;
        return NEWS_PATH_RE.test(location.pathname);
    }

    function ensureState() {
        if (onTargetPage() && !running) {
            const N = getNotificationCtor();
            if (N && N.permission === 'granted') start();
            else requestPermission();
        } else if (!onTargetPage() && running) stop();
    }

    function requestPermission() {
        const N = getNotificationCtor();
        if (!N) { toast('이 브라우저는 알림을 지원하지 않습니다'); return; }
        if (N.permission === 'granted') { ensureState(); return; }
        if (N.permission === 'denied') { toast('알림 차단됨.\n주소창 자물쇠 → 알림 → 허용'); paint(); return; }
        N.requestPermission().then((p) => {
            paint();
            if (p === 'granted') ensureState();
            else toast('Alt+N 으로 패널을 열고 클릭해 허용해 주세요');
        }).catch(() => toast('권한 요청 실패'));
    }

    (function hookHistory() {
        ['pushState', 'replaceState'].forEach((m) => {
            const orig = history[m];
            if (typeof orig !== 'function') return;
            history[m] = function () {
                const r = orig.apply(this, arguments);
                setTimeout(ensureState, 500); return r;
            };
        });
        window.addEventListener('popstate', () => setTimeout(ensureState, 500));
    })();

    /* Alt+N 으로 패널 여닫기 (한글 자판의 'ㅜ'도 같은 키) */
    window.addEventListener('keydown', (e) => {
        if (!e.altKey || e.ctrlKey || e.metaKey) return;
        const k = (e.key || '').toLowerCase();
        if (k !== 'n' && k !== 'ㅜ') return;
        e.preventDefault();
        togglePanel();
    }, true);

    /* ============================================================
     *  시작
     * ========================================================== */
    console.log('%c[카페알리미 ' + VERSION + '] ' + (IS_TALK ? '채팅 모드' : '소식 모드') + ' — Alt+N 패널',
                'background:#03c75a;color:#fff;padding:2px 6px', location.href);

    setInterval(mountPanel, 1000);
    function boot() { mountPanel(); ensureState(); }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
    else boot();
    window.addEventListener('load', () => setTimeout(boot, 500));

    try {
        unsafeWindow.__cafeNotifier = { VERSION, IS_TALK, diagnose, reset, scan: safeScan,
                                        panel: togglePanel, CONFIG, TYPES, start, stop };
    } catch (e) { log('unsafeWindow 노출 실패', e); }
})();
