(function () {
  "use strict";

  var STORAGE_KEY = "atlas_demo_state_v1";
  var reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  var cryptoAvailable = !!(window.crypto && window.crypto.subtle);

  // Fixed minor-unit decimal places per asset — a protocol constant, the
  // same one backend/src/domain/money.ts defines server-side (ASSETS). This
  // is display-formatting math only, never a market rate: nothing below
  // uses this to price anything. Real rates always come from
  // AtlasAPI.getRate(), a live call to the backend.
  var ASSET_DECIMALS = { GBP: 2, USD: 2, BTC: 8, ETH: 18, USDC: 6 };
  var CRYPTO_ASSETS = ["BTC", "ETH", "USDC"];
  var FIAT_ASSETS = ["GBP", "USD"];

  function minorToDecimalString(minorUnitsStr, decimals) {
    var negative = minorUnitsStr.charAt(0) === "-";
    var abs = negative ? minorUnitsStr.slice(1) : minorUnitsStr;
    var s = abs.padStart(decimals + 1, "0");
    var whole = s.slice(0, s.length - decimals) || "0";
    var frac = decimals > 0 ? "." + s.slice(s.length - decimals) : "";
    return (negative ? "-" : "") + whole + frac;
  }

  function formatGBP(n) {
    return new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP" }).format(n || 0);
  }
  function formatFiat(n, currency) {
    return new Intl.NumberFormat(currency === "USD" ? "en-US" : "en-GB", { style: "currency", currency: currency }).format(n || 0);
  }
  function formatCrypto(asset, decimalStr) {
    var n = parseFloat(decimalStr) || 0;
    var places = asset === "BTC" ? 6 : asset === "ETH" ? 5 : 2; // display precision, not the ledger's real precision
    return n.toFixed(places);
  }

  /* ---------------- vault encryption (AES-256-GCM, key generated on-device) ----------------
   * Unchanged from the original prototype's design and still real: this is
   * what protects the identity's private key seed at rest in localStorage.
   * The key never leaves this device either way — this just means the copy
   * sitting in localStorage isn't plaintext. */

  var KEY_STORAGE_KEY = "atlas_demo_key_v1";
  var textEncoder = new TextEncoder();
  var textDecoder = new TextDecoder();

  function bytesToBase64(bytes) {
    var binary = "";
    for (var i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary);
  }
  function base64ToBytes(b64) {
    var binary = atob(b64);
    var bytes = new Uint8Array(binary.length);
    for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  async function getOrCreateLocalKey() {
    var stored = localStorage.getItem(KEY_STORAGE_KEY);
    if (stored) {
      var raw = base64ToBytes(stored);
      return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
    }
    var key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
    var exported = await crypto.subtle.exportKey("raw", key);
    localStorage.setItem(KEY_STORAGE_KEY, bytesToBase64(new Uint8Array(exported)));
    return key;
  }

  async function encryptJSON(obj, key) {
    var iv = crypto.getRandomValues(new Uint8Array(12));
    var plaintext = textEncoder.encode(JSON.stringify(obj));
    var ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv: iv }, key, plaintext);
    return { iv: bytesToBase64(iv), data: bytesToBase64(new Uint8Array(ciphertext)) };
  }
  async function decryptJSON(envelope, key) {
    var iv = base64ToBytes(envelope.iv);
    var data = base64ToBytes(envelope.data);
    var plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv: iv }, key, data);
    return JSON.parse(textDecoder.decode(plaintext));
  }

  /* ---------------- state ---------------- */

  var state = null;
  var cryptoKey = null;
  // The live signing session — {identityId, privateKey (CryptoKey)}. Rebuilt
  // from state.seedB64 on boot and after generation/recovery; never itself
  // persisted, since a CryptoKey isn't serializable and doesn't need to be —
  // the seed is what's stored, the key is reimported from it each load.
  var session = null;
  var sourcesCache = [];

  function defaultState() {
    return {
      identityId: null,
      displayId: null,
      fingerprint: null,
      publicKeyB64: null,
      seedB64: null,
      onboardingComplete: false,
      recoveryEnabled: false,
      recoveryKeys: [], // only known locally if generated/regenerated on this device — see Settings
      displayCurrency: "GBP",
      activity: [],
    };
  }

  function pushActivity(text) {
    state.activity.unshift({ text: text, ts: Date.now() });
    state.activity = state.activity.slice(0, 12);
    saveState();
    renderActivity();
  }

  async function saveState() {
    if (cryptoKey) {
      var envelope = await encryptJSON(state, cryptoKey);
      localStorage.setItem(STORAGE_KEY, JSON.stringify(envelope));
    } else {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ plain: true, state: state }));
    }
  }

  async function buildSessionFromState() {
    var keyPair = await AtlasAPI.importKeyPairFromSeed(base64ToBytes(state.seedB64), base64ToBytes(state.publicKeyB64));
    session = { identityId: state.identityId, privateKey: keyPair.privateKey };
  }

  /* ---------------- live log (real steps, real timing — no scripted delays) ---------------- */

  function makeLiveLog(el) {
    el.innerHTML = "";
    return {
      line: function (text, isError) {
        var d = document.createElement("div");
        d.className = "line" + (isError ? " line-error" : "");
        d.textContent = text;
        el.appendChild(d);
        if (reduced) {
          d.classList.add("shown");
        } else {
          requestAnimationFrame(function () { d.classList.add("shown"); });
        }
      },
    };
  }

  /* ---------------- funding sources (server is the source of truth) ---------------- */

  async function refreshSources() {
    sourcesCache = await AtlasAPI.listFundingSources(session);
    return sourcesCache;
  }

  function sourceRowHTML(s) {
    var revokeBtn = s.status === "ACTIVE"
      ? '<button class="row-revoke" data-revoke-id="' + s.id + '" type="button">Revoke</button>'
      : '<span class="row-revoked">Revoked</span>';
    return '<li><span class="row-main"><span class="row-tag">' + s.kind + '</span>' +
      '<span class="row-name">' + s.label + "</span></span>" +
      '<span class="row-value">' + revokeBtn + "</span></li>";
  }

  function renderSourceLists() {
    var html = sourcesCache.map(sourceRowHTML).join("");
    ["ob-sources-list", "main-sources-list"].forEach(function (id) {
      var el = document.getElementById(id);
      if (!el) return;
      el.innerHTML = html;
      el.querySelectorAll("[data-revoke-id]").forEach(function (btn) {
        btn.addEventListener("click", async function () {
          btn.disabled = true;
          btn.textContent = "Revoking…";
          try {
            await AtlasAPI.revokeFundingSource(session, btn.getAttribute("data-revoke-id"));
            var source = sourcesCache.find(function (s) { return s.id === btn.getAttribute("data-revoke-id"); });
            pushActivity("Revoked " + (source ? source.kind + " · " + source.label : "source"));
            await refreshSources();
            renderSourceLists();
            renderConvertForm();
          } catch (err) {
            btn.disabled = false;
            btn.textContent = "Revoke";
            alert("Could not revoke: " + err.message);
          }
        });
      });
    });
    var empty = document.getElementById("sources-empty");
    if (empty) empty.hidden = sourcesCache.length > 0;
  }

  /* ---------------- holdings (real balances, fetched live) ---------------- */

  // Fetched once per refresh and reused by renderHoldings, renderTotalValue,
  // and the Convert tab's reverse direction — one real round trip per asset
  // instead of the same balance being re-fetched by every consumer of it.
  var balancesCache = {}; // asset -> decimal string, e.g. { BTC: "0.00098039" }

  async function refreshBalances() {
    var assets = CRYPTO_ASSETS.concat(FIAT_ASSETS);
    for (var i = 0; i < assets.length; i++) {
      var res = await AtlasAPI.getBalance(session, assets[i]);
      balancesCache[assets[i]] = res.balance;
    }
    return balancesCache;
  }

  function heldCryptoAssets() {
    return CRYPTO_ASSETS.filter(function (a) { return parseFloat(balancesCache[a] || "0") > 0; });
  }

  function renderHoldings() {
    var el = document.getElementById("holdings-list");
    var empty = document.getElementById("holdings-empty");
    if (!el) return 0;
    var rows = [];
    CRYPTO_ASSETS.concat(FIAT_ASSETS).forEach(function (asset) {
      var bal = balancesCache[asset];
      if (!bal || parseFloat(bal) <= 0) return;
      var isFiat = FIAT_ASSETS.indexOf(asset) !== -1;
      var valueText = isFiat ? formatFiat(parseFloat(bal), asset) : formatCrypto(asset, bal) + " " + asset;
      rows.push('<li><span class="row-main"><span class="row-tag">POSITION</span>' +
        '<span class="row-name">' + asset + "</span></span>" +
        '<span class="row-value">' + valueText + "</span></li>");
    });
    el.innerHTML = rows.join("");
    if (empty) empty.hidden = rows.length > 0;
    return rows.length;
  }

  function renderActivity() {
    var el = document.getElementById("activity-list");
    var empty = document.getElementById("activity-empty");
    if (!el) return;
    el.innerHTML = state.activity.map(function (a) {
      return '<li><span class="row-name">' + a.text + "</span>" +
        '<span class="row-value">' + new Date(a.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) + "</span></li>";
    }).join("");
    if (empty) empty.hidden = state.activity.length > 0;
  }

  async function renderTotalValue() {
    var statTotal = document.getElementById("stat-total");
    if (!statTotal) return;
    statTotal.textContent = "…";
    var total = 0;
    // Fiat balances only add directly to the total when they're already in
    // the selected display currency — there's no real GBP<->USD rate wired
    // up (the rate endpoint is fiat<->crypto only), so a fiat position held
    // in the other currency stays visible in Holdings but isn't silently
    // folded into this figure without a real exchange rate behind it.
    var fiatHeld = parseFloat(balancesCache[state.displayCurrency] || "0");
    if (fiatHeld > 0) total += fiatHeld;
    for (var i = 0; i < CRYPTO_ASSETS.length; i++) {
      var asset = CRYPTO_ASSETS[i];
      var amt = parseFloat(balancesCache[asset] || "0");
      if (amt > 0) {
        var rateRes = await AtlasAPI.getRate(asset, state.displayCurrency);
        total += amt * rateRes.rate;
      }
    }
    // This total is a display-only aggregate for the dashboard header — the
    // ledger itself never stores or moves a float; every real balance above
    // came from the server as an exact decimal string.
    statTotal.textContent = formatFiat(total, state.displayCurrency);
  }

  /* ---------------- onboarding ---------------- */

  var obStep = 1;
  var genPhase = "idle";

  function renderOnboarding() {
    document.querySelectorAll("#onboarding .step").forEach(function (s) {
      s.classList.toggle("is-active", Number(s.dataset.step) === obStep);
    });
    document.getElementById("step-current").textContent = obStep;
    document.getElementById("progress-fill").style.width = (obStep / 4 * 100) + "%";
    document.querySelector(".onboarding-nav").hidden = obStep === 1;

    var back = document.getElementById("ob-back");
    back.hidden = obStep === 1 || (obStep === 2 && genPhase === "generating");

    var next = document.getElementById("ob-next");
    next.disabled = false;
    if (obStep === 1) next.textContent = "Begin";
    else if (obStep === 2) {
      if (genPhase === "idle") next.textContent = "Generate identity";
      else if (genPhase === "generating") { next.textContent = "Generating…"; next.disabled = true; }
      else next.textContent = "Continue";
    } else if (obStep === 3) next.textContent = "Continue";
    else next.textContent = "Enter Atlas";
  }

  async function startIdentityGeneration() {
    document.getElementById("gen-idle").hidden = true;
    genPhase = "generating";
    renderOnboarding();
    var log = makeLiveLog(document.getElementById("gen-log"));
    try {
      log.line("Generating Ed25519 keypair…");
      var keyPair = await AtlasAPI.generateKeyPair();
      log.line("Registering with Atlas (" + AtlasAPI.API_BASE + ")…");
      var identity = await AtlasAPI.registerIdentity(keyPair);
      var seed = await AtlasAPI.exportSeed(keyPair);

      state.identityId = identity.id;
      state.displayId = identity.displayId;
      state.fingerprint = identity.publicKeyFingerprint;
      state.publicKeyB64 = identity.publicKey;
      state.seedB64 = bytesToBase64(seed);
      await saveState();
      session = { identityId: identity.id, privateKey: keyPair.privateKey };

      log.line("Identity ready.");
      document.getElementById("identity-id").textContent = state.displayId;
      document.getElementById("fingerprint").textContent = state.fingerprint;
      genPhase = "done";
      renderOnboarding();
    } catch (err) {
      log.line("Failed: " + err.message, true);
      genPhase = "idle";
      document.getElementById("gen-idle").hidden = false;
      renderOnboarding();
    }
  }

  async function enterApp() {
    state.onboardingComplete = true;
    await saveState();
    document.getElementById("onboarding").hidden = true;
    document.getElementById("app").hidden = false;
    await renderAll();
  }

  document.getElementById("ob-next").addEventListener("click", function () {
    if (obStep === 1) { obStep = 2; renderOnboarding(); }
    else if (obStep === 2) {
      if (genPhase === "idle") startIdentityGeneration();
      else if (genPhase === "done") { obStep = 3; renderOnboarding(); }
    } else if (obStep === 3) { obStep = 4; renderOnboarding(); }
    else { enterApp(); }
  });

  document.getElementById("ob-back").addEventListener("click", function () {
    obStep = Math.max(1, obStep - 1);
    if (obStep === 1) resetRecoveryUI();
    renderOnboarding();
  });

  /* ---------------- recover an existing identity (real 3-of-5 Shamir) ---------------- */

  var identityChoice = document.getElementById("identity-choice");
  var recoveryPanel = document.getElementById("recovery-panel");
  var recoverError = document.getElementById("recover-error");
  var recoverPanelFrame = document.getElementById("recover-panel-frame");

  function recoveryKeyInputs() {
    return [1, 2, 3, 4, 5].map(function (n) { return document.getElementById("recover-key-" + n); });
  }

  function resetRecoveryUI() {
    identityChoice.hidden = false;
    recoveryPanel.hidden = true;
    recoverPanelFrame.hidden = true;
    recoverError.hidden = true;
    recoveryKeyInputs().forEach(function (el) { el.value = ""; el.disabled = false; });
    document.getElementById("recover-submit").disabled = false;
    document.getElementById("recover-back").disabled = false;
  }

  document.getElementById("choice-new").addEventListener("click", function () {
    obStep = 2;
    renderOnboarding();
  });

  document.getElementById("choice-existing").addEventListener("click", function () {
    identityChoice.hidden = true;
    recoveryPanel.hidden = false;
  });

  document.getElementById("recover-back").addEventListener("click", resetRecoveryUI);

  document.getElementById("recover-submit").addEventListener("click", async function () {
    var texts = recoveryKeyInputs().map(function (el) { return el.value.trim(); }).filter(Boolean);
    recoverError.hidden = true;

    if (texts.length < AtlasAPI.recoveryThreshold) {
      recoverError.textContent = "Enter at least " + AtlasAPI.recoveryThreshold + " of your " + AtlasAPI.recoveryShareCount + " recovery keys.";
      recoverError.hidden = false;
      return;
    }

    recoveryKeyInputs().forEach(function (el) { el.disabled = true; });
    document.getElementById("recover-submit").disabled = true;
    document.getElementById("recover-back").disabled = true;
    recoverPanelFrame.hidden = false;

    var log = makeLiveLog(document.getElementById("recover-log"));
    try {
      log.line("Reconstructing private key from recovery shares…");
      var result = await AtlasAPI.recoverIdentity(texts);
      log.line("Looking up identity…");
      var seed = await AtlasAPI.exportSeed(result.keyPair);

      state.identityId = result.identity.id;
      state.displayId = result.identity.displayId;
      state.fingerprint = result.identity.publicKeyFingerprint;
      state.publicKeyB64 = result.identity.publicKey;
      state.seedB64 = bytesToBase64(seed);
      state.recoveryEnabled = true;
      state.recoveryKeys = []; // we only hold the keys just typed in, not necessarily all 5 — see Settings
      await saveState();
      session = { identityId: result.identity.id, privateKey: result.keyPair.privateKey };

      log.line("Identity restored.");
      document.getElementById("identity-id").textContent = state.displayId;
      document.getElementById("fingerprint").textContent = state.fingerprint;
      genPhase = "done";
      obStep = 3;
      renderOnboarding();
    } catch (err) {
      log.line("Failed: " + err.message, true);
      resetRecoveryUI();
      recoverError.textContent = err.message;
      recoverError.hidden = false;
    }
  });

  /* ---------------- connect a source (real backend calls) ---------------- */

  function setupConnectForm(prefix, bankBtnId, walletBtnId) {
    var form = document.getElementById(prefix + "-connect-form");
    var errorEl = document.getElementById(prefix + "-connect-error");
    var fieldsByType = {
      BANK: [prefix + "-field-bank-name"],
      WALLET: [prefix + "-field-wallet"],
    };
    var allFieldIds = fieldsByType.BANK.concat(fieldsByType.WALLET);
    var currentType = null;

    function showError(msg) {
      errorEl.textContent = msg;
      errorEl.hidden = false;
    }

    function openForm(type) {
      currentType = type;
      errorEl.hidden = true;
      form.hidden = false;
      allFieldIds.forEach(function (id) { document.getElementById(id).hidden = true; });
      fieldsByType[type].forEach(function (id) { document.getElementById(id).hidden = false; });
    }

    function closeForm() {
      form.hidden = true;
      errorEl.hidden = true;
      currentType = null;
      allFieldIds.forEach(function (fieldId) {
        var input = document.getElementById(fieldId).querySelector("input");
        if (input) input.value = "";
      });
    }

    document.getElementById(bankBtnId).addEventListener("click", function () { openForm("BANK"); });
    document.getElementById(walletBtnId).addEventListener("click", function () { openForm("WALLET"); });
    document.getElementById(prefix + "-connect-cancel").addEventListener("click", closeForm);

    document.getElementById(prefix + "-connect-add").addEventListener("click", async function () {
      errorEl.hidden = true;
      var addBtn = document.getElementById(prefix + "-connect-add");
      var args = null;

      if (currentType === "BANK") {
        var bankName = document.getElementById(prefix + "-input-bank-name").value.trim();
        if (!bankName) { showError("Enter a bank name."); return; }
        // PISP (Open Banking) linking has no real provider integration yet
        // on the backend either — see backend/src/adapters/funding/stub.ts.
        // This reference is honestly a local placeholder, exactly matching
        // what the server-side stub already documents about itself; it is
        // NOT presented as a real bank connection the way the old fake
        // "balance" field was.
        args = { kind: "BANK", rail: "PISP", label: bankName, externalRef: "local-consent-" + crypto.randomUUID() };
      } else if (currentType === "WALLET") {
        var address = document.getElementById(prefix + "-input-wallet").value.trim();
        if (!address) { showError("Enter a wallet address."); return; }
        args = { kind: "WALLET", rail: "ONCHAIN", label: address, externalRef: address };
      } else {
        return;
      }

      addBtn.disabled = true;
      addBtn.textContent = "Connecting…";
      try {
        var source = await AtlasAPI.connectFundingSource(session, args);
        pushActivity("Connected " + source.kind + " · " + source.label);
        await refreshSources();
        renderSourceLists();
        renderConvertForm();
        closeForm();
      } catch (err) {
        showError(err.message);
      } finally {
        addBtn.disabled = false;
        addBtn.textContent = "Add source";
      }
    });

    return { openForm: openForm };
  }

  setupConnectForm("ob", "connect-bank", "connect-wallet");
  var mainConnect = setupConnectForm("main", "connect-bank-2", "connect-wallet-2");

  /* ---------------- app shell / tabs ---------------- */

  document.querySelectorAll(".nav-btn").forEach(function (btn) {
    btn.addEventListener("click", async function () {
      document.querySelectorAll(".nav-btn").forEach(function (b) { b.classList.toggle("is-active", b === btn); });
      document.querySelectorAll(".tab-panel").forEach(function (p) {
        p.classList.toggle("is-active", p.dataset.tab === btn.dataset.tab);
      });
      if (btn.dataset.tab === "convert") await renderConvertForm();
    });
  });

  document.getElementById("reset-demo").addEventListener("click", function () {
    if (confirm("Reset your Atlas identity on this device? This forgets the private key locally — recovery keys (if enabled) are the only way back in. The identity itself still exists on the server.")) {
      localStorage.removeItem(STORAGE_KEY);
      window.location.reload();
    }
  });

  /* ---------------- settings / recovery ---------------- */

  function renderSettings() {
    var statusEl = document.getElementById("recovery-status");
    if (!statusEl) return;
    var btn = document.getElementById("recovery-enable-btn");
    var block = document.getElementById("recovery-keys-block");
    var grid = document.getElementById("recovery-keys-grid");
    var regenNote = document.getElementById("recovery-regen-note");

    if (state.recoveryEnabled) {
      statusEl.textContent = "Recovery is on, permanently";
      btn.textContent = "Recovery enabled";
      btn.disabled = true;
      if (state.recoveryKeys.length === 5) {
        block.hidden = false;
        regenNote.hidden = true;
        grid.innerHTML = state.recoveryKeys.map(function (k, i) {
          return '<div class="recovery-key"><span class="k-label">Key ' + (i + 1) + '</span><span class="k-value">' + k + "</span></div>";
        }).join("");
      } else {
        block.hidden = true;
        regenNote.hidden = false;
      }
    } else {
      statusEl.textContent = "Recovery is off";
      btn.textContent = "Enable recovery";
      btn.disabled = false;
      block.hidden = true;
      regenNote.hidden = true;
    }

    var currencySelect = document.getElementById("display-currency");
    if (currencySelect) currencySelect.value = state.displayCurrency;
  }

  async function generateAndStoreRecoveryKeys() {
    var keyPair = await AtlasAPI.importKeyPairFromSeed(base64ToBytes(state.seedB64), base64ToBytes(state.publicKeyB64));
    var keys = await AtlasAPI.makeRecoveryKeys(keyPair);
    state.recoveryEnabled = true;
    state.recoveryKeys = keys;
    await saveState();
    renderSettings();
  }

  var recoveryConfirm = document.getElementById("recovery-confirm");

  document.getElementById("recovery-enable-btn").addEventListener("click", function () {
    if (state.recoveryEnabled) return;
    recoveryConfirm.hidden = false;
    document.getElementById("recovery-enable-btn").disabled = true;
  });

  document.getElementById("recovery-confirm-cancel").addEventListener("click", function () {
    recoveryConfirm.hidden = true;
    document.getElementById("recovery-enable-btn").disabled = false;
  });

  document.getElementById("recovery-confirm-yes").addEventListener("click", async function () {
    recoveryConfirm.hidden = true;
    await generateAndStoreRecoveryKeys();
    pushActivity("Recovery enabled — 5 real key shares generated (any 3 restore this identity)");
  });

  var regenBtn = document.getElementById("recovery-regen-btn");
  if (regenBtn) {
    regenBtn.addEventListener("click", async function () {
      if (!confirm("Generate a fresh set of 5 recovery keys? Any recovery keys from before this identity was restored on this device will stop working.")) return;
      await generateAndStoreRecoveryKeys();
      pushActivity("Recovery keys regenerated");
    });
  }

  var currencySelectEl = document.getElementById("display-currency");
  if (currencySelectEl) {
    currencySelectEl.addEventListener("change", async function () {
      state.displayCurrency = currencySelectEl.value;
      await saveState();
      await renderTotalValue();
      renderConvertForm();
    });
  }

  /* ---------------- trust ---------------- */

  var trustView = document.getElementById("trust-view");
  function openTrust() { trustView.hidden = false; }
  function closeTrust() { trustView.hidden = true; }
  document.getElementById("trust-btn-ob").addEventListener("click", openTrust);
  document.getElementById("trust-btn-app").addEventListener("click", openTrust);
  document.getElementById("trust-back").addEventListener("click", closeTrust);

  /* ---------------- anonymity ---------------- */

  var anonymityView = document.getElementById("anonymity-view");
  var anonymityOpenedFromTrust = false;

  function openAnonymity(fromTrust) {
    anonymityOpenedFromTrust = !!fromTrust;
    if (fromTrust) trustView.hidden = true;
    anonymityView.hidden = false;
  }
  function closeAnonymity() {
    anonymityView.hidden = true;
    if (anonymityOpenedFromTrust) trustView.hidden = false;
  }

  document.getElementById("footer-anonymity-link").addEventListener("click", function () { openAnonymity(false); });
  document.getElementById("trust-anonymity-link").addEventListener("click", function () { openAnonymity(true); });
  document.getElementById("anonymity-back").addEventListener("click", closeAnonymity);

  /* ---------------- convert (real grant + real settlement, both directions) ----------------
   * "Fiat -> Crypto" and "Crypto -> Fiat" are two directions of the same
   * idea: your Atlas balance is one thing, representable as fiat or crypto.
   * Neither direction pays out externally or holds cash on your behalf the
   * way a broker would — see fiatCredited's doc comment in the backend for
   * why that specific choice was deliberate. */

  var convertFromSelect = document.getElementById("convert-from");
  var convertToSelect = document.getElementById("convert-to");
  var convertAmount = document.getElementById("convert-amount");
  var convertEstimate = document.getElementById("convert-estimate");
  var convertError = document.getElementById("convert-error");
  var convertForm = document.getElementById("convert-form");
  var convertEmpty = document.getElementById("convert-empty");
  var convertEmptyText = document.getElementById("convert-empty-text");
  var convertPanel = document.getElementById("convert-panel");
  var convertHeading = document.getElementById("convert-heading");
  var convertFromLabel = document.getElementById("convert-from-label");
  var convertToLabel = document.getElementById("convert-to-label");
  var convertAmountLabel = document.getElementById("convert-amount-label");
  var convertDirForward = document.getElementById("convert-direction-forward");
  var convertDirReverse = document.getElementById("convert-direction-reverse");

  var CRYPTO_OPTIONS_HTML = CRYPTO_ASSETS.map(function (a) {
    var names = { BTC: "Bitcoin", ETH: "Ethereum", USDC: "USD Coin" };
    return '<option value="' + a + '">' + names[a] + " (" + a + ")</option>";
  }).join("");
  var FIAT_OPTIONS_HTML = FIAT_ASSETS.map(function (a) {
    return '<option value="' + a + '">' + a + "</option>";
  }).join("");

  var convertDirection = "forward"; // "forward" (fiat->crypto) | "reverse" (crypto->fiat)
  var rateCache = null; // { asset, rate }

  function setConvertDirection(dir) {
    convertDirection = dir;
    convertDirForward.setAttribute("aria-pressed", String(dir === "forward"));
    convertDirReverse.setAttribute("aria-pressed", String(dir === "reverse"));
    rateCache = null;
    renderConvertForm();
  }
  convertDirForward.addEventListener("click", function () { setConvertDirection("forward"); });
  convertDirReverse.addEventListener("click", function () { setConvertDirection("reverse"); });

  async function renderConvertForm() {
    if (convertDirection === "reverse") await refreshBalances();

    if (convertDirection === "forward") {
      convertHeading.textContent = "Convert a bank balance into a position.";
      convertFromLabel.textContent = "From";
      convertToLabel.textContent = "To";
      convertAmountLabel.textContent = "Amount (GBP)";
      convertEmptyText.textContent = "Connect a bank first to convert a balance.";

      var banks = sourcesCache.filter(function (s) { return s.kind === "BANK" && s.status === "ACTIVE"; });
      convertEmpty.hidden = banks.length > 0;
      if (convertPanel.hidden) convertForm.hidden = banks.length === 0;
      convertFromSelect.innerHTML = banks.map(function (b) {
        return '<option value="' + b.id + '">' + b.label + "</option>";
      }).join("");
      convertToSelect.innerHTML = CRYPTO_OPTIONS_HTML;
    } else {
      convertHeading.textContent = "Convert a position back into a fiat balance.";
      convertFromLabel.textContent = "From";
      convertToLabel.textContent = "To";
      convertAmountLabel.textContent = "Amount (" + (convertFromSelect.value || "crypto") + ")";
      convertEmptyText.textContent = "Convert a fiat balance into crypto first — there's nothing to convert back yet.";

      var held = heldCryptoAssets();
      convertEmpty.hidden = held.length > 0;
      if (convertPanel.hidden) convertForm.hidden = held.length === 0;
      convertFromSelect.innerHTML = held.map(function (a) {
        return '<option value="' + a + '">' + a + " · " + formatCrypto(a, balancesCache[a]) + "</option>";
      }).join("");
      convertToSelect.innerHTML = FIAT_OPTIONS_HTML;
      convertAmountLabel.textContent = "Amount (" + (convertFromSelect.value || "crypto") + ")";
    }
    updateEstimate();
  }

  convertFromSelect.addEventListener("change", function () {
    if (convertDirection === "reverse") convertAmountLabel.textContent = "Amount (" + convertFromSelect.value + ")";
    rateCache = null;
    updateEstimate();
  });

  async function fetchRateIfNeeded() {
    var cryptoAsset = convertDirection === "forward" ? convertToSelect.value : convertFromSelect.value;
    var fiatAsset = convertDirection === "forward" ? "GBP" : (convertToSelect.value || "GBP");
    if (rateCache && rateCache.asset === cryptoAsset && rateCache.fiat === fiatAsset) return rateCache;
    var res = await AtlasAPI.getRate(cryptoAsset, fiatAsset);
    rateCache = { asset: cryptoAsset, fiat: fiatAsset, rate: res.rate };
    return rateCache;
  }

  async function updateEstimate() {
    var amt = parseFloat(convertAmount.value) || 0;
    if (amt <= 0) { convertEstimate.textContent = "Enter an amount to see the estimate."; return; }
    if (convertDirection === "reverse" && !convertFromSelect.value) { convertEstimate.textContent = "Nothing to convert yet."; return; }
    try {
      var rate = await fetchRateIfNeeded();
      if (convertDirection === "forward") {
        convertEstimate.textContent = "≈ " + (amt / rate.rate).toFixed(8) + " " + rate.asset + " at " + formatGBP(rate.rate) + "/" + rate.asset + " (live from the backend, illustrative rate)";
      } else {
        convertEstimate.textContent = "≈ " + formatFiat(amt * rate.rate, rate.fiat) + " at " + formatFiat(rate.rate, rate.fiat) + "/" + rate.asset + " (live from the backend, illustrative rate)";
      }
    } catch (err) {
      convertEstimate.textContent = "Could not fetch a rate: " + err.message;
    }
  }

  convertAmount.addEventListener("input", updateEstimate);
  convertToSelect.addEventListener("change", function () { rateCache = null; updateEstimate(); });

  document.getElementById("convert-connect-bank").addEventListener("click", function () {
    document.querySelector('.nav-btn[data-tab="identity"]').click();
    mainConnect.openForm("BANK");
  });

  convertForm.addEventListener("submit", async function (e) {
    e.preventDefault();
    convertError.hidden = true;
    var amount = parseFloat(convertAmount.value);
    if (!amount || amount <= 0) { showConvertError("Enter an amount greater than zero."); return; }

    convertForm.hidden = true;
    convertPanel.hidden = false;
    document.getElementById("convert-success").hidden = true;
    var log = makeLiveLog(document.getElementById("convert-log"));

    if (convertDirection === "forward") {
      var source = sourcesCache.find(function (s) { return s.id === convertFromSelect.value; });
      var asset = convertToSelect.value;
      if (!source) { convertForm.hidden = false; convertPanel.hidden = true; showConvertError("Connect a bank first."); return; }
      var amountDecimal = amount.toFixed(2);
      try {
        log.line("Creating a single-use permission grant for £" + amountDecimal + "…");
        var grant = await AtlasAPI.createGrant(session, {
          fundingSourceId: source.id, limitAsset: "GBP", limitDecimal: amountDecimal, windowSeconds: 3600, singleUse: true,
        });
        log.line("Executing settlement…");
        var result = await AtlasAPI.purchase(session, { grantId: grant.id, fiatAsset: "GBP", fiatDecimal: amountDecimal, cryptoAsset: asset });
        var allocatedDecimal = minorToDecimalString(result.cryptoAllocated.minorUnits, ASSET_DECIMALS[asset]);
        log.line("Settled.");
        pushActivity("Converted £" + amountDecimal + " to " + formatCrypto(asset, allocatedDecimal) + " " + asset);
        document.getElementById("convert-success-text").textContent =
          "Converted £" + amountDecimal + " to " + formatCrypto(asset, allocatedDecimal) + " " + asset + ".";
        document.getElementById("convert-success").hidden = false;
        await refreshBalances();
        renderHoldings();
        await renderTotalValue();
      } catch (err) {
        log.line("Failed: " + err.message, true);
      }
    } else {
      var cryptoAsset = convertFromSelect.value;
      var fiatAsset = convertToSelect.value;
      if (!cryptoAsset) { convertForm.hidden = false; convertPanel.hidden = true; showConvertError("Nothing to convert."); return; }
      var cryptoDecimal = amount.toFixed(8);
      try {
        log.line("Converting " + cryptoDecimal + " " + cryptoAsset + " back to " + fiatAsset + "…");
        var conv = await AtlasAPI.convertCryptoToFiat(session, { cryptoAsset: cryptoAsset, cryptoDecimal: cryptoDecimal, fiatAsset: fiatAsset });
        var fiatDecimal = minorToDecimalString(conv.fiatReceived.minorUnits, ASSET_DECIMALS[fiatAsset]);
        log.line("Converted.");
        pushActivity("Converted " + cryptoDecimal + " " + cryptoAsset + " to " + formatFiat(parseFloat(fiatDecimal), fiatAsset));
        document.getElementById("convert-success-text").textContent =
          "Converted " + cryptoDecimal + " " + cryptoAsset + " to " + formatFiat(parseFloat(fiatDecimal), fiatAsset) + ", held in Atlas.";
        document.getElementById("convert-success").hidden = false;
        await refreshBalances();
        renderHoldings();
        await renderTotalValue();
      } catch (err) {
        log.line("Failed: " + err.message, true);
      }
    }
  });

  function showConvertError(msg) {
    convertError.textContent = msg;
    convertError.hidden = false;
  }

  document.getElementById("convert-again").addEventListener("click", async function () {
    convertPanel.hidden = true;
    convertForm.hidden = false;
    convertAmount.value = "";
    await renderConvertForm();
  });

  /* ---------------- render all ---------------- */

  async function renderAll() {
    if (!state.identityId) return;
    var sidebarId = document.getElementById("sidebar-id");
    if (sidebarId) sidebarId.textContent = state.displayId;
    var mainId = document.getElementById("main-identity-id");
    if (mainId) mainId.textContent = state.displayId;
    var mainFp = document.getElementById("main-fingerprint");
    if (mainFp) mainFp.textContent = state.fingerprint;

    await refreshSources();
    renderSourceLists();

    var statSources = document.getElementById("stat-sources");
    if (statSources) statSources.textContent = String(sourcesCache.length);

    await refreshBalances();
    var holdingsCount = renderHoldings();
    var statHoldings = document.getElementById("stat-holdings");
    if (statHoldings) statHoldings.textContent = String(holdingsCount);

    await renderTotalValue();
    renderActivity();
    await renderConvertForm();
    renderSettings();
  }

  /* ---------------- boot ---------------- */

  var cryptoWarning = document.getElementById("crypto-warning");

  async function showApp() {
    if (state.identityId && state.onboardingComplete) {
      await buildSessionFromState();
      document.getElementById("onboarding").hidden = true;
      document.getElementById("app").hidden = false;
      await renderAll();
    } else if (state.identityId) {
      await buildSessionFromState();
      document.getElementById("gen-idle").hidden = true;
      document.getElementById("identity-id").textContent = state.displayId;
      document.getElementById("fingerprint").textContent = state.fingerprint;
      genPhase = "done";
      obStep = 3;
      renderOnboarding();
    } else {
      renderOnboarding();
    }
  }

  async function boot() {
    var raw = localStorage.getItem(STORAGE_KEY);
    var parsed = null;
    if (raw) {
      try { parsed = JSON.parse(raw); } catch (e) { parsed = null; }
    }

    if (!cryptoAvailable) {
      cryptoWarning.hidden = false;
      if (parsed && parsed.plain && parsed.state) {
        state = Object.assign(defaultState(), parsed.state);
      } else {
        state = defaultState();
      }
      await showApp();
      return;
    }

    cryptoKey = await getOrCreateLocalKey();

    if (parsed && parsed.iv && parsed.data) {
      try {
        var decrypted = await decryptJSON(parsed, cryptoKey);
        state = Object.assign(defaultState(), decrypted);
      } catch (e) {
        state = defaultState();
      }
    } else {
      state = defaultState();
    }
    await showApp();
  }

  boot();
})();
