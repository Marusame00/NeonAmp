'use strict';

const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { resolveArtwork } = require('./metadata');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.flac': 'audio/flac',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac'
};

const STATIC_ROUTES = {
  '/': 'overlay.html',
  '/overlay': 'overlay.html',
  '/overlay.html': 'overlay.html',
  '/overlay.css': 'overlay.css',
  '/overlay.js': 'overlay.js',
  '/fallback.svg': 'fallback.svg'
};

function send(res, status, body, headers = {}) {
  res.writeHead(status, {
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
    ...headers
  });
  res.end(body);
}

function streamAudio(req, res, filePath) {
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return send(res, 404, 'Not found');
  }
  if (!stat.isFile()) return send(res, 404, 'Not found');

  const total = stat.size;
  const type = MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
  const range = req.headers.range;

  if (!range) {
    res.writeHead(200, {
      'Content-Type': type,
      'Content-Length': total,
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-store'
    });
    if (req.method === 'HEAD') return res.end();
    return fs.createReadStream(filePath).on('error', () => res.destroy()).pipe(res);
  }

  const match = /^bytes=(\d*)-(\d*)$/.exec(String(range).trim());
  if (!match) {
    return send(res, 416, 'Range Not Satisfiable', { 'Content-Range': `bytes */${total}` });
  }

  let start;
  let end;
  if (match[1] === '' && match[2] === '') {
    return send(res, 416, 'Range Not Satisfiable', { 'Content-Range': `bytes */${total}` });
  } else if (match[1] === '') {
    const suffix = Number(match[2]);
    if (!Number.isFinite(suffix) || suffix <= 0) {
      return send(res, 416, 'Range Not Satisfiable', { 'Content-Range': `bytes */${total}` });
    }
    start = Math.max(0, total - suffix);
    end = total - 1;
  } else {
    start = Number(match[1]);
    end = match[2] === '' ? total - 1 : Math.min(Number(match[2]), total - 1);
  }

  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= total) {
    return send(res, 416, 'Range Not Satisfiable', { 'Content-Range': `bytes */${total}` });
  }

  res.writeHead(206, {
    'Content-Type': type,
    'Content-Length': end - start + 1,
    'Content-Range': `bytes ${start}-${end}/${total}`,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store'
  });
  if (req.method === 'HEAD') return res.end();
  return fs.createReadStream(filePath, { start, end }).on('error', () => res.destroy()).pipe(res);
}

function startServer({ getSnapshot, overlayDir, preferredPort = 8765, host = '127.0.0.1', resolveAudio = () => null }) {
  const clients = new Set();
  let heartbeat = null;

  const broadcast = (payload) => {
    if (!clients.size) return;
    const frame = `data: ${JSON.stringify(payload)}\n\n`;
    for (const res of clients) {
      try {
        res.write(frame);
      } catch {
        clients.delete(res);
      }
    }
  };

  const handler = async (req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return send(res, 405, 'Method Not Allowed', { Allow: 'GET, HEAD' });
    }

    let pathname;
    try {
      pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    } catch {
      return send(res, 400, 'Bad Request');
    }

    if (pathname === '/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'Access-Control-Allow-Origin': '*',
        'X-Accel-Buffering': 'no'
      });
      res.write('retry: 1000\n\n');
      res.write(`data: ${JSON.stringify(getSnapshot())}\n\n`);
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }

    if (pathname === '/api/state') {
      return send(res, 200, JSON.stringify(getSnapshot()), { 'Content-Type': 'application/json; charset=utf-8' });
    }

    if (pathname === '/health') {
      return send(res, 200, JSON.stringify({ ok: true, clients: clients.size }), {
        'Content-Type': 'application/json; charset=utf-8'
      });
    }

    if (pathname.startsWith('/artwork/')) {
      const file = resolveArtwork(pathname.slice('/artwork/'.length));
      if (!file) return send(res, 404, 'Not found');
      try {
        const data = await fsp.readFile(file);
        return send(res, 200, data, {
          'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
          'Cache-Control': 'public, max-age=31536000, immutable'
        });
      } catch {
        return send(res, 404, 'Not found');
      }
    }

    if (pathname.startsWith('/audio/')) {
      const id = pathname.slice('/audio/'.length);
      if (!/^[0-9a-f]{16}$/.test(id)) return send(res, 400, 'Bad id');
      const file = resolveAudio(id);
      if (!file) return send(res, 404, 'Not found');
      return streamAudio(req, res, file);
    }

    const staticFile = STATIC_ROUTES[pathname];
    if (staticFile) {
      try {
        const data = await fsp.readFile(path.join(overlayDir, staticFile));
        return send(res, 200, data, { 'Content-Type': MIME[path.extname(staticFile)] || 'text/plain' });
      } catch {
        return send(res, 404, 'Not found');
      }
    }

    if (pathname === '/favicon.ico') return send(res, 204, '');

    return send(res, 404, 'Not found');
  };

  const server = http.createServer((req, res) => {
    handler(req, res).catch((err) => {
      console.error('[server] request failed:', err);
      if (!res.headersSent) send(res, 500, 'Internal error');
      else res.end();
    });
  });

  return new Promise((resolve, reject) => {
    let port = preferredPort;
    let attempts = 0;

    const onError = (err) => {
      if (err.code === 'EADDRINUSE' && attempts < 20) {
        attempts += 1;
        port += 1;
        server.listen(port, host);
        return;
      }
      server.removeListener('error', onError);
      reject(err);
    };

    server.on('error', onError);
    server.listen(port, host, () => {
      server.removeListener('error', onError);
      server.on('error', (err) => console.error('[server] runtime error:', err));

      heartbeat = setInterval(() => {
        for (const res of clients) {
          try {
            res.write(': ping\n\n');
          } catch {
            clients.delete(res);
          }
        }
      }, 15000);
      if (heartbeat.unref) heartbeat.unref();

      resolve({
        host,
        port,
        url: `http://${host}:${port}/`,
        broadcast,
        get clientCount() {
          return clients.size;
        },
        close() {
          if (heartbeat) clearInterval(heartbeat);
          for (const res of clients) {
            try {
              res.end();
            } catch {
              /* ignore */
            }
          }
          clients.clear();
          return new Promise((done) => server.close(() => done()));
        }
      });
    });
  });
}

module.exports = { startServer };
