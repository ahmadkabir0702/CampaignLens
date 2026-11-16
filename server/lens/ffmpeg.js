/**
 * Runs ffmpeg on a video that came from outside (an upload or a public post),
 * with the guard rails that matter for files we did not make:
 *
 *   - Only local files are read. -protocol_whitelist stops a crafted file
 *     from making ffmpeg fetch a URL (playlists and some containers can point
 *     at other addresses, which would let a file probe internal services).
 *   - Only video containers we expect are processed (MP4/MOV family, WebM).
 *   - Every run has a time limit and an output cap.
 *   - No shell: arguments go straight to the binary.
 *
 * The binary is ffmpeg-static (bundled, so Render needs nothing installed),
 * or FFMPEG_PATH when set.
 */
const { spawn } = require('child_process');

function bin() {
  if (process.env.FFMPEG_PATH) return process.env.FFMPEG_PATH;
  try { return require('ffmpeg-static'); } catch (e) { return 'ffmpeg'; }
}

const ALLOWED_FORMATS = /^(mov,mp4,m4a,3gp,3g2,mj2|matroska,webm)$/;
const MAX_STDERR = 4 * 1024 * 1024;

/** Runs ffmpeg and returns its stderr (where it reports). Rejects on timeout. */
function run(args, { timeoutMs = 120000 } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(bin(), args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    let size = 0;
    const timer = setTimeout(() => { p.kill('SIGKILL'); reject(new Error('ffmpeg took too long')); }, timeoutMs);
    p.stderr.on('data', d => {
      size += d.length;
      if (size <= MAX_STDERR) err += d.toString();
    });
    p.on('error', e => { clearTimeout(timer); reject(e); });
    p.on('close', code => {
      clearTimeout(timer);
      // ffmpeg exits non-zero for some harmless endings; callers read stderr.
      resolve({ code, stderr: err });
    });
  });
}

const SAFE_INPUT = ['-hide_banner', '-nostdin', '-protocol_whitelist', 'file', '-i'];

/** What the file is: container, duration, whether it has sound. Throws if it is not a video we accept. */
async function probe(filePath) {
  const { stderr } = await run([...SAFE_INPUT, filePath, '-t', '0', '-f', 'null', '-'], { timeoutMs: 30000 });
  const fmt = (stderr.match(/Input #0, ([^ ]+?), from/) || [])[1] || '';
  if (!ALLOWED_FORMATS.test(fmt)) throw new Error(`Not a supported video file (${fmt || 'unknown format'}).`);
  const d = stderr.match(/Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/);
  const duration = d ? Number(d[1]) * 3600 + Number(d[2]) * 60 + Number(d[3]) : null;
  return {
    format: fmt,
    duration,
    hasVideo: /Stream #0:\d+.*?: Video:/.test(stderr),
    hasAudio: /Stream #0:\d+.*?: Audio:/.test(stderr),
  };
}

/**
 * EBU R128 loudness: integrated loudness, true peak, and momentary loudness
 * every 0.1 s (a 0.4 s window).
 */
async function loudness(filePath) {
  const { stderr } = await run([
    '-hide_banner', '-nostdin', '-nostats', '-loglevel', 'verbose', '-protocol_whitelist', 'file',
    '-i', filePath, '-map', '0:a:0', '-af', 'ebur128=peak=true', '-f', 'null', '-',
  ], { timeoutMs: 180000 });
  const series = [];
  const re = /t:\s*([\d.]+)\s+TARGET.*?M:\s*(-?[\d.]+|-inf)/g;
  let m;
  while ((m = re.exec(stderr))) {
    const v = m[2] === '-inf' ? -70 : Math.max(-70, Number(m[2]));
    series.push([Number(m[1]), v]);
  }
  const summ = stderr.slice(stderr.lastIndexOf('Summary:'));
  const num = r => { const x = summ.match(r); return x ? Number(x[1]) : null; };
  return {
    integrated: num(/I:\s*(-?[\d.]+) LUFS/),
    truePeak: num(/Peak:\s*(-?[\d.]+) dBFS/),
    range: num(/LRA:\s*(-?[\d.]+) LU/),
    series,
  };
}

module.exports = { probe, loudness, run, bin };
