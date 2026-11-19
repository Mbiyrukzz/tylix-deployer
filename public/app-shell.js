/*
 * Tylix Flux: the app shell. Loaded from app/head.html before any page
 * script runs.
 *
 *  1. Theme and sidebar width before first paint, so nothing jumps.
 *
 *  2. In-app navigation that keeps the shell. Tylix builds every page as
 *     its own document, so a plain link click used to throw away the
 *     sidebar and top bar and draw them again. Now a click between app
 *     pages fetches the next page, runs its script against a hidden
 *     staging area, and moves only the page itself into the existing
 *     layout. The sidebar, top bar and command palette mount once per
 *     visit. The old page keeps showing (frozen) until the new one has
 *     rendered, the URL and history work as usual, and anything unexpected
 *     falls back to a normal page load.
 *
 *  3. Every page cleans up after itself. Timers, sockets, EventSources and
 *     window/document listeners a page creates are tracked per page and
 *     released when you leave it, so live stats, log tails and polling
 *     never keep running in the background.
 *
 *  4. Sessions that keep themselves alive. Access tokens live 15 minutes;
 *     any /api call that answers 401 refreshes once (shared by every request
 *     in flight) and is retried. Reads that fail on a network blip or a
 *     502/503/504 are retried with backoff.
 *
 *  5. Offline and session notices, and keyboard shortcuts.
 *
 * Persistent shell components (Sidebar, Topbar, CommandPalette) register
 * their listeners and timers through window.__flux.on / .every so page
 * cleanup never touches them.
 */
(function () {
    "use strict";

    var W = window;
    var doc = document.documentElement;
    if (W.__flux) return;

    // ---- 0. native references, before anything is patched ---------------
    var ET = EventTarget.prototype;
    var N = {
        setTimeout: W.setTimeout.bind(W),
        clearTimeout: W.clearTimeout.bind(W),
        setInterval: W.setInterval.bind(W),
        clearInterval: W.clearInterval.bind(W),
        addEventListener: ET.addEventListener,
        removeEventListener: ET.removeEventListener,
        WebSocket: W.WebSocket,
        EventSource: W.EventSource,
        fetch: W.fetch ? W.fetch.bind(W) : null,
    };

    // App sections: the pages that live inside the sidebar shell.
    var APP_PREFIXES = ["/dashboard", "/servers", "/settings", "/team", "/providers", "/registrars", "/source-control"];

    // Pages that hold something open for their whole life (an SSH session,
    // a one-shot invite). Moving to or from them is always a full load.
    var HARD_PATHS = [/^\/servers\/server-terminal/, /^\/servers\/site-terminal/];

    function isAppPath(pathname) {
        for (var i = 0; i < APP_PREFIXES.length; i++) {
            var p = APP_PREFIXES[i];
            if (pathname === p || pathname.indexOf(p + "/") === 0 || pathname.indexOf(p + "?") === 0) return true;
        }
        return false;
    }
    function isHardPath(pathname) {
        for (var i = 0; i < HARD_PATHS.length; i++) if (HARD_PATHS[i].test(pathname)) return true;
        return false;
    }

    function store(key, value) {
        try {
            if (value === undefined) return localStorage.getItem(key);
            if (value === null) localStorage.removeItem(key);
            else localStorage.setItem(key, value);
        } catch (e) {
            return null;
        }
        return null;
    }

    // ---- 1. theme and sidebar before first paint --------------------------
    (function () {
        var stored = store("theme");
        doc.classList.toggle("dark", stored ? stored === "dark" : true);

        var sb = store("flux-sidebar");
        if (sb === null && store("tylix-sidebar") === "1") sb = "collapsed";
        doc.setAttribute("data-sidebar", sb === "collapsed" ? "collapsed" : "expanded");
        doc.setAttribute("data-shell", isAppPath(location.pathname) ? "app" : "public");
    })();

    // ---- events -----------------------------------------------------------
    function on(target, type, fn, opts) {
        N.addEventListener.call(target, type, fn, opts);
        return function () {
            N.removeEventListener.call(target, type, fn, opts);
        };
    }
    function emit(name, detail) {
        try {
            W.dispatchEvent(new CustomEvent(name, { detail: detail }));
        } catch (e) {
            /* very old browser */
        }
    }

    // ---- 3. per-page resource tracking ------------------------------------
    function Bucket(label) {
        this.label = label;
        this.timeouts = new Set();
        this.intervals = new Set();
        this.listeners = [];
        this.closers = [];
        this.dead = false;
    }
    Bucket.prototype.counts = function () {
        return { timeouts: this.timeouts.size, intervals: this.intervals.size, listeners: this.listeners.length, sockets: this.closers.length };
    };
    var lastReleased = null;
    Bucket.prototype.dispose = function () {
        if (!this.dead) lastReleased = { page: this.label, released: this.counts(), at: new Date().toISOString() };
        this.dead = true;
        this.timeouts.forEach(function (id) {
            N.clearTimeout(id);
        });
        this.intervals.forEach(function (id) {
            N.clearInterval(id);
        });
        this.listeners.forEach(function (l) {
            try {
                N.removeEventListener.call(l[0], l[1], l[2], l[3]);
            } catch (e) {}
        });
        this.closers.forEach(function (close) {
            try {
                close();
            } catch (e) {}
        });
        this.timeouts.clear();
        this.intervals.clear();
        this.listeners = [];
        this.closers = [];
    };

    function trackedConstructor(Native, bucketOf) {
        if (!Native) return Native;
        function Tracked(a, b) {
            var inst = arguments.length > 1 ? new Native(a, b) : new Native(a);
            // Tylix's own dev channels (hot reload) belong to the document.
            if (String(a).indexOf("/__tylix/") !== -1) return inst;
            var bucket = bucketOf();
            if (bucket) {
                if (bucket.dead) {
                    try {
                        inst.close();
                    } catch (e) {}
                } else {
                    bucket.closers.push(function () {
                        inst.close();
                    });
                }
            }
            return inst;
        }
        Tracked.prototype = Native.prototype;
        ["CONNECTING", "OPEN", "CLOSING", "CLOSED"].forEach(function (k) {
            if (k in Native) Tracked[k] = Native[k];
        });
        return Tracked;
    }

    // Timer and listener functions that record into a bucket.
    function scopedApi(bucketOf) {
        var api = {
            setTimeout: function (fn, ms) {
                var bucket = bucketOf();
                if (bucket && bucket.dead) return 0;
                var args = Array.prototype.slice.call(arguments, 2);
                var id = N.setTimeout(function () {
                    if (bucket) bucket.timeouts.delete(id);
                    if (typeof fn === "function") fn.apply(W, args);
                }, ms);
                if (bucket) bucket.timeouts.add(id);
                return id;
            },
            clearTimeout: function (id) {
                var bucket = bucketOf();
                if (bucket) bucket.timeouts.delete(id);
                N.clearTimeout(id);
            },
            setInterval: function (fn, ms) {
                var bucket = bucketOf();
                if (bucket && bucket.dead) return 0;
                var args = Array.prototype.slice.call(arguments, 2);
                var id = N.setInterval(function () {
                    if (typeof fn === "function") fn.apply(W, args);
                }, ms);
                if (bucket) bucket.intervals.add(id);
                return id;
            },
            clearInterval: function (id) {
                var bucket = bucketOf();
                if (bucket) bucket.intervals.delete(id);
                N.clearInterval(id);
            },
            WebSocket: trackedConstructor(N.WebSocket, bucketOf),
            EventSource: trackedConstructor(N.EventSource, bucketOf),
            listen: function (target, type, fn, opts) {
                var bucket = bucketOf();
                N.addEventListener.call(target, type, fn, opts);
                if (bucket && !bucket.dead && type !== "DOMContentLoaded") bucket.listeners.push([target, type, fn, opts]);
            },
            unlisten: function (target, type, fn, opts) {
                N.removeEventListener.call(target, type, fn, opts);
            },
        };
        return api;
    }

    // The first page of a visit runs as a normal script, so its resources
    // are caught by patching the globals. Pages swapped in later get their
    // own scoped globals (see runPage). The global bucket is released and
    // replaced on every in-place navigation, which also catches stragglers
    // (a poll whose request was still in flight when you left).
    var globalBucket = new Bucket("global");
    var currentBucket = null;
    var globalApi = scopedApi(function () {
        return globalBucket;
    });

    W.setTimeout = globalApi.setTimeout;
    W.clearTimeout = globalApi.clearTimeout;
    W.setInterval = globalApi.setInterval;
    W.clearInterval = globalApi.clearInterval;
    if (N.WebSocket) W.WebSocket = globalApi.WebSocket;
    if (N.EventSource) W.EventSource = globalApi.EventSource;
    // The dev error overlay's own keyboard handler (Esc closes it).
    function devOverlayKey(target, type) {
        var cs = document.currentScript;
        return type === "keydown" && !!cs && !cs.src && (cs.textContent || "").indexOf("__TYLIX_OVERLAY__") !== -1;
    }

    // Global error reporters (and the dev error overlay) watch the whole
    // visit, not one page, so error listeners are never released.
    var KEEP_TYPES = { DOMContentLoaded: 1, load: 1, error: 1, unhandledrejection: 1 };
    ET.addEventListener = function (type, fn, opts) {
        if ((this === W || this === document) && !KEEP_TYPES[type] && !devOverlayKey(this, type)) {
            globalBucket.listeners.push([this, type, fn, opts]);
        }
        return N.addEventListener.call(this, type, fn, opts);
    };

    // ---- public helpers for the shell components ---------------------------
    var flux = (W.__flux = {
        native: N,
        on: on,
        emit: emit,
        isAppPath: isAppPath,
        every: function (ms, fn) {
            var id = N.setInterval(fn, ms);
            return function () {
                N.clearInterval(id);
            };
        },
        later: function (ms, fn) {
            var id = N.setTimeout(fn, ms);
            return function () {
                N.clearTimeout(id);
            };
        },
        // True inside a page that is being swapped in: the layout then
        // renders only its slot (the real shell is already on screen).
        swapping: false,
        navigate: function (url) {
            softNavigate(url, {});
        },
        toast: function () {},
        // Diagnostics: what the current page holds open, and what the last
        // page released when you left it. Try __flux.stats() in the console.
        stats: function () {
            return {
                page: currentBucket ? { path: currentBucket.label, holds: currentBucket.counts() } : null,
                firstPage: globalBucket.counts(),
                lastReleased: lastReleased,
                cachedPages: htmlCache.size,
            };
        },
        sidebar: function (state) {
            var next = state || (doc.getAttribute("data-sidebar") === "collapsed" ? "expanded" : "collapsed");
            doc.setAttribute("data-sidebar", next);
            store("flux-sidebar", next);
            emit("flux:sidebar", { state: next });
            return next;
        },
        theme: function (mode) {
            var dark = mode ? mode === "dark" : !doc.classList.contains("dark");
            doc.classList.toggle("dark", dark);
            store("theme", dark ? "dark" : "light");
            emit("flux:theme", { mode: dark ? "dark" : "light" });
            return dark ? "dark" : "light";
        },
    });

    // ---- 2a. first load: splash only on a cold start ----------------------
    try {
        var navEntry = performance.getEntriesByType("navigation")[0];
        var navType = navEntry ? navEntry.type : "navigate";
        var sameOrigin = document.referrer && new URL(document.referrer).origin === location.origin;
        if (sameOrigin && navType !== "reload") doc.setAttribute("data-soft-nav", "");
    } catch (e) {}

    function markReady() {
        doc.setAttribute("data-app-ready", "");
        doc.removeAttribute("data-navigating");
        revealActiveTab();
        N.setTimeout(revealActiveTab, 400);
        // Transitions only after the first paint, so the sidebar width
        // doesn't animate in on load.
        N.setTimeout(function () {
            doc.setAttribute("data-flux-ready", "");
        }, 60);
    }

    // On phones the section sidebar is a sideways strip: bring the current
    // tab into view (horizontally only, the page itself doesn't move).
    function revealActiveTab() {
        if (!W.matchMedia || !matchMedia("(max-width: 1023px)").matches) return;
        var strips = document.querySelectorAll(".app-subnav");
        for (var i = 0; i < strips.length; i++) {
            var strip = strips[i];
            var current = strip.querySelector('[aria-current="page"]');
            if (!current || strip.scrollWidth <= strip.clientWidth) continue;
            var left = current.offsetLeft - (strip.clientWidth - current.offsetWidth) / 2;
            strip.scrollLeft = Math.max(0, left);
        }
    }

    function watchReady() {
        var app = document.getElementById("app");
        if (app && app.firstElementChild) return markReady();
        var mo = new MutationObserver(function () {
            var el = document.getElementById("app");
            if (el && el.firstElementChild) {
                mo.disconnect();
                markReady();
            }
        });
        mo.observe(document.body, { childList: true, subtree: true });
        N.setTimeout(markReady, 15000);
    }
    if (document.readyState === "loading") on(document, "DOMContentLoaded", watchReady);
    else watchReady();

    on(W, "pageshow", function (e) {
        if (e.persisted) markReady();
    });

    // ---- 2b. soft navigation ----------------------------------------------
    var canSoftNav =
        typeof DOMParser !== "undefined" && typeof Proxy !== "undefined" && typeof Set !== "undefined" && !!N.fetch && !!history.pushState;

    var htmlCache = new Map(); // url -> { at, promise }
    var CACHE_MS = 30 * 1000;
    var navSeq = 0;
    var rendered = location.pathname + location.search;

    function cacheKey(url) {
        return url.pathname + url.search;
    }

    function fetchHtml(url) {
        var key = cacheKey(url);
        var hit = htmlCache.get(key);
        if (hit && Date.now() - hit.at < CACHE_MS) return hit.promise;
        var promise = N.fetch(url.href, {
            credentials: "same-origin",
            headers: { Accept: "text/html", "X-Flux-Navigation": "1" },
        }).then(function (res) {
            var type = res.headers.get("content-type") || "";
            if (!res.ok || type.indexOf("text/html") === -1) throw new Error("not a page: " + res.status);
            var finalUrl = new URL(res.url || url.href);
            return res.text().then(function (html) {
                return { html: html, url: finalUrl };
            });
        });
        htmlCache.set(key, { at: Date.now(), promise: promise });
        promise.catch(function () {
            htmlCache.delete(key);
        });
        if (htmlCache.size > 24) htmlCache.delete(htmlCache.keys().next().value);
        return promise;
    }

    function parsePage(html) {
        var parsed = new DOMParser().parseFromString(html, "text/html");
        var scripts = parsed.body ? parsed.body.querySelectorAll("script:not([src])") : [];
        // The compiled page script registers its page with kind "page". Dev
        // mode adds other inline scripts (hot reload, error overlay) after it.
        var code = null;
        for (var i = 0; i < scripts.length; i++) {
            var text = scripts[i].textContent || "";
            if (text.indexOf('kind: "page"') !== -1 && text.indexOf('document.addEventListener("DOMContentLoaded"') !== -1) {
                code = text;
                break;
            }
        }
        if (!code) return null;
        var styles = [];
        parsed.head.querySelectorAll("style").forEach(function (s) {
            styles.push(s.textContent || "");
        });
        return { code: code, title: parsed.title, styles: styles };
    }

    // Window methods that must be called with the real window as `this`.
    var WINDOW_METHODS = {
        fetch: 1, alert: 1, confirm: 1, prompt: 1, open: 1, close: 1, focus: 1, blur: 1, print: 1,
        scroll: 1, scrollTo: 1, scrollBy: 1, getComputedStyle: 1, matchMedia: 1, postMessage: 1,
        requestAnimationFrame: 1, cancelAnimationFrame: 1, requestIdleCallback: 1, cancelIdleCallback: 1,
        queueMicrotask: 1, atob: 1, btoa: 1, getSelection: 1, structuredClone: 1, reportError: 1,
        dispatchEvent: 1, createImageBitmap: 1,
    };

    function runPage(code, staging, bucket) {
        var api = scopedApi(function () {
            return bucket;
        });

        var docProxy = new Proxy(document, {
            get: function (target, prop) {
                if (prop === "getElementById") {
                    return function (id) {
                        return id === "app" ? staging : target.getElementById(id);
                    };
                }
                if (prop === "addEventListener") {
                    return function (type, fn, opts) {
                        if (type === "DOMContentLoaded") {
                            Promise.resolve().then(function () {
                                fn.call(target, new Event("DOMContentLoaded"));
                            });
                            return;
                        }
                        api.listen(target, type, fn, opts);
                    };
                }
                if (prop === "removeEventListener") {
                    return function (type, fn, opts) {
                        api.unlisten(target, type, fn, opts);
                    };
                }
                var value = target[prop];
                return typeof value === "function" ? value.bind(target) : value;
            },
            set: function (target, prop, value) {
                target[prop] = value;
                return true;
            },
        });

        var winProxy = new Proxy(W, {
            get: function (target, prop) {
                switch (prop) {
                    case "document":
                        return docProxy;
                    case "window":
                    case "self":
                    case "globalThis":
                        return winProxy;
                    case "setTimeout":
                    case "clearTimeout":
                    case "setInterval":
                    case "clearInterval":
                    case "WebSocket":
                    case "EventSource":
                        return api[prop];
                    case "addEventListener":
                        return function (type, fn, opts) {
                            api.listen(target, type, fn, opts);
                        };
                    case "removeEventListener":
                        return function (type, fn, opts) {
                            api.unlisten(target, type, fn, opts);
                        };
                }
                var value = target[prop];
                if (typeof value === "function" && WINDOW_METHODS[prop]) return value.bind(target);
                return value;
            },
            set: function (target, prop, value) {
                target[prop] = value;
                return true;
            },
            has: function (target, prop) {
                return prop in target;
            },
        });

        // Run the page's script as an inline <script> (allowed by the default
        // Tylix CSP, unlike eval/new Function), wrapped in a function whose
        // parameters shadow the globals above.
        var key = "__fluxRun" + ++runSeq;
        var ctx = {
            self: winProxy,
            args: [
                docProxy, winProxy, winProxy, winProxy,
                api.setTimeout, api.clearTimeout, api.setInterval, api.clearInterval,
                api.WebSocket, api.EventSource,
                function (type, fn, opts) {
                    api.listen(W, type, fn, opts);
                },
                function (type, fn, opts) {
                    api.unlisten(W, type, fn, opts);
                },
            ],
            ran: false,
            error: null,
        };
        W[key] = ctx;
        var el = document.createElement("script");
        el.textContent =
            "(function(){var __c=window." + key + ";__c.ran=true;try{(function(document,window,self,globalThis,setTimeout,clearTimeout,setInterval,clearInterval,WebSocket,EventSource,addEventListener,removeEventListener){\n" +
            code +
            "\n}).apply(__c.self,__c.args);}catch(e){__c.error=e;}})();";
        try {
            document.body.appendChild(el);
        } finally {
            el.remove();
            try {
                delete W[key];
            } catch (e) {
                W[key] = undefined;
            }
        }
        if (!ctx.ran) throw new Error("the page script was blocked");
        if (ctx.error) throw ctx.error;
    }
    var runSeq = 0;

    // Page <style> blocks: keep the ones the next page shares, swap the rest.
    function syncStyles(styles) {
        var wanted = new Set(styles);
        var have = new Set();
        document.head.querySelectorAll("style").forEach(function (el) {
            if (el.hasAttribute("data-flux-keep")) return;
            var text = el.textContent || "";
            if (!wanted.has(text)) el.remove();
            else have.add(text);
        });
        styles.forEach(function (text) {
            if (have.has(text)) return;
            var el = document.createElement("style");
            el.textContent = text;
            document.head.appendChild(el);
        });
    }

    // A frozen copy of the page on screen: same pixels, no ids, no handlers.
    function freeze(nodes) {
        var shell = document.createElement("div");
        shell.setAttribute("inert", "");
        shell.setAttribute("aria-busy", "true");
        shell.setAttribute("data-flux-frozen", "");
        nodes.forEach(function (n) {
            var copy = n.cloneNode(true);
            if (copy.nodeType === 1) {
                if (copy.id) copy.removeAttribute("id");
                copy.querySelectorAll("[id]").forEach(function (el) {
                    el.removeAttribute("id");
                });
                copy.querySelectorAll("canvas").forEach(function (el) {
                    el.style.visibility = "hidden";
                });
            }
            shell.appendChild(copy);
        });
        return shell;
    }

    function realSlot() {
        return document.querySelector(".flux-main > [data-tylix-slot]");
    }

    function stagedContent(staging) {
        var slot = staging.querySelector("[data-tylix-slot]");
        if (slot) return slot.firstChild ? slot : null;
        // Not-found and forbidden screens write straight into #app.
        return staging.firstElementChild && !staging.firstElementChild.hasAttribute("data-tylix-slot") ? staging : null;
    }

    function settled(container) {
        if (container.querySelector("[data-page-loader]")) return false;
        return container.getBoundingClientRect().height > 48;
    }

    var hardNav = false;
    function hardNavigate(url, replace) {
        hardNav = true;
        doc.setAttribute("data-navigating", "");
        if (replace) location.replace(url);
        else location.assign(url);
    }

    function setNavigating(onOff) {
        if (onOff) doc.setAttribute("data-navigating", "");
        else doc.removeAttribute("data-navigating");
    }

    function saveScroll() {
        try {
            var state = Object.assign({}, history.state || {}, { flux: true, fluxY: W.scrollY });
            history.replaceState(state, "");
        } catch (e) {}
    }

    function softNavigate(href, opts) {
        opts = opts || {};
        var url;
        try {
            url = new URL(href, location.href);
        } catch (e) {
            return false;
        }
        if (!eligible(url)) {
            if (opts.pop) location.reload();
            else hardNavigate(url.href, opts.replace);
            return true;
        }

        var seq = ++navSeq;
        var slot = realSlot();
        if (!slot) {
            hardNavigate(url.href, opts.replace);
            return true;
        }

        setNavigating(true);
        if (!opts.pop) saveScroll();

        fetchHtml(url)
            .then(function (result) {
                if (seq !== navSeq) return;
                if (result.url.origin !== location.origin || !eligible(result.url)) {
                    // Redirected somewhere outside the app (signed out, ...).
                    hardNavigate(result.url.href, true);
                    return;
                }
                var page = parsePage(result.html);
                if (!page) throw new Error("no page script");

                var target = result.url.pathname + result.url.search + (url.hash || "");
                if (!opts.pop) {
                    var state = { flux: true, fluxY: 0 };
                    if (opts.replace) history.replaceState(state, "", target);
                    else history.pushState(state, "", target);
                }
                return swapIn(page, slot, seq, opts);
            })
            .catch(function (err) {
                if (seq !== navSeq) return;
                if (W.console && console.warn) console.warn("[flux] in-place navigation failed, loading the page:", err);
                hardNavigate(url.href, true);
            });
        return true;
    }

    function swapIn(page, slot, seq, opts) {
        // Leaving the current page: release everything it holds open.
        globalBucket.dispose();
        globalBucket = new Bucket("global");
        if (currentBucket) currentBucket.dispose();

        var oldNodes = Array.prototype.slice.call(slot.childNodes);
        var frozen = freeze(oldNodes);
        slot.replaceChildren(frozen);

        var bucket = new Bucket(location.pathname);
        currentBucket = bucket;

        var main = slot.parentNode;
        var staging = document.createElement("div");
        staging.setAttribute("aria-hidden", "true");
        staging.setAttribute("data-flux-staging", "");
        staging.style.cssText = "position:absolute;left:0;right:0;top:0;visibility:hidden;pointer-events:none;contain:layout style;";
        main.appendChild(staging);

        document.querySelectorAll(".flux-loadbar").forEach(function (el) {
            el.remove();
        });

        flux.swapping = true;
        W.__fluxSwap = true;
        rendered = location.pathname + location.search;

        try {
            runPage(page.code, staging, bucket);
        } catch (err) {
            staging.remove();
            throw err;
        }

        return new Promise(function (resolve, reject) {
            var started = Date.now();
            var firstSeen = 0;
            var done = false;
            var mo;

            function finish() {
                if (done) return;
                done = true;
                if (mo) mo.disconnect();
                if (seq !== navSeq) {
                    staging.remove();
                    resolve();
                    return;
                }
                var content = stagedContent(staging);
                if (!content) {
                    staging.remove();
                    reject(new Error("page did not render"));
                    return;
                }
                var nodes = Array.prototype.slice.call(content.childNodes);
                var commit = function () {
                    slot.replaceChildren.apply(slot, nodes);
                    staging.remove();
                    if (page.title) document.title = page.title;
                    syncStyles(page.styles);
                    var y = opts.pop && history.state && typeof history.state.fluxY === "number" ? history.state.fluxY : 0;
                    W.scrollTo(0, y);
                    if (location.hash) {
                        var anchor = document.getElementById(location.hash.slice(1));
                        if (anchor) anchor.scrollIntoView();
                    }
                };
                var committed = false;
                var commitAndAnnounce = function () {
                    if (committed) return;
                    committed = true;
                    try {
                        commit();
                    } catch (err) {
                        reject(err);
                        return;
                    }
                    setNavigating(false);
                    announce(page.title);
                    N.setTimeout(revealActiveTab, 0);
                    emit("flux:navigated", { url: location.href, path: location.pathname });
                    resolve();
                };
                if (document.startViewTransition && !matchMedia("(prefers-reduced-motion: reduce)").matches) {
                    try {
                        document.startViewTransition(commitAndAnnounce);
                        // A transition that never runs its callback (tab hidden,
                        // another transition) must not leave the old page up.
                        N.setTimeout(commitAndAnnounce, 400);
                    } catch (e) {
                        commitAndAnnounce();
                    }
                } else {
                    commitAndAnnounce();
                    slot.classList.remove("flux-swap-in");
                    void slot.offsetWidth;
                    slot.classList.add("flux-swap-in");
                }
            }

            function check() {
                if (done) return;
                if (seq !== navSeq) return finish();
                var content = stagedContent(staging);
                if (content) {
                    if (!firstSeen) firstSeen = Date.now();
                    // Wait for the page's own loading state to clear, briefly:
                    // a page that is still loading after that shows its skeleton.
                    if (settled(content) || Date.now() - firstSeen > 2200) return finish();
                }
                if (Date.now() - started > 20000) {
                    done = true;
                    if (mo) mo.disconnect();
                    staging.remove();
                    reject(new Error("timed out"));
                }
            }

            mo = new MutationObserver(check);
            mo.observe(staging, { childList: true, subtree: true, attributes: true });
            (function tick() {
                if (done) return;
                check();
                N.setTimeout(tick, 120);
            })();
        });
    }

    // Screen readers hear the new page's name.
    var live;
    function announce(text) {
        if (!text) return;
        if (!live) {
            live = document.createElement("div");
            live.setAttribute("aria-live", "polite");
            live.setAttribute("role", "status");
            live.style.cssText = "position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;";
            document.body.appendChild(live);
        }
        live.textContent = text;
    }

    function eligible(url) {
        if (!canSoftNav) return false;
        if (url.origin !== location.origin) return false;
        if (url.pathname.indexOf("/api/") === 0) return false;
        if (!isAppPath(url.pathname) || isHardPath(url.pathname)) return false;
        if (!isAppPath(location.pathname) || isHardPath(location.pathname)) return false;
        if (!realSlot()) return false;
        return true;
    }

    function linkFrom(e) {
        var a = e.target && e.target.closest ? e.target.closest("a[href]") : null;
        if (!a) return null;
        if (a.target && a.target !== "_self") return null;
        if (a.hasAttribute("download") || a.hasAttribute("data-no-soft") || a.hasAttribute("data-no-prerender")) return null;
        return a;
    }

    on(document, "click", function (e) {
        if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        var a = linkFrom(e);
        if (!a) return;
        var url;
        try {
            url = new URL(a.href, location.href);
        } catch (err) {
            return;
        }
        if (url.origin !== location.origin || url.pathname.indexOf("/api/") === 0) return;
        // Same page, only the hash changes: let the browser scroll.
        if (url.pathname === location.pathname && url.search === location.search && url.hash) return;

        if (eligible(url)) {
            e.preventDefault();
            if (url.pathname + url.search === location.pathname + location.search && !url.hash) {
                // Clicking the page you're on reloads it in place.
                htmlCache.delete(cacheKey(url));
            }
            softNavigate(url.href, {});
            return;
        }
        setNavigating(true);
    });

    on(W, "popstate", function () {
        var here = location.pathname + location.search;
        if (here === rendered) return; // only the hash changed
        if (isAppPath(location.pathname) && realSlot()) {
            softNavigate(location.href, { pop: true });
        } else {
            location.reload();
        }
    });

    // Pages also navigate from code (window.location.href = "/servers/..."
    // after creating something). Where the Navigation API exists, those
    // keep the shell too. Elsewhere they are ordinary page loads.
    if (canSoftNav && W.navigation && typeof W.navigation.addEventListener === "function") {
        on(W.navigation, "navigate", function (e) {
            if (hardNav || !e.cancelable) return;
            if (e.navigationType !== "push" && e.navigationType !== "replace") return;
            if (e.hashChange || e.downloadRequest || e.formData) return;
            if (e.destination && e.destination.sameDocument) return;
            var url;
            try {
                url = new URL(e.destination.url);
            } catch (err) {
                return;
            }
            if (!eligible(url)) return;
            e.preventDefault();
            softNavigate(url.href, { replace: e.navigationType === "replace" });
        });
    }

    // Prefetch on intent: hovering or touching a link fetches the page so
    // the click opens it at once.
    var intentTimer = 0;
    function prefetchFrom(e) {
        var a = linkFrom(e);
        if (!a) return;
        var url;
        try {
            url = new URL(a.href, location.href);
        } catch (err) {
            return;
        }
        if (!eligible(url) || url.pathname + url.search === location.pathname + location.search) return;
        N.clearTimeout(intentTimer);
        intentTimer = N.setTimeout(
            function () {
                fetchHtml(url).catch(function () {});
            },
            e.type === "touchstart" ? 0 : 60
        );
    }
    on(document, "mouseover", prefetchFrom, { passive: true });
    on(document, "focusin", prefetchFrom, { passive: true });
    on(document, "touchstart", prefetchFrom, { passive: true });
    on(document, "mouseout", function () {
        N.clearTimeout(intentTimer);
    }, { passive: true });

    if (canSoftNav && "scrollRestoration" in history && isAppPath(location.pathname)) {
        history.scrollRestoration = "manual";
    }

    // ---- 5. toasts ---------------------------------------------------------
    var toastHost;
    function toast(opts) {
        if (typeof opts === "string") opts = { title: opts };
        if (!document.body) return function () {};
        if (!toastHost) {
            toastHost = document.createElement("div");
            toastHost.setAttribute("aria-live", "polite");
            toastHost.className =
                "fixed z-[80] bottom-4 right-4 left-4 sm:left-auto flex flex-col items-stretch sm:items-end gap-2 pointer-events-none";
            toastHost.style.marginBottom = "env(safe-area-inset-bottom)";
            document.body.appendChild(toastHost);
        }
        if (opts.id) {
            var existing = toastHost.querySelector('[data-toast-id="' + opts.id + '"]');
            if (existing) existing.remove();
        }
        var tone = opts.tone || "neutral";
        var dot = { neutral: "bg-zinc-400", ok: "bg-emerald-500", warn: "bg-amber-400", error: "bg-brand-500" }[tone] || "bg-zinc-400";
        var el = document.createElement("div");
        if (opts.id) el.setAttribute("data-toast-id", opts.id);
        el.setAttribute("role", tone === "error" ? "alert" : "status");
        el.className =
            "pointer-events-auto w-full sm:w-[360px] flex items-start gap-3 rounded-2xl border border-line bg-panel px-4 py-3 shadow-pop animate-flux-sheet";
        var dotEl = document.createElement("span");
        dotEl.className = "mt-1.5 w-2 h-2 shrink-0 rounded-full " + dot;
        var body = document.createElement("div");
        body.className = "min-w-0 flex-1";
        var title = document.createElement("p");
        title.className = "text-sm font-medium text-zinc-900 dark:text-zinc-100";
        title.textContent = opts.title || "";
        body.appendChild(title);
        if (opts.text) {
            var text = document.createElement("p");
            text.className = "text-xs text-zinc-500 mt-0.5";
            text.textContent = opts.text;
            body.appendChild(text);
        }
        el.appendChild(dotEl);
        el.appendChild(body);
        if (opts.action) {
            var btn = document.createElement(opts.action.href ? "a" : "button");
            if (opts.action.href) btn.href = opts.action.href;
            btn.className =
                "shrink-0 self-center rounded-full bg-zinc-900 text-white dark:bg-white dark:text-zinc-900 text-xs font-semibold px-3 py-1.5";
            btn.textContent = opts.action.label;
            if (opts.action.run) on(btn, "click", opts.action.run);
            el.appendChild(btn);
        }
        var close = document.createElement("button");
        close.setAttribute("aria-label", "Dismiss");
        close.className = "shrink-0 -mr-1 w-6 h-6 rounded-full text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-100";
        close.innerHTML =
            '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" class="w-4 h-4 mx-auto"><path d="M6 6l8 8M14 6l-8 8" stroke-linecap="round"/></svg>';
        var dismiss = function () {
            el.remove();
        };
        on(close, "click", dismiss);
        el.appendChild(close);
        toastHost.appendChild(el);
        if (opts.timeout !== 0) N.setTimeout(dismiss, opts.timeout || 5000);
        return dismiss;
    }
    flux.toast = toast;

    on(W, "offline", function () {
        toast({ id: "net", tone: "warn", title: "You're offline", text: "Changes can't be saved until the connection is back.", timeout: 0 });
    });
    on(W, "online", function () {
        toast({ id: "net", tone: "ok", title: "Back online", timeout: 3000 });
        htmlCache.clear();
        emit("flux:online", {});
    });

    // ---- keyboard shortcuts -------------------------------------------------
    // g then a letter jumps to a section; [ collapses the sidebar. The
    // command palette (components/CommandPalette.tyx) owns Cmd/Ctrl+K and /.
    var GO = { d: "/dashboard", s: "/servers", p: "/providers", r: "/registrars", c: "/source-control", t: "/team", ",": "/settings" };
    var pendingG = 0;
    function typing(e) {
        var t = e.target;
        if (!t || !t.tagName) return false;
        var tag = t.tagName;
        return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || t.isContentEditable;
    }
    on(document, "keydown", function (e) {
        if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || typing(e)) return;
        if (doc.getAttribute("data-shell") !== "app") return;
        var k = e.key;
        if (pendingG && GO[k.toLowerCase()]) {
            e.preventDefault();
            pendingG = 0;
            softNavigate(GO[k.toLowerCase()], {});
            return;
        }
        pendingG = 0;
        if (k === "g") {
            pendingG = 1;
            N.setTimeout(function () {
                pendingG = 0;
            }, 1200);
        } else if (k === "[") {
            e.preventDefault();
            flux.sidebar();
        }
    });

    // ---- 4. sessions and resilient requests ---------------------------------
    if (!N.fetch) return;

    var refreshing = null;
    var signedIn = false;
    var lastRefresh = Date.now();
    var sessionNoticeShown = false;

    // Calls that mean "who are you" and must not loop into a refresh.
    var NO_RETRY = /^\/api\/(auth\/|login$|register$|me$)/;

    function apiPath(input) {
        try {
            var raw = typeof input === "string" ? input : input && input.url ? input.url : String(input);
            var url = new URL(raw, location.href);
            if (url.origin !== location.origin) return null;
            return url.pathname.indexOf("/api/") === 0 ? url.pathname : null;
        } catch (e) {
            return null;
        }
    }

    function methodOf(input, init) {
        var m = (init && init.method) || (typeof Request !== "undefined" && input instanceof Request ? input.method : "GET");
        return String(m || "GET").toUpperCase();
    }

    function refresh() {
        if (!refreshing) {
            refreshing = N.fetch("/api/auth/refresh", {
                method: "POST",
                credentials: "same-origin",
                headers: { Accept: "application/json" },
            })
                .then(function (res) {
                    if (res.ok) lastRefresh = Date.now();
                    return res.ok;
                })
                .catch(function () {
                    return false;
                })
                .then(function (ok) {
                    N.setTimeout(function () {
                        refreshing = null;
                    }, 1000);
                    return ok;
                });
        }
        return refreshing;
    }

    function sessionEnded() {
        if (sessionNoticeShown || !signedIn) return;
        sessionNoticeShown = true;
        var next = encodeURIComponent(location.pathname + location.search);
        toast({
            id: "session",
            tone: "warn",
            title: "Your session ended",
            text: "Sign in again to pick up where you left off.",
            action: { label: "Sign in", href: "/login?next=" + next },
            timeout: 0,
        });
    }

    var RETRY_STATUS = { 502: 1, 503: 1, 504: 1 };
    var RETRY_DELAYS = [400, 1200];

    function wait(ms) {
        return new Promise(function (resolve) {
            N.setTimeout(resolve, ms);
        });
    }

    // GET and HEAD are safe to repeat: retry them through short outages.
    function withRetries(input, init, attempt) {
        return N.fetch(input, init).then(
            function (res) {
                if (RETRY_STATUS[res.status] && attempt < RETRY_DELAYS.length && navigator.onLine !== false) {
                    return wait(RETRY_DELAYS[attempt]).then(function () {
                        return withRetries(input, init, attempt + 1);
                    });
                }
                return res;
            },
            function (err) {
                var aborted = err && err.name === "AbortError";
                if (!aborted && attempt < RETRY_DELAYS.length && navigator.onLine !== false) {
                    return wait(RETRY_DELAYS[attempt]).then(function () {
                        return withRetries(input, init, attempt + 1);
                    });
                }
                throw err;
            }
        );
    }

    W.fetch = function (input, init) {
        var path = apiPath(input);
        if (!path) return N.fetch(input, init);
        var method = methodOf(input, init);
        var idempotent = method === "GET" || method === "HEAD";
        var reusable = !(typeof Request !== "undefined" && input instanceof Request);
        var pending = idempotent && reusable ? withRetries(input, init, 0) : N.fetch(input, init);
        if (NO_RETRY.test(path)) {
            return pending.then(function (res) {
                if (res.ok && path === "/api/me") signedIn = true;
                return res;
            });
        }

        return pending.then(function (res) {
            if (res.status !== 401) {
                if (res.ok) signedIn = true;
                return res;
            }
            if (!reusable) return res;
            return refresh().then(function (ok) {
                if (!ok) {
                    sessionEnded();
                    return res;
                }
                signedIn = true;
                return N.fetch(input, init);
            });
        });
    };

    // Background refresh for pages left open, only while signed in and the
    // tab is visible (a hidden tab refreshes when it comes back).
    var KEEP_ALIVE_MS = 10 * 60 * 1000;
    function keepAlive() {
        if (signedIn && document.visibilityState === "visible" && Date.now() - lastRefresh >= KEEP_ALIVE_MS) {
            refresh();
        }
    }
    N.setInterval(keepAlive, 60 * 1000);
    on(document, "visibilitychange", keepAlive);
})();
