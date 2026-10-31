/* 语音消息录音器。

   产出的录音只是一段加密字节：走的是和图片 / 文件完全相同的通道
   （C.encryptFile → /api/files/upload），服务端只经手密文。
   随消息下发的只有「文件 id + 时长 + 波形」，波形是纯 UI 装饰数据，
   不参与加解密，也不影响内容理解。

   交互：点麦克风开始 → 实时波形与计时 → 停止后可试听 / 重录 → 发送。
   上限 60 秒（到点自动停），短于 1 秒视为误触。
*/
import { el } from './util.js';
import { icoHtml } from './icons.js';
import { toast, modal } from './ui.js';

const MAX_SEC = 60;
const MIN_SEC = 1;
const BARS = 36;

function pickMime() {
  const cands = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'];
  for (const m of cands) {
    try { if (window.MediaRecorder && window.MediaRecorder.isTypeSupported(m)) return m; } catch { /* ignore */ }
  }
  return '';
}

/** 把逐帧音量降采样成固定根数的波形柱 */
function downsample(arr, n) {
  if (!arr.length) return new Array(n).fill(0);
  const out = [];
  const step = arr.length / n;
  for (let i = 0; i < n; i++) {
    const s = Math.floor(i * step);
    const e = Math.max(s + 1, Math.floor((i + 1) * step));
    let m = 0;
    for (let j = s; j < e && j < arr.length; j++) if (arr[j] > m) m = arr[j];
    out.push(m);
  }
  const peak = Math.max(...out, 0.05);
  return out.map((v) => Math.min(1, 0.12 + (v / peak) * 0.88));
}

const mmss = (s) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

/**
 * 打开录音面板。
 * @returns {Promise<{blob: Blob, duration: number, wave: number[], mime: string}|null>}
 */
export function recordVoice() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || typeof window.MediaRecorder === 'undefined') {
    toast('当前浏览器不支持录音，请使用 Edge / Chrome 等现代浏览器', 'err');
    return Promise.resolve(null);
  }

  return new Promise((resolve) => {
    let finished = false;
    let sendBtn = null;
    let stream = null, rec = null, chunks = [], actx = null, analyser = null;
    let samples = [], tick = 0, t0 = 0, mime = '';
    let audio = null, previewUrl = '';
    let result = null;

    /* ---------- DOM ---------- */
    const wave = el('div', { class: 'voice-wave' });
    const bars = [];
    for (let i = 0; i < BARS; i++) {
      const b = el('span', { class: 'voice-wave__bar' });
      bars.push(b);
      wave.appendChild(b);
    }
    const paintWave = (arr, ratio = -1) => {
      const v = downsample(arr, BARS);
      bars.forEach((b, i) => {
        b.style.height = `${Math.round(7 + v[i] * 27)}px`;
        b.classList.toggle('is-played', ratio >= 0 && i / BARS <= ratio);
      });
    };
    paintWave([]);

    const status = el('div', { class: 'voice-rec__status', text: '点击麦克风开始录音' });
    const timeEl = el('div', { class: 'voice-rec__time', text: '00:00' });
    const micBtn = el('button', { class: 'btn btn--primary voice-rec__mic', html: icoHtml('mic', 26) });
    micBtn.setAttribute('aria-label', '开始或结束录音');

    const playBtn = el('button', {
      class: 'btn btn--sm btn--ghost', title: '试听', html: icoHtml('play', 16),
      onClick: () => { if (audio) { audio.paused ? audio.play() : audio.pause(); } },
    });
    const redoBtn = el('button', {
      class: 'btn btn--sm btn--ghost', title: '重录', html: icoHtml('refresh', 16),
      onClick: () => { resetResult(); start(); },
    });
    const tools = el('div', { class: 'voice-rec__tools' }, [playBtn, redoBtn]);
    tools.hidden = true;

    const body = el('div', { class: 'voice-rec' }, [
      status, timeEl, wave, micBtn, tools,
      el('div', { class: 'muted center', text: `最长 ${MAX_SEC} 秒 · 录音在浏览器内加密后上传` }),
    ]);

    /* ---------- 生命周期 ---------- */
    const stopTracks = () => {
      clearInterval(tick); tick = 0;
      if (stream) { stream.getTracks().forEach((t) => t.stop()); stream = null; }
      if (actx) { try { actx.close(); } catch { /* ignore */ } actx = null; analyser = null; }
    };

    function resetResult() {
      if (previewUrl) { URL.revokeObjectURL(previewUrl); previewUrl = ''; }
      if (audio) { audio.pause(); audio.src = ''; audio = null; }
      if (rec && rec.state !== 'inactive') { try { rec.stop(); } catch { /* ignore */ } }
      result = null; chunks = []; samples = [];
      tools.hidden = true;
      micBtn.classList.remove('is-rec');
      paintWave([]);
      timeEl.textContent = '00:00';
      if (sendBtn) sendBtn.disabled = true;
    }

    const finish = (v) => {
      if (finished) return;
      finished = true;
      stopTracks();
      if (rec && rec.state !== 'inactive') { try { rec.stop(); } catch { /* ignore */ } }
      if (previewUrl) { URL.revokeObjectURL(previewUrl); previewUrl = ''; }
      if (audio) { audio.pause(); audio = null; }
      resolve(v);
    };

    const measure = () => {
      if (!analyser) { samples.push(0.2); return; }
      const buf = new Uint8Array(analyser.fftSize);
      analyser.getByteTimeDomainData(buf);
      let sum = 0;
      for (let i = 0; i < buf.length; i++) { const d = (buf[i] - 128) / 128; sum += d * d; }
      samples.push(Math.sqrt(sum / buf.length));
    };

    function start() {
      navigator.mediaDevices.getUserMedia({ audio: true }).then((st) => {
        stream = st;
        try {
          actx = new (window.AudioContext || window.webkitAudioContext)();
          const src = actx.createMediaStreamSource(st);
          analyser = actx.createAnalyser();
          analyser.fftSize = 1024;
          src.connect(analyser);
        } catch { actx = null; analyser = null; }

        const m = pickMime();
        try { rec = new MediaRecorder(st, m ? { mimeType: m } : undefined); }
        catch { rec = new MediaRecorder(st); }
        mime = rec.mimeType || m || 'audio/webm';

        chunks = []; samples = [];
        rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
        rec.onstop = () => {
          clearInterval(tick); tick = 0;
          const sec = Math.max(0, (Date.now() - t0) / 1000);
          if (sec < MIN_SEC) { toast('录音太短了，请再试一次', 'info'); resetResult(); return; }
          const blob = new Blob(chunks, { type: mime });
          previewUrl = URL.createObjectURL(blob);
          audio = new Audio(previewUrl);
          audio.addEventListener('ended', () => paintWave(samples, -1));
          audio.addEventListener('timeupdate', () => {
            if (audio.duration) paintWave(samples, audio.currentTime / audio.duration);
          });
          paintWave(samples, -1);
          result = {
            blob,
            duration: Math.round(sec * 10) / 10,
            wave: downsample(samples, BARS).map((v) => Math.round(v * 100) / 100),
            mime,
          };
          tools.hidden = false;
          micBtn.classList.remove('is-rec');
          status.textContent = '录好了，可以试听或直接发送';
          if (sendBtn) sendBtn.disabled = false;
        };

        t0 = Date.now();
        rec.start(250);
        tick = setInterval(() => {
          measure();
          const sec = (Date.now() - t0) / 1000;
          timeEl.textContent = mmss(sec);
          paintWave(samples);
          if (sec >= MAX_SEC) { toast(`已达 ${MAX_SEC} 秒上限，自动结束`, 'info'); stop(); }
        }, 60);
        status.textContent = '正在录音……再次点击可结束';
        micBtn.classList.add('is-rec');
      }).catch((e) => {
        toast('无法访问麦克风：' + (e && e.message ? e.message : '权限被拒绝'), 'err');
      });
    }

    function stop() {
      clearInterval(tick); tick = 0;
      if (rec && rec.state !== 'inactive') { try { rec.stop(); } catch { /* ignore */ } }
    }

    micBtn.addEventListener('click', () => {
      if (rec && rec.state === 'recording') stop();
      else if (!result) start();
    });

    const dlg = modal({
      title: '语音消息',
      body,
      footer: [
        { text: '取消', kind: 'ghost', onClick: () => finish(null) },
        {
          text: '发送', kind: 'primary', close: false, onClick: () => {
            if (!result) { toast('请先录一段语音', 'info'); return false; }
            finish(result);
            // 必须自己关：onClose 里的 finish(null) 已被 finished 拦掉，不会影响结果
            dlg.close();
          },
        },
      ],
      onClose: () => finish(null),
    });
    // modal 的 footer 按钮是匿名构造的，这里把它捞出来控制禁用态
    sendBtn = dlg.box.querySelector('.modal__foot .btn--primary');
    if (sendBtn) sendBtn.disabled = true;
  });
}
