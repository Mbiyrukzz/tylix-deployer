/*
 * Tylix Deploy: the bits every page needs before it renders.
 * Loaded from app/head.html, ahead of the page script.
 *
 * 1. Theme before first paint. The deployer defaults to dark (see
 *    capabilities/Theme.tyx); the framework's own head script falls back to
 *    the OS setting, which flashed light pages between navigations.
 *
 * 2. Sessions that keep themselves alive. Tylix 2 access tokens live 15
 *    minutes; the refresh session lives 30 days and rotates on every use.
 *    Any /api call that answers 401 refreshes once (shared by every request
 *    in flight, so a page firing six calls rotates the token once) and is
 *    retried. Pages that stay open (terminals, deploy logs, live stats) also
 *    refresh in the background so their channels keep a valid cookie.
 *
 * 3. Navigation without the reload look. Every page is its own document, so
 *    the full-screen Tylix loader used to cover the screen on every click.
 *    Now it only shows on the first visit: moving between pages keeps the
 *    background, cross-fades (View Transitions), and shows a slim progress
 *    bar instead. Links are prerendered on hover (Speculation Rules, in
 *    app/head.html), so most clicks open an already rendered page.
 */
(function () {
    "use strict";

    var doc = document.documentElement;

    // ---- 1. theme -------------------------------------------------------
    try {
        var stored = localStorage.getItem("theme");
        doc.classList.toggle("dark", stored ? stored === "dark" : true);
    } catch (e) {
        doc.classList.add("dark");
    }

    // ---- 3a. was this an in-app navigation? ------------------------------
    // Same-origin referrer and a normal navigation (or back/forward) means
    // the person was already in the app: skip the splash, show the bar.
    try {
        var nav = performance.getEntriesByType("navigation")[0];
        var type = nav ? nav.type : "navigate";
        var sameOrigin = document.referrer && new URL(document.referrer).origin === location.origin;
        if (sameOrigin && type !== "reload") doc.setAttribute("data-soft-nav", "");
    } catch (e) {
        /* old browser: keep the splash */
    }

    // Done as soon as the page put something on screen (the same signal the
    // framework's loading screen waits for).
    function markReady() {
        doc.setAttribute("data-app-ready", "");
        doc.removeAttribute("data-navigating");
        // Pages often render their sidebar after data arrives; try again shortly.
        revealActiveTab();
        setTimeout(revealActiveTab, 400);
    }

    // On phones the section sidebar is a sideways strip: bring the current
    // tab into view (horizontally only, the page itself doesn't move).
    function revealActiveTab() {
        if (!window.matchMedia || !matchMedia("(max-width: 1023px)").matches) return;
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
        setTimeout(markReady, 15000);
    }
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", watchReady);
    else watchReady();

    // A page restored from the back/forward cache is already rendered.
    addEventListener("pageshow", function (e) {
        if (e.persisted) markReady();
    });

    // ---- 3b. feedback the moment a link is clicked ----------------------
    // The bar starts on click, before the next document arrives, so a slow
    // server still feels like it heard you.
    document.addEventListener("click", function (e) {
        if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        var a = e.target && e.target.closest ? e.target.closest("a[href]") : null;
        if (!a || a.target === "_blank" || a.hasAttribute("download")) return;
        var url;
        try {
            url = new URL(a.href, location.href);
        } catch (err) {
            return;
        }
        if (url.origin !== location.origin || url.pathname.indexOf("/api/") === 0) return;
        // Same page, different hash: no navigation.
        if (url.pathname === location.pathname && url.search === location.search && url.hash) return;
        doc.setAttribute("data-navigating", "");
    });

    // ---- 2. sessions ----------------------------------------------------
    if (!window.fetch) return;

    var nativeFetch = window.fetch.bind(window);
    var refreshing = null;
    var signedIn = false;
    var lastRefresh = Date.now();

    // Calls that mean "who are you" and must not loop into a refresh.
    var NO_RETRY = /^\/api\/(auth\/|login$|register$)/;

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

    function refresh() {
        if (!refreshing) {
            refreshing = nativeFetch("/api/auth/refresh", {
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
                    // Keep the answer for a moment so requests that 401'd
                    // together reuse it instead of rotating again.
                    setTimeout(function () {
                        refreshing = null;
                    }, 1000);
                    return ok;
                });
        }
        return refreshing;
    }

    window.fetch = function (input, init) {
        var path = apiPath(input);
        var pending = nativeFetch(input, init);
        if (!path || NO_RETRY.test(path)) return pending;

        return pending.then(function (res) {
            if (res.status !== 401) {
                if (res.ok) signedIn = true;
                return res;
            }
            // A Request object's body can only be read once; let it fail.
            if (typeof Request !== "undefined" && input instanceof Request) return res;
            return refresh().then(function (ok) {
                if (!ok) return res;
                signedIn = true;
                return nativeFetch(input, init);
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
    setInterval(keepAlive, 60 * 1000);
    document.addEventListener("visibilitychange", keepAlive);
})();
