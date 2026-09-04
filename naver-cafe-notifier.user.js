// ==UserScript==
// @name         네이버 카페 '내 소식' 알리미
// @namespace    https://section.cafe.naver.com/
// @version      17.0.0
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

    const VERSION = 'v17';

    /* ============================================================
     *  기본값 — 켜고 끄기는 화면의 패널에서 하며 설정은 저장된다
     * ========================================================== */
    const CONFIG = {
        DEFAULT_COMMENT: true,    // 댓글 알림
        DEFAULT_REPLY:   true,    // 답글 알림
        DEFAULT_CHAT:    true,    // 채팅 알림
        DEFAULT_SECRET:  false,   // 비밀 모드 (내용 숨김)

        SECRET_HIDES_SOURCE: true,// 비밀 모드에서 카페명·작성자까지 숨길지

        RELOAD_INTERVAL_SEC: 30,  // 15초 미만 비권장
        CHAT_SOURCE: 'news',      // 'news' = 사이드바 뱃지 / 'talk' = 채팅 창
        ONLY_UNREAD: true,

        LIST_STYLE: 'latest',     // 'latest' | 'compact' | 'detail'
        TITLE_PREFIX: '[네이버 카페]',

        /* 세부 */
        NOTIFY_MODE: 'summary',
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

    const SUMMARY_TAG = CONFIG.BASE_TAG + '-summary';
    const NEWS_PATH_RE = /\/ca-fe\/home\/my-news/;
    const IS_TALK = /talk\.cafe\.naver\.com$/.test(location.hostname);

    /* 좋아요는 알림 대상이 아니지만, 댓글로 오분류되지 않도록 분류 규칙은 남긴다 */
    const TYPES = [
        { id: 'reply',   re: /내\s*(댓글|글)의\s*답글/, label: '새 답글', tag: '답글',
          msg: '새 답글이 도착했습니다.', pref: 'reply',   ui: true },
        { id: 'comment', re: /내\s*(글|댓글)의\s*댓글/, label: '새 댓글', tag: '댓글',
          msg: '새 댓글이 도착했습니다.', pref: 'comment', ui: true },
        { id: 'like_comment', re: /좋아해요/,   label: '좋아요', tag: '♡', msg: '', pref: null, ui: false },
        { id: 'like_post',    re: /좋아합니다/, label: '좋아요', tag: '♡', msg: '', pref: null, ui: false }
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
        PREFS: 'ncn_prefs', CHAT_NEWS: 'ncn_chat_news', CHAT_TALK: 'ncn_chat_talk',
        SEEN: 'ncn_seen_keys', INIT: 'ncn_initialized'
    };

    /* ============================================================
     *  유틸 / 저장소
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

    /* 사용자 설정 — 새로고침해도 유지된다 */
    const PREFS = (function () {
        const base = {
            comment: CONFIG.DEFAULT_COMMENT,
            reply:   CONFIG.DEFAULT_REPLY,
            chat:    CONFIG.DEFAULT_CHAT,
            secret:  CONFIG.DEFAULT_SECRET,
            minimized: false
        };
        const raw = store.get(KEY.PREFS, '{}');
        let saved = {};
        try { saved = typeof raw === 'string' ? JSON.parse(raw) : (raw || {}); } catch (e) { saved = {}; }
        return Object.assign(base, saved);
    })();
    function savePrefs() { store.set(KEY.PREFS, JSON.stringify(PREFS)); }

    /* 비밀 모드 — 토글 하나로 내용과 출처를 함께 가린다 */
    const hideContent = () => !!PREFS.secret;
    const hideSource  = () => !!PREFS.secret && CONFIG.SECRET_HIDES_SOURCE;

    const CHAT_ON_NEWS = () => PREFS.chat && CONFIG.CHAT_SOURCE === 'news';
    const CHAT_ON_TALK = () => PREFS.chat && CONFIG.CHAT_SOURCE === 'talk';
    const alertOn = (type) => !!(type && type.pref && PREFS[type.pref]);

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
     *  피드 파싱
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

        let unread = false, node = el;
        for (let i = 0; i < 4 && node && node !== document.body; i++, node = node.parentElement) {
            let bg = '';
            try { bg = getComputedStyle(node).backgroundColor; } catch (e) { continue; }
            const c = parseRGB(bg);
            if (!c || c.a < 0.05) continue;
            if (Math.abs(c.r - c.g) <= 2 && Math.abs(c.g - c.b) <= 2) continue;
            if (c.g > c.r && c.g > c.b) { unread = true; break; }
        }
        return { key, type, lines, text, cafe, time, author, content, subject, href, el, unread };
    }

    /* ============================================================
     *  알림 문구
     * ========================================================== */
    const W = () => CONFIG.NOTIFY_LINE_WIDTH;
    const PAD = () => CONFIG.CONTENT_PREFIX.length + 1;
    const P = () => CONFIG.TITLE_PREFIX ? CONFIG.TITLE_PREFIX + ' ' : '';

    function whoLine(i, withLabel) {
        const label = withLabel ? '[' + i.type.label + ']' : '';
        const who = hideSource() ? '' : [i.cafe, i.author].filter(Boolean).join(' · ');
        const s = [label, who].filter(Boolean).join(' ');
        return s ? clipWidth(s, W()) : '';
    }
    function contentLine(i) {
        if (hideContent() || !i.content) return '';
        return CONFIG.CONTENT_PREFIX + clipWidth(i.content, W() - PAD());
    }
    function detailBody(i) {
        const out = [];
        const w = whoLine(i, false); if (w) out.push(w);
        const c = contentLine(i);    if (c) out.push(c);
        if (CONFIG.SHOW_SUBJECT && !hideContent() && i.subject) out.push('  ' + clipWidth(i.subject, W() - 3));
        if (!out.length) out.push(i.type.msg || '새 소식이 도착했습니다.');
        return out.join('\n');
    }
    function countsLine(items, chatCount) {
        const parts = [];
        TYPES.filter((t) => t.ui).forEach((t) => {
            const n = items.filter((i) => i.type.id === t.id).length;
            if (n) parts.push(t.tag + ' ' + n);
        });
        if (chatCount) parts.push('채팅 ' + chatCount);
        return parts.join(' · ');
    }
    function compactLine(i, showCafe) {
        const who = hideSource() ? '' : [showCafe ? i.cafe : '', i.author].filter(Boolean).join('·');
        const head = '[' + i.type.tag + ']' + (who ? ' ' + who : '');
        const c = hideContent() ? '' : i.content;
        return clipWidth(head + (c ? ' ' + c : ''), W());
    }

    function buildSummary(items, chatCount) {
        const total = items.length + (chatCount || 0);
        if (!total) return null;
        if (!items.length)
            return { title: P() + '채팅 ' + chatCount, body: '새로운 채팅 메시지가 도착했습니다.', url: '' };
        if (items.length === 1 && !chatCount)
            return { title: P() + items[0].type.label, body: detailBody(items[0]), url: items[0].href };

        const title = P() + countsLine(items, chatCount);
        if (hideContent() && hideSource())
            return { title, body: '새 소식 ' + total + '건이 도착했습니다.', url: items[0].href };

        const parts = [];
        if (CONFIG.LIST_STYLE === 'latest') {
            const i = items[0];
            const w = whoLine(i, true); if (w) parts.push(w);
            const c = contentLine(i);   if (c) parts.push(c);
        } else {
            const cafes = new Set(items.map((i) => i.cafe).filter(Boolean));
            const showCafe = cafes.size > 1, n = CONFIG.MERGE_MAX_ITEMS;
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
        if (CHAT_ON_NEWS()) {
            chatCur = newsChatCount();
            lastStat.chat = chatCur;
            if (chatCur !== null) {
                const prev = Number(store.get(KEY.CHAT_NEWS, 0)) || 0;
                if (initialized && chatCur > prev) chatIncreased = true;
                if (chatCur !== prev) store.set(KEY.CHAT_NEWS, chatCur);
            }
        } else if (CHAT_ON_TALK()) {
            lastStat.chat = Number(store.get(KEY.CHAT_TALK, 0)) || 0;
        } else lastStat.chat = 0;

        const items = collectFeedItems().map(buildItem).filter((i) => i.type);
        const unreadItems = items.filter((i) => i.unread);

        const counts = {};
        TYPES.forEach((t) => { counts[t.id] = 0; });
        unreadItems.forEach((i) => { counts[i.type.id] += 1; });
        lastStat.counts = counts;
        lastStat.scanned = true;

        /* 알림이 꺼진 종류도 '이미 본 것'으로 기록한다.
         * 그래야 나중에 켰을 때 밀린 알림이 한꺼번에 쏟아지지 않는다. */
        const allKeys = items.map((i) => i.key);
        if (!initialized) {
            saveSeen(allKeys);
            store.set(KEY.INIT, true);
            paint();
            return;
        }

        const pool = CONFIG.ONLY_UNREAD ? unreadItems : items;
        const enabled = pool.filter((i) => alertOn(i.type));
        const seenSet = new Set(loadSeen());
        const fresh = enabled.filter((i) => !seenSet.has(i.key));
        saveSeen(allKeys.concat(loadSeen()));

        if (CONFIG.NOTIFY_MODE === 'summary') {
            if (fresh.length || chatIncreased) {
                const s = buildSummary(enabled, CHAT_ON_NEWS() ? (chatCur || 0) : 0);
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
        else if (cur > prev && PREFS.chat)
            enqueue(P() + '채팅 ' + cur, '새로운 채팅 메시지가 도착했습니다.');
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
        const out = ['=== 카페 알리미 ' + VERSION + ' ==='];
        const N = getNotificationCtor();
        out.push('권한 ' + (N ? N.permission : '없음') + ' / 설정 ' + JSON.stringify(PREFS));
        if (IS_TALK) out.push('채팅 안읽음 = ' + talkUnreadCount());
        else {
            out.push('채팅 뱃지 = ' + newsChatCount());
            const items = collectFeedItems().map(buildItem);
            const un = items.filter((i) => i.unread);
            out.push('스캔 ' + items.length + '건 / 안읽음 ' + un.length + '건');
            const s = buildSummary(un.filter((i) => alertOn(i.type)), CHAT_ON_NEWS() ? (newsChatCount() || 0) : 0);
            out.push('\n[지금 보낼 알림]');
            out.push(s ? '  ' + s.title + '\n' + s.body.split('\n').map(l => '  ' + l).join('\n') : '  (없음)');
            items.slice(0, 3).forEach((f, i) => out.push(
                '\n[' + i + '] ' + (f.unread ? '●' : '○') + ' (' + (f.type ? f.type.id : '?') + ') ' +
                '카페=' + f.cafe + ' 작성자=' + f.author + ' 내용=' + truncate(f.content, 30)));
        }
        const text = out.join('\n');
        console.log(text);
        try { navigator.clipboard.writeText(text); toast('진단 결과 복사됨'); } catch (e) { toast('콘솔에 출력됨'); }
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
     *  UI — 설정 패널 / 최소화 버블
     * ========================================================== */
    let root = null, panelMain = null, panelFoot = null, bubbleBadge = null;

    function toast(msg) {
        const host = document.documentElement;
        if (!host) return;
        const t = document.createElement('div');
        t.textContent = msg;
        t.style.cssText = 'position:fixed;right:16px;bottom:86px;z-index:2147483647;padding:9px 13px;' +
            'border-radius:8px;background:rgba(0,0,0,.85);color:#fff;font:12px/1.4 sans-serif;max-width:260px';
        host.appendChild(t);
        setTimeout(() => t.remove(), 3500);
    }

    function mkToggle(label, prefKey, onChange) {
        const row = document.createElement('div');
        row.style.cssText = 'display:flex;align-items:center;justify-content:space-between;' +
            'padding:5px 0;cursor:pointer;user-select:none';
        const name = document.createElement('span');
        name.textContent = label;
        name.style.cssText = 'font-size:12.5px';

        const sw = document.createElement('div');
        sw.style.cssText = 'width:34px;height:19px;border-radius:10px;padding:2px;box-sizing:border-box;' +
            'transition:background .15s;flex:none';
        const knob = document.createElement('div');
        knob.style.cssText = 'width:15px;height:15px;border-radius:50%;background:#fff;transition:transform .15s';
        sw.appendChild(knob);

        const render = () => {
            const on = !!PREFS[prefKey];
            sw.style.background = on ? '#03c75a' : 'rgba(255,255,255,.22)';
            knob.style.transform = on ? 'translateX(15px)' : 'translateX(0)';
            name.style.opacity = on ? '1' : '.55';
        };
        row.addEventListener('click', (e) => {
            e.stopPropagation();
            PREFS[prefKey] = !PREFS[prefKey];
            savePrefs(); render(); paint();
            if (onChange) onChange();
        });
        render();
        row.append(name, sw);
        return row;
    }

    function clearRoot() {
        if (root) root.remove();
        root = null; panelMain = null; panelFoot = null; bubbleBadge = null;
    }

    function unreadTotal() {
        let n = 0;
        TYPES.filter((t) => t.ui).forEach((t) => { if (PREFS[t.pref]) n += (lastStat.counts[t.id] || 0); });
        if (PREFS.chat) n += (lastStat.chat || 0);
        return n;
    }

    function buildBubble() {
        root = document.createElement('div');
        root.title = '카페 알리미 — 클릭해서 열기';
        root.style.cssText = 'position:fixed;right:18px;bottom:18px;z-index:2147483647;width:46px;height:46px;' +
            'border-radius:50%;background:rgba(20,22,26,.88);box-shadow:0 3px 12px rgba(0,0,0,.35);' +
            'display:flex;align-items:center;justify-content:center;cursor:pointer;font-size:20px;' +
            'user-select:none;transition:transform .12s';
        root.textContent = PREFS.secret ? '🔒' : '🔔';
        root.addEventListener('mouseenter', () => { root.style.transform = 'scale(1.08)'; });
        root.addEventListener('mouseleave', () => { root.style.transform = 'scale(1)'; });
        root.addEventListener('click', () => { PREFS.minimized = false; savePrefs(); render(); });

        bubbleBadge = document.createElement('div');
        bubbleBadge.style.cssText = 'position:absolute;top:-2px;right:-2px;min-width:18px;height:18px;padding:0 4px;' +
            'border-radius:9px;background:#e8443a;color:#fff;font:bold 11px/18px sans-serif;text-align:center;display:none';
        root.appendChild(bubbleBadge);

        document.documentElement.appendChild(root);
    }

    function buildPanel() {
        root = document.createElement('div');
        root.style.cssText = 'position:fixed;right:18px;bottom:18px;z-index:2147483647;width:196px;' +
            'padding:11px 13px 9px;border-radius:12px;background:rgba(20,22,26,.93);color:#fff;' +
            'font:12px/1.5 sans-serif;box-shadow:0 4px 16px rgba(0,0,0,.4);user-select:none';

        const head = document.createElement('div');
        head.style.cssText = 'display:flex;align-items:center;justify-content:space-between;margin-bottom:6px';
        const title = document.createElement('span');
        title.textContent = '🔔 카페 알리미';
        title.style.cssText = 'font-weight:700;color:#03c75a;font-size:12.5px';
        const min = document.createElement('span');
        min.textContent = '—';
        min.title = '최소화';
        min.style.cssText = 'cursor:pointer;font-size:15px;line-height:1;opacity:.6;padding:0 3px';
        min.addEventListener('click', (e) => {
            e.stopPropagation();
            PREFS.minimized = true; savePrefs(); render();
        });
        head.append(title, min);

        panelMain = document.createElement('div');
        panelMain.style.cssText = 'font-size:12.5px;font-weight:600;margin-bottom:7px;opacity:.9';

        const box = document.createElement('div');
        box.style.cssText = 'border-top:1px solid rgba(255,255,255,.12);padding-top:4px';
        if (!IS_TALK) {
            box.appendChild(mkToggle('댓글 알림', 'comment'));
            box.appendChild(mkToggle('답글 알림', 'reply'));
        }
        box.appendChild(mkToggle('채팅 알림', 'chat'));

        /* 비밀 모드 — 종류별이 아니라 전체에 한 번에 적용된다 */
        const secretBox = document.createElement('div');
        secretBox.style.cssText = 'border-top:1px solid rgba(255,255,255,.12);margin-top:4px;padding-top:2px';
        const hint = document.createElement('div');
        hint.style.cssText = 'font-size:10px;opacity:.4;margin-bottom:2px';
        const syncHint = () => {
            hint.textContent = PREFS.secret ? '내용을 가리고 건수만 알립니다' : '';
        };
        secretBox.appendChild(mkToggle('🔒 비밀 모드', 'secret', syncHint));
        secretBox.appendChild(hint);
        syncHint();

        panelFoot = document.createElement('div');
        panelFoot.style.cssText = 'font-size:10px;opacity:.4;margin-top:6px;display:flex;' +
            'justify-content:space-between;align-items:center';
        const status = document.createElement('span');
        const tools = document.createElement('span');
        tools.style.cssText = 'cursor:pointer;text-decoration:underline';
        tools.textContent = '테스트';
        tools.addEventListener('click', (e) => {
            e.stopPropagation();
            enqueue(P() + '테스트 알림', '알림이 정상 동작합니다.');
        });
        panelFoot.append(status, tools);
        panelFoot._status = status;

        root.append(head, panelMain, box, secretBox, panelFoot);
        document.documentElement.appendChild(root);
    }

    function render() {
        clearRoot();
        if (!document.documentElement) return;
        if (PREFS.minimized) buildBubble(); else buildPanel();
        paint();
    }

    function ensureRoot() {
        if (!root || !document.documentElement.contains(root)) render();
    }

    let secLeft = 0;
    function paint() {
        if (!root) return;

        if (PREFS.minimized) {
            if (!bubbleBadge) return;
            root.firstChild && (root.childNodes[0].nodeType === 3
                ? (root.childNodes[0].nodeValue = PREFS.secret ? '🔒' : '🔔') : null);
            const n = unreadTotal();
            bubbleBadge.textContent = n > 99 ? '99+' : String(n);
            bubbleBadge.style.display = n > 0 ? 'block' : 'none';
            return;
        }
        if (!panelMain) return;

        const N = getNotificationCtor();
        if (N && N.permission !== 'granted') {
            panelMain.textContent = '알림 권한이 필요합니다';
            panelMain.style.cursor = 'pointer';
            panelMain.onclick = requestPermission;
            if (panelFoot._status) panelFoot._status.textContent = '여기를 클릭';
            return;
        }
        panelMain.onclick = null;
        panelMain.style.cursor = '';

        if (!lastStat.scanned) {
            panelMain.textContent = '확인 중…';
            if (panelFoot._status) panelFoot._status.textContent = '';
            return;
        }

        const parts = [];
        if (!IS_TALK) TYPES.filter((t) => t.ui).forEach((t) => parts.push(t.tag + ' ' + (lastStat.counts[t.id] || 0)));
        parts.push('채팅 ' + (lastStat.chat === null ? '?' : lastStat.chat));
        panelMain.textContent = parts.join(' · ');

        if (panelFoot._status) {
            panelFoot._status.textContent = IS_TALK
                ? CONFIG.TALK_SCAN_INTERVAL_SEC + '초마다 확인'
                : (running ? secLeft + '초 후 확인' : '대기 중');
        }
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
        if (IS_TALK) return CHAT_ON_TALK();
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
        if (N.permission === 'denied') { toast('알림이 차단됨\n주소창 자물쇠 → 알림 → 허용'); return; }
        N.requestPermission().then((p) => {
            paint();
            if (p === 'granted') ensureState();
        }).catch(() => {});
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

    /* ============================================================
     *  시작
     * ========================================================== */
    console.log('%c[카페알리미 ' + VERSION + ']', 'background:#03c75a;color:#fff;padding:2px 6px', location.href);

    function boot() { if (onTargetPage()) ensureRoot(); ensureState(); }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
    else boot();
    window.addEventListener('load', () => setTimeout(boot, 400));
    setInterval(() => { if (onTargetPage()) ensureRoot(); }, 1500);

    try {
        unsafeWindow.__cafeNotifier = { VERSION, diagnose, reset, scan: safeScan, PREFS, CONFIG, render };
    } catch (e) { log('unsafeWindow 노출 실패', e); }
})();
