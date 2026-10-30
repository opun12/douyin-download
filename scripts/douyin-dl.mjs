#!/usr/bin/env node
/**
 * douyin-dl.mjs — 抖音视频完整下载（无水印直链，非录屏、非切片）
 *
 * 原理：用本地 Chromium 真实打开抖音视频页，让页面自己完成 __ac / s_v_web_id 验证，
 * 然后从播放器网络请求里取到该视频的完整 mp4 直链（douyinvod），带同一套 Cookie 拉全量文件；
 * 下载后用 ffprobe 校验时长，若拿到的是预览小片会自动换下一个候选重下。
 *
 * 用法：
 *   node douyin-dl.mjs "复制这条链接 7.43 abc:/ https://v.douyin.com/xxxx/"
 *   node douyin-dl.mjs --out "D:/素材" <链接或分享文本> [更多链接...]
 *   node douyin-dl.mjs --headed <链接>        # 显示浏览器窗口，便于排查
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..');

// puppeteer-core 从「本仓库 / 当前目录」的 node_modules 解析，也可用 PUPPETEER_BASE 指向别处
const REQUIRE_BASES = [
  process.env.PUPPETEER_BASE,
  path.join(REPO_ROOT, 'package.json'),
  path.join(process.cwd(), 'package.json'),
].filter(Boolean);

function loadPuppeteer() {
  const tried = [];
  for (const base of REQUIRE_BASES) {
    try {
      const req = createRequire(base);
      return req('puppeteer-core');
    } catch (e) {
      tried.push(`${base} (${e.code || e.message})`);
    }
  }
  throw new Error(
    `找不到 puppeteer-core，请先在项目目录执行 npm install。已尝试：\n - ${tried.join('\n - ')}`
  );
}

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 按平台枚举可用的 Chrome / Edge / Chromium；CHROME_PATH 优先级最高 */
function chromeCandidates() {
  const list = [process.env.CHROME_PATH];
  const pf = process.env.PROGRAMFILES || 'C:/Program Files';
  const pf86 = process.env['PROGRAMFILES(X86)'] || 'C:/Program Files (x86)';
  const localApp =
    process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');

  if (process.platform === 'win32') {
    list.push(
      path.join(pf, 'Google/Chrome/Application/chrome.exe'),
      path.join(pf86, 'Google/Chrome/Application/chrome.exe'),
      path.join(localApp, 'Google/Chrome/Application/chrome.exe'),
      path.join(pf, 'Microsoft/Edge/Application/msedge.exe'),
      path.join(pf86, 'Microsoft/Edge/Application/msedge.exe')
    );
    // Playwright 自带的 Chromium（版本号目录按新到旧）
    const pwDir = path.join(localApp, 'ms-playwright');
    try {
      const dirs = fs
        .readdirSync(pwDir)
        .filter((d) => d.startsWith('chromium-'))
        .sort()
        .reverse();
      for (const d of dirs) {
        list.push(path.join(pwDir, d, 'chrome-win64', 'chrome.exe'));
        list.push(path.join(pwDir, d, 'chrome-win', 'chrome.exe'));
      }
    } catch {}
  } else if (process.platform === 'darwin') {
    list.push(
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'
    );
  } else {
    list.push(
      '/usr/bin/google-chrome',
      '/usr/bin/google-chrome-stable',
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser',
      '/snap/bin/chromium'
    );
  }
  return list.filter(Boolean);
}

function findChrome() {
  const candidates = chromeCandidates();
  for (const p of candidates) if (fs.existsSync(p)) return p;
  throw new Error(
    `找不到 Chrome / Edge / Chromium。请安装 Chrome，或用 CHROME_PATH 环境变量指定浏览器路径。已尝试：\n - ${candidates.join('\n - ')}`
  );
}

function sanitize(name, max = 50) {
  return (
    String(name || '')
      .replace(/[\u0000-\u001f<>:"/\\|?*\n\r\t]/g, ' ')
      .replace(/#[^\s#]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, max) || ''
  );
}

function pickUrl(text) {
  const m = String(text).match(/https?:\/\/[^\s，,。"'）)]+/);
  return m ? m[0] : String(text).trim();
}

function extractAwemeId(url) {
  for (const re of [
    /\/video\/(\d{15,25})/,
    /\/note\/(\d{15,25})/,
    /[?&]modal_id=(\d{15,25})/,
    /\/share\/video\/(\d{15,25})/,
  ]) {
    const m = url.match(re);
    if (m) return m[1];
  }
  return null;
}

async function expandUrl(url) {
  let cur = url;
  for (let i = 0; i < 6; i++) {
    const res = await fetch(cur, {
      method: 'GET',
      redirect: 'manual',
      headers: { 'User-Agent': UA },
    });
    const loc = res.headers.get('location');
    if ([301, 302, 303, 307, 308].includes(res.status) && loc) {
      cur = new URL(loc, cur).href;
      continue;
    }
    break;
  }
  return cur;
}

async function normalizeInput(raw) {
  const url = pickUrl(raw);
  if (!/^https?:\/\//.test(url)) throw new Error(`输入里没有可用链接：${raw}`);
  if (extractAwemeId(url)) return url;
  const expanded = await expandUrl(url);
  const id = extractAwemeId(expanded);
  if (!id) throw new Error(`无法解析视频 ID：${expanded}`);
  return `https://www.douyin.com/video/${id}`;
}

function probeDuration(file) {
  return new Promise((resolve) => {
    execFile(
      'ffprobe',
      ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file],
      { timeout: 30000 },
      (err, stdout) => resolve(err ? 0 : parseFloat(String(stdout).trim()) || 0)
    );
  });
}

function ffprobeInfo(file) {
  return new Promise((resolve) => {
    execFile(
      'ffprobe',
      ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file],
      { timeout: 60000 },
      (err, stdout) => {
        if (err) return resolve(null);
        try {
          const j = JSON.parse(stdout);
          const streams = j.streams || [];
          resolve({
            duration: parseFloat(j.format?.duration || 0) || 0,
            hasAudio: streams.some((s) => s.codec_type === 'audio'),
            hasVideo: streams.some((s) => s.codec_type === 'video'),
            audioDuration: parseFloat(
              streams.find((s) => s.codec_type === 'audio')?.duration || 0
            ) || 0,
          });
        } catch {
          resolve(null);
        }
      }
    );
  });
}

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 300000 }, (err, _o, stderr) =>
      err ? reject(new Error(`${cmd} 失败: ${String(stderr).slice(0, 300)}`)) : resolve()
    );
  });
}

/**
 * 抖音网页播放器是 DASH 分离流：抓到的 mp4 只有画面。
 * 这里再拉一条 media-audio 音轨，用 ffmpeg 无损封装回单文件。
 */
async function attachAudio(videoPath, audioUrls, cookieHeader, expectedDur) {
  const info = await ffprobeInfo(videoPath);
  if (info?.hasAudio) return { merged: false, reason: '已有音轨' };
  if (!audioUrls.length) return { merged: false, reason: '页面没给出音轨' };

  const audioPath = videoPath.replace(/\.mp4$/i, '') + '.audio.m4a';
  for (const [i, url] of audioUrls.slice(0, 4).entries()) {
    try {
      const { tmp } = await downloadTo(url, audioPath, cookieHeader);
      const a = await ffprobeInfo(tmp);
      if (!a?.hasAudio) {
        await fsp.rm(tmp, { force: true });
        continue;
      }
      const muxTmp = videoPath + '.mux.mp4';
      await run('ffmpeg', [
        '-v', 'error', '-y',
        '-i', videoPath,
        '-i', tmp,
        '-map', '0:v:0',
        '-map', '1:a:0',
        '-c', 'copy',
        '-shortest',
        muxTmp,
      ]);
      await fsp.rm(videoPath, { force: true });
      await fsp.rename(muxTmp, videoPath);
      await fsp.rm(tmp, { force: true });
      return { merged: true, audioDuration: a.duration || expectedDur };
    } catch (e) {
      await fsp.rm(audioPath + '.part', { force: true }).catch(() => {});
      if (i === Math.min(audioUrls.length, 4) - 1) {
        return { merged: false, reason: e.message };
      }
    }
  }
  return { merged: false, reason: '音轨候选都不可用' };
}

async function downloadTo(url, filePath, cookieHeader) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': UA,
      Referer: 'https://www.douyin.com/',
      Cookie: cookieHeader,
      Accept: '*/*',
    },
    redirect: 'follow',
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const total = Number(res.headers.get('content-length') || 0);
  const tmp = filePath + '.part';
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  const ws = fs.createWriteStream(tmp);
  let got = 0;
  for await (const chunk of res.body) {
    got += chunk.length;
    if (!ws.write(chunk)) await new Promise((r) => ws.once('drain', r));
  }
  await new Promise((r) => ws.end(r));
  if (total && got !== total) {
    await fsp.rm(tmp, { force: true });
    throw new Error(`不完整 ${got}/${total}`);
  }
  return { tmp, size: got };
}

async function handleOne(browser, raw, outDir) {
  const target = await normalizeInput(raw);
  const awemeId = extractAwemeId(target);
  const pageUrl = `https://www.douyin.com/video/${awemeId}`;
  console.log(`\n=== ${pageUrl}`);

  const page = await browser.newPage();
  try {
    await page.setUserAgent(UA);
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'zh-CN,zh;q=0.9' });

    /** @type {Map<string, {len:number}>} */
    const candidates = new Map();
    /** @type {Map<string, string>} key=pathname, value=完整音轨直链 */
    const audioMap = new Map();
    page.on('response', (res) => {
      const u = res.url();
      const h = res.headers();
      const ct = h['content-type'] || '';
      if (!/(douyinvod|bytevcloud|bytecdn|amemv)/i.test(u)) return;
      if (/media-audio|mime_type=audio|audio_mp4/i.test(u) || ct.startsWith('audio/')) {
        try {
          audioMap.set(new URL(u).pathname, u);
        } catch {}
        return;
      }
      if (!(ct.startsWith('video/') || /mime_type=video_mp4/.test(u))) return;
      candidates.set(u, { len: Number(h['content-length'] || 0) });
    });

    await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });

    // 等播放器真正就绪：duration>1 且 already 有数据，避免拿到预览小片
    let pageDur = 0;
    let liveSrc = '';
    for (let i = 0; i < 40; i++) {
      const st = await page.evaluate(() => {
        const v = document.querySelector('video');
        if (!v) return null;
        return {
          src: v.currentSrc || v.src || '',
          dur: Number.isFinite(v.duration) ? v.duration : 0,
          ready: v.readyState,
        };
      });
      if (st) {
        liveSrc = st.src || liveSrc;
        pageDur = st.dur || pageDur;
        if (st.dur > 1 && st.ready >= 2 && st.src) break;
      }
      await sleep(500);
    }

    // 抖音默认静音播放，不解除静音就不会去拉音轨；这里强制出声再等音轨请求
    await page
      .evaluate(() => {
        const v = document.querySelector('video');
        if (!v) return;
        v.muted = false;
        v.volume = 1;
        v.play?.().catch(() => {});
      })
      .catch(() => {});
    for (let i = 0; i < 16 && audioMap.size === 0; i++) await sleep(500);

    const meta = await page.evaluate(() => {
      const og = (p) =>
        document.querySelector(`meta[property="${p}"]`)?.content ||
        document.querySelector(`meta[name="${p}"]`)?.content ||
        '';
      const t =
        document.querySelector('[data-e2e="video-desc"]')?.textContent ||
        document.querySelector('h1')?.textContent ||
        og('og:title');
      const a =
        document.querySelector('[data-e2e="video-author-name"]')?.textContent ||
        document.querySelector('[data-e2e="user-name"]')?.textContent ||
        '';
      return { title: (t || '').trim(), author: (a || '').trim() };
    });

    // 候选排序：先页面播放器正在用的，再按体积降序
    const ordered = [];
    if (liveSrc) ordered.push(liveSrc);
    for (const [u, m] of [...candidates.entries()].sort((a, b) => b[1].len - a[1].len)) {
      if (!ordered.includes(u)) ordered.push(u);
    }
    if (!ordered.length) {
      throw new Error('页面没吐出视频直链（可能已删除 / 私密 / 触发验证）');
    }

    const cookies = await page.cookies('https://www.douyin.com');
    const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join('; ');

    const title = sanitize(meta.title);
    const author = sanitize(meta.author, 20);
    const base = [author, title].filter(Boolean).join('_');
    const filePath = path.join(outDir, `${base ? base + '_' : ''}${awemeId}.mp4`);

    if (fs.existsSync(filePath) && fs.statSync(filePath).size > 100 * 1024) {
      const old = await ffprobeInfo(filePath);
      if (old?.hasAudio || audioMap.size === 0) {
        console.log(`↩︎ 已存在，跳过：${filePath}`);
        return { ok: true, id: awemeId, file: filePath, skipped: true };
      }
      console.log('… 本地旧文件无音轨，重新下载');
      await fsp.rm(filePath, { force: true });
    }

    for (const [i, url] of ordered.entries()) {
      try {
        const { tmp, size } = await downloadTo(url, filePath, cookieHeader);
        const dur = await probeDuration(tmp);
        const okDur = !pageDur || dur >= pageDur * 0.9;
        if (!okDur && i < ordered.length - 1) {
          console.log(`… 候选 ${i + 1} 只有 ${dur.toFixed(1)}s / 完整 ${pageDur.toFixed(1)}s，换下一个`);
          await fsp.rm(tmp, { force: true });
          continue;
        }
        await fsp.rename(tmp, filePath);
        const audioUrls = [...audioMap.values()];
        const mux = await attachAudio(filePath, audioUrls, cookieHeader, pageDur);
        const final = await ffprobeInfo(filePath);
        const finalSize = fs.statSync(filePath).size;
        const audioNote = mux.merged
          ? '含音轨(已合并 aac)'
          : mux.reason === '已有音轨'
            ? '含音轨(原生)'
            : `无音轨(${mux.reason})`;
        console.log(
          `✅ ${filePath}\n   ${(finalSize / 1048576).toFixed(2)} MB · ${(final?.duration || dur).toFixed(1)}s / 页面 ${pageDur.toFixed(1)}s · ` +
            audioNote
        );
        return {
          ok: true,
          id: awemeId,
          file: filePath,
          size: finalSize,
          duration: final?.duration || dur,
          audio: !!mux.merged,
        };
      } catch (e) {
        if (i === ordered.length - 1) throw new Error(`全部候选下载失败：${e.message}`);
      }
    }
    throw new Error('没有可用直链');
  } finally {
    await page.close().catch(() => {});
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const headed = argv.includes('--headed');
  const outIdx = argv.indexOf('--out');
  const outDir =
    outIdx >= 0 && argv[outIdx + 1]
      ? path.resolve(argv[outIdx + 1])
      : path.join(os.homedir(), 'Downloads', '抖音视频');
  const inputs = argv.filter((a, i) => !a.startsWith('--') && !(outIdx >= 0 && i === outIdx + 1));

  if (!inputs.length) {
    console.error('用法: node douyin-dl.mjs [--out 目录] [--headed] <抖音链接或分享文本...>');
    process.exit(1);
  }

  const puppeteer = loadPuppeteer();

  const browser = await puppeteer.launch({
    executablePath: findChrome(),
    headless: headed ? false : 'new',
    defaultViewport: { width: 1280, height: 900 },
    args: [
      '--no-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--autoplay-policy=no-user-gesture-required',
      '--lang=zh-CN',
      '--mute-audio',
    ],
    userDataDir: path.join(os.homedir(), '.cache', 'douyin-dl-profile'),
  });

  const results = [];
  try {
    for (const raw of inputs) {
      try {
        results.push(await handleOne(browser, raw, outDir));
      } catch (e) {
        console.error(`❌ ${raw}\n   ${e.message}`);
        results.push({ ok: false, input: raw, error: e.message });
      }
    }
  } finally {
    await browser.close().catch(() => {});
  }

  const ok = results.filter((r) => r.ok);
  const bad = results.filter((r) => !r.ok);
  console.log(`\n完成：成功 ${ok.length} / 失败 ${bad.length}，输出目录 ${outDir}`);
  if (bad.length) process.exit(2);
}

main().catch((e) => {
  console.error('FATAL:', e.message);
  process.exit(1);
});
