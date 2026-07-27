(function () {
  "use strict";

  var STORAGE_KEY = "atlas_demo_state_v1";
  var reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  var cryptoAvailable = !!(window.crypto && window.crypto.subtle);

  var RATES = { BTC: 51000, ETH: 2800, USDC: 0.79 };
  var DECIMALS = { BTC: 6, ETH: 4, USDC: 2 };

  function hex(len) { var s = ""; for (var i = 0; i < len; i++) s += Math.floor(Math.random() * 16).toString(16); return s; }
  function randDigits(len) { var s = ""; for (var i = 0; i < len; i++) s += Math.floor(Math.random() * 10); return s; }
  function makeIdentity() {
    var groups = [];
    for (var i = 0; i < 4; i++) groups.push(randDigits(4));
    return "ATLAS " + groups.join(" ");
  }
  function makeFingerprint() { var g = []; for (var i = 0; i < 8; i++) g.push(hex(4)); return g.join(" "); }
  function makeRecoveryKey() {
    var groups = [];
    for (var i = 0; i < 4; i++) groups.push(hex(4).toUpperCase());
    return groups.join("-");
  }

  function formatGBP(n) {
    return new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP" }).format(n || 0);
  }
  function formatCrypto(asset, n) {
    return (n || 0).toFixed(DECIMALS[asset] || 4);
  }

  /* ---------------- vault encryption (AES-256-GCM, key generated on-device) ---------------- */

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

  // No passphrase: the key is generated once and stored on this device, so
  // encryption is invisible and automatic. That protects data copied or
  // intercepted elsewhere, but not someone with this device itself, open
  // and unlocked — see the Anonymity page for the honest boundary.
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

  function defaultState() {
    return { identity: null, onboardingComplete: false, recoveryEnabled: false, recoveryKeys: [], sources: [], holdings: { BTC: 0, ETH: 0, USDC: 0 }, activity: [] };
  }

  function pushActivity(text) {
    state.activity.unshift({ text: text, ts: Date.now() });
    state.activity = state.activity.slice(0, 12);
  }

  async function saveState() {
    if (cryptoKey) {
      var envelope = await encryptJSON(state, cryptoKey);
      localStorage.setItem(STORAGE_KEY, JSON.stringify(envelope));
    } else {
      // No Web Crypto available on this device. Kept functional, but
      // unencrypted — the crypto-warning banner stays visible whenever
      // this path is in use.
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ plain: true, state: state }));
    }
  }

  /* ---------------- shared: log animation ---------------- */

  function runLog(el, lines, delay, cb) {
    el.innerHTML = "";
    if (reduced) {
      lines.forEach(function (t) {
        var d = document.createElement("div");
        d.className = "line shown";
        d.textContent = t;
        el.appendChild(d);
      });
      cb();
      return;
    }
    lines.forEach(function (t, i) {
      setTimeout(function () {
        var d = document.createElement("div");
        d.className = "line";
        d.textContent = t;
        el.appendChild(d);
        requestAnimationFrame(function () { d.classList.add("shown"); });
        if (i === lines.length - 1) setTimeout(cb, 320);
      }, i * delay);
    });
  }

  /* ---------------- sources ---------------- */

  function addSource(tag, name, balance) {
    var id = "src_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    state.sources.push({ id: id, tag: tag, name: name, balance: (balance === undefined ? null : balance) });
    saveState();
    renderAll();
  }

  function sourceRowHTML(s) {
    var value = s.balance === null ? "Attested" : formatGBP(s.balance);
    return '<li><span class="row-main"><span class="row-tag">' + s.tag + '</span>' +
      '<span class="row-name">' + s.name + "</span></span>" +
      '<span class="row-value">' + value + "</span></li>";
  }

  function renderSourceLists() {
    var html = state.sources.map(sourceRowHTML).join("");
    ["ob-sources-list", "main-sources-list"].forEach(function (id) {
      var el = document.getElementById(id);
      if (el) el.innerHTML = html;
    });
    var empty = document.getElementById("sources-empty");
    if (empty) empty.hidden = state.sources.length > 0;
  }

  function renderHoldings() {
    var el = document.getElementById("holdings-list");
    var empty = document.getElementById("holdings-empty");
    if (!el) return;
    var rows = [];
    Object.keys(state.holdings).forEach(function (asset) {
      var amt = state.holdings[asset];
      if (amt > 0) {
        rows.push('<li><span class="row-main"><span class="row-tag">POSITION</span>' +
          '<span class="row-name">' + asset + "</span></span>" +
          '<span class="row-value">' + formatCrypto(asset, amt) + " " + asset + "</span></li>");
      }
    });
    el.innerHTML = rows.join("");
    if (empty) empty.hidden = rows.length > 0;
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

  function totalValue() {
    var total = 0;
    state.sources.forEach(function (s) { if (s.balance) total += s.balance; });
    Object.keys(state.holdings).forEach(function (asset) { total += state.holdings[asset] * RATES[asset]; });
    return total;
  }

  function holdingsCount() {
    return Object.keys(state.holdings).filter(function (a) { return state.holdings[a] > 0; }).length;
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

  function startIdentityGeneration() {
    document.getElementById("gen-idle").hidden = true;
    genPhase = "generating";
    renderOnboarding();
    var logEl = document.getElementById("gen-log");
    runLog(logEl, [
      "Collecting local entropy",
      "Deriving Ed25519 keypair",
      "Computing key fingerprint",
      "Assigning identity number",
      "Identity ready"
    ], 260, async function () {
      state.identity = { id: makeIdentity(), fingerprint: makeFingerprint() };
      await saveState();
      document.getElementById("identity-id").textContent = state.identity.id;
      document.getElementById("fingerprint").textContent = state.identity.fingerprint;
      genPhase = "done";
      renderOnboarding();
    });
  }

  async function enterApp() {
    state.onboardingComplete = true;
    await saveState();
    document.getElementById("onboarding").hidden = true;
    document.getElementById("app").hidden = false;
    renderAll();
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

  /* ---------------- recover an existing identity ---------------- */

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
    var inputs = recoveryKeyInputs();
    var keys = inputs.map(function (el) { return el.value.trim(); });
    recoverError.hidden = true;

    if (keys.some(function (k) { return !k; })) {
      recoverError.textContent = "Enter all 5 recovery keys.";
      recoverError.hidden = false;
      return;
    }

    inputs.forEach(function (el) { el.disabled = true; });
    document.getElementById("recover-submit").disabled = true;
    document.getElementById("recover-back").disabled = true;
    recoverPanelFrame.hidden = false;

    var logEl = document.getElementById("recover-log");
    runLog(logEl, [
      "Verifying recovery keys",
      "Reconstructing identity",
      "Identity restored"
    ], 300, async function () {
      state.identity = { id: makeIdentity(), fingerprint: makeFingerprint() };
      state.recoveryEnabled = true;
      state.recoveryKeys = keys;
      await saveState();
      document.getElementById("identity-id").textContent = state.identity.id;
      document.getElementById("fingerprint").textContent = state.identity.fingerprint;
      genPhase = "done";
      obStep = 3;
      renderOnboarding();
    });
  });

  /* ---------------- connect a source (real, user-entered) ---------------- */

  function setupConnectForm(prefix, bankBtnId, walletBtnId, cardBtnId) {
    var form = document.getElementById(prefix + "-connect-form");
    var errorEl = document.getElementById(prefix + "-connect-error");
    var fieldsByType = {
      BANK: [prefix + "-field-bank-name", prefix + "-field-bank-balance"],
      WALLET: [prefix + "-field-wallet"],
      CARD: [prefix + "-field-card"]
    };
    var allFieldIds = fieldsByType.BANK.concat(fieldsByType.WALLET, fieldsByType.CARD);
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
    document.getElementById(cardBtnId).addEventListener("click", function () { openForm("CARD"); });
    document.getElementById(prefix + "-connect-cancel").addEventListener("click", closeForm);

    document.getElementById(prefix + "-connect-add").addEventListener("click", function () {
      errorEl.hidden = true;
      if (currentType === "BANK") {
        var bankName = document.getElementById(prefix + "-input-bank-name").value.trim();
        var balance = parseFloat(document.getElementById(prefix + "-input-bank-balance").value);
        if (!bankName) { showError("Enter a bank name."); return; }
        if (isNaN(balance) || balance < 0) { showError("Enter a starting balance."); return; }
        addSource("BANK", bankName, balance);
      } else if (currentType === "WALLET") {
        var address = document.getElementById(prefix + "-input-wallet").value.trim();
        if (!address) { showError("Enter a wallet address."); return; }
        addSource("WALLET", address);
      } else if (currentType === "CARD") {
        var cardLabel = document.getElementById(prefix + "-input-card").value.trim();
        if (!cardLabel) { showError("Enter a card label."); return; }
        addSource("CARD", cardLabel);
      }
      closeForm();
    });

    return { openForm: openForm };
  }

  setupConnectForm("ob", "connect-bank", "connect-wallet", "connect-card");
  var mainConnect = setupConnectForm("main", "connect-bank-2", "connect-wallet-2", "connect-card-2");

  /* ---------------- app shell / tabs ---------------- */

  document.querySelectorAll(".nav-btn").forEach(function (btn) {
    btn.addEventListener("click", function () {
      document.querySelectorAll(".nav-btn").forEach(function (b) { b.classList.toggle("is-active", b === btn); });
      document.querySelectorAll(".tab-panel").forEach(function (p) {
        p.classList.toggle("is-active", p.dataset.tab === btn.dataset.tab);
      });
    });
  });

  document.getElementById("reset-demo").addEventListener("click", function () {
    if (confirm("Reset your Atlas identity and start over? This clears everything in this demo.")) {
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

    if (state.recoveryEnabled) {
      statusEl.textContent = "Recovery is on, permanently";
      btn.textContent = "Recovery enabled";
      btn.disabled = true;
      block.hidden = false;
      grid.innerHTML = state.recoveryKeys.map(function (k, i) {
        return '<div class="recovery-key"><span class="k-label">Key ' + (i + 1) + '</span><span class="k-value">' + k + "</span></div>";
      }).join("");
    } else {
      statusEl.textContent = "Recovery is off";
      btn.textContent = "Enable recovery";
      btn.disabled = false;
      block.hidden = true;
    }
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

  document.getElementById("recovery-confirm-yes").addEventListener("click", function () {
    var keys = [];
    for (var i = 0; i < 5; i++) keys.push(makeRecoveryKey());
    state.recoveryEnabled = true;
    state.recoveryKeys = keys;
    saveState();
    recoveryConfirm.hidden = true;
    renderSettings();
  });

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

  /* ---------------- convert ---------------- */

  var convertFromSelect = document.getElementById("convert-from");
  var convertToSelect = document.getElementById("convert-to");
  var convertAmount = document.getElementById("convert-amount");
  var convertEstimate = document.getElementById("convert-estimate");
  var convertError = document.getElementById("convert-error");
  var convertForm = document.getElementById("convert-form");
  var convertEmpty = document.getElementById("convert-empty");
  var convertPanel = document.getElementById("convert-panel");

  function renderConvertForm() {
    var banks = state.sources.filter(function (s) { return s.tag === "BANK"; });
    convertEmpty.hidden = banks.length > 0;
    if (convertPanel.hidden) {
      convertForm.hidden = banks.length === 0;
    }
    convertFromSelect.innerHTML = banks.map(function (b) {
      return '<option value="' + b.id + '">' + b.name + " · " + formatGBP(b.balance) + "</option>";
    }).join("");
  }

  function updateEstimate() {
    var amt = parseFloat(convertAmount.value) || 0;
    var asset = convertToSelect.value;
    var rate = RATES[asset];
    if (amt <= 0) { convertEstimate.textContent = "Enter an amount to see the estimate."; return; }
    convertEstimate.textContent = "≈ " + formatCrypto(asset, amt / rate) + " " + asset + " at " + formatGBP(rate) + "/" + asset + " (illustrative rate)";
  }

  convertAmount.addEventListener("input", updateEstimate);
  convertToSelect.addEventListener("change", updateEstimate);

  document.getElementById("convert-connect-bank").addEventListener("click", function () {
    document.querySelector('.nav-btn[data-tab="identity"]').click();
    mainConnect.openForm("BANK");
  });

  convertForm.addEventListener("submit", function (e) {
    e.preventDefault();
    convertError.hidden = true;
    var source = state.sources.find(function (s) { return s.id === convertFromSelect.value; });
    var amount = parseFloat(convertAmount.value);
    var asset = convertToSelect.value;

    if (!source) { showConvertError("Connect a bank first."); return; }
    if (!amount || amount <= 0) { showConvertError("Enter an amount greater than zero."); return; }
    if (amount > source.balance) { showConvertError("That exceeds the connected balance."); return; }

    convertForm.hidden = true;
    convertPanel.hidden = false;
    document.getElementById("convert-success").hidden = true;

    var logEl = document.getElementById("convert-log");
    runLog(logEl, [
      "Negotiating settlement route",
      "Selecting adapter: bank → stablecoin → chain",
      "Locking claim against bank evidence",
      "Minting equivalent position on-chain",
      "Settled instantly"
    ], 320, function () {
      var gained = amount / RATES[asset];
      source.balance -= amount;
      state.holdings[asset] = (state.holdings[asset] || 0) + gained;
      pushActivity("Converted " + formatGBP(amount) + " to " + formatCrypto(asset, gained) + " " + asset);
      saveState();
      document.getElementById("convert-success-text").textContent =
        "Converted " + formatGBP(amount) + " to " + formatCrypto(asset, gained) + " " + asset + ".";
      document.getElementById("convert-success").hidden = false;
      renderAll();
    });
  });

  function showConvertError(msg) {
    convertError.textContent = msg;
    convertError.hidden = false;
  }

  document.getElementById("convert-again").addEventListener("click", function () {
    convertPanel.hidden = true;
    convertForm.hidden = false;
    convertAmount.value = "";
    updateEstimate();
    renderConvertForm();
  });

  /* ---------------- render all ---------------- */

  function renderAll() {
    if (!state.identity) return;
    var sidebarId = document.getElementById("sidebar-id");
    if (sidebarId) sidebarId.textContent = state.identity.id;
    var mainId = document.getElementById("main-identity-id");
    if (mainId) mainId.textContent = state.identity.id;
    var mainFp = document.getElementById("main-fingerprint");
    if (mainFp) mainFp.textContent = state.identity.fingerprint;

    var statTotal = document.getElementById("stat-total");
    if (statTotal) statTotal.textContent = formatGBP(totalValue());
    var statSources = document.getElementById("stat-sources");
    if (statSources) statSources.textContent = String(state.sources.length);
    var statHoldings = document.getElementById("stat-holdings");
    if (statHoldings) statHoldings.textContent = String(holdingsCount());

    renderSourceLists();
    renderHoldings();
    renderActivity();
    renderConvertForm();
    updateEstimate();
    renderSettings();
  }

  /* ---------------- boot ---------------- */

  var cryptoWarning = document.getElementById("crypto-warning");

  function showApp() {
    if (state.identity && state.onboardingComplete) {
      document.getElementById("onboarding").hidden = true;
      document.getElementById("app").hidden = false;
      renderAll();
    } else if (state.identity) {
      // Identity was generated but onboarding wasn't finished. Resume
      // at the debrief step instead of granting dashboard access early.
      document.getElementById("gen-idle").hidden = true;
      document.getElementById("identity-id").textContent = state.identity.id;
      document.getElementById("fingerprint").textContent = state.identity.fingerprint;
      genPhase = "done";
      obStep = 3;
      renderOnboarding();
      renderSourceLists();
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
      showApp();
      return;
    }

    cryptoKey = await getOrCreateLocalKey();

    if (parsed && parsed.iv && parsed.data) {
      try {
        var decrypted = await decryptJSON(parsed, cryptoKey);
        state = Object.assign(defaultState(), decrypted);
      } catch (e) {
        // Encrypted with a key that no longer matches (e.g. the key
        // entry was cleared independently of the data). Nothing to
        // recover from here, so start fresh rather than get stuck.
        state = defaultState();
      }
    } else {
      state = defaultState();
    }
    showApp();
  }

  boot();
})();
