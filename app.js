// 書類スキャンアプリ
// カメラ撮影（輪郭自動検出）→ カテゴリ選択 → Claude で OCR・命名・フォルダ提案 → 承認 → Dropbox に PDF 保存

import Anthropic from "https://esm.sh/@anthropic-ai/sdk";

// ---------------------------------------------------------------------------
// 状態・設定
// ---------------------------------------------------------------------------

const state = {
  pages: [],          // 補正済みページ画像の dataURL (image/jpeg)
  pageSources: [],    // ページごとの原本・検出した角・モード
  category: null,     // "/00 仕事" or "/01 Private"
  proposal: null,     // Claude の提案結果
  browsePath: null,   // フォルダブラウザの現在地
  docRules: null,
};

const settings = {
  get anthropicKey() { return localStorage.getItem("anthropic_api_key") || ""; },
  set anthropicKey(v) { localStorage.setItem("anthropic_api_key", v); },
  get dropboxAppKey() { return localStorage.getItem("dropbox_app_key") || ""; },
  set dropboxAppKey(v) { localStorage.setItem("dropbox_app_key", v); },
  get dropboxTokens() {
    try { return JSON.parse(localStorage.getItem("dropbox_tokens")) || null; } catch { return null; }
  },
  set dropboxTokens(v) {
    if (v) localStorage.setItem("dropbox_tokens", JSON.stringify(v));
    else localStorage.removeItem("dropbox_tokens");
  },
};

const $ = (sel) => document.querySelector(sel);

function showScreen(id) {
  document.querySelectorAll(".screen").forEach((s) => s.classList.remove("active"));
  $(id).classList.add("active");
}

// ---------------------------------------------------------------------------
// Dropbox API (OAuth PKCE + files API)
// ---------------------------------------------------------------------------

const DBX_AUTH_URL = "https://www.dropbox.com/oauth2/authorize";
const DBX_TOKEN_URL = "https://api.dropboxapi.com/oauth2/token";

function base64UrlEncode(bytes) {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function dropboxStartAuth() {
  const appKey = settings.dropboxAppKey;
  if (!appKey) { alert("先に Dropbox アプリキーを入力・保存してください"); return; }
  const verifierBytes = crypto.getRandomValues(new Uint8Array(48));
  const verifier = base64UrlEncode(verifierBytes);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  const challenge = base64UrlEncode(new Uint8Array(digest));
  sessionStorage.setItem("dbx_code_verifier", verifier);
  const redirectUri = location.origin + location.pathname;
  const params = new URLSearchParams({
    client_id: appKey,
    response_type: "code",
    code_challenge: challenge,
    code_challenge_method: "S256",
    redirect_uri: redirectUri,
    token_access_type: "offline",
  });
  location.href = `${DBX_AUTH_URL}?${params}`;
}

async function dropboxHandleRedirect() {
  const code = new URLSearchParams(location.search).get("code");
  if (!code) return;
  const verifier = sessionStorage.getItem("dbx_code_verifier");
  history.replaceState(null, "", location.pathname); // URL から code を消す
  if (!verifier) return;
  const body = new URLSearchParams({
    code,
    grant_type: "authorization_code",
    code_verifier: verifier,
    client_id: settings.dropboxAppKey,
    redirect_uri: location.origin + location.pathname,
  });
  const res = await fetch(DBX_TOKEN_URL, { method: "POST", body });
  if (!res.ok) { alert("Dropbox 認証に失敗しました: " + (await res.text())); return; }
  const tok = await res.json();
  settings.dropboxTokens = {
    access_token: tok.access_token,
    refresh_token: tok.refresh_token,
    expires_at: Date.now() + tok.expires_in * 1000,
  };
  sessionStorage.removeItem("dbx_code_verifier");
  alert("Dropbox と接続しました");
}

async function dropboxAccessToken() {
  let tok = settings.dropboxTokens;
  if (!tok) throw new Error("Dropbox 未接続です。設定画面から接続してください。");
  if (Date.now() > tok.expires_at - 60_000) {
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: tok.refresh_token,
      client_id: settings.dropboxAppKey,
    });
    const res = await fetch(DBX_TOKEN_URL, { method: "POST", body });
    if (!res.ok) {
      settings.dropboxTokens = null;
      throw new Error("Dropbox トークン更新に失敗しました。再接続してください。");
    }
    const refreshed = await res.json();
    tok = { ...tok, access_token: refreshed.access_token, expires_at: Date.now() + refreshed.expires_in * 1000 };
    settings.dropboxTokens = tok;
  }
  return tok.access_token;
}

async function dbxRpc(endpoint, body) {
  const token = await dropboxAccessToken();
  const res = await fetch(`https://api.dropboxapi.com/2/${endpoint}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Dropbox API エラー (${endpoint}): ${await res.text()}`);
  return res.json();
}

// Dropbox-API-Arg ヘッダは非 ASCII を \uXXXX エスケープする必要がある
function httpHeaderSafeJson(v) {
  return JSON.stringify(v).replace(/[\u007f-\uffff]/g, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));
}

async function dbxUpload(path, blob) {
  const token = await dropboxAccessToken();
  const res = await fetch("https://content.dropboxapi.com/2/files/upload", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/octet-stream",
      "Dropbox-API-Arg": httpHeaderSafeJson({ path, mode: "add", autorename: true, mute: true }),
    },
    body: blob,
  });
  if (!res.ok) throw new Error("アップロードに失敗しました: " + (await res.text()));
  return res.json();
}

async function dbxListSubfolders(path) {
  const folders = [];
  let resp = await dbxRpc("files/list_folder", { path, recursive: false });
  for (;;) {
    for (const e of resp.entries) {
      if (e[".tag"] === "folder") folders.push({ name: e.name, path: e.path_display });
    }
    if (!resp.has_more) break;
    resp = await dbxRpc("files/list_folder/continue", { cursor: resp.cursor });
  }
  folders.sort((a, b) => a.name.localeCompare(b.name, "ja"));
  return folders;
}

// 提案用にカテゴリ配下のフォルダツリーを取得（深さ制限つき BFS）
async function fetchFolderTree(rootPath, maxDepth = 2, maxFolders = 350) {
  // ルート直下はエラーを握りつぶさず投げる（権限不足・未接続をここで早期検出する）
  const rootFolders = await dbxListSubfolders(rootPath);
  const lines = [];
  let queue = [];
  let count = 0;
  for (const f of rootFolders) {
    if (count >= maxFolders) break;
    lines.push(f.path);
    count++;
    queue.push({ path: f.path, depth: 1, name: f.name });
  }
  while (queue.length && count < maxFolders) {
    const batch = queue.splice(0, 6);
    const results = await Promise.all(
      batch.map((item) => dbxListSubfolders(item.path).catch(() => []))
    );
    for (let i = 0; i < batch.length; i++) {
      const parent = batch[i];
      for (const f of results[i]) {
        if (count >= maxFolders) break;
        lines.push("  ".repeat(parent.depth) + f.path);
        count++;
        // 通常は maxDepth まで。「過去の資料検索」配下の年度フォルダは 1 階層深く展開する
        const limit = parent.name === "過去の資料検索" ? maxDepth + 1 : maxDepth;
        if (parent.depth + 1 < limit) {
          queue.push({ path: f.path, depth: parent.depth + 1, name: f.name });
        }
      }
    }
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// カメラ・輪郭検出（jscanify / OpenCV.js）
// ---------------------------------------------------------------------------

let videoStream = null;
let overlayTimer = null;
let scanner = null;

function cvReady() {
  return window.__cvLoaded && window.cv && typeof window.cv.imread === "function";
}

function getScanner() {
  if (!scanner && typeof window.jscanify === "function" && cvReady()) scanner = new window.jscanify();
  return scanner;
}

async function startCamera() {
  showScreen("#screen-camera");
  $("#camera-page-count").textContent = state.pages.length ? `${state.pages.length}枚目まで撮影済` : "";
  const video = $("#video");
  try {
    videoStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "environment", width: { ideal: 1920 }, height: { ideal: 1080 } },
      audio: false,
    });
  } catch (e) {
    alert("カメラを起動できませんでした。「カメラアプリ / 写真から選ぶ」をご利用ください。\n" + e.message);
    showScreen("#screen-home");
    return;
  }
  video.srcObject = videoStream;
  await video.play();

  const canvas = $("#camera-canvas");
  const work = document.createElement("canvas");
  const loop = () => {
    if (!videoStream) return;
    if (video.videoWidth) {
      // 表示は縮小して輪郭ハイライトを描画（性能優先）
      const scale = 640 / video.videoWidth;
      work.width = 640;
      work.height = Math.round(video.videoHeight * scale);
      work.getContext("2d").drawImage(video, 0, 0, work.width, work.height);
      canvas.width = work.width;
      canvas.height = work.height;
      const ctx = canvas.getContext("2d");
      const sc = getScanner();
      if (sc) {
        try {
          ctx.drawImage(sc.highlightPaper(work, { color: "#34a853", thickness: 6 }), 0, 0);
        } catch {
          ctx.drawImage(work, 0, 0);
        }
      } else {
        ctx.drawImage(work, 0, 0);
      }
    }
    overlayTimer = setTimeout(loop, 180);
  };
  loop();
}

function stopCamera() {
  if (overlayTimer) { clearTimeout(overlayTimer); overlayTimer = null; }
  if (videoStream) { videoStream.getTracks().forEach((t) => t.stop()); videoStream = null; }
}

function capturePhoto() {
  const video = $("#video");
  if (!video.videoWidth) return;
  const full = document.createElement("canvas");
  full.width = video.videoWidth;
  full.height = video.videoHeight;
  full.getContext("2d").drawImage(video, 0, 0);
  stopCamera();
  addPageFromCanvas(full);
}

// ---------------------------------------------------------------------------
// 書類輪郭の検出（OpenCV 直接利用・複数前処理で最良の四角形を選ぶ）
// ---------------------------------------------------------------------------

function downscaleCanvas(canvas, maxLong) {
  const long = Math.max(canvas.width, canvas.height);
  if (long <= maxLong) return canvas;
  const s = maxLong / long;
  const out = document.createElement("canvas");
  out.width = Math.round(canvas.width * s);
  out.height = Math.round(canvas.height * s);
  const ctx = out.getContext("2d");
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(canvas, 0, 0, out.width, out.height);
  return out;
}

function orderCorners(pts) {
  const sum = (p) => p.x + p.y;
  const diff = (p) => p.y - p.x;
  return {
    topLeftCorner: pts.reduce((a, b) => (sum(a) < sum(b) ? a : b)),
    bottomRightCorner: pts.reduce((a, b) => (sum(a) > sum(b) ? a : b)),
    topRightCorner: pts.reduce((a, b) => (diff(a) < diff(b) ? a : b)),
    bottomLeftCorner: pts.reduce((a, b) => (diff(a) > diff(b) ? a : b)),
  };
}

// Canny（閾値2種）＋大津の二値化の3通りで輪郭を探し、
// 「画面の2割以上を占める凸の四角形」のうち最大のものを採用する
function detectDocumentCorners(canvas) {
  if (!cvReady()) return null;
  const cv = window.cv;
  const small = downscaleCanvas(canvas, 800);
  const scale = canvas.width / small.width;
  let src, gray;
  const candidates = [];
  try {
    src = cv.imread(small);
    gray = new cv.Mat();
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
    cv.GaussianBlur(gray, gray, new cv.Size(5, 5), 0);

    const variants = [
      () => {
        const m = new cv.Mat();
        cv.Canny(gray, m, 50, 150);
        const k = cv.Mat.ones(3, 3, cv.CV_8U);
        cv.dilate(m, m, k);
        k.delete();
        return m;
      },
      () => {
        const m = new cv.Mat();
        cv.Canny(gray, m, 25, 80);
        const k = cv.Mat.ones(3, 3, cv.CV_8U);
        cv.dilate(m, m, k);
        k.delete();
        return m;
      },
      () => {
        const m = new cv.Mat();
        cv.threshold(gray, m, 0, 255, cv.THRESH_BINARY + cv.THRESH_OTSU);
        return m;
      },
    ];

    const minArea = small.width * small.height * 0.2;
    for (const make of variants) {
      const bin = make();
      const contours = new cv.MatVector();
      const hier = new cv.Mat();
      cv.findContours(bin, contours, hier, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);
      for (let i = 0; i < contours.size(); i++) {
        const c = contours.get(i);
        const area = cv.contourArea(c);
        if (area > minArea) {
          const approx = new cv.Mat();
          cv.approxPolyDP(c, approx, 0.02 * cv.arcLength(c, true), true);
          if (approx.rows === 4 && cv.isContourConvex(approx)) {
            const pts = [];
            for (let j = 0; j < 4; j++) pts.push({ x: approx.data32S[j * 2], y: approx.data32S[j * 2 + 1] });
            candidates.push({ pts, area });
          }
          approx.delete();
        }
        c.delete();
      }
      contours.delete();
      hier.delete();
      bin.delete();
    }
  } catch (e) {
    console.warn("輪郭検出エラー:", e);
    return null;
  } finally {
    src?.delete();
    gray?.delete();
  }
  if (!candidates.length) return null;
  candidates.sort((a, b) => b.area - a.area);
  const pts = candidates[0].pts.map((p) => ({ x: p.x * scale, y: p.y * scale }));
  return orderCorners(pts);
}

// ---------------------------------------------------------------------------
// 画質補正（モード別）
// ---------------------------------------------------------------------------

// コントラスト・明るさのピクセル補正（CSS filter 非対応ブラウザでも動く）
function adjustPixels(canvas, contrast, brightness) {
  const ctx = canvas.getContext("2d");
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    for (let k = 0; k < 3; k++) {
      const v = (d[i + k] - 128) * contrast + 128 + brightness;
      d[i + k] = v < 0 ? 0 : v > 255 ? 255 : v;
    }
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

// 縮小→拡大による近似ブラー（背景推定用）
function blurApprox(canvas, factor) {
  const small = document.createElement("canvas");
  small.width = Math.max(1, Math.round(canvas.width / factor));
  small.height = Math.max(1, Math.round(canvas.height / factor));
  small.getContext("2d").drawImage(canvas, 0, 0, small.width, small.height);
  const out = document.createElement("canvas");
  out.width = canvas.width;
  out.height = canvas.height;
  const ctx = out.getContext("2d");
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(small, 0, 0, out.width, out.height);
  return out;
}

// ホワイトボード補正: 推定背景で除算して背景を白く飛ばし、ペン字を強調する
function whiteboardEnhance(canvas) {
  const bg = blurApprox(canvas, 24);
  const ctx = canvas.getContext("2d");
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const bgImg = bg.getContext("2d").getImageData(0, 0, canvas.width, canvas.height);
  const d = img.data, b = bgImg.data;
  for (let i = 0; i < d.length; i += 4) {
    for (let k = 0; k < 3; k++) {
      const v = (255 * d[i + k]) / Math.max(b[i + k], 1);
      d[i + k] = v > 255 ? 255 : v;
    }
  }
  ctx.putImageData(img, 0, 0);
  return adjustPixels(canvas, 1.3, 0);
}

// ---------------------------------------------------------------------------
// ページの取り込みとモード別処理
// ---------------------------------------------------------------------------

const PAGE_MODES = {
  document: { label: "📄 書類", crop: true },
  whiteboard: { label: "🖥 ホワイトボード", crop: true },
  photo: { label: "🖼 写真", crop: false },
};

function loadImageCanvas(dataUrl) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement("canvas");
      c.width = img.naturalWidth;
      c.height = img.naturalHeight;
      c.getContext("2d").drawImage(img, 0, 0);
      resolve(c);
    };
    img.src = dataUrl;
  });
}

// 原本＋検出した角＋モードから、最終ページ画像（dataURL）を生成する
async function processSource(source) {
  const original = await loadImageCanvas(source.originalDataUrl);
  let canvas = original;
  let cropped = false;
  if (PAGE_MODES[source.mode].crop && source.corners) {
    const c = source.corners;
    const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
    const w = Math.round(Math.max(dist(c.topLeftCorner, c.topRightCorner), dist(c.bottomLeftCorner, c.bottomRightCorner)));
    const h = Math.round(Math.max(dist(c.topLeftCorner, c.bottomLeftCorner), dist(c.topRightCorner, c.bottomRightCorner)));
    const sc = getScanner();
    if (sc && w > original.width * 0.3 && h > original.height * 0.3) {
      try {
        canvas = sc.extractPaper(original, w, h, c);
        cropped = true;
      } catch (e) {
        console.warn("台形補正に失敗:", e);
      }
    }
  }
  canvas = downscaleCanvas(canvas, 2000);
  if (source.mode === "document") adjustPixels(canvas, 1.12, 6);
  else if (source.mode === "whiteboard") whiteboardEnhance(canvas);
  source.cropped = cropped;
  return canvas.toDataURL("image/jpeg", 0.85);
}

async function addPageFromCanvas(srcCanvas) {
  const original = downscaleCanvas(srcCanvas, 2400);
  const source = {
    originalDataUrl: original.toDataURL("image/jpeg", 0.92),
    corners: detectDocumentCorners(original),
    mode: "document",
  };
  state.pageSources.push(source);
  state.pages.push(await processSource(source));
  showPreview();
}

async function switchPageMode(mode) {
  const idx = state.pageSources.length - 1;
  if (idx < 0 || !PAGE_MODES[mode]) return;
  const source = state.pageSources[idx];
  if (source.mode === mode) return;
  source.mode = mode;
  $("#preview-note").textContent = "処理中...";
  state.pages[idx] = await processSource(source);
  showPreview();
}

function showPreview() {
  const idx = state.pages.length - 1;
  const source = state.pageSources[idx];
  $("#preview-img").src = state.pages[idx];
  document.querySelectorAll(".mode-btn").forEach((b) => {
    b.classList.toggle("active", b.dataset.mode === source.mode);
  });
  let note = `${state.pages.length} ページ / モード: ${PAGE_MODES[source.mode].label}`;
  if (PAGE_MODES[source.mode].crop) {
    note += source.cropped ? "（輪郭を自動補正済み）" : "（輪郭を検出できず元画像のまま）";
  }
  $("#preview-note").textContent = note;
  showScreen("#screen-preview");
}

function handleFileInput(file) {
  const img = new Image();
  img.onload = () => {
    const c = document.createElement("canvas");
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    c.getContext("2d").drawImage(img, 0, 0);
    URL.revokeObjectURL(img.src);
    addPageFromCanvas(c);
  };
  img.src = URL.createObjectURL(file);
}

// ---------------------------------------------------------------------------
// Claude による OCR・命名・フォルダ提案
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

async function analyzeDocument() {
  if (!settings.anthropicKey) throw new Error("Anthropic API キーが未設定です。設定画面から登録してください。");

  $("#processing-status").textContent = "Dropbox のフォルダ構成を取得中...";
  const tree = await fetchFolderTree(state.category);

  if (!state.docRules) {
    state.docRules = await fetch("./doc_rules.json").then((r) => r.json()).catch(() => null);
  }

  $("#processing-status").textContent = "書類を読み取り中（OCR・命名・フォルダ提案）...";

  const client = new Anthropic({
    apiKey: settings.anthropicKey,
    dangerouslyAllowBrowser: true,
    defaultHeaders: { "anthropic-dangerous-direct-browser-access": "true" },
  });

  const today = new Date().toLocaleDateString("sv-SE"); // YYYY-MM-DD
  const imageBlocks = state.pages.slice(0, 3).map((dataUrl) => ({
    type: "image",
    source: { type: "base64", media_type: "image/jpeg", data: dataUrl.split(",")[1] },
  }));

  const prompt = `あなたは書類整理アシスタントです。添付したスキャン書類の画像を読み取り、次を行ってください。

1. 書類の内容を OCR で読み取り、要約する
2. 書類上の日付を特定する（なければ空文字。ファイル名には今日の日付 ${today} を使う）
3. ネーミングルールに従ってファイル名を生成する（形式: 「YYYY-MM-DD タイトル.pdf」。日付とタイトルの間は半角スペース）
4. 下記のフォルダ一覧（実際の Dropbox 構成）から最適な保存先を 1 つ選び、理由と次点候補も挙げる
   - destination_folder と alternative_folders は必ず一覧にあるパスを一字一句そのままコピーすること
   - どのフォルダにもフィットしない場合は、最も近い親フォルダを destination_folder にして new_folder_suggestion に新規フォルダ名を提案すること（日付プレフィックス「YYYY-MM-DD 案件名」形式）

# 今日の日付
${today}

# ネーミングルール（doc_rules.json）
${JSON.stringify(state.docRules?.naming ?? {}, null, 1)}
${JSON.stringify(state.docRules?.folder_naming ?? {}, null, 1)}

# 選択されたカテゴリ
${state.category}

# フォルダ一覧（実際の Dropbox 構成）
${state.category}
${tree}`;

  const response = await client.messages.create({
    model: "claude-opus-4-8",
    max_tokens: 16000,
    thinking: { type: "adaptive" },
    output_config: { format: { type: "json_schema", schema: PROPOSAL_SCHEMA } },
    messages: [{ role: "user", content: [...imageBlocks, { type: "text", text: prompt }] }],
  });

  const text = response.content.find((b) => b.type === "text")?.text;
  if (!text) throw new Error("Claude から応答を取得できませんでした");
  return JSON.parse(text);
}

// 保存先フォルダの実在チェックつき表示。存在しない場合は赤くして「新規作成されます」と明記する
let folderCheckSeq = 0;

async function dbxFolderExists(path) {
  try {
    const meta = await dbxRpc("files/get_metadata", { path: path.normalize("NFC") });
    return meta[".tag"] === "folder";
  } catch {
    return false;
  }
}

async function setProposalFolder(path) {
  state.proposal.destination_folder = path;
  const el = $("#proposal-folder");
  el.classList.remove("new-folder");
  el.textContent = `${path}（確認中...）`;
  const seq = ++folderCheckSeq;
  const exists = await dbxFolderExists(path);
  if (seq !== folderCheckSeq) return; // 確認中に別のフォルダへ切り替えられた
  if (exists) {
    el.textContent = path;
  } else {
    el.classList.add("new-folder");
    el.textContent = `${path}\n⚠️ このフォルダは存在しません。保存時に新規作成されます`;
  }
}

function showProposal(p) {
  state.proposal = p;
  $("#proposal-filename").value = p.filename.normalize("NFC");
  setProposalFolder(p.destination_folder);
  let reason = p.reason || "";
  if (p.doc_summary) reason = `📝 ${p.doc_summary}\n${reason}`;
  if (p.new_folder_suggestion) {
    reason += `\n💡 新規フォルダ「${p.new_folder_suggestion}」の作成をおすすめします（「フォルダを変更する」→「＋新規フォルダ」で作成できます）`;
  }
  $("#proposal-reason").textContent = reason;

  const altWrap = $("#proposal-alternatives");
  altWrap.innerHTML = "";
  (p.alternative_folders || []).slice(0, 2).forEach((alt) => {
    const btn = document.createElement("button");
    btn.className = "alt-btn";
    btn.textContent = alt;
    btn.onclick = () => setProposalFolder(alt);
    altWrap.appendChild(btn);
  });
  showScreen("#screen-proposal");
}

// ---------------------------------------------------------------------------
// PDF 生成と保存
// ---------------------------------------------------------------------------

async function buildPdfBlob() {
  const { jsPDF } = window.jspdf;
  const pdf = new jsPDF({ unit: "mm", format: "a4", compress: true });
  const pageW = 210, pageH = 297;
  for (let i = 0; i < state.pages.length; i++) {
    if (i > 0) pdf.addPage();
    const dim = await new Promise((resolve) => {
      const img = new Image();
      img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight });
      img.src = state.pages[i];
    });
    const scale = Math.min(pageW / dim.w, pageH / dim.h);
    const w = dim.w * scale, h = dim.h * scale;
    pdf.addImage(state.pages[i], "JPEG", (pageW - w) / 2, (pageH - h) / 2, w, h);
  }
  return pdf.output("blob");
}

async function saveToDropbox() {
  let filename = $("#proposal-filename").value.trim().normalize("NFC");
  if (!filename) { alert("ファイル名を入力してください"); return; }
  if (!filename.toLowerCase().endsWith(".pdf")) filename += ".pdf";
  const folder = state.proposal.destination_folder.normalize("NFC");

  showScreen("#screen-processing");
  $("#processing-status").textContent = "PDF を作成して Dropbox に保存中...";
  try {
    const blob = await buildPdfBlob();
    const result = await dbxUpload(`${folder}/${filename}`, blob);
    addHistory({
      ts: new Date().toISOString(),
      filename: result.name,
      path: result.path_display,
      pages: state.pages.length,
      sizeKB: Math.round(blob.size / 1024),
    });
    $("#done-detail").textContent = `${result.path_display}\n（${state.pages.length} ページ / ${Math.round(blob.size / 1024)} KB）`;
    showScreen("#screen-done");
  } catch (e) {
    alert(e.message);
    showScreen("#screen-proposal");
  }
}

// ---------------------------------------------------------------------------
// 実施履歴（localStorage に保存）
// ---------------------------------------------------------------------------

function loadHistory() {
  try { return JSON.parse(localStorage.getItem("scan_history")) || []; } catch { return []; }
}

function addHistory(entry) {
  const h = loadHistory();
  h.unshift(entry);
  localStorage.setItem("scan_history", JSON.stringify(h.slice(0, 200)));
}

function renderHistory() {
  const list = $("#history-list");
  const items = loadHistory();
  list.innerHTML = "";
  if (!items.length) {
    list.innerHTML = "<li class='empty'>まだ履歴はありません</li>";
    return;
  }
  for (const it of items) {
    const li = document.createElement("li");
    li.className = "history-item";
    const when = new Date(it.ts).toLocaleString("ja-JP", {
      year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
    });
    const folder = it.path.replace(/\/[^/]+$/, "") || "/";

    const whenDiv = document.createElement("div");
    whenDiv.className = "history-when";
    whenDiv.textContent = `${when}・${it.pages}ページ・${it.sizeKB}KB`;

    const nameDiv = document.createElement("div");
    nameDiv.className = "history-name";
    nameDiv.textContent = `📄 ${it.filename}`;

    const pathDiv = document.createElement("div");
    pathDiv.className = "history-path";
    pathDiv.textContent = `📁 ${folder}`;

    const link = document.createElement("a");
    link.className = "history-link";
    link.target = "_blank";
    link.rel = "noopener";
    link.textContent = "Dropboxでフォルダを開く ↗";
    link.href = "https://www.dropbox.com/home" + folder.split("/").map(encodeURIComponent).join("/");

    li.append(whenDiv, nameDiv, pathDiv, link);
    list.appendChild(li);
  }
}

// ---------------------------------------------------------------------------
// フォルダブラウザ
// ---------------------------------------------------------------------------

async function openBrowser(path) {
  state.browsePath = path.normalize("NFC");
  $("#browser-path").textContent = state.browsePath;
  const list = $("#browser-list");
  list.innerHTML = "<li class='empty'>読み込み中...</li>";
  showScreen("#screen-browser");
  try {
    const folders = await dbxListSubfolders(state.browsePath);
    list.innerHTML = "";
    if (!folders.length) list.innerHTML = "<li class='empty'>サブフォルダはありません</li>";
    for (const f of folders) {
      const li = document.createElement("li");
      li.textContent = `📁 ${f.name}`;
      li.onclick = () => openBrowser(f.path);
      list.appendChild(li);
    }
  } catch (e) {
    list.innerHTML = `<li class='empty'>${e.message}</li>`;
  }
}

async function createNewFolder() {
  const today = new Date().toLocaleDateString("sv-SE");
  const suggested = state.proposal?.new_folder_suggestion || `${today} `;
  const name = prompt("新規フォルダ名（推奨: YYYY-MM-DD 案件名）", suggested);
  if (!name) return;
  try {
    const res = await dbxRpc("files/create_folder_v2", { path: `${state.browsePath}/${name.trim().normalize("NFC")}` });
    await openBrowser(res.metadata.path_display);
  } catch (e) {
    alert("フォルダ作成に失敗しました: " + e.message);
  }
}

// ---------------------------------------------------------------------------
// 画面遷移・イベント
// ---------------------------------------------------------------------------

function resetAll() {
  state.pages = [];
  state.pageSources = [];
  state.category = null;
  state.proposal = null;
  stopCamera();
}

function refreshHomeStatus() {
  const lines = [];
  lines.push(settings.anthropicKey ? "✅ Anthropic API キー設定済み" : "⚠️ Anthropic API キー未設定（⚙️ 設定へ）");
  lines.push(settings.dropboxTokens ? "✅ Dropbox 接続済み" : "⚠️ Dropbox 未接続（⚙️ 設定へ）");
  $("#home-status").textContent = lines.join("\n");
}

function refreshSettingsScreen() {
  $("#setting-anthropic-key").value = settings.anthropicKey;
  $("#setting-dropbox-key").value = settings.dropboxAppKey;
  const st = $("#dropbox-status");
  if (settings.dropboxTokens) {
    st.textContent = "✅ Dropbox 接続済み";
    st.classList.add("connected");
  } else {
    st.textContent = "未接続です。アプリキーを保存してから「Dropbox と接続する」を押してください。";
    st.classList.remove("connected");
  }
}

let settingsReturnScreen = "#screen-home";

function openSettings() {
  const current = document.querySelector(".screen.active");
  if (current && current.id !== "screen-settings") settingsReturnScreen = `#${current.id}`;
  refreshSettingsScreen();
  showScreen("#screen-settings");
}

// 入力欄からフォーカスが外れた時点で自動保存（保存ボタンの押し忘れ・画面遷移による消失を防ぐ）
function persistSettingInputs() {
  settings.anthropicKey = $("#setting-anthropic-key").value.trim();
  settings.dropboxAppKey = $("#setting-dropbox-key").value.trim();
}

document.addEventListener("click", async (ev) => {
  const action = ev.target.closest("[data-action]")?.dataset.action;
  const category = ev.target.closest("[data-category]")?.dataset.category;
  const mode = ev.target.closest("[data-mode]")?.dataset.mode;

  if (mode) {
    await switchPageMode(mode);
    return;
  }

  if (category) {
    state.category = category;
    showScreen("#screen-processing");
    try {
      const proposal = await analyzeDocument();
      showProposal(proposal);
    } catch (e) {
      alert(e.message);
      if (!settings.anthropicKey || !settings.dropboxTokens) {
        settingsReturnScreen = "#screen-category";
        refreshSettingsScreen();
        showScreen("#screen-settings");
      } else {
        showScreen("#screen-category");
      }
    }
    return;
  }

  switch (action) {
    case "open-settings": openSettings(); break;
    case "close-settings": refreshHomeStatus(); showScreen(settingsReturnScreen); break;
    case "save-settings":
      persistSettingInputs();
      refreshSettingsScreen();
      alert("保存しました");
      break;
    case "dropbox-connect":
      persistSettingInputs(); // リダイレクト前に両方のキーを保存しておく
      await dropboxStartAuth();
      break;
    case "cancel-camera": stopCamera(); state.pages.length ? showPreview(true) : showScreen("#screen-home"); break;
    case "retake": state.pages.pop(); state.pageSources.pop(); startCamera(); break;
    case "add-page": startCamera(); break;
    case "to-category": showScreen("#screen-category"); break;
    case "back-preview": showScreen("#screen-preview"); break;
    case "approve-save": await saveToDropbox(); break;
    case "change-folder": await openBrowser(state.proposal?.destination_folder || state.category); break;
    case "browser-up": {
      const parent = state.browsePath.replace(/\/[^/]+$/, "");
      if (state.browsePath !== state.category) await openBrowser(parent || state.category);
      break;
    }
    case "browser-new": await createNewFolder(); break;
    case "browser-choose":
      setProposalFolder(state.browsePath);
      showScreen("#screen-proposal");
      break;
    case "browser-back": showScreen("#screen-proposal"); break;
    case "cancel-all": resetAll(); refreshHomeStatus(); showScreen("#screen-home"); break;
    case "open-history": renderHistory(); showScreen("#screen-history"); break;
    case "history-home": refreshHomeStatus(); showScreen("#screen-home"); break;
    case "history-clear":
      if (confirm("実施履歴をすべて削除しますか？（Dropbox上のファイルは削除されません）")) {
        localStorage.removeItem("scan_history");
        renderHistory();
      }
      break;
    case "abort-to-home":
      if (state.pages.length && !confirm("スキャンした画像を破棄してホームに戻りますか？")) break;
      resetAll();
      refreshHomeStatus();
      showScreen("#screen-home");
      break;
    case "go-home": resetAll(); refreshHomeStatus(); showScreen("#screen-home"); break;
  }
});

$("#setting-anthropic-key").addEventListener("change", persistSettingInputs);
$("#setting-dropbox-key").addEventListener("change", persistSettingInputs);

$("#btn-scan").addEventListener("click", () => startCamera());
$("#btn-shutter").addEventListener("click", () => capturePhoto());
$("#btn-scan-file").addEventListener("click", () => $("#file-input").click());
$("#file-input").addEventListener("change", (ev) => {
  const file = ev.target.files[0];
  ev.target.value = "";
  if (file) handleFileInput(file);
});

// 起動処理
(async function init() {
  await dropboxHandleRedirect();
  refreshHomeStatus();
})();
