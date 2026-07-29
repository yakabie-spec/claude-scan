// 書類スキャンアプリ v2
// カメラ撮影（輪郭自動検出・手動調整）→ カテゴリ選択 → Claude で OCR・命名・フォルダ提案 → 承認 → Dropbox に PDF 保存
// v2 改善点: 手動四隅調整 / 影除去などの画質補正強化 / tool-use による確実な JSON 解析 /
//            自動リトライ / 解析失敗時の受信箱フォールバック / 保存履歴 / PWA 対応

const APP_VERSION = "2.2.1";

// ---------------------------------------------------------------------------
// 状態・設定（localStorage キーは v1 と互換）
// ---------------------------------------------------------------------------
const LS_ANTHROPIC = "anthropic_api_key";
const LS_DBX_APP = "dropbox_app_key";
const LS_DBX_TOKENS = "dropbox_tokens";
const LS_PKCE = "dbx_code_verifier";
const LS_MODEL = "anthropic_model";
const LS_HISTORY = "scan_history_v2";
const LS_FOLDER_CACHE = "folder_tree_cache_v2";

const DBX_AUTH_URL = "https://www.dropbox.com/oauth2/authorize";
const DBX_TOKEN_URL = "https://api.dropboxapi.com/oauth2/token";
const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const DEFAULT_MODEL = "claude-opus-4-8";
const FOLDER_CACHE_TTL = 30 * 60 * 1000; // 30分

const settings = {
  get anthropicKey() { return localStorage.getItem(LS_ANTHROPIC) || ""; },
  set anthropicKey(v) { localStorage.setItem(LS_ANTHROPIC, v); },
  get dropboxAppKey() { return localStorage.getItem(LS_DBX_APP) || ""; },
  set dropboxAppKey(v) { localStorage.setItem(LS_DBX_APP, v); },
  get model() { return localStorage.getItem(LS_MODEL) || DEFAULT_MODEL; },
  set model(v) { localStorage.setItem(LS_MODEL, v); },
  get tokens() {
    try { return JSON.parse(localStorage.getItem(LS_DBX_TOKENS) || "null"); }
    catch { return null; }
  },
  set tokens(v) {
    if (v) localStorage.setItem(LS_DBX_TOKENS, JSON.stringify(v));
    else localStorage.removeItem(LS_DBX_TOKENS);
  },
};

const state = {
  pages: [],          // { src: canvas, corners, mode, rotation, out: canvas|null }
  currentPage: 0,
  category: null,     // "/00 仕事" | "/01 Private"
  proposal: null,     // Claude の提案
  isNewFolder: false,
  docRules: null,
  browserPath: "",
  stream: null,
  torchOn: false,
  analyzeAbort: null,
  cropDraft: null,    // 範囲調整中の一時 corners
  saving: false,
};

const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------------------
// 画面遷移・トースト
// ---------------------------------------------------------------------------
function showScreen(name) {
  document.querySelectorAll(".screen").forEach((s) => s.classList.remove("active"));
  $("screen-" + name).classList.add("active");
  window.scrollTo(0, 0);
}

let toastTimer = null;
function toast(msg, isError = false, ms = 3200) {
  const el = $("toast");
  el.textContent = msg;
  el.classList.toggle("error", isError);
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, ms);
}

// ---------------------------------------------------------------------------
// 共通ユーティリティ
// ---------------------------------------------------------------------------
const nfc = (s) => (s || "").normalize("NFC");

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function sanitizeFilename(name) {
  let n = nfc(name).trim().replace(/[\\/:*?"<>|]/g, "・").replace(/\s+/g, " ");
  if (!/\.pdf$/i.test(n)) n += ".pdf";
  return n;
}

// 一時的な失敗（429/5xx/ネットワーク）を自動リトライ
async function withRetry(fn, { tries = 3, baseDelay = 1200, label = "" } = {}) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (e && e.name === "AbortError") throw e;
      const retriable = e && (e.retriable === true || e.status === 429 || (e.status >= 500 && e.status < 600) || e.network === true);
      if (!retriable || i === tries - 1) throw e;
      const wait = baseDelay * Math.pow(2, i);
      if (label) setProcessing(`${label}\n（通信エラーのため再試行中 ${i + 1}/${tries - 1}...）`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  throw lastErr;
}

function httpError(status, message) {
  const e = new Error(message || `HTTP ${status}`);
  e.status = status;
  return e;
}

function networkError(orig) {
  const e = new Error("ネットワークに接続できません");
  e.network = true;
  e.cause = orig;
  return e;
}

function setProcessing(msg) { $("processing-status").textContent = msg; }

// ---------------------------------------------------------------------------
// Dropbox OAuth (PKCE) — オフラインアクセス + 自動リフレッシュ
// ---------------------------------------------------------------------------
function base64UrlEncode(bytes) {
  return btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function randomVerifier() {
  const arr = new Uint8Array(48);
  crypto.getRandomValues(arr);
  return base64UrlEncode(arr);
}

async function dropboxStartAuth() {
  const appKey = settings.dropboxAppKey.trim();
  if (!appKey) { toast("先に Dropbox アプリキーを入力・保存してください", true); return; }
  const verifier = randomVerifier();
  localStorage.setItem(LS_PKCE, verifier);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  const challenge = base64UrlEncode(digest);
  const redirect = location.origin + location.pathname;
  const url = `${DBX_AUTH_URL}?client_id=${encodeURIComponent(appKey)}&response_type=code` +
    `&code_challenge=${challenge}&code_challenge_method=S256` +
    `&redirect_uri=${encodeURIComponent(redirect)}&token_access_type=offline`;
  location.href = url;
}

async function dropboxHandleRedirect() {
  const params = new URLSearchParams(location.search);
  const code = params.get("code");
  if (!code) return;
  history.replaceState(null, "", location.pathname); // URL からコードを消す
  const verifier = localStorage.getItem(LS_PKCE);
  const appKey = settings.dropboxAppKey.trim();
  if (!verifier || !appKey) { toast("Dropbox 接続情報が不足しています。設定からやり直してください", true); return; }
  try {
    const body = new URLSearchParams({
      code, grant_type: "authorization_code",
      redirect_uri: location.origin + location.pathname,
      code_verifier: verifier, client_id: appKey,
    });
    const res = await fetch(DBX_TOKEN_URL, { method: "POST", body });
    if (!res.ok) throw httpError(res.status, await res.text());
    const data = await res.json();
    settings.tokens = {
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      expires_at: Date.now() + (data.expires_in - 120) * 1000,
    };
    localStorage.removeItem(LS_PKCE);
    toast("Dropbox と接続しました ✅");
  } catch (e) {
    console.error(e);
    toast("Dropbox 接続に失敗しました: " + (e.message || ""), true);
  }
  refreshHomeStatus();
}

async function dropboxAccessToken() {
  const t = settings.tokens;
  if (!t) throw new Error("Dropbox が未接続です（設定から接続してください）");
  if (t.expires_at && Date.now() < t.expires_at) return t.access_token;
  if (!t.refresh_token) return t.access_token; // 旧形式トークンはそのまま使用
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: t.refresh_token,
    client_id: settings.dropboxAppKey.trim(),
  });
  const res = await fetch(DBX_TOKEN_URL, { method: "POST", body }).catch((e) => { throw networkError(e); });
  if (!res.ok) {
    if (res.status === 400 || res.status === 401) {
      settings.tokens = null;
      refreshHomeStatus();
      throw new Error("Dropbox の接続が無効になりました。設定から再接続してください");
    }
    throw httpError(res.status, "Dropbox 認証の更新に失敗しました");
  }
  const data = await res.json();
  settings.tokens = { ...t, access_token: data.access_token, expires_at: Date.now() + (data.expires_in - 120) * 1000 };
  return data.access_token;
}

// ---------------------------------------------------------------------------
// Dropbox API
// ---------------------------------------------------------------------------
async function dbxRpc(endpoint, arg) {
  return withRetry(async () => {
    const token = await dropboxAccessToken();
    let res;
    try {
      res = await fetch(`https://api.dropboxapi.com/2/${endpoint}`, {
        method: "POST",
        headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(arg),
      });
    } catch (e) { throw networkError(e); }
    if (!res.ok) {
      const text = await res.text();
      const err = httpError(res.status, text);
      err.body = text;
      throw err;
    }
    return res.json();
  });
}

function httpHeaderSafeJson(obj) {
  return JSON.stringify(obj).replace(/[\u007f-\uffff]/g, (c) =>
    "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));
}

async function dbxUpload(path, blob) {
  return withRetry(async () => {
    const token = await dropboxAccessToken();
    let res;
    try {
      res = await fetch("https://content.dropboxapi.com/2/files/upload", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${token}`,
          "Content-Type": "application/octet-stream",
          "Dropbox-API-Arg": httpHeaderSafeJson({
            path: nfc(path), mode: "add", autorename: true, mute: true,
          }),
        },
        body: blob,
      });
    } catch (e) { throw networkError(e); }
    if (!res.ok) throw httpError(res.status, await res.text());
    return res.json();
  }, { tries: 3, label: "Dropbox に保存中..." });
}

async function dbxListSubfolders(path) {
  const folders = [];
  let result = await dbxRpc("files/list_folder", { path: path === "/" ? "" : nfc(path) });
  for (;;) {
    for (const e of result.entries) if (e[".tag"] === "folder") folders.push(e.path_display);
    if (!result.has_more) break;
    result = await dbxRpc("files/list_folder/continue", { cursor: result.cursor });
  }
  folders.sort((a, b) => a.localeCompare(b, "ja"));
  return folders;
}

async function dbxFolderExists(path) {
  try {
    const meta = await dbxRpc("files/get_metadata", { path: nfc(path) });
    return meta[".tag"] === "folder";
  } catch (e) {
    if (e.status === 409) return false;
    throw e;
  }
}

async function dbxEnsureFolder(path) {
  try {
    await dbxRpc("files/create_folder_v2", { path: nfc(path), autorename: false });
  } catch (e) {
    if (e.status === 409) return; // 既に存在
    throw e;
  }
}

// カテゴリ配下のフォルダツリー（深さ2）を取得。キャッシュ付き
async function fetchFolderTree(base, force = false) {
  let cache = {};
  try { cache = JSON.parse(localStorage.getItem(LS_FOLDER_CACHE) || "{}"); } catch { cache = {}; }
  const hit = cache[base];
  if (!force && hit && Date.now() - hit.ts < FOLDER_CACHE_TTL) return hit.list;

  const list = [base];
  const level1 = await dbxListSubfolders(base).catch(() => []);
  list.push(...level1);
  const expand = level1.slice(0, 40);
  const children = await Promise.all(expand.map((f) => dbxListSubfolders(f).catch(() => [])));
  for (const c of children) list.push(...c.slice(0, 25));
  const capped = list.slice(0, 220);

  cache[base] = { ts: Date.now(), list: capped };
  try { localStorage.setItem(LS_FOLDER_CACHE, JSON.stringify(cache)); } catch { /* 容量超過は無視 */ }
  return capped;
}

function clearFolderCache() {
  localStorage.removeItem(LS_FOLDER_CACHE);
  toast("フォルダ一覧キャッシュを削除しました。次回解析時に再取得します");
}

// ---------------------------------------------------------------------------
// OpenCV / jscanify（輪郭検出）
// ---------------------------------------------------------------------------
let scannerInstance = null;

async function cvReady() {
  // 注意: window.cv を await してはいけない（Emscripten の thenable は
  // 自分自身を返すため、await すると無限ループでフリーズする既知バグがある）。
  // 初期化完了は cv.Mat の出現をポーリングして判定する。
  const started = Date.now();
  for (;;) {
    if (window.cv && window.cv.Mat && window.cv.getPerspectiveTransform) return;
    if (Date.now() - started > 30000) {
      throw new Error("画像処理ライブラリの読み込みに失敗しました。通信環境をご確認のうえ再読み込みしてください");
    }
    await new Promise((r) => setTimeout(r, 150));
  }
}

async function getScanner() {
  await cvReady();
  if (!scannerInstance) scannerInstance = new jscanify();
  return scannerInstance;
}

const QUAD_KEYS = ["topLeftCorner", "topRightCorner", "bottomLeftCorner", "bottomRightCorner"];

// ---------------------------------------------------------------------------
// ML 四隅検出（UNet + MobileNetV3 / ONNX Runtime Web）
// 学習済みモデルで書類の4隅をヒートマップ推定する。Google レンズと同系統の方式。
// モデルが未ロード・失敗時は従来の幾何学検出へフォールバックする。
// ---------------------------------------------------------------------------
const ML_MODEL_URL = "https://huggingface.co/spaces/KennethTM/document_corner_detector/resolve/main/models/timm-mobilenetv3_small_100.onnx";
const ML_INPUT_SIZE = 224;
const ML_MEAN = [0.485, 0.456, 0.406];
const ML_STD = [0.229, 0.224, 0.225];

let mlSession = null;      // ロード完了後にセットされる
let mlSessionPromise = null;
let mlInferBusy = false;
let mlAvgMs = 0;           // 直近の推論時間（ライブ検出の間隔調整に使用）

function loadMlSession() {
  if (mlSessionPromise) return mlSessionPromise;
  mlSessionPromise = (async () => {
    if (!window.ort) throw new Error("onnxruntime not loaded");
    ort.env.wasm.wasmPaths = new URL("vendor/ort/", location.href).href;
    ort.env.wasm.numThreads = 1;
    // モデルは Cache Storage に保存してオフライン・2回目以降を高速化
    let resp = null;
    let cache = null;
    try {
      cache = await caches.open("ml-model-v1");
      resp = await cache.match(ML_MODEL_URL);
    } catch {}
    if (!resp) {
      resp = await fetch(ML_MODEL_URL);
      if (!resp.ok) throw new Error("model download failed: " + resp.status);
      if (cache) { try { await cache.put(ML_MODEL_URL, resp.clone()); } catch {} }
    }
    const buf = await resp.arrayBuffer();
    const session = await ort.InferenceSession.create(buf, { executionProviders: ["wasm"] });
    mlSession = session;
    console.info("ML corner model ready");
    return session;
  })();
  mlSessionPromise.catch((e) => {
    console.warn("ML model unavailable, falling back to classical detection", e);
    mlSessionPromise = null; // 後で再試行できるように
  });
  return mlSessionPromise;
}

// ML で四隅を推定。失敗・不正な形状なら null
async function mlDetectCorners(canvas, session) {
  const S = ML_INPUT_SIZE;
  const scale = S / Math.max(canvas.width, canvas.height);
  const w = Math.max(1, Math.round(canvas.width * scale));
  const h = Math.max(1, Math.round(canvas.height * scale));
  const x0 = Math.floor((S - w) / 2);
  const y0 = Math.floor((S - h) / 2);
  const c = document.createElement("canvas");
  c.width = S; c.height = S;
  const ctx = c.getContext("2d", { willReadFrequently: true });
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, S, S);
  ctx.drawImage(canvas, x0, y0, w, h);
  const data = ctx.getImageData(0, 0, S, S).data;
  const n = S * S;
  const input = new Float32Array(3 * n);
  for (let i = 0; i < n; i++) {
    input[i] = (data[i * 4] / 255 - ML_MEAN[0]) / ML_STD[0];
    input[n + i] = (data[i * 4 + 1] / 255 - ML_MEAN[1]) / ML_STD[1];
    input[2 * n + i] = (data[i * 4 + 2] / 255 - ML_MEAN[2]) / ML_STD[2];
  }
  const t0 = performance.now();
  const feeds = {};
  feeds[session.inputNames[0]] = new ort.Tensor("float32", input, [1, 3, S, S]);
  const out = await session.run(feeds);
  mlAvgMs = mlAvgMs ? mlAvgMs * 0.6 + (performance.now() - t0) * 0.4 : performance.now() - t0;
  const heat = out[session.outputNames[0]].data; // [1,4,S,S] → TL,TR,BR,BL の順
  const pts = [];
  for (let k = 0; k < 4; k++) {
    let best = -Infinity, bi = 0;
    const off = k * n;
    for (let i = 0; i < n; i++) {
      const v = heat[off + i];
      if (v > best) { best = v; bi = i; }
    }
    pts.push({
      x: Math.min(canvas.width, Math.max(0, ((bi % S) - x0) / scale)),
      y: Math.min(canvas.height, Math.max(0, (Math.floor(bi / S) - y0) / scale)),
    });
  }
  const quad = orderQuadPoints(pts);
  // 妥当性チェック（面積・縮退・辺の長さ）
  const A = canvas.width * canvas.height;
  if (quadArea(quad) < A * 0.04) return null;
  const sides = [
    dist(quad.topLeftCorner, quad.topRightCorner),
    dist(quad.topRightCorner, quad.bottomRightCorner),
    dist(quad.bottomRightCorner, quad.bottomLeftCorner),
    dist(quad.bottomLeftCorner, quad.topLeftCorner),
  ];
  if (Math.min(...sides) < Math.max(canvas.width, canvas.height) * 0.05) return null;
  return quad;
}

// 4点を TL/TR/BL/BR に並べ替え（回転した書類にも対応）
function orderQuadPoints(pts) {
  const bySum = [...pts].sort((a, b) => (a.x + a.y) - (b.x + b.y));
  const byDiff = [...pts].sort((a, b) => (a.y - a.x) - (b.y - b.x));
  return {
    topLeftCorner: bySum[0],
    bottomRightCorner: bySum[3],
    topRightCorner: byDiff[0],
    bottomLeftCorner: byDiff[3],
  };
}

// 2値画像から凸4角形の候補を収集
function collectQuads(binMat, minArea, maxArea, out) {
  const contours = new cv.MatVector();
  const hierarchy = new cv.Mat();
  try {
    cv.findContours(binMat, contours, hierarchy, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);
    for (let i = 0; i < contours.size(); i++) {
      const c = contours.get(i);
      const area = cv.contourArea(c);
      if (area >= minArea && area <= maxArea) {
        const peri = cv.arcLength(c, true);
        for (const eps of [0.02, 0.035, 0.05]) {
          const approx = new cv.Mat();
          cv.approxPolyDP(c, approx, eps * peri, true);
          const ok = approx.rows === 4 && cv.isContourConvex(approx);
          if (ok) {
            const pts = [];
            for (let j = 0; j < 4; j++) pts.push({ x: approx.data32S[j * 2], y: approx.data32S[j * 2 + 1] });
            out.push({ quad: orderQuadPoints(pts), score: area });
          }
          approx.delete();
          if (ok) break;
        }
      }
      c.delete();
    }
  } finally {
    contours.delete();
    hierarchy.delete();
  }
}

// RGBA Mat から書類らしい四角形を探す（複数戦略）
function findQuadInMat(src, W, H, maxArea) {
  const minArea = W * H * 0.10;
  const mats = [];
  const track = (m) => (mats.push(m), m);
  try {
    const gray = track(new cv.Mat());
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
    cv.GaussianBlur(gray, gray, new cv.Size(5, 5), 0, 0, cv.BORDER_DEFAULT);
    const kernel = track(cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(3, 3)));
    const candidates = [];

    // 戦略1: Canny エッジ + 膨張（輪郭の途切れを閉じる）
    const edges = track(new cv.Mat());
    cv.Canny(gray, edges, 50, 150);
    cv.dilate(edges, edges, kernel);
    collectQuads(edges, minArea, maxArea, candidates);

    // 戦略2: 適応的しきい値（机と紙のコントラストが低い場合に強い）
    if (!candidates.length) {
      const th = track(new cv.Mat());
      cv.adaptiveThreshold(gray, th, 255, cv.ADAPTIVE_THRESH_GAUSSIAN_C, cv.THRESH_BINARY, 31, 6);
      cv.morphologyEx(th, th, cv.MORPH_CLOSE, kernel);
      collectQuads(th, minArea, maxArea, candidates);
    }

    // 戦略3: Otsu 2値化（照明が均一な場合の最後の砦）
    if (!candidates.length) {
      const otsu = track(new cv.Mat());
      cv.threshold(gray, otsu, 0, 255, cv.THRESH_BINARY + cv.THRESH_OTSU);
      collectQuads(otsu, minArea, maxArea, candidates);
    }

    if (!candidates.length) return null;
    candidates.sort((a, b) => b.score - a.score);
    return candidates[0].quad;
  } finally {
    mats.forEach((m) => { try { m.delete(); } catch {} });
  }
}

// canvas から書類の四隅を検出
// 1. ML モデル（高精度）を最優先 → 2. 幾何学検出（高速・フォールバック）
// waitForMl: true なら未ロードのモデルを最大7秒待つ（静止画向け）。
// false ならロード済みの場合のみ ML を使う（ライブ表示向け）。
async function detectCorners(canvas, targetDim = 900, { waitForMl = false } = {}) {
  try {
    let session = mlSession;
    if (!session && waitForMl) {
      session = await Promise.race([
        loadMlSession(),
        new Promise((r) => setTimeout(() => r(null), 7000)),
      ]).catch(() => null);
    }
    if (session) {
      const q = await mlDetectCorners(canvas, session);
      if (q) return q;
    }
  } catch (e) {
    console.warn("ML detection failed, using classical fallback", e);
  }
  return classicalDetectCorners(canvas, targetDim);
}

// 幾何学ベースの検出（縮小＋黒縁パディングで検出→元座標へ戻す）
// 縁までいっぱいに写った書類も、パディングにより輪郭が閉じて検出できる
async function classicalDetectCorners(canvas, targetDim = 900) {
  await cvReady();
  const scale = Math.min(1, targetDim / Math.max(canvas.width, canvas.height));
  const pad = 6;
  const w = Math.round(canvas.width * scale);
  const h = Math.round(canvas.height * scale);
  const padded = document.createElement("canvas");
  padded.width = w + pad * 2;
  padded.height = h + pad * 2;
  const pctx = padded.getContext("2d");
  pctx.fillStyle = "#000";
  pctx.fillRect(0, 0, padded.width, padded.height);
  pctx.drawImage(canvas, pad, pad, w, h);

  let src = null;
  try {
    src = cv.imread(padded);
    // パディング境界（ほぼ画面全体の枠）は候補から除外する
    const maxArea = (padded.width - pad * 2 - 6) * (padded.height - pad * 2 - 6);
    const quad = findQuadInMat(src, padded.width, padded.height, maxArea);
    if (!quad) return null;
    const inv = 1 / scale;
    const res = {};
    for (const k of QUAD_KEYS) {
      if (!quad[k]) return null;
      res[k] = {
        x: Math.min(canvas.width, Math.max(0, (quad[k].x - pad) * inv)),
        y: Math.min(canvas.height, Math.max(0, (quad[k].y - pad) * inv)),
      };
    }
    // 妥当性チェック: 面積・辺の長さ
    if (quadArea(res) < canvas.width * canvas.height * 0.10) return null;
    const sides = [
      dist(res.topLeftCorner, res.topRightCorner),
      dist(res.topRightCorner, res.bottomRightCorner),
      dist(res.bottomRightCorner, res.bottomLeftCorner),
      dist(res.bottomLeftCorner, res.topLeftCorner),
    ];
    if (Math.min(...sides) < Math.max(canvas.width, canvas.height) * 0.08) return null;
    return res;
  } catch (e) {
    console.warn("detectCorners failed", e);
    return null;
  } finally {
    try { src && src.delete(); } catch {}
  }
}

function scaleQuad(q, f) {
  const r = {};
  for (const k of QUAD_KEYS) r[k] = { x: q[k].x * f, y: q[k].y * f };
  return r;
}

function blendQuad(a, b, w) {
  const r = {};
  for (const k of QUAD_KEYS) r[k] = { x: a[k].x * (1 - w) + b[k].x * w, y: a[k].y * (1 - w) + b[k].y * w };
  return r;
}

function quadsClose(a, b, tol) {
  return QUAD_KEYS.every((k) => Math.hypot(a[k].x - b[k].x, a[k].y - b[k].y) < tol);
}

function quadArea(c) {
  const p = [c.topLeftCorner, c.topRightCorner, c.bottomRightCorner, c.bottomLeftCorner];
  let a = 0;
  for (let i = 0; i < 4; i++) {
    const q = p[(i + 1) % 4];
    a += p[i].x * q.y - q.x * p[i].y;
  }
  return Math.abs(a / 2);
}

function fullCorners(canvas) {
  return {
    topLeftCorner: { x: 0, y: 0 },
    topRightCorner: { x: canvas.width, y: 0 },
    bottomLeftCorner: { x: 0, y: canvas.height },
    bottomRightCorner: { x: canvas.width, y: canvas.height },
  };
}

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

async function warpPaper(srcCanvas, corners) {
  const scanner = await getScanner();
  const w = Math.max(dist(corners.topLeftCorner, corners.topRightCorner), dist(corners.bottomLeftCorner, corners.bottomRightCorner));
  const h = Math.max(dist(corners.topLeftCorner, corners.bottomLeftCorner), dist(corners.topRightCorner, corners.bottomRightCorner));
  const cap = 2200;
  const s = Math.min(1, cap / Math.max(w, h));
  const outW = Math.max(200, Math.round(w * s));
  const outH = Math.max(200, Math.round(h * s));
  return scanner.extractPaper(srcCanvas, outW, outH, corners);
}

// ---------------------------------------------------------------------------
// 画質補正（影除去・コントラスト）
// ---------------------------------------------------------------------------
// 積分画像による高速ボックスブラー（グレースケール背景推定用）
function estimateBackground(gray, w, h, radius) {
  const integral = new Float64Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) {
    let rowSum = 0;
    for (let x = 0; x < w; x++) {
      rowSum += gray[y * w + x];
      integral[(y + 1) * (w + 1) + (x + 1)] = integral[y * (w + 1) + (x + 1)] + rowSum;
    }
  }
  const bg = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - radius), y1 = Math.min(h - 1, y + radius);
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - radius), x1 = Math.min(w - 1, x + radius);
      const sum = integral[(y1 + 1) * (w + 1) + (x1 + 1)] - integral[y0 * (w + 1) + (x1 + 1)]
                - integral[(y1 + 1) * (w + 1) + x0] + integral[y0 * (w + 1) + x0];
      bg[y * w + x] = sum / ((y1 - y0 + 1) * (x1 - x0 + 1));
    }
  }
  return bg;
}

function enhanceCanvas(canvas, mode) {
  if (mode === "photo") return canvas;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const d = img.data;
  const w = canvas.width, h = canvas.height, n = w * h;

  const gray = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    gray[i] = 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2];
  }
  const radius = Math.max(12, Math.round(Math.max(w, h) / 22));
  const bg = estimateBackground(gray, w, h, radius);

  const isWb = mode === "whiteboard";
  const gain = isWb ? 1.32 : 1.42;   // コントラスト（文字を濃く・背景を白く）
  const pivot = isWb ? 150 : 150;    // 中心
  const lift = isWb ? 14 : 8;        // 明るさ底上げ

  for (let i = 0; i < n; i++) {
    const b = Math.max(bg[i], 40);
    const ratio = 235 / b; // 影・照明ムラの除去（背景をほぼ白に）
    for (let c = 0; c < 3; c++) {
      let v = d[i * 4 + c] * ratio;
      v = (v - pivot) * gain + pivot + lift;
      d[i * 4 + c] = v < 0 ? 0 : v > 255 ? 255 : v;
    }
    if (isWb) {
      // ホワイトボードは彩度を少し下げてマーカーを読みやすく
      const avg = (d[i * 4] + d[i * 4 + 1] + d[i * 4 + 2]) / 3;
      for (let c = 0; c < 3; c++) {
        d[i * 4 + c] = d[i * 4 + c] * 0.82 + avg * 0.18;
      }
    }
  }

  // アンシャープマスク（文字の輪郭をくっきりさせる）
  const amount = isWb ? 0.55 : 0.85;
  const gray2 = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    gray2[i] = 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2];
  }
  const blur2 = estimateBackground(gray2, w, h, 2);
  for (let i = 0; i < n; i++) {
    const delta = (gray2[i] - blur2[i]) * amount;
    if (delta > 1 || delta < -1) {
      for (let c = 0; c < 3; c++) {
        const v = d[i * 4 + c] + delta;
        d[i * 4 + c] = v < 0 ? 0 : v > 255 ? 255 : v;
      }
    }
  }

  ctx.putImageData(img, 0, 0);
  return canvas;
}

function rotateCanvas(canvas, quarterTurns) {
  const t = ((quarterTurns % 4) + 4) % 4;
  if (t === 0) return canvas;
  const out = document.createElement("canvas");
  if (t === 2) { out.width = canvas.width; out.height = canvas.height; }
  else { out.width = canvas.height; out.height = canvas.width; }
  const ctx = out.getContext("2d");
  ctx.translate(out.width / 2, out.height / 2);
  ctx.rotate((Math.PI / 2) * t);
  ctx.drawImage(canvas, -canvas.width / 2, -canvas.height / 2);
  return out;
}

function downscaleCanvas(source, maxDim) {
  const scale = Math.min(1, maxDim / Math.max(source.width, source.height));
  if (scale >= 1) return source;
  const out = document.createElement("canvas");
  out.width = Math.round(source.width * scale);
  out.height = Math.round(source.height * scale);
  out.getContext("2d").drawImage(source, 0, 0, out.width, out.height);
  return out;
}

// ページの出力キャンバス（切り抜き→補正→回転）を生成
async function renderPage(page) {
  let base;
  if (page.mode === "photo" || !page.corners) {
    base = document.createElement("canvas");
    base.width = page.src.width; base.height = page.src.height;
    base.getContext("2d").drawImage(page.src, 0, 0);
    base = downscaleCanvas(base, 2200);
  } else {
    base = await warpPaper(page.src, page.corners);
  }
  enhanceCanvas(base, page.mode);
  page.out = rotateCanvas(base, page.rotation);
  return page.out;
}

// ---------------------------------------------------------------------------
// カメラ
// ---------------------------------------------------------------------------
let cameraLoopId = null;
// ライブ検出の状態（フレーム間スムージングで枠のちらつきを防ぐ）
const live = { quad: null, stable: 0, lastSeenAt: 0, lastDetectAt: 0, busy: false };

function resetLive() {
  live.quad = null;
  live.stable = 0;
  live.lastSeenAt = 0;
  live.lastDetectAt = 0;
  live.busy = false;
}

async function startCamera() {
  try {
    state.stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "environment", width: { ideal: 3200 }, height: { ideal: 2400 } },
      audio: false,
    });
  } catch (e) {
    toast("カメラを起動できませんでした。ブラウザのカメラ許可を確認するか、「カメラアプリ / 写真から選ぶ」をご利用ください", true, 4500);
    return false;
  }
  loadMlSession(); // ML モデルを未ロードなら読み込み開始（バックグラウンド）
  const video = $("video");
  video.srcObject = state.stream;
  await video.play().catch(() => {});
  setupTorch();
  showScreen("camera");
  $("camera-page-count").textContent = state.pages.length ? `${state.pages.length}ページ済` : "";
  resetLive();
  cameraLoop();
  return true;
}

function setupTorch() {
  const btn = $("btn-torch");
  btn.hidden = true;
  state.torchOn = false;
  btn.classList.remove("on");
  try {
    const track = state.stream && state.stream.getVideoTracks()[0];
    const caps = track && track.getCapabilities ? track.getCapabilities() : null;
    if (caps && caps.torch) {
      btn.hidden = false;
      btn.onclick = async () => {
        state.torchOn = !state.torchOn;
        try { await track.applyConstraints({ advanced: [{ torch: state.torchOn }] }); } catch {}
        btn.classList.toggle("on", state.torchOn);
      };
    }
  } catch {}
}

function cameraLoop() {
  const video = $("video");
  const canvas = $("camera-canvas");
  const ctx = canvas.getContext("2d");
  const step = async () => {
    if (!state.stream) return;
    if (video.videoWidth) {
      if (canvas.width !== video.videoWidth) {
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
      }
      ctx.drawImage(video, 0, 0);
      // ライブ輪郭検出（ML使用時は推論時間に応じて間隔を自動調整、結果はスムージング）
      const now = performance.now();
      const interval = mlSession ? Math.max(140, mlAvgMs * 1.3) : 110;
      const engineReady = mlSession || (window.cv && window.cv.Mat);
      if (!live.busy && now - live.lastDetectAt > interval && engineReady) {
        live.busy = true;
        live.lastDetectAt = now;
        const frame = downscaleCanvas(canvas, 420);
        const fx = canvas.width / frame.width;
        detectCorners(frame, 420).then((c) => {
          if (c) {
            const q = scaleQuad(c, fx);
            if (live.quad && quadsClose(live.quad, q, canvas.width * 0.08)) {
              // 前フレームと近い → なめらかに追従し、安定度を上げる
              live.quad = blendQuad(live.quad, q, 0.45);
              live.stable = Math.min(live.stable + 1, 10);
            } else {
              live.quad = q;
              live.stable = 1;
            }
            live.lastSeenAt = performance.now();
          } else if (performance.now() - live.lastSeenAt > 700) {
            // 0.7秒以上見失ったら枠を消す（瞬間的な検出抜けでは消さない）
            live.quad = null;
            live.stable = 0;
          }
        }).finally(() => { live.busy = false; });
      }
      if (live.quad && live.stable >= 2) drawQuad(ctx, live.quad, live.stable >= 4);
    }
    cameraLoopId = requestAnimationFrame(step);
  };
  cameraLoopId = requestAnimationFrame(step);
}

function drawQuad(ctx, c, locked = false) {
  ctx.save();
  // 安定して捉えている間は緑（撮影どき）、追従中は青
  ctx.strokeStyle = locked ? "rgba(34, 197, 94, .95)" : "rgba(59, 130, 246, .95)";
  ctx.fillStyle = locked ? "rgba(34, 197, 94, .16)" : "rgba(59, 130, 246, .14)";
  ctx.lineWidth = Math.max(3, ctx.canvas.width / 300);
  ctx.beginPath();
  ctx.moveTo(c.topLeftCorner.x, c.topLeftCorner.y);
  ctx.lineTo(c.topRightCorner.x, c.topRightCorner.y);
  ctx.lineTo(c.bottomRightCorner.x, c.bottomRightCorner.y);
  ctx.lineTo(c.bottomLeftCorner.x, c.bottomLeftCorner.y);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  const r = Math.max(6, ctx.canvas.width / 140);
  for (const k of QUAD_KEYS) {
    ctx.beginPath();
    ctx.arc(c[k].x, c[k].y, r, 0, Math.PI * 2);
    ctx.fillStyle = "#fff";
    ctx.fill();
    ctx.beginPath();
    ctx.arc(c[k].x, c[k].y, r * 0.55, 0, Math.PI * 2);
    ctx.fillStyle = locked ? "#16a34a" : "#2563eb";
    ctx.fill();
  }
  ctx.restore();
}

function stopCamera() {
  if (cameraLoopId) cancelAnimationFrame(cameraLoopId);
  cameraLoopId = null;
  if (state.stream) {
    state.stream.getTracks().forEach((t) => t.stop());
    state.stream = null;
  }
}

async function capturePhoto() {
  const video = $("video");
  if (!video.videoWidth) return;
  const shot = document.createElement("canvas");
  shot.width = video.videoWidth;
  shot.height = video.videoHeight;
  shot.getContext("2d").drawImage(video, 0, 0);
  // ライブ検出で安定して捉えていた枠を、静止画検出失敗時の予備として渡す
  const seed = live.quad && live.stable >= 2 ? live.quad : null;
  stopCamera();
  await addPageFromCanvas(shot, seed);
}

// ---------------------------------------------------------------------------
// ページ管理・プレビュー
// ---------------------------------------------------------------------------
async function addPageFromCanvas(srcCanvas, seedQuad = null) {
  showScreen("processing");
  setProcessing("画像を処理中...");
  const src = downscaleCanvas(srcCanvas, 2600);
  const prevMode = state.pages.length ? state.pages[state.pages.length - 1].mode : "document";
  let corners = prevMode === "photo" ? null : await detectCorners(src, 900, { waitForMl: true }).catch(() => null);
  // 静止画での検出に失敗したら、ライブ検出の安定枠を利用
  if (!corners && seedQuad && prevMode !== "photo") {
    corners = scaleQuad(seedQuad, src.width / srcCanvas.width);
  }
  const page = { src, corners, mode: prevMode, rotation: 0, out: null, autoCorners: corners };
  state.pages.push(page);
  state.currentPage = state.pages.length - 1;
  await renderPage(page);
  showPreview();
  if (prevMode !== "photo" && !corners) {
    toast("輪郭を自動検出できませんでした。「✂️ 範囲調整」で手動指定できます", false, 3800);
  }
}

function currentPage() { return state.pages[state.currentPage] || null; }

// ---------------------------------------------------------------------------
// プレビューのピンチズーム（ブレ確認用）
// ---------------------------------------------------------------------------
const pz = { scale: 1, tx: 0, ty: 0, pointers: new Map(), pinch: null, lastTap: 0 };

function pzApply() {
  $("preview-img").style.transform = `translate(${pz.tx}px, ${pz.ty}px) scale(${pz.scale})`;
}

function pzReset() {
  pz.scale = 1; pz.tx = 0; pz.ty = 0;
  pz.pointers.clear(); pz.pinch = null;
  pzApply();
}

function pzClamp() {
  const img = $("preview-img");
  const W = img.clientWidth, H = img.clientHeight;
  pz.scale = Math.min(6, Math.max(1, pz.scale));
  pz.tx = Math.min(0, Math.max(W - W * pz.scale, pz.tx));
  pz.ty = Math.min(0, Math.max(H - H * pz.scale, pz.ty));
}

function setupPreviewZoom() {
  const wrap = $("preview-zoom-wrap");

  wrap.addEventListener("pointerdown", (ev) => {
    wrap.setPointerCapture(ev.pointerId);
    pz.pointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
    if (pz.pointers.size === 2) {
      const [a, b] = [...pz.pointers.values()];
      pz.pinch = {
        dist: Math.hypot(a.x - b.x, a.y - b.y),
        scale: pz.scale, tx: pz.tx, ty: pz.ty,
        mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2,
      };
    } else if (pz.pointers.size === 1) {
      const now = Date.now();
      if (now - pz.lastTap < 320) {
        // ダブルタップ: 2.5倍 ⇔ 等倍
        const r = wrap.getBoundingClientRect();
        if (pz.scale > 1.01) {
          pz.scale = 1; pz.tx = 0; pz.ty = 0;
        } else {
          const s = 2.5;
          pz.tx = -(ev.clientX - r.left) * (s - 1);
          pz.ty = -(ev.clientY - r.top) * (s - 1);
          pz.scale = s;
          pzClamp();
        }
        pzApply();
        pz.lastTap = 0;
        return;
      }
      pz.lastTap = now;
    }
  });

  wrap.addEventListener("pointermove", (ev) => {
    const p = pz.pointers.get(ev.pointerId);
    if (!p) return;
    if (pz.pointers.size === 2 && pz.pinch) {
      p.x = ev.clientX; p.y = ev.clientY;
      const [a, b] = [...pz.pointers.values()];
      const distNow = Math.hypot(a.x - b.x, a.y - b.y);
      if (!distNow || !pz.pinch.dist) return;
      const r = wrap.getBoundingClientRect();
      const newScale = Math.min(6, Math.max(1, pz.pinch.scale * (distNow / pz.pinch.dist)));
      const kk = newScale / pz.pinch.scale;
      const mx = pz.pinch.mx - r.left, my = pz.pinch.my - r.top;
      pz.tx = mx - (mx - pz.pinch.tx) * kk;
      pz.ty = my - (my - pz.pinch.ty) * kk;
      pz.scale = newScale;
      pzClamp(); pzApply();
    } else if (pz.pointers.size === 1 && pz.scale > 1) {
      const dx = ev.clientX - p.x, dy = ev.clientY - p.y;
      p.x = ev.clientX; p.y = ev.clientY;
      pz.tx += dx; pz.ty += dy;
      pzClamp(); pzApply();
    }
  });

  const pzUp = (ev) => {
    pz.pointers.delete(ev.pointerId);
    if (pz.pointers.size < 2) pz.pinch = null;
  };
  wrap.addEventListener("pointerup", pzUp);
  wrap.addEventListener("pointercancel", pzUp);

  // デスクトップ: ホイールでもズーム可能
  wrap.addEventListener("wheel", (ev) => {
    ev.preventDefault();
    const r = wrap.getBoundingClientRect();
    const next = Math.min(6, Math.max(1, pz.scale * (ev.deltaY < 0 ? 1.15 : 1 / 1.15)));
    const kk = next / pz.scale;
    const mx = ev.clientX - r.left, my = ev.clientY - r.top;
    pz.tx = mx - (mx - pz.tx) * kk;
    pz.ty = my - (my - pz.ty) * kk;
    pz.scale = next;
    pzClamp(); pzApply();
  }, { passive: false });
}

function showPreview() {
  const page = currentPage();
  if (!page) { resetAll(); return; }
  pzReset();
  $("preview-img").src = page.out.toDataURL("image/jpeg", 0.85);
  document.querySelectorAll(".mode-btn").forEach((b) =>
    b.classList.toggle("active", b.dataset.mode === page.mode));
  renderThumbs();
  showScreen("preview");
}

function renderThumbs() {
  const wrap = $("page-thumbs");
  wrap.innerHTML = "";
  if (state.pages.length < 2) return;
  state.pages.forEach((p, i) => {
    const btn = document.createElement("button");
    btn.className = "page-thumb" + (i === state.currentPage ? " active" : "");
    const img = document.createElement("img");
    img.src = downscaleCanvas(p.out, 140).toDataURL("image/jpeg", 0.6);
    img.alt = `${i + 1}ページ目`;
    const num = document.createElement("span");
    num.className = "p-num";
    num.textContent = i + 1;
    btn.append(img, num);
    btn.addEventListener("click", () => { state.currentPage = i; showPreview(); });
    wrap.appendChild(btn);
  });
}

async function switchPageMode(mode) {
  const page = currentPage();
  if (!page || page.mode === mode) return;
  page.mode = mode;
  if (mode !== "photo" && !page.corners) {
    page.corners = page.autoCorners || (await detectCorners(page.src, 900, { waitForMl: true }).catch(() => null));
  }
  showScreen("processing");
  setProcessing("画像を処理中...");
  await renderPage(page);
  showPreview();
}

async function rotateCurrentPage() {
  const page = currentPage();
  if (!page) return;
  page.rotation = (page.rotation + 1) % 4;
  await renderPage(page);
  showPreview();
}

function deleteCurrentPage() {
  if (!state.pages.length) return;
  state.pages.splice(state.currentPage, 1);
  if (!state.pages.length) { resetAll(); return; }
  state.currentPage = Math.min(state.currentPage, state.pages.length - 1);
  showPreview();
}

async function handleFileInput(files) {
  if (!files || !files.length) return;
  showScreen("processing");
  setProcessing("画像を読み込み中...");
  try {
    for (const file of files) {
      const canvas = await loadImageCanvas(file);
      const src = downscaleCanvas(canvas, 2600);
      const corners = await detectCorners(src, 900, { waitForMl: true }).catch(() => null);
      state.pages.push({ src, corners, mode: "document", rotation: 0, out: null, autoCorners: corners });
    }
    for (const p of state.pages) if (!p.out) await renderPage(p);
    state.currentPage = state.pages.length - 1;
    showPreview();
  } catch (e) {
    console.error(e);
    toast("画像の読み込みに失敗しました", true);
    if (state.pages.length) showPreview(); else showScreen("home");
  }
}

function loadImageCanvas(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const c = document.createElement("canvas");
      c.width = img.naturalWidth; c.height = img.naturalHeight;
      c.getContext("2d").drawImage(img, 0, 0);
      URL.revokeObjectURL(url);
      resolve(c);
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("image load error")); };
    img.src = url;
  });
}

// ---------------------------------------------------------------------------
// 範囲調整（四隅ドラッグ）
// ---------------------------------------------------------------------------
const cropUI = { scale: 1, dragging: null, canvas: null, ctx: null };
const CORNER_KEYS = ["topLeftCorner", "topRightCorner", "bottomRightCorner", "bottomLeftCorner"];

function openCropEditor() {
  const page = currentPage();
  if (!page) return;
  if (page.mode === "photo") { toast("写真モードでは切り抜きを行いません。書類/ホワイトボードに切り替えてください"); return; }
  const src = page.src;
  const c = page.corners || page.autoCorners || fullCorners(src);
  state.cropDraft = JSON.parse(JSON.stringify(c));
  showScreen("crop");
  requestAnimationFrame(() => setupCropCanvas(page));
}

function setupCropCanvas(page) {
  const canvas = $("crop-canvas");
  const wrap = canvas.parentElement;
  const availW = Math.min(wrap.clientWidth || 320, 560);
  const availH = Math.max(240, Math.round(window.innerHeight * 0.56));
  const scale = Math.min(availW / page.src.width, availH / page.src.height);
  canvas.width = Math.round(page.src.width * scale);
  canvas.height = Math.round(page.src.height * scale);
  cropUI.scale = scale;
  cropUI.canvas = canvas;
  cropUI.ctx = canvas.getContext("2d");
  drawCrop(page);

  canvas.onpointerdown = (ev) => {
    const pos = cropPointerPos(ev);
    let best = null, bestD = 40; // 40px 以内のハンドルを掴む
    for (const k of CORNER_KEYS) {
      const p = state.cropDraft[k];
      const d = Math.hypot(p.x * cropUI.scale - pos.x, p.y * cropUI.scale - pos.y);
      if (d < bestD) { best = k; bestD = d; }
    }
    if (best) {
      cropUI.dragging = best;
      canvas.setPointerCapture(ev.pointerId);
      moveCropCorner(ev, page);
    }
  };
  canvas.onpointermove = (ev) => { if (cropUI.dragging) moveCropCorner(ev, page); };
  canvas.onpointerup = canvas.onpointercancel = () => {
    cropUI.dragging = null;
    $("crop-magnifier").style.display = "none";
    drawCrop(page);
  };
}

function cropPointerPos(ev) {
  const r = cropUI.canvas.getBoundingClientRect();
  return {
    x: (ev.clientX - r.left) * (cropUI.canvas.width / r.width),
    y: (ev.clientY - r.top) * (cropUI.canvas.height / r.height),
  };
}

function moveCropCorner(ev, page) {
  const pos = cropPointerPos(ev);
  const p = state.cropDraft[cropUI.dragging];
  p.x = Math.min(page.src.width, Math.max(0, pos.x / cropUI.scale));
  p.y = Math.min(page.src.height, Math.max(0, pos.y / cropUI.scale));
  drawCrop(page);
  drawMagnifier(page, p);
}

function drawCrop(page) {
  const { ctx, canvas } = cropUI;
  ctx.drawImage(page.src, 0, 0, canvas.width, canvas.height);
  const s = cropUI.scale;
  const c = state.cropDraft;
  // 半透明マスク
  ctx.save();
  ctx.fillStyle = "rgba(15, 23, 42, .55)";
  ctx.beginPath();
  ctx.rect(0, 0, canvas.width, canvas.height);
  ctx.moveTo(c.topLeftCorner.x * s, c.topLeftCorner.y * s);
  ctx.lineTo(c.bottomLeftCorner.x * s, c.bottomLeftCorner.y * s);
  ctx.lineTo(c.bottomRightCorner.x * s, c.bottomRightCorner.y * s);
  ctx.lineTo(c.topRightCorner.x * s, c.topRightCorner.y * s);
  ctx.closePath();
  ctx.fill("evenodd");
  ctx.restore();
  // 枠線とハンドル
  ctx.save();
  ctx.strokeStyle = "#3b82f6";
  ctx.lineWidth = 2.5;
  ctx.beginPath();
  ctx.moveTo(c.topLeftCorner.x * s, c.topLeftCorner.y * s);
  for (const k of ["topRightCorner", "bottomRightCorner", "bottomLeftCorner"]) ctx.lineTo(c[k].x * s, c[k].y * s);
  ctx.closePath();
  ctx.stroke();
  for (const k of CORNER_KEYS) {
    ctx.beginPath();
    ctx.arc(c[k].x * s, c[k].y * s, 11, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(255,255,255,.95)";
    ctx.fill();
    ctx.beginPath();
    ctx.arc(c[k].x * s, c[k].y * s, 6.5, 0, Math.PI * 2);
    ctx.fillStyle = "#2563eb";
    ctx.fill();
  }
  ctx.restore();
}

function drawMagnifier(page, srcPoint) {
  const mag = $("crop-magnifier");
  mag.style.display = "block";
  const mctx = mag.getContext("2d");
  const zoom = 2.4, half = 60 / zoom;
  mctx.fillStyle = "#fff";
  mctx.fillRect(0, 0, 120, 120);
  mctx.drawImage(page.src,
    srcPoint.x - half, srcPoint.y - half,
    half * 2, half * 2, 0, 0, 120, 120);
  mctx.strokeStyle = "#ef4444";
  mctx.lineWidth = 1.5;
  mctx.beginPath(); mctx.moveTo(60, 44); mctx.lineTo(60, 76); mctx.stroke();
  mctx.beginPath(); mctx.moveTo(44, 60); mctx.lineTo(76, 60); mctx.stroke();
}

async function applyCrop() {
  const page = currentPage();
  if (!page || !state.cropDraft) return;
  page.corners = state.cropDraft;
  state.cropDraft = null;
  showScreen("processing");
  setProcessing("画像を処理中...");
  await renderPage(page);
  showPreview();
}

// ---------------------------------------------------------------------------
// Claude 解析
// ---------------------------------------------------------------------------
const PROPOSAL_SCHEMA = {
  type: "object",
  properties: {
    doc_summary: { type: "string", description: "書類の内容の要約（1〜2文）" },
    doc_date: { type: "string", description: "書類上の日付 YYYY-MM-DD。不明なら空文字" },
    title: { type: "string", description: "書類のタイトル（日本語、ファイル名に使う）" },
    filename: { type: "string", description: "ネーミングルールに従ったファイル名（.pdf まで含む）" },
    destination_folder: { type: "string", description: "フォルダ一覧の中から選んだ最適な保存先パス。一覧のパスを一字一句そのままコピーすること" },
    reason: { type: "string", description: "そのフォルダを選んだ理由（日本語1〜2文）" },
    alternative_folders: { type: "array", items: { type: "string" }, description: "次点の候補フォルダパス（最大2つ、一覧から選ぶ）" },
    new_folder_suggestion: { type: "string", description: "既存フォルダが合わない場合の新規フォルダ名の提案（例: 2026-06-10 ○○）。不要なら空文字" },
  },
  required: ["doc_summary", "doc_date", "title", "filename", "destination_folder", "reason", "alternative_folders", "new_folder_suggestion"],
  additionalProperties: false,
};

function buildAnalysisPrompt(folderList) {
  const rules = state.docRules || {};
  const today = todayStr();
  return `あなたは書類整理の専門アシスタントです。添付したスキャン画像（複数枚の場合は同じ書類の連続ページ）を読み取り、propose_filing ツールで整理案を1件提出してください。

# 手順
1. 書類の内容を読み取り、要約する（doc_summary）
2. 書類上の日付を探す（doc_date）。請求日・発行日・開催日など書類の主たる日付を YYYY-MM-DD で。見つからなければ空文字にし、ファイル名にはスキャン日（今日）を使う
3. ネーミングルールに従ってファイル名を生成する（形式: 「YYYY-MM-DD タイトル.pdf」。日付とタイトルの間は半角スペース）
4. 下記のフォルダ一覧（実際の Dropbox 構成）から最適な保存先を 1 つ選び、理由と次点候補も挙げる
   - destination_folder と alternative_folders は必ず一覧にあるパスを一字一句そのままコピーすること
   - どのフォルダにもフィットしない場合は、最も近い親フォルダを destination_folder にして new_folder_suggestion に新規フォルダ名を提案すること（日付プレフィックス「YYYY-MM-DD 案件名」形式）
5. 振り分けルール（routes）のキーワードに合致する場合はその destination を最優先で検討すること

# 今日の日付
${today}

# ネーミングルール（doc_rules.json）
${JSON.stringify(rules.naming ?? {}, null, 1)}
${JSON.stringify(rules.folder_naming ?? {}, null, 1)}

# 振り分けルール（routes）
${JSON.stringify(rules.routes ?? [], null, 1)}

# 選択されたカテゴリ
${state.category}

# フォルダ一覧（実際の Dropbox 構成・この中から選ぶ）
${folderList.join("\n")}`;
}

async function callClaude(imageBlocks, prompt, signal) {
  return withRetry(async () => {
    let res;
    try {
      res = await fetch(ANTHROPIC_URL, {
        method: "POST",
        signal,
        headers: {
          "x-api-key": settings.anthropicKey.trim(),
          "anthropic-version": "2023-06-01",
          "anthropic-dangerous-direct-browser-access": "true",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: settings.model,
          max_tokens: 1600,
          tools: [{
            name: "propose_filing",
            description: "スキャンした書類の整理案（ファイル名・保存先フォルダ）を提出する",
            input_schema: PROPOSAL_SCHEMA,
          }],
          tool_choice: { type: "tool", name: "propose_filing" },
          messages: [{
            role: "user",
            content: [...imageBlocks, { type: "text", text: prompt }],
          }],
        }),
      });
    } catch (e) {
      if (e.name === "AbortError") throw e;
      throw networkError(e);
    }
    if (!res.ok) {
      const body = await res.text();
      if (res.status === 401) throw new Error("Anthropic API キーが正しくありません。設定を確認してください");
      if (res.status === 400 && body.includes("credit")) throw new Error("Anthropic API のクレジットが不足しています");
      throw httpError(res.status, `AI 解析エラー (${res.status})`);
    }
    const data = await res.json();
    const tool = (data.content || []).find((b) => b.type === "tool_use");
    if (!tool || !tool.input) throw new Error("AI から有効な提案が得られませんでした");
    return tool.input;
  }, { tries: 3, label: "AI が書類を解析中..." });
}

function inboxForCategory() {
  const inbox = state.docRules?.inbox || {};
  if (state.category === "/00 仕事") return inbox.work_inbox || "/00 仕事/00 Temporary";
  if (state.category === "/01 Private") return inbox.private_inbox || "/01 Private/Temporary";
  return inbox.fallback || "/整理フォルダ/Scans";
}

async function analyzeDocument() {
  if (!settings.anthropicKey) {
    toast("Anthropic API キーが未設定です。設定画面から入力してください", true);
    openSettings();
    return;
  }
  showScreen("processing");
  const cancelBtn = document.querySelector(".processing-cancel");
  cancelBtn.hidden = true;
  const abort = new AbortController();
  state.analyzeAbort = abort;
  const showCancelTimer = setTimeout(() => { cancelBtn.hidden = false; }, 6000);

  try {
    // 1. フォルダ一覧（キャッシュ付き）
    setProcessing("Dropbox のフォルダ構成を取得中...");
    let folderList = [];
    try {
      folderList = await fetchFolderTree(state.category);
      const inbox = inboxForCategory();
      if (!folderList.includes(inbox)) folderList.push(inbox);
    } catch (e) {
      console.warn("folder tree failed", e);
      folderList = [state.category, inboxForCategory()];
    }

    // 2. 画像ブロック（最大5ページ・長辺1568px）
    setProcessing("AI が書類を解析中...");
    const imageBlocks = state.pages.slice(0, 5).map((p) => {
      const small = downscaleCanvas(p.out, 1568);
      const dataUrl = small.toDataURL("image/jpeg", 0.85);
      return {
        type: "image",
        source: { type: "base64", media_type: "image/jpeg", data: dataUrl.split(",")[1] },
      };
    });

    // 3. Claude 呼び出し
    const proposal = await callClaude(imageBlocks, buildAnalysisPrompt(folderList), abort.signal);

    // 4. 提案の検証・補正
    proposal.filename = sanitizeFilename(proposal.filename || `${todayStr()} スキャン.pdf`);
    proposal.destination_folder = nfc(proposal.destination_folder || inboxForCategory());
    proposal.alternative_folders = (proposal.alternative_folders || []).slice(0, 2).map(nfc);
    proposal.new_folder_suggestion = nfc(proposal.new_folder_suggestion || "");
    state.proposal = proposal;

    setProcessing("保存先を確認中...");
    await showProposal();
  } catch (e) {
    console.error(e);
    if (e.name === "AbortError") {
      showPreview();
      toast("解析をキャンセルしました");
    } else {
      // フォールバック: 受信箱への手動保存を提案
      state.proposal = {
        doc_summary: "",
        doc_date: "",
        title: "スキャン",
        filename: `${todayStr()} スキャン.pdf`,
        destination_folder: inboxForCategory(),
        reason: `AI 解析に失敗したため、いったん受信箱に保存する案を表示しています（${e.message || "エラー"}）。ファイル名は編集できます。`,
        alternative_folders: [],
        new_folder_suggestion: "",
        _fallback: true,
      };
      await showProposal();
      toast("AI 解析に失敗しました: " + (e.message || ""), true, 4500);
    }
  } finally {
    clearTimeout(showCancelTimer);
    cancelBtn.hidden = true;
    state.analyzeAbort = null;
  }
}

// ---------------------------------------------------------------------------
// 提案画面
// ---------------------------------------------------------------------------
async function setProposalFolder(path, { checkExists = true } = {}) {
  state.proposal.destination_folder = nfc(path);
  state.isNewFolder = false;
  if (checkExists) {
    try { state.isNewFolder = !(await dbxFolderExists(path)); }
    catch { state.isNewFolder = false; }
  }
  renderProposalFolder();
}

function proposalFullFolder() {
  const p = state.proposal;
  if (p.new_folder_suggestion) {
    return p.destination_folder.replace(/\/$/, "") + "/" + p.new_folder_suggestion;
  }
  return p.destination_folder;
}

function renderProposalFolder() {
  const el = $("proposal-folder");
  const p = state.proposal;
  const full = proposalFullFolder();
  const isNew = state.isNewFolder || !!p.new_folder_suggestion;
  el.classList.toggle("new-folder", isNew);
  el.textContent = full + (isNew ? "\n（新しいフォルダを作成して保存します）" : "");
}

async function showProposal() {
  const p = state.proposal;
  $("proposal-summary").textContent = p.doc_summary || "";
  $("proposal-filename").value = p.filename;
  $("proposal-reason").textContent = p.reason || "";
  const alts = $("proposal-alternatives");
  alts.innerHTML = "";
  for (const alt of p.alternative_folders || []) {
    if (!alt || alt === p.destination_folder) continue;
    const b = document.createElement("button");
    b.className = "alt-btn";
    b.textContent = alt;
    b.addEventListener("click", async () => {
      p.new_folder_suggestion = "";
      await setProposalFolder(alt);
    });
    alts.appendChild(b);
  }
  // 保存先の存在チェック（new_folder_suggestion がある場合はチェック不要）
  if (p.new_folder_suggestion) {
    state.isNewFolder = true;
    renderProposalFolder();
  } else {
    await setProposalFolder(p.destination_folder);
  }
  showScreen("proposal");
}

// ---------------------------------------------------------------------------
// PDF 生成・保存
// ---------------------------------------------------------------------------
function buildPdfBlob() {
  const { jsPDF } = window.jspdf;
  const pdf = new jsPDF({ unit: "mm", format: "a4", compress: true });
  const A4W = 210, A4H = 297;
  state.pages.forEach((page, i) => {
    if (i > 0) pdf.addPage("a4", page.out.width > page.out.height ? "l" : "p");
    else if (page.out.width > page.out.height) {
      pdf.deletePage(1);
      pdf.addPage("a4", "l");
    }
    const pw = page.out.width > page.out.height ? A4H : A4W;
    const ph = page.out.width > page.out.height ? A4W : A4H;
    const scale = Math.min(pw / page.out.width, ph / page.out.height);
    const w = page.out.width * scale, h = page.out.height * scale;
    const dataUrl = page.out.toDataURL("image/jpeg", 0.92);
    pdf.addImage(dataUrl, "JPEG", (pw - w) / 2, (ph - h) / 2, w, h);
  });
  if (state.proposal) {
    pdf.setProperties({
      title: state.proposal.filename.replace(/\.pdf$/i, ""),
      subject: state.proposal.doc_summary || "",
      creator: "書類スキャン v" + APP_VERSION,
    });
  }
  return pdf.output("blob");
}

async function saveToDropbox() {
  if (state.saving) return;
  const filename = sanitizeFilename($("proposal-filename").value);
  if (!filename || filename === ".pdf") { toast("ファイル名を入力してください", true); return; }
  state.saving = true;
  showScreen("processing");
  setProcessing("PDF を作成中...");
  try {
    const folder = nfc(proposalFullFolder());
    const blob = buildPdfBlob();
    setProcessing("Dropbox に保存中...");
    if (state.isNewFolder || state.proposal.new_folder_suggestion) {
      await dbxEnsureFolder(folder);
    }
    const meta = await dbxUpload(`${folder}/${filename}`, blob);
    // 履歴に記録
    addHistory({
      ts: Date.now(),
      name: meta.name || filename,
      path: meta.path_display || `${folder}/${filename}`,
      pages: state.pages.length,
      summary: state.proposal?.doc_summary || "",
    });
    $("done-detail").textContent = `${meta.path_display || folder + "/" + filename}\n（${state.pages.length}ページ / ${(blob.size / 1024 / 1024).toFixed(1)}MB）`;
    showScreen("done");
  } catch (e) {
    console.error(e);
    toast("保存に失敗しました: " + (e.message || "") + "\nデータは保持されています。もう一度お試しください", true, 5000);
    showScreen("proposal"); // データを失わず提案画面に戻る
  } finally {
    state.saving = false;
  }
}

// ---------------------------------------------------------------------------
// フォルダブラウザ
// ---------------------------------------------------------------------------
async function openBrowser(startPath) {
  state.browserPath = startPath || state.category || "";
  showScreen("browser");
  await renderBrowser();
}

async function renderBrowser() {
  $("browser-path").textContent = state.browserPath || "/";
  const listEl = $("browser-list");
  listEl.innerHTML = '<li class="empty">読み込み中...</li>';
  try {
    const folders = await dbxListSubfolders(state.browserPath);
    listEl.innerHTML = "";
    if (!folders.length) {
      listEl.innerHTML = '<li class="empty">サブフォルダはありません</li>';
      return;
    }
    for (const f of folders) {
      const li = document.createElement("li");
      li.textContent = "📁 " + f.split("/").pop();
      li.addEventListener("click", () => { state.browserPath = f; renderBrowser(); });
      listEl.appendChild(li);
    }
  } catch (e) {
    listEl.innerHTML = '<li class="empty">読み込みに失敗しました</li>';
    toast(e.message || "フォルダ一覧の取得に失敗しました", true);
  }
}

function browserUp() {
  if (!state.browserPath || state.browserPath === "/") return;
  const parent = state.browserPath.replace(/\/[^/]+$/, "");
  state.browserPath = parent || "";
  renderBrowser();
}

async function createNewFolder() {
  const name = prompt("新しいフォルダ名（例: " + todayStr() + " 案件名）");
  if (!name) return;
  const path = state.browserPath.replace(/\/$/, "") + "/" + nfc(name.trim());
  try {
    await dbxEnsureFolder(path);
    state.browserPath = path;
    await renderBrowser();
    toast("フォルダを作成しました");
  } catch (e) {
    toast("フォルダ作成に失敗しました: " + (e.message || ""), true);
  }
}

async function chooseBrowserFolder() {
  state.proposal.new_folder_suggestion = "";
  await setProposalFolder(state.browserPath, { checkExists: false });
  state.isNewFolder = false;
  renderProposalFolder();
  showScreen("proposal");
}

// ---------------------------------------------------------------------------
// 履歴
// ---------------------------------------------------------------------------
function getHistory() {
  try { return JSON.parse(localStorage.getItem(LS_HISTORY) || "[]"); }
  catch { return []; }
}

function addHistory(entry) {
  const list = getHistory();
  list.unshift(entry);
  try { localStorage.setItem(LS_HISTORY, JSON.stringify(list.slice(0, 20))); } catch {}
}

function renderHistory() {
  const wrap = $("home-history");
  wrap.innerHTML = "";
  const list = getHistory().slice(0, 5);
  if (!list.length) return;
  const title = document.createElement("p");
  title.className = "history-title";
  title.textContent = "最近の保存";
  wrap.appendChild(title);
  for (const h of list) {
    const div = document.createElement("div");
    div.className = "history-item";
    const d = new Date(h.ts);
    const time = `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    div.innerHTML = `<div class="h-name"></div><div class="h-path"></div><div class="h-time"></div>`;
    div.querySelector(".h-name").textContent = "📄 " + h.name;
    div.querySelector(".h-path").textContent = h.path.replace(/\/[^/]+$/, "");
    div.querySelector(".h-time").textContent = `${time} ・ ${h.pages}ページ`;
    wrap.appendChild(div);
  }
}

// ---------------------------------------------------------------------------
// ホーム・設定
// ---------------------------------------------------------------------------
function refreshHomeStatus() {
  const el = $("home-status");
  const okAnthropic = !!settings.anthropicKey;
  const okDropbox = !!settings.tokens;
  el.innerHTML = "";
  const line1 = document.createElement("span");
  line1.className = okAnthropic ? "ok" : "warn";
  line1.textContent = okAnthropic ? "✅ Anthropic API: 設定済み" : "⚠️ Anthropic API キー未設定（設定 ⚙️ から入力）";
  const line2 = document.createElement("span");
  line2.className = okDropbox ? "ok" : "warn";
  line2.textContent = okDropbox ? "✅ Dropbox: 接続済み" : "⚠️ Dropbox 未接続（設定 ⚙️ から接続）";
  el.append(line1, document.createTextNode("\n"), line2);
  if (!navigator.onLine) {
    const off = document.createElement("span");
    off.className = "warn";
    off.textContent = "📴 オフラインです（解析・保存にはネット接続が必要）";
    el.append(document.createTextNode("\n"), off);
  }
  renderHistory();
}

function openSettings() {
  $("setting-anthropic-key").value = settings.anthropicKey;
  $("setting-dropbox-key").value = settings.dropboxAppKey;
  $("setting-model").value = settings.model;
  const st = $("dropbox-status");
  if (settings.tokens) {
    st.textContent = "✅ Dropbox 接続済み";
    st.classList.add("connected");
  } else {
    st.textContent = "未接続です。アプリキーを保存してから「Dropbox と接続する」を押してください";
    st.classList.remove("connected");
  }
  $("version-note").textContent = `書類スキャン v${APP_VERSION}`;
  showScreen("settings");
}

function saveSettings() {
  settings.anthropicKey = $("setting-anthropic-key").value.trim();
  settings.dropboxAppKey = $("setting-dropbox-key").value.trim();
  settings.model = $("setting-model").value;
  toast("設定を保存しました");
  refreshHomeStatus();
  openSettings();
}

// ---------------------------------------------------------------------------
// リセット
// ---------------------------------------------------------------------------
function resetAll() {
  stopCamera();
  state.pages = [];
  state.currentPage = 0;
  state.category = null;
  state.proposal = null;
  state.isNewFolder = false;
  state.cropDraft = null;
  $("file-input").value = "";
  refreshHomeStatus();
  showScreen("home");
}

// ---------------------------------------------------------------------------
// イベント配線
// ---------------------------------------------------------------------------
function wireEvents() {
  setupPreviewZoom();
  $("btn-scan").addEventListener("click", async () => {
    await cvReady().catch((e) => toast(e.message, true));
    startCamera();
  });
  $("btn-scan-file").addEventListener("click", () => $("file-input").click());
  $("file-input").addEventListener("change", (e) => handleFileInput(e.target.files));
  $("btn-shutter").addEventListener("click", capturePhoto);

  document.querySelectorAll(".mode-btn").forEach((b) =>
    b.addEventListener("click", () => switchPageMode(b.dataset.mode)));
  document.querySelectorAll(".cat-btn").forEach((b) =>
    b.addEventListener("click", () => {
      state.category = b.dataset.category;
      analyzeDocument();
    }));

  document.addEventListener("click", async (ev) => {
    const btn = ev.target.closest("[data-action]");
    if (!btn) return;
    const action = btn.dataset.action;
    switch (action) {
      case "open-settings": openSettings(); break;
      case "close-settings":
        if (state.proposal) showScreen("proposal");
        else if (state.pages.length) showPreview();
        else { refreshHomeStatus(); showScreen("home"); }
        break;
      case "save-settings": saveSettings(); break;
      case "dropbox-connect": dropboxStartAuth(); break;
      case "clear-folder-cache": clearFolderCache(); break;
      case "cancel-camera": stopCamera(); state.pages.length ? showPreview() : resetAll(); break;
      case "abort-to-home":
        if (confirm("スキャンを破棄してホームに戻りますか？")) resetAll();
        break;
      case "retake": {
        state.pages.splice(state.currentPage, 1);
        startCamera();
        break;
      }
      case "add-page": startCamera(); break;
      case "delete-page":
        if (confirm("このページを削除しますか？")) deleteCurrentPage();
        break;
      case "rotate": rotateCurrentPage(); break;
      case "edit-crop": openCropEditor(); break;
      case "crop-cancel": state.cropDraft = null; showPreview(); break;
      case "crop-apply": applyCrop(); break;
      case "crop-reset": {
        const page = currentPage();
        state.cropDraft = JSON.parse(JSON.stringify(page.autoCorners || fullCorners(page.src)));
        drawCrop(page);
        break;
      }
      case "crop-full": {
        const page = currentPage();
        state.cropDraft = fullCorners(page.src);
        drawCrop(page);
        break;
      }
      case "to-category":
        if (!settings.tokens) {
          toast("Dropbox が未接続です。設定から接続してください", true);
          openSettings();
          break;
        }
        showScreen("category");
        break;
      case "back-preview": showPreview(); break;
      case "processing-cancel": state.analyzeAbort?.abort(); break;
      case "approve-save": saveToDropbox(); break;
      case "change-folder": openBrowser(state.proposal?.destination_folder || state.category); break;
      case "browser-up": browserUp(); break;
      case "browser-new": createNewFolder(); break;
      case "browser-choose": chooseBrowserFolder(); break;
      case "browser-back": showScreen("proposal"); break;
      case "cancel-all":
        if (confirm("スキャンを破棄してホームに戻りますか？")) resetAll();
        break;
      case "go-home": resetAll(); break;
      case "scan-again": {
        state.pages = [];
        state.currentPage = 0;
        state.proposal = null;
        startCamera();
        break;
      }
    }
  });

  window.addEventListener("online", refreshHomeStatus);
  window.addEventListener("offline", refreshHomeStatus);
  window.addEventListener("pagehide", stopCamera);
}

// ---------------------------------------------------------------------------
// 初期化
// ---------------------------------------------------------------------------
async function init() {
  wireEvents();
  refreshHomeStatus();

  // PWA
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }

  // Dropbox OAuth リダイレクト処理
  await dropboxHandleRedirect();

  // 命名・振り分けルール読み込み
  try {
    const res = await fetch("doc_rules.json", { cache: "no-store" });
    state.docRules = await res.json();
  } catch (e) {
    console.warn("doc_rules.json load failed", e);
    state.docRules = null;
  }

  // ML 四隅検出モデルを事前ロード（ページ表示を妨げないよう少し遅らせる）
  setTimeout(() => loadMlSession(), 1500);
}

init();
