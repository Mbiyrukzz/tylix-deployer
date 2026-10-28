
(function () {
    "use strict";


        var IS_LOCAL = /^(localhost|127\.0\.0\.1)$/.test(window.location.hostname);

       var CONFIG = {
        provider: "turnstile",
        siteKey: IS_LOCAL
            ? "1x00000000000000000000AA"
            : "0x4AAAAAAFpDJv7OAJgPUe-S",
    };

    var MIN = 10;
    var MAX = 128;

    var SCRIPTS = {
        recaptcha: "https://www.google.com/recaptcha/api.js?render=explicit",
        turnstile: "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit",
    };

    var scriptPromise = null;
    var mounts = {};

    function captchaEnabled() {
        return !!CONFIG.siteKey;
    }

    function loadScript() {
        if (scriptPromise) return scriptPromise;
        scriptPromise = new Promise(function (resolve, reject) {
            var s = document.createElement("script");
            s.src = SCRIPTS[CONFIG.provider];
            s.async = true;
            s.defer = true;
            s.onload = resolve;
            s.onerror = function () {
                scriptPromise = null;
                reject(new Error("CAPTCHA script failed to load"));
            };
            document.head.appendChild(s);
        });
        return scriptPromise;
    }

    function provider() {
        return CONFIG.provider === "turnstile" ? window.turnstile : window.grecaptcha;
    }

    function whenReady(cb) {
        if (CONFIG.provider === "recaptcha" && window.grecaptcha && window.grecaptcha.ready) {
            window.grecaptcha.ready(cb);
        } else {
            cb();
        }
    }

    /**
     * Renders the widget into the element with this id. The element may not
     * exist yet (the page toggles it with {{#if}}), so this polls and also
     * re-renders if the framework swaps the element out from under it.
     */
    function mountCaptcha(containerId, onToken, onExpire) {
        if (!captchaEnabled()) return;
        unmountCaptcha(containerId);

        var mount = { widget: null, timer: null };
        mounts[containerId] = mount;

        loadScript()
            .then(function () {
                mount.timer = setInterval(function () {
                    var el = document.getElementById(containerId);
                    if (!el) {
                        mount.widget = null;
                        return;
                    }
                    if (mount.widget !== null && el.childNodes.length > 0) return;

                    whenReady(function () {
                        var target = document.getElementById(containerId);
                        if (mounts[containerId] !== mount || !target || target.childNodes.length > 0) return;
                        mount.widget = provider().render(target, {
                            sitekey: CONFIG.siteKey,
                            callback: function (token) {
                                onToken(token);
                            },
                            "expired-callback": function () {
                                onExpire();
                            },
                            "error-callback": function () {
                                onExpire();
                            },
                        });
                    });
                }, 400);
            })
            .catch(function (err) {
                console.error(err);
            });
    }

    function resetCaptcha(containerId) {
        var mount = mounts[containerId];
        if (!mount || mount.widget === null) return;
        try {
            provider().reset(mount.widget);
        } catch (err) {
            console.error(err);
        }
    }

    function unmountCaptcha(containerId) {
        var mount = mounts[containerId];
        if (mount && mount.timer) clearInterval(mount.timer);
        delete mounts[containerId];
    }

    /** Rule checks + strength data for the register page. */
    function passwordChecks(password) {
        var pw = String(password || "");
        var length = pw.length >= MIN && pw.length <= MAX;
        var letter = /\p{L}/u.test(pw);
        var number = /\d/.test(pw);
        var symbol = /[^\p{L}\d\s]/u.test(pw);
        var ok = length && letter && number && symbol;

        var met = (length ? 1 : 0) + (letter ? 1 : 0) + (number ? 1 : 0) + (symbol ? 1 : 0);
        var label = "";
        var pct = 0;
        var color = "#f43f5e";

        if (pw.length === 0) {
            label = "";
        } else if (!ok) {
            label = "Too weak";
            pct = 10 + met * 10;
        } else if (pw.length >= 18) {
            label = "Very strong";
            pct = 100;
            color = "#059669";
        } else if (pw.length >= 14) {
            label = "Strong";
            pct = 80;
            color = "#10b981";
        } else {
            label = "Okay";
            pct = 55;
            color = "#f59e0b";
        }

        return {
            length: length,
            letter: letter,
            number: number,
            symbol: symbol,
            ok: ok,
            label: label,
            pct: pct,
            color: color,
        };
    }

    window.TylixAuthUi = {
        captchaEnabled: captchaEnabled,
        mountCaptcha: mountCaptcha,
        resetCaptcha: resetCaptcha,
        unmountCaptcha: unmountCaptcha,
        passwordChecks: passwordChecks,
        MIN_PASSWORD_LENGTH: MIN,
        MAX_PASSWORD_LENGTH: MAX,
    };
})();