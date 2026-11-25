"use strict";

/**
 * Node.js 零依赖双固定端口本地仿真服务器（作为无 Python 环境时的自动降级兜底）。
 * - 系统 A 默认 18761 -> sys_a_query.html
 * - 系统 B 默认 18762 -> sys_b_form.html
 */
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml'
};

function parseArgs(argv) {
  const opts = {
    host: '127.0.0.1',
    portA: 18761,
    portB: 18762,
    noOpen: false
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--no-open') opts.noOpen = true;
    else if (arg === '--host' && argv[i + 1]) opts.host = argv[++i];
    else if (arg === '--port-a' && argv[i + 1]) opts.portA = Number(argv[++i]);
    else if (arg === '--port-b' && argv[i + 1]) opts.portB = Number(argv[++i]);
  }
  return opts;
}

function openBrowser(url) {
  if (process.platform === 'win32') {
    execFile('cmd.exe', ['/c', 'start', '', url], () => {});
  } else if (process.platform === 'darwin') {
    execFile('open', [url], () => {});
  } else {
    execFile('xdg-open', [url], () => {});
  }
}

function createStaticServer(rootDir, defaultPage) {
  return http.createServer(async (req, res) => {
    try {
      const reqUrl = new URL(req.url || '/', 'http://127.0.0.1');
      let relPath = decodeURIComponent(reqUrl.pathname || '/');
      if (relPath === '/' || relPath === '') relPath = `/${defaultPage}`;

      const resolved = path.resolve(rootDir, '.' + relPath);
      if (!resolved.startsWith(rootDir + path.sep) && resolved !== rootDir) {
        res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end('Forbidden');
        return;
      }

      const data = await fs.readFile(resolved);
      const ext = path.extname(resolved).toLowerCase();
      res.writeHead(200, {
        'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
        'Cache-Control': 'no-store'
      });
      if (req.method === 'HEAD') res.end();
      else res.end(data);
    } catch (_) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end('Not Found');
    }
  });
}

function listenServer(server, host, port) {
  return new Promise((resolve, reject) => {
    const onError = (err) => {
      server.off('listening', onListening);
      reject(err);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve(server.address().port);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const here = path.dirname(fileURLToPath(import.meta.url));
  const rootDir = path.resolve(here, 'demo-site');

  for (const required of ['sys_a_query.html', 'sys_b_form.html', 'index.html']) {
    await fs.access(path.join(rootDir, required));
  }

  const serverA = createStaticServer(rootDir, 'sys_a_query.html');
  const serverB = createStaticServer(rootDir, 'sys_b_form.html');

  try {
    const portA = await listenServer(serverA, opts.host, opts.portA);
    const portB = await listenServer(serverB, opts.host, opts.portB);

    const urlA = `http://${opts.host}:${portA}/sys_a_query.html`;
    const urlB = `http://${opts.host}:${portB}/sys_b_form.html`;
    const urlLegacy = `http://${opts.host}:${portA}/index.html`;

    console.log('SkillFlow v0.3 dual fixed-port local demo (Node fallback)');
    console.log(`System A (Query): ${urlA}`);
    console.log(`System B (Form) : ${urlB}`);
    console.log(`Legacy Smoke    : ${urlLegacy}`);
    console.log('Press Ctrl+C to stop both servers.');

    if (!opts.noOpen) {
      setTimeout(() => openBrowser(urlA), 600);
      setTimeout(() => openBrowser(urlB), 1000);
    }

    const shutdown = () => {
      serverA.closeAllConnections?.();
      serverB.closeAllConnections?.();
      serverA.close();
      serverB.close();
      process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  } catch (err) {
    serverA.close();
    serverB.close();
    console.error(`Unable to bind fixed ports (${opts.portA}/${opts.portB}): ${err.message}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
