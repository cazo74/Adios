/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║  AD'IOS — content.js v2.0                                               ║
 * ║  "Say goodbye to ads."                                                  ║
 * ║                                                                          ║
 * ║  Moteur de détection multi-couches :                                    ║
 * ║    Layer 1 — Classes CSS YouTube (8 sélecteurs)                         ║
 * ║    Layer 2 — Player API interne (ytInitialPlayerResponse + getAdState)  ║
 * ║    Layer 3 — Video Events natifs (timeupdate, ratechange, playing)      ║
 * ║    Layer 4 — PerformanceObserver (URLs de ressources pub)               ║
 * ║                                                                          ║
 * ║  Stratégies d'action (cascade) :                                        ║
 * ║    1. Click Skip button                                                  ║
 * ║    2. Close overlay/banner                                               ║
 * ║    3. Fast-forward (currentTime = duration)                             ║
 * ║    4. Mute + playbackRate x16 (pubs non-skippables)                     ║
 * ║    5. Reload SPA (last resort)                                           ║
 * ║                                                                          ║
 * ║  Robustesse :                                                            ║
 * ║    - Backoff exponentiel entre tentatives                               ║
 * ║    - Verrou anti-concurrence                                             ║
 * ║    - Gestion SPA YouTube (yt-navigate-* + pushState)                   ║
 * ║    - Auto-restauration audio/vitesse après pub                          ║
 * ║    - Zéro setInterval agressif                                          ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 */

;(function () {
  'use strict';

  // ── Garde contre les injections multiples ────────────────────────────────────
  if (window.__adiosLoaded) return;
  window.__adiosLoaded = true;

  // ════════════════════════════════════════════════════════════════════════════
  //  CONFIGURATION
  // ════════════════════════════════════════════════════════════════════════════
  const CFG = {
    // Détection
    MIN_SIGNALS        : 2,      // Signaux minimum pour confirmer une pub
    // Timing
    DELAY_MIN          : 400,    // ms — délai min avant action
    DELAY_MAX          : 650,    // ms — délai max avant action
    DEBOUNCE_MS        : 200,    // ms — debounce MutationObserver
    RECHECK_MS         : 800,    // ms — délai avant re-vérification
    INIT_RETRY_MS      : 1200,   // ms — délai ré-init post-navigation
    // Tentatives
    MAX_ATTEMPTS       : 4,      // Max tentatives avant abandon
    BACKOFF_BASE       : 500,    // ms — base du backoff exponentiel
    // Accélération pub non-skippable
    MUTE_RATE          : 16,     // vitesse x16 sur pubs non-skippables
    // Logs
    PREFIX             : "AD'IOS",
  };

  // ════════════════════════════════════════════════════════════════════════════
  //  ÉTAT GLOBAL
  // ════════════════════════════════════════════════════════════════════════════
  const STATE = {
    attempts       : 0,
    isHandling     : false,
    debounceTimer  : null,
    initTimer      : null,
    observer       : null,       // MutationObserver
    perfObserver   : null,       // PerformanceObserver
    videoListeners : [],         // [{ el, type, fn }] — pour cleanup propre
    mutedByUs      : false,      // On a muté nous-mêmes
    rateChangedByUs: false,      // On a changé la vitesse
    originalRate   : 1,
    lastAdUrl      : null,       // Dernière URL de pub détectée via Perf
    adConfirmedByPerf: false,    // Pub confirmée par PerformanceObserver
  };

  // ════════════════════════════════════════════════════════════════════════════
  //  LOGGER
  // ════════════════════════════════════════════════════════════════════════════
  const log  = (...a) => console.log( `%c${CFG.PREFIX}`, 'color:#ff3d3d;font-weight:bold', ...a);
  const warn = (...a) => console.warn(`%c${CFG.PREFIX}`, 'color:#f39c12;font-weight:bold', ...a);
  const dbg  = (...a) => console.debug(`%c${CFG.PREFIX}`, 'color:#888', ...a);

  // ════════════════════════════════════════════════════════════════════════════
  //  PERSISTANCE (popup stats)
  // ════════════════════════════════════════════════════════════════════════════
  function persistLog(msg, type = '') {
    try {
      chrome.storage.local.get(['logs', 'totalSkipped', 'sessionStart'], (data) => {
        const logs         = data.logs         || [];
        const totalSkipped = data.totalSkipped || 0;
        const sessionStart = data.sessionStart || Date.now();

        logs.push({ ts: Date.now(), msg, type });
        if (logs.length > 150) logs.splice(0, logs.length - 150);

        chrome.storage.local.set({
          logs,
          totalSkipped: type === 'success' ? totalSkipped + 1 : totalSkipped,
          sessionStart,
        });
      });
    } catch (_) { /* Extension context invalidé — pas grave */ }
  }

  // ════════════════════════════════════════════════════════════════════════════
  //  UTILITAIRES
  // ════════════════════════════════════════════════════════════════════════════

  const sleep = ms => new Promise(r => setTimeout(r, ms));

  const humanDelay = () =>
    sleep(Math.floor(Math.random() * (CFG.DELAY_MAX - CFG.DELAY_MIN + 1)) + CFG.DELAY_MIN);

  /** Backoff exponentiel : 500ms, 1s, 2s, 4s… */
  const backoffDelay = attempt =>
    sleep(CFG.BACKOFF_BASE * Math.pow(2, attempt - 1));

  /** Vérifie si un élément est vraiment visible à l'écran. */
  function isVisible(el) {
    if (!el) return false;
    const s = window.getComputedStyle(el);
    if (s.display === 'none' || s.visibility === 'hidden' || parseFloat(s.opacity) === 0) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  /** Ajoute un event listener et l'enregistre pour cleanup. */
  function addTrackedListener(el, type, fn, options) {
    if (!el) return;
    el.addEventListener(type, fn, options);
    STATE.videoListeners.push({ el, type, fn });
  }

  /** Supprime tous les listeners enregistrés. */
  function removeTrackedListeners() {
    for (const { el, type, fn } of STATE.videoListeners) {
      try { el.removeEventListener(type, fn); } catch (_) {}
    }
    STATE.videoListeners = [];
  }

  // ════════════════════════════════════════════════════════════════════════════
  //  LAYER 1 — DÉTECTION CSS / DOM
  // ════════════════════════════════════════════════════════════════════════════

  /**
   * Analyse le DOM en croisant 8+ signaux indépendants.
   * Retourne { isAd, signals[], skipBtn, overlayCloseBtn, video, isUnskippable }
   */
  function detectAdDOM() {
    const signals = [];

    // Signal 1 — Classe .ad-showing sur le player
    const player = document.getElementById('movie_player');
    if (player?.classList.contains('ad-showing'))      signals.push('css:ad-showing');
    if (player?.classList.contains('ad-interrupting')) signals.push('css:ad-interrupting');

    // Signal 2 — Bouton Skip (toutes les variantes connues + attributs)
    const skipSelectors = [
      '.ytp-ad-skip-button',
      '.ytp-ad-skip-button-modern',
      '.ytp-skip-ad-button',
      '[class*="skip-button"][class*="ytp"]',
      'button[id*="skip"]',
    ];
    const skipBtn = document.querySelector(skipSelectors.join(','));
    if (skipBtn && isVisible(skipBtn)) signals.push('dom:skip-btn');

    // Signal 3 — Overlay close button
    const overlayCloseBtn = document.querySelector(
      '.ytp-ad-overlay-close-button, .ytp-ad-overlay-slot .ytp-ad-text-overlay'
    );
    if (overlayCloseBtn && isVisible(overlayCloseBtn)) signals.push('dom:overlay-close');

    // Signal 4 — Texte/badge publicitaire
    const adText = document.querySelector([
      '.ytp-ad-simple-ad-badge',
      '.ytp-ad-text',
      '.ytp-ad-duration-remaining',
      '.ytp-ad-preview-text',
    ].join(','));
    if (adText && isVisible(adText)) signals.push('dom:ad-text');

    // Signal 5 — Overlay container principal
    const adOverlay = document.querySelector('.ytp-ad-player-overlay, .ytp-ad-player-overlay-instream-info');
    if (adOverlay && isVisible(adOverlay)) signals.push('dom:ad-overlay');

    // Signal 6 — Preview pub (compte à rebours avant le skip)
    const adPreview = document.querySelector('.ytp-ad-preview-container, .ytp-ad-preview-slot');
    if (adPreview && isVisible(adPreview)) signals.push('dom:ad-preview');

    // Signal 7 — Module companion/sponsored
    const companionAd = document.querySelector('.ytp-ad-module, .ytp-ad-action-interstitial');
    if (companionAd && isVisible(companionAd)) signals.push('dom:companion');

    // Signal 8 — Bouton "Pourquoi cette pub" / "Visit advertiser"
    const whyAd = document.querySelector('.ytp-ad-button-icon, [id="visit-advertiser-link"]');
    if (whyAd && isVisible(whyAd)) signals.push('dom:why-ad');

    // Signal 9 — PerformanceObserver a détecté une URL pub
    if (STATE.adConfirmedByPerf) signals.push('perf:ad-url');

    // Détection pub non-skippable : pas de bouton skip mais overlay pub présent
    const isUnskippable = signals.length >= CFG.MIN_SIGNALS &&
      !skipBtn &&
      signals.some(s => s.includes('ad-overlay') || s.includes('ad-text') || s.includes('ad-showing'));

    return {
      isAd        : signals.length >= CFG.MIN_SIGNALS,
      signals,
      skipBtn     : (skipBtn && isVisible(skipBtn)) ? skipBtn : null,
      overlayCloseBtn: (overlayCloseBtn && isVisible(overlayCloseBtn)) ? overlayCloseBtn : null,
      video       : document.querySelector('video'),
      isUnskippable,
    };
  }

  // ════════════════════════════════════════════════════════════════════════════
  //  LAYER 2 — PLAYER API INTERNE YOUTUBE
  // ════════════════════════════════════════════════════════════════════════════

  /**
   * YouTube expose des méthodes sur l'élément #movie_player.
   * getAdState() retourne un objet avec l'état réel de la pub.
   * Beaucoup plus fiable que les classes CSS qui peuvent changer.
   */
  function detectAdPlayerAPI() {
    try {
      const player = document.getElementById('movie_player');
      if (!player) return { isAd: false, source: 'api:no-player' };

      // Méthode 1 : getAdState (disponible sur certaines versions)
      if (typeof player.getAdState === 'function') {
        const state = player.getAdState();
        // -1 = pas de pub, 1+ = pub en cours
        if (state !== -1 && state !== null && state !== undefined) {
          dbg(`getAdState() = ${state}`);
          return { isAd: true, source: 'api:getAdState' };
        }
      }

      // Méthode 2 : getVideoData — les pubs ont un isAd flag
      if (typeof player.getVideoData === 'function') {
        const data = player.getVideoData();
        if (data?.isAd === true) {
          return { isAd: true, source: 'api:getVideoData' };
        }
      }

      // Méthode 3 : getCurrentTime vs getDuration — ratio suspect = pub
      // (les pubs instream ont une durée courte et un currentTime qui repart de 0)

    } catch (e) {
      dbg('API player error:', e.message);
    }
    return { isAd: false, source: 'api:clean' };
  }

  // ════════════════════════════════════════════════════════════════════════════
  //  LAYER 4 — PERFORMANCE OBSERVER (URLs ressources pub)
  // ════════════════════════════════════════════════════════════════════════════

  /**
   * YouTube charge des ressources spécifiques pendant les pubs.
   * On les détecte via PerformanceObserver sans webRequest blocking.
   * Patterns connus dans les URLs de tracking/serving pub YouTube.
   */
  const AD_URL_PATTERNS = [
    'googlevideo.com/videoplayback',  // Stream vidéo pub
    'doubleclick.net',                // Tracking Google Ads
    'googleads.g.doubleclick',
    'ad.youtube.com',
    '/api/stats/ads',                 // Stats pub YouTube
    'youtube.com/pagead',
    'googleadservices.com',
    '/ptracking',                     // Pixel tracking pub
    'yt3.ggpht.com/ytad',             // Thumbnail pub
  ];

  function initPerformanceObserver() {
    if (!window.PerformanceObserver) return;

    try {
      STATE.perfObserver?.disconnect();

      STATE.perfObserver = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          const url = entry.name || '';
          if (AD_URL_PATTERNS.some(p => url.includes(p))) {
            if (STATE.lastAdUrl !== url) {
              STATE.lastAdUrl = url;
              STATE.adConfirmedByPerf = true;
              dbg('PerformanceObserver — URL pub:', url.substring(0, 80));
              // Reset après 5s (la pub est chargée, pas forcément encore jouée)
              setTimeout(() => { STATE.adConfirmedByPerf = false; }, 5000);
            }
          }
        }
      });

      STATE.perfObserver.observe({ entryTypes: ['resource'] });
      dbg('PerformanceObserver actif');
    } catch (e) {
      dbg('PerformanceObserver non disponible:', e.message);
    }
  }

  // ════════════════════════════════════════════════════════════════════════════
  //  LAYER 3 — VIDEO EVENTS
  // ════════════════════════════════════════════════════════════════════════════

  /**
   * Écoute les événements natifs de la balise <video>.
   * Si la vidéo joue ET que des signaux pub existent → déclenche handleAd.
   * Permet de détecter les pubs qui démarrent sans mutation DOM notable.
   */
  function attachVideoListeners() {
    removeTrackedListeners();

    const video = document.querySelector('video');
    if (!video) return;

    // À chaque changement de source vidéo, on vérifie
    addTrackedListener(video, 'playing', () => {
      // Légère temporisation pour laisser le DOM se mettre à jour
      setTimeout(() => {
        const d = detectAdDOM();
        if (d.isAd && !STATE.isHandling) {
          dbg('Video event "playing" → pub détectée');
          handleAd(d);
        }
      }, 150);
    });

    // Détection pub non-skippable via timeupdate
    // Si durée < 35s et overlay pub présent → pub non-skippable
    addTrackedListener(video, 'timeupdate', () => {
      if (STATE.isHandling) return;
      const dur = video.duration;
      if (!isFinite(dur) || dur > 35) return;
      const d = detectAdDOM();
      if (d.isAd && d.isUnskippable && !STATE.isHandling) {
        dbg('Video event "timeupdate" → pub non-skippable détectée');
        handleAd(d);
      }
    });

    dbg('Video listeners attachés');
  }

  // ════════════════════════════════════════════════════════════════════════════
  //  DÉTECTION COMBINÉE (tous les layers)
  // ════════════════════════════════════════════════════════════════════════════

  function detectAdFull() {
    const domResult = detectAdDOM();
    const apiResult = detectAdPlayerAPI();

    // Si l'API confirme → on ajoute un signal fort
    if (apiResult.isAd && !domResult.signals.includes(apiResult.source)) {
      domResult.signals.push(apiResult.source);
    }

    domResult.isAd = domResult.signals.length >= CFG.MIN_SIGNALS;
    return domResult;
  }

  // ════════════════════════════════════════════════════════════════════════════
  //  STRATÉGIES D'ACTION
  // ════════════════════════════════════════════════════════════════════════════

  /** Stratégie 1 — Clic Skip button */
  function strategySkipClick(d) {
    if (!d.skipBtn) return false;
    d.skipBtn.click();
    log('✓ Skip button cliqué');
    persistLog('Skip button cliqué', 'success');
    return true;
  }

  /** Stratégie 2 — Fermer overlay/bannière */
  function strategyCloseOverlay(d) {
    if (!d.overlayCloseBtn) return false;
    d.overlayCloseBtn.click();
    log('✓ Overlay fermée');
    persistLog('Overlay pub fermée', 'success');
    return true;
  }

  /**
   * Stratégie 3 — Fast-forward à la fin de la pub.
   * On mute avant pour éviter le flash audio.
   */
  function strategyFastForward(d) {
    const { video } = d;
    if (!video) return false;

    const dur = video.duration;
    if (!isFinite(dur) || dur <= 0 || video.currentTime >= dur - 0.3) return false;

    try {
      if (!video.muted) {
        video.muted = true;
        STATE.mutedByUs = true;
      }
      video.currentTime = Math.max(dur - 0.1, 0);
      log(`✓ Fast-forward → ${dur.toFixed(2)}s`);
      persistLog(`Fast-forward pub (${dur.toFixed(1)}s)`, 'success');
      return true;
    } catch (e) {
      warn('Fast-forward échoué:', e.message);
      return false;
    }
  }

  /**
   * Stratégie 4 — Mute + playbackRate x16
   * Pour les pubs non-skippables dont on ne peut pas sauter la timeline.
   * La pub se "joue" 16x plus vite — en ~1s pour une pub de 15s.
   */
  function strategyTurbo(d) {
    const { video } = d;
    if (!video) return false;

    try {
      STATE.originalRate = video.playbackRate || 1;
      if (!video.muted) {
        video.muted = true;
        STATE.mutedByUs = true;
      }
      video.playbackRate = CFG.MUTE_RATE;
      STATE.rateChangedByUs = true;
      log(`✓ Turbo mode x${CFG.MUTE_RATE} — pub en cours d'accélération`);
      persistLog(`Pub accélérée x${CFG.MUTE_RATE}`, 'success');
      return true;
    } catch (e) {
      warn('Turbo échoué:', e.message);
      return false;
    }
  }

  /** Stratégie 5 — Reload SPA (last resort) */
  function strategyReload() {
    warn('⚠ Last resort — rechargement SPA');
    persistLog('Rechargement page (last resort)', 'warn');
    window.location.href = window.location.href;
  }

  // ════════════════════════════════════════════════════════════════════════════
  //  RESTAURATION AUDIO / VITESSE
  // ════════════════════════════════════════════════════════════════════════════

  function restoreVideoState() {
    const video = document.querySelector('video');
    if (!video) return;

    if (STATE.mutedByUs) {
      video.muted = false;
      STATE.mutedByUs = false;
      dbg('Son restauré');
    }
    if (STATE.rateChangedByUs) {
      video.playbackRate = STATE.originalRate || 1;
      STATE.rateChangedByUs = false;
      dbg(`Vitesse restaurée → x${STATE.originalRate}`);
    }
  }

  // ════════════════════════════════════════════════════════════════════════════
  //  RESET D'ÉTAT
  // ════════════════════════════════════════════════════════════════════════════

  function resetState() {
    const hadAttempts = STATE.attempts > 0;
    STATE.attempts    = 0;
    STATE.isHandling  = false;
    if (hadAttempts) log('↺ Vidéo normale — état réinitialisé');
  }

  // ════════════════════════════════════════════════════════════════════════════
  //  GESTIONNAIRE PRINCIPAL
  // ════════════════════════════════════════════════════════════════════════════

  async function handleAd(detection) {
    if (STATE.isHandling) return;
    if (STATE.attempts >= CFG.MAX_ATTEMPTS) {
      warn(`Plafond de ${CFG.MAX_ATTEMPTS} tentatives atteint — pause jusqu'à prochaine navigation`);
      return;
    }

    STATE.isHandling = true;
    STATE.attempts++;

    log(
      `📺 Pub confirmée — Tentative ${STATE.attempts}/${CFG.MAX_ATTEMPTS}`,
      `| [${detection.signals.join(' · ')}]`
    );

    // Délai naturel (anti-pattern-detect + stabilisation DOM)
    await humanDelay();

    // Re-vérification : la pub est-elle encore là ?
    const recheck = detectAdFull();
    if (!recheck.isAd) {
      log('Pub disparue pendant le délai — aucune action');
      restoreVideoState();
      STATE.isHandling = false;
      resetState();
      return;
    }

    // ── Cascade de stratégies ─────────────────────────────────────────────────

    // 1. Skip button
    if (strategySkipClick(recheck)) {
      STATE.isHandling = false;
      return;
    }

    // 2. Close overlay
    if (strategyCloseOverlay(recheck)) {
      STATE.isHandling = false;
      return;
    }

    // 3. Fast-forward (si durée connue)
    if (strategyFastForward(recheck)) {
      await sleep(CFG.RECHECK_MS);
      const post = detectAdFull();
      if (!post.isAd) {
        restoreVideoState();
        resetState();
      } else {
        restoreVideoState();
        warn('Fast-forward insuffisant');
      }
      STATE.isHandling = false;
      return;
    }

    // 4. Turbo x16 (pub non-skippable)
    if (recheck.isUnskippable && strategyTurbo(recheck)) {
      // On surveille la fin de la pub via timeupdate
      const video = recheck.video;
      if (video) {
        const onEnd = () => {
          restoreVideoState();
          resetState();
          video.removeEventListener('ended', onEnd);
          video.removeEventListener('pause', onEnd);
        };
        video.addEventListener('ended', onEnd, { once: true });
        // Sécurité : si YouTube reprend la vidéo normale (pause puis play)
        video.addEventListener('pause', () => {
          setTimeout(() => {
            const still = detectAdFull();
            if (!still.isAd) { restoreVideoState(); resetState(); }
          }, 300);
        }, { once: true });
      }
      STATE.isHandling = false;
      return;
    }

    // 5. Last resort reload
    if (STATE.attempts >= CFG.MAX_ATTEMPTS) {
      strategyReload();
      return;
    }

    // Pas encore au max → libère le verrou, le backoff laissera une chance
    STATE.isHandling = false;

    // Backoff exponentiel avant la prochaine tentative
    await backoffDelay(STATE.attempts);
    const retry = detectAdFull();
    if (retry.isAd) handleAd(retry);
  }

  // ════════════════════════════════════════════════════════════════════════════
  //  MUTATION OBSERVER
  // ════════════════════════════════════════════════════════════════════════════

  function onMutation() {
    clearTimeout(STATE.debounceTimer);
    STATE.debounceTimer = setTimeout(() => {
      const d = detectAdFull();

      if (d.isAd) {
        handleAd(d);
      } else if (STATE.attempts > 0 && !STATE.isHandling) {
        restoreVideoState();
        resetState();
      }
    }, CFG.DEBOUNCE_MS);
  }

  function initObserver() {
    STATE.observer?.disconnect();

    // Cible préférée : #movie_player (scope limité = moins de mutations inutiles)
    // Fallback : document.body
    const target = document.getElementById('movie_player') || document.body;

    STATE.observer = new MutationObserver(onMutation);
    STATE.observer.observe(target, {
      attributes     : true,
      attributeFilter: ['class', 'style', 'aria-label'],
      childList      : true,
      subtree        : true,
    });

    dbg(`MutationObserver actif sur <${target.tagName}#${target.id || '—'}>`);
  }

  // ════════════════════════════════════════════════════════════════════════════
  //  GESTION NAVIGATION SPA YOUTUBE
  // ════════════════════════════════════════════════════════════════════════════

  function onNavigationStart() {
    dbg('Navigation démarrée — cleanup');
    clearTimeout(STATE.debounceTimer);
    clearTimeout(STATE.initTimer);
    removeTrackedListeners();
    restoreVideoState();
    resetState();
    STATE.adConfirmedByPerf = false;
  }

  function onNavigationFinish() {
    dbg('Navigation terminée — ré-init');
    STATE.initTimer = setTimeout(() => {
      initObserver();
      attachVideoListeners();
      // Vérification immédiate au démarrage de la nouvelle vidéo
      const d = detectAdFull();
      if (d.isAd) {
        log('Pub au démarrage de vidéo');
        handleAd(d);
      }
    }, CFG.INIT_RETRY_MS);
  }

  function setupNavigationListeners() {
    // Événements natifs YouTube SPA
    document.addEventListener('yt-navigate-start',  onNavigationStart);
    document.addEventListener('yt-navigate-finish', onNavigationFinish);

    // Fallback History API (certaines versions de YouTube ne fire pas les events custom)
    const _push = history.pushState.bind(history);
    history.pushState = function (...args) {
      _push(...args);
      dbg('pushState intercepté');
      clearTimeout(STATE.initTimer);
      STATE.initTimer = setTimeout(() => {
        resetState();
        initObserver();
        attachVideoListeners();
      }, CFG.INIT_RETRY_MS);
    };
  }

  // ════════════════════════════════════════════════════════════════════════════
  //  POINT D'ENTRÉE
  // ════════════════════════════════════════════════════════════════════════════

  function init() {
    log("🚀 v2.0.0 démarré — 'Say goodbye to ads.'");

    setupNavigationListeners();
    initObserver();
    initPerformanceObserver();
    attachVideoListeners();

    // Vérification initiale (page déjà chargée avec une pub en cours)
    setTimeout(() => {
      const d = detectAdFull();
      if (d.isAd) {
        log('Pub détectée au chargement initial');
        handleAd(d);
      }
    }, 500);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
