const APP_ID = "34w4UNfk1crTsZL1SGg9c";
const WS_URL = "wss://api.derivws.com/trading/v1/options/ws/public";
const DERIV_API = "https://api.derivws.com";
const MAX_TICKS = 100;
const LIVE_SUB_BATCH = 6;
const LIVE_BATCH_MS = 15000;
let liveBatchIndex = 0;
let liveBatchTimer = null;
let reconnectAttempts = 0;
const liveSubscriptions = new Set();
const DEFAULT_DURATION_TICKS = 5;
let durationTicks = Number(sessionStorage.getItem("deriv_duration_ticks")) || DEFAULT_DURATION_TICKS;
if (!Number.isInteger(durationTicks) || durationTicks < 1 || durationTicks > 10) durationTicks = DEFAULT_DURATION_TICKS;
const SCAN_SIZE = 100;

const digitWrap = document.querySelector("#digits");
const grid = document.querySelector("#numberGrid");
const priceEl = document.querySelector("#price");
const changeEl = document.querySelector("#change");
const statusEl = document.querySelector("#status");
const trendEl = document.querySelector("#trend");
const marketNameEl = document.querySelector("#marketName");
const marketCodeEl = document.querySelector("#marketCode");
const marketSelector = document.querySelector("#marketSelector");

let selected = 8;
let ws = null;
let reconnectTimer = null;
let authToken = sessionStorage.getItem("deriv_token") || "";
let accountWs = null;
let accountWsReady = false;
let tradeReqId = 9000;
let pendingTrade = null;
let activeTrade = null;
const settledContracts = new Set();
let tradeStats = { wins: 0, losses: 0, netPL: 0 };
let symbols = [];
let markets = new Map();
let selectedSymbol = "AUTO";
let bestOpportunity = null;
const historyReqSymbols = new Map();

function toast(msg) {
  const t = document.querySelector("#toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(window.toastTimer);
  window.toastTimer = setTimeout(() => t.classList.remove("show"), 2200);
}

function setStatus(text, ok = false) {
  statusEl.className = `live-status ${ok ? "ok" : ""}`;
  statusEl.innerHTML = `<span></span> ${text}`;
}

function digitFromQuote(quote) {
  const s = String(quote);
  const clean = s.replace(".", "");
  return Number(clean.slice(-1));
}

function ensureMarket(symbol, displayName = symbol) {
  if (!markets.has(symbol)) markets.set(symbol, { symbol, displayName, ticks: [], lastPrice: null });
  const m = markets.get(symbol);
  if (displayName) m.displayName = displayName;
  return m;
}

function analyzeMarket(m) {
  if (!m || m.ticks.length < 20) return null;
  const sample = m.ticks.slice(0, SCAN_SIZE);
  const counts = Array(10).fill(0);
  sample.forEach(t => counts[digitFromQuote(t)]++);
  const ranked = counts.map((count, digit) => ({ digit, count })).sort((a,b) => b.count - a.count);
  const hot = ranked[0];
  const second = ranked[1];
  const edge = hot.count - second.count;
  const hotPct = hot.count / sample.length * 100;

  // MATCHES-only: a signal needs both a frequency edge and minimum occurrence rate.
  if (edge < 2 || hotPct < 11) return null;

  const confidence = Math.max(50, Math.min(95, 50 + edge * 4 + Math.max(0, hotPct - 10) * 1.5));
  return { symbol: m.symbol, displayName: m.displayName, digit: hot.digit, confidence, edge, hotPct, sampleSize: sample.length, lastDigit: digitFromQuote(sample[0]) };
}

function allOpportunities() {
  return symbols.map(s => analyzeMarket(markets.get(s))).filter(Boolean).sort((a,b) => b.confidence - a.confidence || b.edge - a.edge);
}

function setSignal(label, signal, confidence, note, opportunity = null) {
  document.querySelector("#signalLabel").textContent = label;
  document.querySelector("#signalText").textContent = signal;
  document.querySelector("#confidence").textContent = confidence ? `${confidence.toFixed(0)}%` : "—%";
  document.querySelector("#signalNote").textContent = note;
  document.querySelector("#lastDigit").textContent = opportunity ? opportunity.lastDigit : "—";
  document.querySelector("#targetDigit").textContent = opportunity ? opportunity.digit : "—";
  document.querySelector("#sampleSize").textContent = opportunity ? opportunity.sampleSize : "0";
}

function refreshBestSignal() {
  const opportunities = allOpportunities();
  bestOpportunity = opportunities[0] || null;

  if (selectedSymbol !== "AUTO") {
    const selectedOpp = analyzeMarket(markets.get(selectedSymbol));
    bestOpportunity = selectedOpp;
  }

  if (!bestOpportunity) {
    setSignal("NO SIGNAL", "WAITING FOR MATCH", 0, "No Volatility Index currently meets the MATCH confirmation conditions. The analyser will keep scanning automatically.");
    return;
  }

  setSignal("MATCH SIGNAL", `MATCH ${bestOpportunity.digit}`, bestOpportunity.confidence,
    `${bestOpportunity.displayName} (${bestOpportunity.symbol}) has the strongest current MATCH setup. The analyser scanned the available Volatility Indices automatically.`, bestOpportunity);

  if (selectedSymbol === "AUTO") renderMarket(bestOpportunity.symbol);
  renderDigits(bestOpportunity.symbol);
  renderOpportunityList(opportunities);
}

function renderOpportunityList(opportunities) {
  const box = document.querySelector("#opportunityList");
  if (!box) return;
  box.innerHTML = opportunities.slice(0, 6).map(o =>
    `<button class="opportunity ${bestOpportunity?.symbol === o.symbol ? "selected" : ""}" data-symbol="${o.symbol}">
      <span><b>${o.displayName}</b><small>${o.symbol} • MATCH ${o.digit}</small></span><strong>${o.confidence.toFixed(0)}%</strong>
    </button>`).join("") || `<div class="empty-opps">Scanning Volatility Indices…</div>`;
  box.querySelectorAll(".opportunity").forEach(b => b.onclick = () => {
    selectedSymbol = b.dataset.symbol;
    marketSelector.value = selectedSymbol;
    renderMarket(selectedSymbol);
    renderDigits(selectedSymbol);
    refreshBestSignal();
  });
}

function renderMarket(symbol) {
  const m = markets.get(symbol);
  if (!m) return;
  marketNameEl.textContent = m.displayName;
  marketCodeEl.textContent = m.symbol;
  const p = Number(m.ticks[0]);
  priceEl.textContent = Number.isFinite(p) ? p.toFixed(2) : "—";
  if (m.ticks.length > 1) {
    const prev = Number(m.ticks[1]);
    const diff = p - prev;
    const pct = prev ? diff / prev * 100 : 0;
    changeEl.textContent = `${diff >= 0 ? "+" : ""}${diff.toFixed(2)} (${pct.toFixed(2)}%)`;
    trendEl.textContent = diff >= 0 ? "▲" : "▼";
  }
}

function renderDigits(symbol = selectedSymbol === "AUTO" ? bestOpportunity?.symbol : selectedSymbol) {
  const m = symbol ? markets.get(symbol) : null;
  const ticks = m?.ticks || [];
  const counts = Array(10).fill(0);
  ticks.forEach(t => counts[digitFromQuote(t)]++);
  const total = ticks.length || 1;
  const percentages = counts.map(c => c / total * 100);
  const max = Math.max(...percentages);
  const last = ticks[0] !== undefined ? digitFromQuote(ticks[0]) : null;

  digitWrap.innerHTML = percentages.map((p, n) => {
    const active = n === selected;
    const high = p === max && total >= 5;
    return `<button class="digit-circle ${active ? "active" : ""} ${high ? "high" : ""}" data-digit="${n}"><div><div class="n">${n}</div><div class="pct">${p.toFixed(1)}%</div></div>${n === last ? '<span class="arrow-marker">▲</span>' : ''}</button>`;
  }).join("");
  document.querySelectorAll(".digit-circle").forEach(b => b.onclick = () => selectDigit(Number(b.dataset.digit)));
}

function renderGrid() {
  grid.innerHTML = Array.from({ length: 10 }, (_, i) => `<button class="num ${i === selected ? "selected" : ""}" data-number="${i}">${i}</button>`).join("");
  document.querySelectorAll(".num").forEach(b => b.onclick = () => selectDigit(Number(b.dataset.number)));
}

function selectDigit(n) { selected = n; renderGrid(); renderDigits(); toast(`Digit ${n} selected`); }

function addTick(symbol, quote) {
  const m = ensureMarket(symbol);
  m.ticks.unshift(quote);
  if (m.ticks.length > MAX_TICKS) m.ticks.pop();
  if (selectedSymbol === symbol || (selectedSymbol === "AUTO" && bestOpportunity?.symbol === symbol)) renderMarket(symbol);
}

function discoverAndSubscribe() {
  ws.send(JSON.stringify({ active_symbols: "brief", req_id: 10 }));
}

function updateScanningLabel(text) {
  const el = document.querySelector("#scanningNow");
  if (el) el.textContent = text;
}

function unsubscribeLiveBatch() {
  if (!ws || ws.readyState !== WebSocket.OPEN || !liveSubscriptions.size) return;
  for (const subId of liveSubscriptions) {
    try { ws.send(JSON.stringify({ forget: subId })); } catch {}
  }
  liveSubscriptions.clear();
}

function subscribeLiveBatch() {
  if (!ws || ws.readyState !== WebSocket.OPEN || !symbols.length) return;
  unsubscribeLiveBatch();
  const batch = symbols.slice(liveBatchIndex, liveBatchIndex + LIVE_SUB_BATCH);
  if (!batch.length) { liveBatchIndex = 0; return subscribeLiveBatch(); }
  liveBatchIndex = (liveBatchIndex + LIVE_SUB_BATCH) % symbols.length;
  updateScanningLabel(`Scanning now: ${batch.map(s => s).join(", ")}`);
  setStatus(`LIVE SCAN — ${batch.length} OF ${symbols.length}`, true);
  batch.forEach((symbol, i) => {
    const historyReqId = 1000 + i;
    historyReqSymbols.set(historyReqId, symbol);
    ws.send(JSON.stringify({ ticks_history: symbol, count: MAX_TICKS, end: "latest", style: "ticks", req_id: historyReqId }));
    ws.send(JSON.stringify({ ticks: symbol, subscribe: 1, req_id: 2000 + i }));
  });
}

function isVolatilityIndex(item) {
  const symbol = String(item.symbol || item.underlying_symbol || "").toUpperCase();
  const text = `${item.display_name || item.underlying_symbol_name || ""} ${item.market_display_name || ""} ${item.submarket_display_name || ""}`.toLowerCase();
  // Support current and legacy Deriv symbol names, including newly added 1-second indices.
  const knownVolatilitySymbol = /^(?:R_\d+|1HZ\d+V)$/.test(symbol);
  return knownVolatilitySymbol || (text.includes("volatility") && text.includes("index"));
}

function connect() {
  clearTimeout(reconnectTimer);
  clearInterval(liveBatchTimer);
  if (ws) { try { unsubscribeLiveBatch(); ws.close(); } catch {} }
  markets.clear(); symbols = []; bestOpportunity = null; liveBatchIndex = 0; liveSubscriptions.clear();
  setStatus("DISCOVERING VOLATILITY INDICES");
  updateScanningLabel("Discovering Volatility Indices…");
  ws = new WebSocket(WS_URL);

  ws.onopen = () => { reconnectAttempts = 0; setStatus("CONNECTED — DISCOVERING VOLATILITY INDICES"); discoverAndSubscribe(); };
  ws.onmessage = event => {
    const data = JSON.parse(event.data);
    if (data.error) { setStatus("ERROR"); toast(data.error.message || "Deriv API error"); return; }

    if (data.msg_type === "active_symbols" && data.active_symbols) {
      const found = data.active_symbols.filter(isVolatilityIndex);
      const normalized = found.map(x => ({
        symbol: x.symbol || x.underlying_symbol,
        displayName: x.display_name || x.underlying_symbol_name || x.symbol || x.underlying_symbol
      })).filter(x => x.symbol);
      symbols = [...new Set(normalized.map(x => x.symbol))];
      normalized.forEach(x => ensureMarket(x.symbol, x.displayName));
      marketSelector.innerHTML = `<option value="AUTO">AUTO — All Volatility Indices</option>` + normalized.map(x => `<option value="${x.symbol}">${x.displayName} (${x.symbol})</option>`).join("");
      marketSelector.value = selectedSymbol;
      if (!symbols.length) { setStatus("NO VOLATILITY INDICES"); toast("No Volatility Indices were returned by Deriv"); return; }
      setStatus(`SCANNING ${symbols.length} VOLATILITY INDICES`, true);
      liveBatchIndex = 0;
      subscribeLiveBatch();
      clearInterval(liveBatchTimer);
      liveBatchTimer = setInterval(() => subscribeLiveBatch(), LIVE_BATCH_MS);
      toast(`Scanning ${symbols.length} Volatility Indices in small live batches`);
      return;
    }

    if (data.msg_type === "history" && data.history?.prices) {
      const symbol = historyReqSymbols.get(data.req_id) || data.echo_req?.ticks_history;
      if (symbol) {
        const m = ensureMarket(symbol);
        m.ticks = data.history.prices.slice(-MAX_TICKS).reverse();
        if (selectedSymbol === symbol) renderMarket(symbol);
        refreshBestSignal();
      }
    }

    if (data.msg_type === "tick" && data.tick) {
      const tickSymbol = data.tick.symbol || data.tick.underlying_symbol;
      if (!tickSymbol) return;
      addTick(tickSymbol, data.tick.quote);
      updateCountdownFromTick(tickSymbol);
      setStatus(`LIVE — ${tickSymbol}`, true);
      refreshBestSignal();
    }
  };
  ws.onerror = () => setStatus("CONNECTION ERROR");
  ws.onclose = () => {
    clearInterval(liveBatchTimer);
    liveSubscriptions.clear();
    reconnectAttempts = Math.min(reconnectAttempts + 1, 5);
    const delay = Math.min(30000, 3000 * (2 ** (reconnectAttempts - 1)));
    setStatus(`RECONNECTING IN ${Math.ceil(delay / 1000)}s`);
    reconnectTimer = setTimeout(connect, delay);
  };
}

marketSelector.onchange = () => {
  selectedSymbol = marketSelector.value;
  if (selectedSymbol === "AUTO") refreshBestSignal();
  else { renderMarket(selectedSymbol); renderDigits(selectedSymbol); refreshBestSignal(); }
};

document.querySelector("#refreshBtn").onclick = () => { toast("Refreshing Volatility scanner…"); connect(); };
document.querySelector("#matches").onclick = () => placeMatchTrade(bestOpportunity?.digit ?? selected);
const durationInput = document.querySelector("#durationTicks");
if (durationInput) {
  durationInput.value = String(durationTicks);
  durationInput.addEventListener("change", () => {
    let value = Number(durationInput.value);
    if (!Number.isInteger(value)) value = DEFAULT_DURATION_TICKS;
    value = Math.max(1, Math.min(10, value));
    durationTicks = value;
    durationInput.value = String(value);
    sessionStorage.setItem("deriv_duration_ticks", String(value));
    toast(`Contract duration set to ${value} tick${value === 1 ? "" : "s"}`);
  });
}
document.querySelector("#aiBtn").onclick = () => { refreshBestSignal(); toast("MATCH scanner refreshed across Volatility Indices"); };

document.querySelectorAll(".tab").forEach(t => t.onclick = () => {
  document.querySelectorAll(".tab").forEach(x => x.classList.remove("active")); t.classList.add("active"); toast(`${t.querySelector("span").textContent} selected`);
});

renderGrid();
renderDigits();
connect();

function updateAccountUI(connected, balance) {
  document.querySelector("#accountBtn").textContent = connected ? "Account connected" : "Connect Deriv Account";
  document.querySelector("#balance").textContent = connected ? `${Number(balance).toFixed(2)} USD` : "Not connected";
}

async function derivFetch(path, token, options = {}) {
  const headers = {
    ...(options.headers || {}),
    "Authorization": `Bearer ${token}`,
    "Deriv-App-ID": APP_ID,
    "Content-Type": "application/json"
  };
  const response = await fetch(`${DERIV_API}${path}`, { ...options, headers });
  const data = await response.json();
  if (!response.ok || data.errors) {
    throw new Error(data?.errors?.[0]?.message || `Deriv API error (${response.status})`);
  }
  return data;
}

async function loadAccountsForToken(token) {
  const result = await derivFetch("/trading/v1/options/accounts", token, { method: "GET" });
  const accounts = Array.isArray(result.data) ? result.data : (result.data ? [result.data] : []);
  if (!accounts.length) throw new Error("No Options trading accounts were returned for this token");
  const normalized = accounts.map(a => ({
    raw: a,
    id: a.account_id || a.accountId || a.loginid || a.id,
    type: String(a.account_type || a.type || "").toLowerCase(),
    balance: Number(a.balance ?? a.available_balance ?? 0),
    currency: a.currency || "USD"
  })).filter(a => a.id);
  const select = document.querySelector("#accountSelect");
  select.innerHTML = normalized.map(a => {
    const label = a.type === "demo" ? "DEMO" : (a.type === "real" ? "REAL" : a.type.toUpperCase() || "ACCOUNT");
    return `<option value="${a.id}" data-type="${a.type}">${label} — ${a.id} — ${a.balance.toFixed(2)} ${a.currency}</option>`;
  }).join("");
  // Prefer demo when available.
  const demo = normalized.find(a => a.type === "demo");
  if (demo) select.value = demo.id;
  return normalized;
}

document.querySelector("#apiToken").addEventListener("change", async () => {
  const token = document.querySelector("#apiToken").value.trim();
  if (!token) return;
  try { await loadAccountsForToken(token); toast("Accounts loaded — DEMO selected when available"); }
  catch (e) { toast(e.message || "Could not load accounts"); }
});

document.querySelector("#apiToken").addEventListener("blur", async () => {
  const token = document.querySelector("#apiToken").value.trim();
  if (!token || document.querySelector("#accountSelect").options.length > 1) return;
  try { await loadAccountsForToken(token); } catch (e) { /* connect button will show the full error */ }
});

async function connectAccount() {
  const token = document.querySelector("#apiToken").value.trim();
  if (!token) return toast("Paste your Deriv API token first");
  try {
    toast("Loading your Deriv accounts…");
    const accounts = await loadAccountsForToken(token);
    const select = document.querySelector("#accountSelect");
    const account = accounts.find(a => a.id === select.value) || accounts.find(a => a.type === "demo") || accounts[0];
    if (!account) throw new Error("No account selected");

    authToken = token;
    sessionStorage.setItem("deriv_token", token);
    sessionStorage.setItem("deriv_account_id", account.id);
    sessionStorage.setItem("deriv_account_type", account.type);
    sessionStorage.setItem("deriv_currency", account.currency || "USD");
    updateAccountUI(true, account.balance);
    document.querySelector("#accountModal").classList.remove("show");
    toast(`${account.type === "demo" ? "DEMO" : "REAL"} connected: ${account.id}`);

    // Get a short-lived authenticated WebSocket URL for the selected account.
    // Deriv returns the correct demo/real endpoint according to the selected account.
    try {
      const otp = await derivFetch(`/trading/v1/options/accounts/${encodeURIComponent(account.id)}/otp`, token, { method: "POST" });
      if (otp?.data?.url) {
        if (accountWs) { try { accountWs.close(); } catch {} }
        accountWsReady = false;
        accountWs = new WebSocket(otp.data.url);
        accountWs.onopen = () => {
          accountWsReady = true;
          toast(`${account.type === "demo" ? "DEMO" : "REAL"} trading connection ready`);
        };
        accountWs.onclose = () => { accountWsReady = false; };
        accountWs.onerror = () => {
          accountWsReady = false;
          toast("Account connected, but the authenticated trading WebSocket could not be opened");
        };
        accountWs.onmessage = handleTradeMessage;
      }
    } catch (otpError) {
      console.warn("Authenticated WebSocket setup failed:", otpError);
      toast("Account connected, but the trading channel could not be established");
    }
  } catch (error) {
    console.error(error);
    toast(error.message || "Could not connect to Deriv account");
  }
}

async function restoreAccount() {
  if (!authToken) return;
  try {
    const result = await derivFetch("/trading/v1/options/accounts", authToken, { method: "GET" });
    const accounts = Array.isArray(result.data) ? result.data : (result.data ? [result.data] : []);
    const savedId = sessionStorage.getItem("deriv_account_id");
    const savedType = sessionStorage.getItem("deriv_account_type");
    const account = accounts.find(a => (a.account_id || a.accountId || a.loginid || a.id) === savedId) || accounts.find(a => String(a.account_type || a.type || "").toLowerCase() === savedType) || accounts.find(a => String(a.account_type || a.type || "").toLowerCase() === "demo") || accounts[0];
    if (!account) throw new Error("No account found");
    const accountId = account.account_id || account.accountId || account.loginid || account.id;
    updateAccountUI(true, Number(account.balance ?? account.available_balance ?? 0));
    sessionStorage.setItem("deriv_account_id", accountId);
    sessionStorage.setItem("deriv_account_type", String(account.account_type || account.type || "").toLowerCase());
  } catch (error) {
    sessionStorage.removeItem("deriv_token");
    sessionStorage.removeItem("deriv_account_id");
    authToken = "";
    updateAccountUI(false);
  }
}

function updateTradeCountdown(label = "TRADE STATUS", text = "READY", detail = "Place a MATCH to start", active = false) {
  const box = document.querySelector("#tradeCountdown");
  const main = document.querySelector("#countdownText");
  const detailEl = document.querySelector("#countdownDetail");
  if (box) box.classList.toggle("active", active);
  if (main) main.textContent = text;
  if (detailEl) detailEl.textContent = detail;
  const labelEl = document.querySelector(".countdown-label");
  if (labelEl) labelEl.textContent = label;
}

function updateCountdownFromTick(symbol) {
  if (!activeTrade || activeTrade.symbol !== symbol || activeTrade.remaining <= 0) return;
  activeTrade.seenTicks += 1;
  activeTrade.remaining = Math.max(0, activeTrade.duration - activeTrade.seenTicks);
  if (activeTrade.remaining > 0) {
    updateTradeCountdown("MATCH ACTIVE", `TICK ${activeTrade.remaining}`, `${activeTrade.remaining} tick${activeTrade.remaining === 1 ? "" : "s"} remaining`, true);
  } else {
    updateTradeCountdown("MATCH ACTIVE", "RESULT…", "Waiting for Deriv to confirm the contract result", true);
  }
}

async function placeMatchTrade(digit) {
  if (!authToken) {
    document.querySelector("#accountModal").classList.add("show");
    toast("Connect your Deriv account first");
    return;
  }
  if (!accountWs || !accountWsReady) {
    toast("Trading connection is not ready yet — reconnect your account");
    return;
  }
  const accountType = sessionStorage.getItem("deriv_account_type") || "demo";
  const accountId = sessionStorage.getItem("deriv_account_id") || "";
  const currency = sessionStorage.getItem("deriv_currency") || "USD";
  const symbol = bestOpportunity?.symbol || (selectedSymbol !== "AUTO" ? selectedSymbol : "");
  if (!symbol) { toast("Wait for a MATCH signal first"); return; }
  if (digit < 0 || digit > 9) { toast("Choose a valid digit"); return; }

  const reqId = ++tradeReqId;
  pendingTrade = { reqId, digit, symbol, stake: 10, currency, accountId, accountType };
  toast(`MANUAL — requesting MATCH ${digit} proposal on ${symbol}…`);
  try {
    accountWs.send(JSON.stringify({
      proposal: 1,
      amount: 10,
      basis: "stake",
      contract_type: "DIGITMATCH",
      currency,
      duration: durationTicks,
      duration_unit: "t",
      barrier: String(digit),
      underlying_symbol: symbol,
      req_id: reqId
    }));
  } catch (e) {
    pendingTrade = null;
    toast("Could not send trade proposal");
  }
}


function updateTradeStats() {
  const wins = document.querySelector("#wins");
  const losses = document.querySelector("#losses");
  const net = document.querySelector("#netPL");
  if (wins) wins.textContent = String(tradeStats.wins);
  if (losses) losses.textContent = String(tradeStats.losses);
  if (net) net.textContent = `${tradeStats.netPL >= 0 ? "+" : ""}${tradeStats.netPL.toFixed(2)} USD`;
}

function handleTradeMessage(event) {
  let data;
  try { data = JSON.parse(event.data); } catch { return; }
  if (data.error) {
    toast(data.error.message || "Deriv trade error");
    pendingTrade = null;
    activeTrade = null;
    updateTradeCountdown("TRADE ERROR", "ERROR", data.error.message || "Trade could not be opened", false);
    return;
  }
  if (data.msg_type === "proposal" && data.proposal && pendingTrade) {
    if (data.req_id && data.req_id !== pendingTrade.reqId) return;
    const proposalId = data.proposal.id;
    const askPrice = Number(data.proposal.ask_price ?? pendingTrade.stake);
    if (!proposalId || !Number.isFinite(askPrice)) {
      pendingTrade = null;
      toast("Deriv did not return a valid MATCH proposal");
      return;
    }
    toast(`MATCH ${pendingTrade.digit} proposal ready — buying…`);
    accountWs.send(JSON.stringify({ buy: proposalId, price: askPrice, req_id: ++tradeReqId }));
    return;
  }
  if (data.msg_type === "buy" && data.buy) {
    const contractId = data.buy.contract_id;
    const buyPrice = data.buy.buy_price;
    const payout = data.buy.payout;
    toast(`MATCH trade opened — ${contractId}`);
    const openedTrade = pendingTrade;
    activeTrade = { contractId, symbol: openedTrade.symbol, duration: durationTicks, seenTicks: 0, remaining: durationTicks };
    updateTradeCountdown("MATCH ACTIVE", `TICK ${durationTicks}`, `${durationTicks} ticks remaining`, true);
    pendingTrade = null;
    if (Number.isFinite(Number(payout))) {
      const payoutStrong = document.querySelector("#matches small strong");
      if (payoutStrong) payoutStrong.textContent = `${Number(payout).toFixed(2)}`;
    }
    if (contractId) {
      accountWs.send(JSON.stringify({ proposal_open_contract: 1, contract_id: contractId, subscribe: 1, req_id: ++tradeReqId }));
    }
    return;
  }
  if (data.msg_type === "proposal_open_contract" && data.proposal_open_contract) {
    const c = data.proposal_open_contract;
    const final = c.is_sold || c.status === "won" || c.status === "lost" || c.status === "expired";
    if (final && !settledContracts.has(String(c.contract_id))) {
      settledContracts.add(String(c.contract_id));
      if (activeTrade && String(activeTrade.contractId) === String(c.contract_id)) activeTrade = null;
      const profit = Number(c.profit ?? 0);
      if (c.status === "won") tradeStats.wins += 1;
      if (c.status === "lost") tradeStats.losses += 1;
      if (Number.isFinite(profit)) tradeStats.netPL += profit;
      updateTradeStats();
      const result = c.status === "won" ? "WIN" : c.status === "lost" ? "LOSS" : String(c.status || "CLOSED").toUpperCase();
      updateTradeCountdown(result, result, `Final P/L: ${profit >= 0 ? "+" : ""}${profit.toFixed(2)} USD`, false);
      toast(`MATCH ${result}: ${profit >= 0 ? "+" : ""}${profit.toFixed(2)} USD`);
    } else if (!final && activeTrade && String(activeTrade.contractId) === String(c.contract_id)) {
      const tickCount = Number(c.tick_count);
      if (Number.isFinite(tickCount) && tickCount >= 0) {
        activeTrade.seenTicks = Math.min(activeTrade.duration, tickCount);
        activeTrade.remaining = Math.max(0, activeTrade.duration - activeTrade.seenTicks);
        if (activeTrade.remaining > 0) updateTradeCountdown("MATCH ACTIVE", `TICK ${activeTrade.remaining}`, `${activeTrade.remaining} tick${activeTrade.remaining === 1 ? "" : "s"} remaining`, true);
      }
    }
  }
}

document.querySelector("#accountBtn").onclick = () => document.querySelector("#accountModal").classList.add("show");
document.querySelector("#closeAccount").onclick = () => document.querySelector("#accountModal").classList.remove("show");
document.querySelector("#connectAccount").onclick = connectAccount;
document.querySelector("#disconnectAccount").onclick = () => { authToken = ""; sessionStorage.removeItem("deriv_token"); if (accountWs) { try { accountWs.close(); } catch {} } accountWsReady = false; updateAccountUI(false); toast("Deriv account disconnected"); };
restoreAccount();
