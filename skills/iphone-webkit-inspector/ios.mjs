#!/usr/bin/env node
// Inspect and drive Safari or Chrome on an iPhone over USB or Wi-Fi.
//
// A background daemon starts the pymobiledevice3 CDP bridge, holds one WebSocket per Safari tab
// (reconnecting to a tab tends to hang, so connections are kept open), and buffers console and
// network events. Every other command talks to that daemon over local HTTP.
//
// Usage: node ios.mjs <command> [args]   (run with no args for the list)

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, openSync, readFileSync, writeFileSync, existsSync, rmSync, chmodSync, statSync } from 'node:fs';
import { createServer, request } from 'node:http';
import { createConnection } from 'node:net';
import { homedir, hostname, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const STATE_DIR = join(homedir(), '.cache', 'iphone-webkit-inspector');
const LOG_FILE = join(STATE_DIR, 'daemon.log');
const PID_FILE = join(STATE_DIR, 'daemon.pid');
// The daemon listens on a Unix socket inside the owner-only state dir: only this user can connect,
// and web pages can't reach it at all, so no token is needed.
const SOCKET = join(STATE_DIR, 'daemon.sock');
// The Web Inspector bridge listens on a Unix socket in the same directory, for the same reason.
const BRIDGE_SOCKET = join(STATE_DIR, 'bridge.sock');
const LOCK_FILE = join(STATE_DIR, 'start.lock');

// State dir and log are owner-only: the log names attached tabs and the dir guards the daemon socket.
function ensureStateDir() {
	mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
	try {
		chmodSync(STATE_DIR, 0o700);
	} catch {}
}

// Only the origin of a page goes into the log, never its path or query.
const originOf = (u) => {
	try {
		return new URL(u).origin;
	} catch {
		return '?';
	}
};
const MAX_EVENTS = 3000;
// Exact version the bridge was tested with; override with IOS_PMD3_VERSION.
const PMD3 = `pymobiledevice3==${process.env.IOS_PMD3_VERSION || '11.49.2'}`;

const AsyncFunction = (async () => {}).constructor;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- daemon

// GET on the bridge's Unix socket.
function bridgeGet(path) {
	return new Promise((res, rej) => {
		const r = request({ socketPath: BRIDGE_SOCKET, path, headers: { host: 'localhost' } }, (x) => {
			let text = '';
			x.setEncoding('utf8');
			x.on('data', (c) => (text += c));
			x.on('end', () => res({ status: x.statusCode, text }));
		});
		r.on('error', rej);
		r.end();
	});
}

// Minimal WebSocket client over a Unix socket (Node's built-in WebSocket only does TCP).
// Same surface as the browser API where Tab uses it: onopen, onmessage({data}), onerror, onclose, send, close.
class UnixWebSocket {
	constructor(socketPath, path) {
		this.chunks = [];
		this.len = 0;
		this.frags = [];
		const key = randomBytes(16).toString('base64');
		const req = request({ socketPath, path, headers: { host: 'localhost', connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-version': '13', 'sec-websocket-key': key } });
		req.on('upgrade', (_res, sock, head) => {
			this.sock = sock;
			sock.on('data', (d) => this.feed(d));
			sock.on('close', () => this.closed());
			sock.on('error', (e) => this.onerror?.(e));
			this.onopen?.();
			if (head.length) this.feed(head);
		});
		req.on('response', (res) => {
			res.resume();
			this.onerror?.(new Error(`websocket handshake failed: HTTP ${res.statusCode}`));
		});
		req.on('error', (e) => this.onerror?.(e));
		req.end();
	}

	feed(d) {
		this.chunks.push(d);
		this.len += d.length;
		for (;;) {
			if (this.len < 2) return;
			let h = this.chunks[0];
			if (h.length < Math.min(14, this.len)) h = this.chunks[0] = Buffer.concat(this.chunks.splice(0));
			if (this.chunks.length === 0) this.chunks.push(h);
			let n = h[1] & 127, off = 2;
			if (n === 126) {
				if (h.length < 4) return;
				n = h.readUInt16BE(2);
				off = 4;
			} else if (n === 127) {
				if (h.length < 10) return;
				n = Number(h.readBigUInt64BE(2));
				off = 10;
			}
			const masked = h[1] & 128;
			if (masked) off += 4;
			if (this.len < off + n) return;
			const fin = h[0] & 128, op = h[0] & 15;
			const mask = masked ? Buffer.from(h.subarray(off - 4, off)) : null;
			this.take(off);
			const payload = this.take(n);
			if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
			if (op === 8) return this.close();
			if (op === 9) {
				this.frame(10, payload);
				continue;
			}
			if (op === 10) continue;
			this.frags.push(payload);
			if (fin) {
				const data = Buffer.concat(this.frags.splice(0)).toString('utf8');
				this.onmessage?.({ data });
			}
		}
	}

	take(n) {
		this.len -= n;
		const c = this.chunks[0];
		if (c.length === n) return this.chunks.shift();
		if (c.length > n) {
			this.chunks[0] = c.subarray(n);
			return Buffer.from(c.subarray(0, n));
		}
		const out = Buffer.allocUnsafe(n);
		let o = 0;
		while (o < n) {
			const x = this.chunks[0];
			const k = Math.min(x.length, n - o);
			x.copy(out, o, 0, k);
			o += k;
			if (k === x.length) this.chunks.shift();
			else this.chunks[0] = x.subarray(k);
		}
		return out;
	}

	// Client frames must be masked.
	frame(op, payload) {
		if (!this.sock || this.sock.destroyed) return;
		const n = payload.length;
		const head = n < 126 ? Buffer.alloc(2) : n < 65536 ? Buffer.alloc(4) : Buffer.alloc(10);
		head[0] = 128 | op;
		if (n < 126) head[1] = 128 | n;
		else if (n < 65536) {
			head[1] = 128 | 126;
			head.writeUInt16BE(n, 2);
		} else {
			head[1] = 128 | 127;
			head.writeBigUInt64BE(BigInt(n), 2);
		}
		const mask = randomBytes(4);
		const body = Buffer.from(payload);
		for (let i = 0; i < n; i++) body[i] ^= mask[i & 3];
		this.sock.write(Buffer.concat([head, mask, body]));
	}

	send(text) {
		this.frame(1, Buffer.from(text, 'utf8'));
	}

	close() {
		this.frame(8, Buffer.alloc(0));
		this.sock?.end();
		this.closed();
	}

	closed() {
		if (this.done) return;
		this.done = true;
		this.onclose?.();
	}
}

class Tab {
	constructor(info) {
		this.id = info.id;
		this.url = info.url;
		this.title = info.title;
		this.ws = null;
		this.nextId = 0;
		this.pending = new Map();
		this.logs = [];
		this.requests = new Map();
		this.loadWaiters = [];
		this.events = []; // every CDP event, newest last (ring buffer)
		this.listeners = new Map(); // method -> Set<fn>
		this.fetchRules = []; // { match, action: 'block' | 'mock', status, body, contentType }
	}

	on(method, fn) {
		if (!this.listeners.has(method)) this.listeners.set(method, new Set());
		this.listeners.get(method).add(fn);
		return () => this.listeners.get(method)?.delete(fn);
	}

	// Answers every paused request: matching rule → fail or fulfill, otherwise let it through.
	async onRequestPaused(p) {
		const rule = this.fetchRules.find((r) => p.request.url.includes(r.match));
		if (!rule) return this.send('Fetch.continueRequest', { requestId: p.requestId });
		rule.hits = (rule.hits || 0) + 1;
		if (rule.action === 'block') return this.send('Fetch.failRequest', { requestId: p.requestId, errorReason: 'BlockedByClient' });
		return this.send('Fetch.fulfillRequest', {
			requestId: p.requestId,
			responseCode: rule.status,
			responseHeaders: [
				{ name: 'Content-Type', value: rule.contentType },
				{ name: 'Access-Control-Allow-Origin', value: '*' },
			],
			body: Buffer.from(rule.body).toString('base64'),
		});
	}

	connect(wsUrl) {
		return new Promise((res, rej) => {
			// this.ws is set only once the socket is open, so a concurrent refresh never sends on a connecting socket.
			const ws = new UnixWebSocket(BRIDGE_SOCKET, new URL(wsUrl).pathname);
			ws.onopen = () => {
				this.ws = ws;
				res();
			};
			ws.onerror = (e) => rej(new Error(`ws error on ${this.id}: ${e.message || 'unknown'}`));
			ws.onclose = () => {
				this.ws = null;
				for (const [, p] of this.pending) p({ error: { message: 'connection closed' } });
				this.pending.clear();
			};
			ws.onmessage = (m) => {
				let d;
				try {
					d = JSON.parse(m.data);
				} catch {
					return;
				}
				this.onMessage(d);
			};
		});
	}

	send(method, params = {}, timeout = 20000) {
		if (!this.ws) return Promise.resolve({ error: { message: 'tab not connected' } });
		return new Promise((res) => {
			const id = ++this.nextId;
			this.pending.set(id, res);
			this.ws.send(JSON.stringify({ id, method, params }));
			setTimeout(() => {
				if (this.pending.delete(id)) res({ error: { message: `timeout after ${timeout}ms (${method})` } });
			}, timeout);
		});
	}

	pushLog(entry) {
		this.logs.push({ t: Date.now(), ...entry });
		if (this.logs.length > MAX_EVENTS) this.logs.splice(0, this.logs.length - MAX_EVENTS);
	}

	onMessage(d) {
		if (d.id) {
			const p = this.pending.get(d.id);
			if (p) {
				this.pending.delete(d.id);
				p(d);
			}
			return;
		}
		const p = d.params || {};
		// usage keeps only CPU and memory samples, plus a request count; no headers or bodies.
		if (this.trace) {
			if (/^(CPUProfiler|Memory)\.trackingUpdate$/.test(d.method)) this.trace.push({ t: Date.now(), method: d.method, params: p });
			else if (d.method === 'Network.requestWillBeSent') this.traceRequests = (this.traceRequests || 0) + 1;
		}
		// Big payload events (trace chunks, frames, heap chunks) go to listeners only, not the ring buffer.
		if (!/^(Tracing\.dataCollected|Page\.screencastFrame|HeapProfiler\.addHeapSnapshotChunk)$/.test(d.method)) {
			this.events.push({ t: Date.now(), method: d.method, params: p });
			if (this.events.length > MAX_EVENTS) this.events.splice(0, this.events.length - MAX_EVENTS);
		}
		for (const fn of this.listeners.get(d.method) || []) {
			try {
				fn(p);
			} catch (e) {
				console.log(new Date().toISOString(), 'listener failed', d.method, e.message);
			}
		}
		switch (d.method) {
			case 'Fetch.requestPaused':
				this.onRequestPaused(p).catch(() => {});
				break;
			case 'Runtime.consoleAPICalled':
				this.pushLog({ kind: 'console', level: p.type, text: (p.args || []).map(fmtRemote).join(' '), where: p.stackTrace?.callFrames?.[0] && frameStr(p.stackTrace.callFrames[0]) });
				break;
			case 'Runtime.exceptionThrown': {
				const e = p.exceptionDetails || {};
				this.pushLog({ kind: 'exception', level: 'error', text: e.exception?.description || e.text, where: e.url && `${e.url}:${e.lineNumber}` });
				break;
			}
			case 'Log.entryAdded':
				this.pushLog({ kind: p.entry.source, level: p.entry.level, text: p.entry.text, where: p.entry.url && `${p.entry.url}:${p.entry.lineNumber}` });
				break;
			case 'Network.requestWillBeSent':
				this.requests.set(p.requestId, { id: p.requestId, method: p.request.method, url: p.request.url, type: p.type, reqHeaders: p.request.headers, postData: p.request.postData, t: Date.now() });
				if (this.requests.size > MAX_EVENTS) this.requests.delete(this.requests.keys().next().value);
				break;
			case 'Network.responseReceived': {
				const r = this.requests.get(p.requestId);
				if (r) Object.assign(r, { status: p.response.status, mime: p.response.mimeType, headers: p.response.headers, type: p.type || r.type, protocol: p.response.protocol });
				break;
			}
			case 'Network.loadingFinished': {
				const r = this.requests.get(p.requestId);
				if (r) Object.assign(r, { bytes: p.encodedDataLength, ms: Date.now() - r.t });
				break;
			}
			case 'Network.loadingFailed': {
				const r = this.requests.get(p.requestId);
				if (r) Object.assign(r, { failed: p.errorText || 'failed', ms: Date.now() - r.t });
				break;
			}
			case 'Page.loadEventFired':
				for (const w of this.loadWaiters.splice(0)) w();
				break;
			case 'Page.frameNavigated':
				if (!p.frame?.parentId && p.frame?.url) this.url = p.frame.url;
				break;
		}
	}

	// Domains are enabled only on the tab being worked on, so other tabs' traffic is never recorded.
	enableOnce() {
		this.enabled ||= this.enable();
		return this.enabled;
	}

	async enable() {
		await Promise.all(['Runtime.enable', 'Network.enable', 'Page.enable', 'Log.enable'].map((m) => this.send(m, {}, 20000)));
	}

	// gesture: run as if the user had tapped (WebKit's emulateUserGesture) so audio, fullscreen, popups are allowed.
	async evaluate(expression, timeout = 20000, gesture = false) {
		const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, ...(gesture && { userGesture: true }) }, timeout);
		if (r.error) throw new Error(r.error.message);
		const res = r.result;
		if (res.wasThrown || res.exceptionDetails) throw new Error(res.result?.description || res.exceptionDetails?.text || 'evaluation threw');
		return res.result?.value;
	}

	// The bridge ignores awaitPromise, so park the promise's outcome on window and poll for it.
	async evaluateAsync(body, timeout = 30000, gesture = false) {
		const key = `__ios_${Date.now()}_${Math.random().toString(36).slice(2)}`;
		await this.evaluate(
			`window[${JSON.stringify(key)}] = undefined; (async () => { ${body} })().then(v => { window[${JSON.stringify(key)}] = { v }; }, e => { window[${JSON.stringify(key)}] = { e: String(e && e.stack || e) }; }); 0`,
			20000,
			gesture,
		);
		const end = Date.now() + timeout;
		while (Date.now() < end) {
			const got = await this.evaluate(`(() => { const r = window[${JSON.stringify(key)}]; if (r) delete window[${JSON.stringify(key)}]; return r; })()`);
			if (got) {
				if ('e' in got) throw new Error(got.e);
				return got.v;
			}
			await sleep(100);
		}
		throw new Error(`async eval timed out after ${timeout}ms`);
	}
}

function fmtRemote(a) {
	if (a.type === 'string') return a.value;
	if ('value' in a) return JSON.stringify(a.value);
	if (a.preview?.properties) {
		const props = a.preview.properties.map((p) => `${p.name}: ${p.value}`).join(', ');
		return a.subtype === 'array' ? `[${props}]` : `${a.className || ''}{${props}}`;
	}
	return a.description || a.type;
}

const frameStr = (f) => `${f.url}:${f.lineNumber}`;

// Chrome trace → page milestones, where main-thread time went, and the longest tasks.
function summarizeTrace(events) {
	const timed = events.filter((e) => typeof e.ts === 'number' && e.ts > 0);
	const t0 = timed.reduce((m, e) => Math.min(m, e.ts), Infinity);
	const ms = (us) => Math.round(us / 100) / 10;
	const markNames = /navigationStart|firstPaint|firstContentfulPaint|largestContentfulPaint|domContentLoadedEventEnd|loadEventEnd|MarkDOMContent|MarkLoad|firstMeaningfulPaint/i;
	const marks = {};
	for (const e of timed) if (markNames.test(e.name) && !(e.name in marks)) marks[e.name] = ms(e.ts - t0);
	const byName = new Map();
	for (const e of timed) {
		if (e.ph !== 'X' || !e.dur) continue;
		const s = byName.get(e.name) || { name: e.name, count: 0, ms: 0 };
		s.count++;
		s.ms += e.dur / 1000;
		byName.set(e.name, s);
	}
	const top = [...byName.values()].sort((a, b) => b.ms - a.ms).slice(0, 12).map((s) => ({ ...s, ms: Math.round(s.ms) }));
	const detail = (e) => {
		const d = e.args?.data || {};
		return d.url || d.functionName || d.type || d.selector || d.stackTrace?.[0]?.url || '';
	};
	const long = timed
		.filter((e) => e.ph === 'X' && e.dur >= 50000)
		.sort((a, b) => b.dur - a.dur)
		.slice(0, 10)
		.map((e) => ({ at: ms(e.ts - t0), ms: Math.round(e.dur / 1000), name: e.name, detail: detail(e) }));
	const end = timed.reduce((m, e) => Math.max(m, e.ts + (e.dur || 0)), 0);
	// Durations are inclusive (nested events overlap) and cover every thread in the trace.
	return { events: events.length, spanMs: timed.length ? ms(end - t0) : 0, marksFromTraceStart: marks, inclusiveMsByEvent: top, longEvents: long, note: 'inclusive times across all threads; nested events overlap, so totals can exceed wall time' };
}

// .cpuprofile → share of samples per function. The bridge's timeDeltas are unreliable (mostly 0 with
// a few huge gaps), so time is reported as sample counts / percentages rather than milliseconds.
function summarizeProfile(profile) {
	const nodes = new Map(profile.nodes.map((n) => [n.id, n]));
	const parent = new Map();
	for (const n of profile.nodes) for (const c of n.children || []) parent.set(c, n.id);
	const counts = new Map();
	for (const s of profile.samples || []) counts.set(s, (counts.get(s) || 0) + 1);
	const key = (n) => `${n.callFrame.functionName || '(anonymous)'}  ${n.callFrame.url ? n.callFrame.url.split('/').pop().split('?')[0] + ':' + (n.callFrame.lineNumber + 1) : ''}`.trim();
	const self = new Map();
	const total = new Map();
	for (const [id, c] of counts) {
		const n = nodes.get(id);
		self.set(key(n), (self.get(key(n)) || 0) + c);
		const seen = new Set();
		for (let cur = id; cur != null; cur = parent.get(cur)) {
			const k = key(nodes.get(cur));
			if (seen.has(k)) continue;
			seen.add(k);
			total.set(k, (total.get(k) || 0) + c);
		}
	}
	const idle = /^\((root|program|idle|garbage collector)\)/;
	const busy = [...self].filter(([k]) => !idle.test(k)).reduce((a, [, c]) => a + c, 0);
	const fmt = (m) => [...m].sort((a, b) => b[1] - a[1]).filter(([k]) => !idle.test(k)).slice(0, 12).map(([fn, c]) => ({ fn, samples: c, pct: Math.round((c / (busy || 1)) * 100) }));
	return { durationMs: Math.round((profile.endTime - profile.startTime) / 1000), samples: profile.samples?.length || 0, busySamples: busy, topSelf: fmt(self), topTotal: fmt(total) };
}

// JS expression that finds one element on the page from: a CSS selector, `text=<label>`,
// `@e12` (a ref from `snapshot`), or `x y` coordinates.
function targetJs(sel) {
	const s = String(sel).trim();
	const xy = s.match(/^(\d+)\s+(\d+)$/);
	if (xy) return `document.elementFromPoint(${xy[1]}, ${xy[2]})`;
	if (/^@e\d+$/.test(s)) return `document.querySelector('[data-iwi-ref="${s.slice(1)}"]')`;
	if (s.startsWith('text=')) {
		const t = JSON.stringify(s.slice(5));
		const q = `'button, a, [role=button], [role=link], [role=tab], [role=menuitem], label, summary, input[type=button], input[type=submit], [onclick]'`;
		return `([...document.querySelectorAll(${q})].find((e) => e.offsetParent !== null && (e.innerText || e.value || '').trim() === ${t}) || [...document.querySelectorAll(${q})].find((e) => e.offsetParent !== null && (e.innerText || e.value || '').includes(${t})) || [...document.querySelectorAll('h1,h2,h3,h4,p,li,span,div')].find((e) => e.offsetParent !== null && e.children.length === 0 && (e.innerText || '').trim() === ${t}))`;
	}
	return `document.querySelector(${JSON.stringify(s)})`;
}

// Runs on the phone: lists what an agent can act on, tagging each element with data-iwi-ref.
const SNAPSHOT_JS = `
	document.querySelectorAll('[data-iwi-ref]').forEach((e) => e.removeAttribute('data-iwi-ref'));
	const sel = 'a[href], button, input, select, textarea, summary, label, [role=button], [role=link], [role=tab], [role=checkbox], [role=switch], [role=menuitem], [role=slider], [onclick], [tabindex]:not([tabindex="-1"]), [contenteditable=""], [contenteditable=true], h1, h2, h3, h4, video, audio, canvas, iframe';
	const vh = innerHeight, out = [];
	let n = 0;
	for (const el of document.querySelectorAll(sel)) {
		const r = el.getBoundingClientRect();
		if (!r.width || !r.height) continue;
		const cs = getComputedStyle(el);
		if (cs.visibility === 'hidden' || cs.display === 'none' || +cs.opacity === 0) continue;
		if (ONLY_VIEWPORT && (r.bottom < 0 || r.top > vh)) continue;
		const ref = 'e' + ++n;
		el.setAttribute('data-iwi-ref', ref);
		const tag = el.tagName.toLowerCase();
		const role = el.getAttribute('role') || (tag === 'a' ? 'link' : /^h\\d$/.test(tag) ? 'heading' : tag === 'input' ? 'input:' + (el.type || 'text') : tag);
		const secret = tag === 'input' && /^(password|hidden)$/i.test(el.type || '') || /cc-|one-time-code|current-password|new-password/.test(el.autocomplete || '');
		const label = el.labels && el.labels[0] ? el.labels[0].innerText : '';
		const name = (el.getAttribute('aria-label') || label || el.innerText || (secret ? (el.value ? '(filled)' : '') : el.value) || el.placeholder || el.title || el.alt || el.getAttribute('href') || '').trim().replace(/\\s+/g, ' ').slice(0, 70);
		const state = [el.disabled && 'disabled', el.checked && 'checked', el.getAttribute('aria-pressed') === 'true' && 'pressed', el.getAttribute('aria-expanded') === 'true' && 'expanded', document.activeElement === el && 'focused', (r.bottom < 0 || r.top > vh) && 'offscreen'].filter(Boolean).join(',');
		out.push({ ref, role, name, state, box: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)] });
	}
	return { url: location.href, title: document.title, viewport: [innerWidth, innerHeight], scrollY: Math.round(scrollY), items: out };
`;

// Runs on the phone: navigation milestones, paint metrics and a per-resource timing breakdown.
const PERF_JS = `
	const r = (n) => Math.round(n);
	const nav = performance.getEntriesByType('navigation')[0];
	const paints = Object.fromEntries(performance.getEntriesByType('paint').map((p) => [p.name, r(p.startTime)]));
	const lcp = await new Promise((res) => {
		let last = null;
		try {
			const po = new PerformanceObserver((l) => { const e = l.getEntries(); last = e[e.length - 1]; });
			po.observe({ type: 'largest-contentful-paint', buffered: true });
			setTimeout(() => { po.disconnect(); res(last && { ms: r(last.startTime), el: last.element && (last.element.tagName + (last.element.id ? '#' + last.element.id : '') + (last.element.className && typeof last.element.className === 'string' ? '.' + last.element.className.trim().split(/\\s+/)[0] : '')), url: last.url || '' }); }, 300);
		} catch { res(null); }
	});
	// CLS = the largest session window (shifts < 1s apart, window < 5s). null when not supported.
	const cls = await new Promise((res) => {
		if (!(PerformanceObserver.supportedEntryTypes || []).includes('layout-shift')) return res(null);
		const shifts = [];
		try {
			const po = new PerformanceObserver((l) => { for (const e of l.getEntries()) if (!e.hadRecentInput) shifts.push(e); });
			po.observe({ type: 'layout-shift', buffered: true });
			setTimeout(() => {
				po.disconnect();
				let best = 0, cur = 0, start = 0, prev = 0;
				for (const e of shifts) {
					if (cur && (e.startTime - prev > 1000 || e.startTime - start > 5000)) cur = 0;
					if (!cur) start = e.startTime;
					cur += e.value; prev = e.startTime; best = Math.max(best, cur);
				}
				res(Math.round(best * 1000) / 1000);
			}, 300);
		} catch { res(null); }
	});
	const res = performance.getEntriesByType('resource').map((e) => ({
		url: e.name, type: e.initiatorType, proto: e.nextHopProtocol,
		start: r(e.startTime), total: r(e.duration),
		dns: r(e.domainLookupEnd - e.domainLookupStart), connect: r(e.connectEnd - e.connectStart),
		ttfb: e.responseStart ? r(e.responseStart - e.requestStart) : null, download: e.responseStart ? r(e.responseEnd - e.responseStart) : null,
		transfer: e.transferSize, body: e.encodedBodySize, decoded: e.decodedBodySize,
		cached: e.transferSize === 0 && e.decodedBodySize > 0,
	}));
	return {
		url: location.href,
		nav: nav && {
			proto: nav.nextHopProtocol, type: nav.type, redirect: r(nav.redirectEnd - nav.redirectStart),
			dns: r(nav.domainLookupEnd - nav.domainLookupStart), connect: r(nav.connectEnd - nav.connectStart),
			ttfb: r(nav.responseStart - nav.requestStart), html: r(nav.responseEnd - nav.responseStart),
			domInteractive: r(nav.domInteractive), domContentLoaded: r(nav.domContentLoadedEventEnd), load: r(nav.loadEventEnd),
			transfer: nav.transferSize, decoded: nav.decodedBodySize,
		},
		paint: { fcp: paints['first-contentful-paint'] ?? null, lcp, cls },
		memory: performance.memory ? r(performance.memory.usedJSHeapSize / 1048576) + 'MB' : null,
		resources: res,
	};
`;

async function runDaemon() {
	ensureStateDir();
	const log = (...a) => console.log(new Date().toISOString(), ...a);

	// Over USB the phone is listed by usbmuxd. Over Wi-Fi it usually isn't, but macOS keeps its own
	// CoreDevice tunnel to it, which the bridge can share with --native (no Finder Wi-Fi sync needed).
	const pmd3 = (...a) => ['--python', '3.12', '--from', PMD3, 'pymobiledevice3', ...a];
	const listed = await new Promise((res) => {
		let out = '';
		const p = spawn('uvx', pmd3('usbmux', 'list'), { stdio: ['ignore', 'pipe', 'ignore'] });
		p.stdout.on('data', (d) => (out += d));
		p.on('exit', () => res(/"Identifier"/.test(out)));
		p.on('error', () => res(false));
	});
	const transport = process.env.IOS_TRANSPORT || (listed ? 'usb' : 'wifi');
	log('transport', transport);
	// bridge_guard.py starts the same bridge on a Unix socket in the owner-only state dir (no TCP port).
	const guard = fileURLToPath(new URL('./bridge_guard.py', import.meta.url));
	rmSync(BRIDGE_SOCKET, { force: true });
	const bridge = spawn('uvx', ['--python', '3.12', '--from', PMD3, 'python', guard, BRIDGE_SOCKET, 'webinspector', 'cdp', ...(transport === 'wifi' ? ['--native'] : [])], { stdio: ['ignore', 'inherit', 'inherit'] });
	// Removes the pid/socket files only if they are ours; another daemon may have written them.
	const releaseState = () => {
		try {
			if (readFileSync(PID_FILE, 'utf8').trim() === String(process.pid)) {
				rmSync(PID_FILE, { force: true });
				rmSync(SOCKET, { force: true });
			}
		} catch {}
	};
	const shutdown = (code = 0) => {
		bridge.kill();
		releaseState();
		process.exit(code);
	};
	bridge.on('exit', (code) => {
		log('bridge exited', code);
		releaseState();
		process.exit(1);
	});
	process.on('SIGTERM', () => shutdown(0));
	process.on('SIGINT', () => shutdown(0));
	process.on('uncaughtException', (e) => {
		log('fatal', e.stack || e.message);
		shutdown(1);
	});
	process.on('unhandledRejection', (e) => log('unhandled rejection', e?.message || e));

	for (let i = 0; ; i++) {
		try {
			if ((await bridgeGet('/json')).status !== 200) throw new Error('not ready');
			break;
		} catch {
			if (i > 120) throw new Error('bridge did not start');
			await sleep(500);
		}
	}
	log('bridge up');

	const tabs = new Map();
	let current = null;
	let lost = null; // the tab being worked on disappeared; don't silently switch to another one

	// Concurrent callers share one refresh, so a tab is never connected twice.
	let refreshing = null;
	function refreshTabs() {
		return (refreshing ||= doRefreshTabs().finally(() => (refreshing = null)));
	}
	async function doRefreshTabs() {
		const list = JSON.parse((await bridgeGet('/json')).text);
		const pages = list.filter((t) => t.type === 'page' && t.webSocketDebuggerUrl);
		const seen = new Set();
		await Promise.all(
			pages.map(async (info) => {
				seen.add(info.id);
				let tab = tabs.get(info.id);
				if (tab?.ws) {
					tab.url = info.url;
					tab.title = info.title;
					return;
				}
				tab = new Tab(info);
				tabs.set(info.id, tab);
				try {
					// Connect only; domains are enabled when the tab becomes the one being worked on.
					await tab.connect(info.webSocketDebuggerUrl);
					log('attached', info.id, originOf(info.url));
				} catch (e) {
					log('attach failed', info.id, e.message);
				}
			}),
		);
		for (const [id, t] of tabs) {
			if (seen.has(id)) continue;
			try {
				t.ws?.close();
			} catch {}
			tabs.delete(id);
		}
		if (current && !tabs.has(current)) {
			lost = current;
			current = null;
		}
	}

	async function tabStates() {
		await refreshTabs();
		return Promise.all(
			[...tabs.values()].map(async (t) => {
				let visible = null;
				try {
					visible = (await t.evaluate('document.visibilityState', 8000)) === 'visible';
				} catch {}
				return { id: t.id, url: t.url, title: t.title, visible, connected: !!t.ws };
			}),
		);
	}

	async function currentTab() {
		if (current) {
			if (!tabs.get(current)?.ws) await refreshTabs();
			const t = current && tabs.get(current);
			if (t?.ws) {
				await t.enableOnce();
				return t;
			}
		}
		if (lost) throw new Error(`The tab you were working on (${lost}) closed or disconnected. Run \`tabs\`, then \`use <id>\` to pick one; commands won't switch to another tab on their own.`);
		const states = await tabStates();
		const vis = states.find((s) => s.visible);
		if (!vis) throw new Error('No visible Safari tab. Unlock the iPhone and bring Safari (the tab to inspect) to the front, then retry. If it keeps failing, run `ios.mjs doctor`.');
		current = vis.id;
		await tabs.get(current).enableOnce();
		return tabs.get(current);
	}

	// Resolve a page element (any targetJs form) to a DOM nodeId by tagging it, then querying for the tag.
	async function nodeFor(tab, target) {
		const tag = 'p' + Date.now().toString(36);
		const ok = await tab.evaluate(`(() => { const el = ${target}; if (!el) return false; el.setAttribute('data-iwi-pick', '${tag}'); return true; })()`);
		if (!ok) throw new Error('no element matches');
		const doc = await tab.send('DOM.getDocument', { depth: 0 });
		const q = await tab.send('DOM.querySelector', { nodeId: doc.result.root.nodeId, selector: `[data-iwi-pick="${tag}"]` });
		tab.evaluate(`document.querySelector('[data-iwi-pick="${tag}"]')?.removeAttribute('data-iwi-pick')`).catch(() => {});
		if (!q.result?.nodeId) throw new Error('could not resolve element');
		return q.result.nodeId;
	}

	// A load waiter that is removed again when the caller gives up (timeout or error).
	function waitLoad(tab) {
		let fn;
		const loaded = new Promise((r) => tab.loadWaiters.push((fn = r)));
		return { loaded, cancel: () => (tab.loadWaiters = tab.loadWaiters.filter((w) => w !== fn)) };
	}

	// Debugger domain on demand: tracks parsed scripts and the current pause.
	async function ensureDebugger(tab) {
		if (tab.debuggerOn) return;
		if (tab.debuggerStarting) return tab.debuggerStarting;
		tab.debuggerStarting = startDebugger(tab).finally(() => (tab.debuggerStarting = null));
		return tab.debuggerStarting;
	}
	async function startDebugger(tab) {
		tab.scripts ||= new Map();
		tab.on('Debugger.scriptParsed', (p) => tab.scripts.set(p.scriptId, p));
		tab.on('Debugger.paused', (p) => (tab.pausedAt = p));
		tab.on('Debugger.resumed', () => (tab.pausedAt = null));
		tab.on('Debugger.globalObjectCleared', () => { tab.scripts.clear(); tab.pausedAt = null; });
		const r = await tab.send('Debugger.enable');
		if (r.error) {
			for (const m of ['Debugger.scriptParsed', 'Debugger.paused', 'Debugger.resumed', 'Debugger.globalObjectCleared']) tab.listeners.delete(m);
			throw new Error(r.error.message);
		}
		tab.debuggerOn = true;
		await sleep(300); // scriptParsed for already-loaded scripts arrives right after enable
	}

	const handlers = {
		async status() {
			return { transport, tabs: tabs.size, current };
		},
		async tabs() {
			const states = await tabStates();
			return states.map((s) => ({ ...s, current: s.id === current }));
		},
		async use({ match, reset }) {
			if (reset) {
				current = null;
				lost = null;
				return null;
			}
			const states = await tabStates();
			const hit = states.find((s) => s.id === match) || (/^\d+$/.test(match) && states.find((s) => s.id.endsWith(':' + match))) || states.find((s) => s.url.includes(match));
			if (!hit) throw new Error(`no tab matches "${match}"`);
			current = hit.id;
			lost = null;
			await tabs.get(current).enableOnce();
			return hit;
		},
		async open({ url, timeout = 30000 }) {
			const tab = await currentTab();
			tab.logs = [];
			tab.requests.clear();
			const { loaded, cancel } = waitLoad(tab);
			const r = await tab.send('Page.navigate', { url });
			if (r.error) {
				cancel();
				throw new Error(r.error.message);
			}
			const ok = await Promise.race([loaded.then(() => true), sleep(timeout).then(() => false)]);
			cancel();
			await sleep(800); // let trailing responses land so `net` right after shows statuses
			const info = await tab.evaluate('({url: location.href, title: document.title})');
			return { ...info, loaded: ok };
		},
		async reload({ timeout = 30000 }) {
			const tab = await currentTab();
			tab.logs = [];
			tab.requests.clear();
			const { loaded, cancel } = waitLoad(tab);
			await tab.send('Page.reload', {});
			const ok = await Promise.race([loaded.then(() => true), sleep(timeout).then(() => false)]);
			cancel();
			return { url: tab.url, loaded: ok };
		},
		async eval({ js, gesture }) {
			const tab = await currentTab();
			// A bare expression is returned as-is; statements need an explicit `return`.
			// Decided by parsing, so a `;` inside a string doesn't turn an expression into statements.
			let expression = !/^\s*(return|const|let|var|if|for|while|try|throw|class|function)\b/.test(js);
			if (expression) {
				try {
					new AsyncFunction(`return (${js}\n);`);
				} catch {
					expression = false;
				}
			}
			const body = expression ? `return (${js}\n);` : js;
			if (/\bawait\b/.test(js)) return tab.evaluateAsync(body, 30000, gesture);
			return tab.evaluate(`(() => { ${body} })()`, 20000, gesture);
		},
		async events({ filter, clear, last = 200 }) {
			const tab = await currentTab();
			let out = tab.events;
			if (filter) out = out.filter((e) => e.method.startsWith(filter) || e.method.includes(filter));
			out = out.slice(-last);
			if (clear) tab.events = [];
			return out;
		},

		// Full performance trace (Chrome trace format, built by the bridge from WebKit's Timeline + ScriptProfiler).
		async traceStart({ screenshots }) {
			const tab = await currentTab();
			tab.traceChunks = [];
			tab.offTrace?.();
			tab.offTrace = tab.on('Tracing.dataCollected', (p) => tab.traceChunks.push(...(p.value || [])));
			const cats = ['devtools.timeline', 'v8.execution', 'disabled-by-default-devtools.timeline', 'disabled-by-default-v8.cpu_profiler', 'blink.user_timing', 'loading', 'latencyInfo'];
			if (screenshots) cats.push('disabled-by-default-devtools.screenshot');
			const r = await tab.send('Tracing.start', { traceConfig: { includedCategories: cats }, transferMode: 'ReportEvents' });
			if (r.error) throw new Error(r.error.message);
			return 'tracing';
		},
		async traceStop({ path }) {
			const tab = await currentTab();
			let off;
			const done = new Promise((res) => {
				off = tab.on('Tracing.tracingComplete', () => res(true));
				setTimeout(() => res(false), 60000);
			}).finally(() => off());
			const r = await tab.send('Tracing.end');
			if (r.error) {
				off();
				throw new Error(r.error.message);
			}
			const complete = await done;
			tab.offTrace?.();
			const events = tab.traceChunks || [];
			tab.traceChunks = null;
			writeFileSync(path, JSON.stringify({ traceEvents: events }));
			return { path, complete, ...summarizeTrace(events) };
		},

		// JS CPU profile (.cpuprofile, opens in Chrome DevTools / speedscope).
		async profileStart() {
			const tab = await currentTab();
			const r = await tab.send('Profiler.start');
			if (r.error) throw new Error(r.error.message);
			return 'profiling';
		},
		async profileStop({ path }) {
			const tab = await currentTab();
			const r = await tab.send('Profiler.stop', {}, 60000);
			if (r.error) throw new Error(r.error.message);
			writeFileSync(path, JSON.stringify(r.result.profile));
			return { path, ...summarizeProfile(r.result.profile) };
		},

		// Heap snapshot (.heapsnapshot, opens in Chrome DevTools Memory tab).
		async heap({ path }) {
			const tab = await currentTab();
			const chunks = [];
			const off = tab.on('HeapProfiler.addHeapSnapshotChunk', (p) => chunks.push(p.chunk));
			const r = await tab.send('HeapProfiler.takeHeapSnapshot', { reportProgress: false }, 120000);
			off();
			if (r.error) throw new Error(r.error.message);
			const data = chunks.join('');
			writeFileSync(path, data);
			let nodes = null;
			try {
				const j = JSON.parse(data);
				nodes = j.snapshot?.node_count ?? null;
			} catch {}
			return { path, bytes: data.length, nodes };
		},

		// Request interception: block or answer requests whose URL contains `match`.
		async intercept({ action, match, status = 200, body = '', contentType = 'application/json' }) {
			const tab = await currentTab();
			if (action === 'clear') tab.fetchRules = match ? tab.fetchRules.filter((r) => r.match !== match) : [];
			else if (action === 'block' || action === 'mock') {
				tab.fetchRules = tab.fetchRules.filter((r) => r.match !== match);
				tab.fetchRules.push({ match, action, status: Number(status), body, contentType });
			}
			const r = await tab.send(tab.fetchRules.length ? 'Fetch.enable' : 'Fetch.disable', tab.fetchRules.length ? { patterns: [{ urlPattern: '*' }] } : {});
			if (r.error) throw new Error(r.error.message);
			return tab.fetchRules.map(({ match: m, action: a, status: s, hits }) => ({ match: m, action: a, status: a === 'mock' ? s : undefined, hits: hits || 0 }));
		},
		async nocache({ on }) {
			const tab = await currentTab();
			const r = await tab.send('Network.setCacheDisabled', { cacheDisabled: on });
			if (r.error) throw new Error(r.error.message);
			return { cacheDisabled: on };
		},
		async media({ value }) {
			const tab = await currentTab();
			const params = value === 'print' || value === 'screen' ? { media: value } : value === 'dark' || value === 'light' ? { media: '', features: [{ name: 'prefers-color-scheme', value }] } : { media: '', features: [] };
			const r = await tab.send('Emulation.setEmulatedMedia', params);
			if (r.error) throw new Error(r.error.message);
			return params;
		},
		// The bridge accepts Page.addScriptToEvaluateOnNewDocument but drops the script; WebKit's own
		// Page.setBootstrapScript works. It holds a single script, so injected snippets are concatenated.
		async inject({ source, clear }) {
			const tab = await currentTab();
			tab.injected = clear ? [] : [...(tab.injected || []), source];
			const r = await tab.send('Page.setBootstrapScript', tab.injected.length ? { source: tab.injected.map((s) => `try { ${s}\n} catch (e) { console.error('inject:', e); }`).join('\n') } : {});
			if (r.error) throw new Error(r.error.message);
			return { scripts: tab.injected.length, appliesFrom: 'next navigation/reload' };
		},
		async listeners({ target }) {
			const tab = await currentTab();
			// The bridge can't translate DOMDebugger.getEventListeners; WebKit's own DOM.getEventListenersForNode
			// works and also returns listeners on ancestors that the event would bubble through.
			const nodeId = await nodeFor(tab, target);
			const r = await tab.send('DOM.getEventListenersForNode', { nodeId });
			if (r.error) throw new Error(r.error.message);
			const names = new Map();
			for (const l of r.result.listeners || []) {
				if (names.has(l.nodeId)) continue;
				const d = await tab.send('DOM.describeNode', { nodeId: l.nodeId });
				const n = d.result?.node;
				names.set(l.nodeId, n ? n.localName || n.nodeName : `node ${l.nodeId}`);
			}
			return (r.result.listeners || []).map((l) => ({
				type: l.type,
				on: l.nodeId === nodeId ? 'element' : names.get(l.nodeId),
				capture: l.useCapture,
				passive: l.passive || undefined,
				once: l.once || undefined,
				attr: l.isAttribute || undefined,
				where: l.location && `script ${l.location.scriptId}:${l.location.lineNumber + 1}:${l.location.columnNumber + 1}`,
			}));
		},

		// Screen recording: JPEG frames from Page.startScreencast written to a folder.
		async screencastStart({ dir, quality = 60, everyNthFrame = 1 }) {
			const tab = await currentTab();
			mkdirSync(dir, { recursive: true });
			tab.cast = { dir, n: 0, t0: Date.now() };
			tab.offCast?.();
			tab.offCast = tab.on('Page.screencastFrame', (p) => {
				const c = tab.cast;
				if (!c) return;
				const ms = Date.now() - c.t0;
				try {
					writeFileSync(join(c.dir, `${String(c.n++).padStart(4, '0')}-${ms}ms.jpg`), Buffer.from(p.data, 'base64'));
				} catch (e) {
					c.error = e.message;
					tab.cast = null;
					tab.send('Page.stopScreencast').catch(() => {});
					return;
				}
				tab.send('Page.screencastFrameAck', { sessionId: p.sessionId }).catch(() => {});
			});
			const r = await tab.send('Page.startScreencast', { format: 'jpeg', quality, maxWidth: 1179, maxHeight: 2556, everyNthFrame });
			if (r.error) throw new Error(r.error.message);
			return { dir };
		},
		async screencastStop() {
			const tab = await currentTab();
			await tab.send('Page.stopScreencast');
			tab.offCast?.();
			const c = tab.cast;
			tab.cast = null;
			return { dir: c?.dir, frames: c?.n ?? 0, seconds: c ? (Date.now() - c.t0) / 1000 : 0 };
		},
		async logs({ clear, level }) {
			const tab = await currentTab();
			let out = tab.logs;
			if (level) out = out.filter((l) => l.level === level || (level === 'error' && l.kind === 'exception'));
			out = out.map((l) => ({ ...l }));
			if (clear) tab.logs = [];
			return out;
		},
		async net({ filter, failed }) {
			const tab = await currentTab();
			let out = [...tab.requests.values()];
			if (filter) out = out.filter((r) => r.url.includes(filter));
			if (failed) out = out.filter((r) => r.failed || r.status >= 400);
			return out.map(({ id, method, status, type, mime, bytes, ms, failed: f, url }) => ({ id, method, status, type, mime, bytes, ms, failed: f, url }));
		},
		async req({ match }) {
			const tab = await currentTab();
			const r = tab.requests.get(match) || [...tab.requests.values()].reverse().find((x) => x.url.includes(match));
			if (!r) throw new Error(`no request matches "${match}"`);
			return r;
		},
		async body({ match }) {
			const tab = await currentTab();
			const r = tab.requests.get(match) || [...tab.requests.values()].reverse().find((x) => x.url.includes(match));
			if (!r) throw new Error(`no request matches "${match}"`);
			const b = await tab.send('Network.getResponseBody', { requestId: r.id });
			if (b.error) throw new Error(b.error.message);
			return { url: r.url, status: r.status, mime: r.mime, base64: b.result.base64Encoded, body: b.result.body };
		},
		async shot({ path }) {
			const tab = await currentTab();
			const r = await tab.send('Page.captureScreenshot', { format: 'png' });
			if (r.error) throw new Error(r.error.message + (r.error.message.includes('empty') ? ' (tab is not visible on the iPhone screen)' : ''));
			writeFileSync(path, Buffer.from(r.result.data, 'base64'));
			return { path };
		},
		async usageStart() {
			const tab = await currentTab();
			tab.trace = [];
			tab.traceRequests = 0;
			const res = {};
			// The bridge forwards CPU and memory sampling (every ~500ms) but not Timeline/ScriptProfiler events.
			for (const m of ['CPUProfiler.startTracking', 'Memory.startTracking']) {
				const r = await tab.send(m);
				res[m] = r.error ? r.error.message : 'ok';
			}
			return res;
		},
		async usageStop({ path }) {
			const tab = await currentTab();
			for (const m of ['CPUProfiler.stopTracking', 'Memory.stopTracking']) await tab.send(m);
			await sleep(800);
			const events = tab.trace || [];
			tab.trace = null;
			writeFileSync(path, JSON.stringify(events));
			const cpu = events.filter((e) => e.method === 'CPUProfiler.trackingUpdate').map((e) => e.params.event);
			const mem = events.filter((e) => e.method === 'Memory.trackingUpdate').map((e) => e.params.event);
			const t0 = cpu[0]?.timestamp ?? mem[0]?.timestamp ?? 0;
			const mb = (b) => Math.round(b / 104857.6) / 10;
			const samples = cpu.map((c, i) => {
				const m = mem.find((x) => Math.abs(x.timestamp - c.timestamp) < 0.05) || mem[i];
				const cats = Object.fromEntries((m?.categories || []).map((k) => [k.type, mb(k.size)]));
				return { t: Math.round((c.timestamp - t0) * 10) / 10, cpu: Math.round(c.usage), main: Math.round(c.threads?.find((th) => th.type === 'main')?.usage ?? 0), memMB: Math.round(Object.values(cats).reduce((a, b) => a + b, 0)), ...cats };
			});
			const peak = (k) => samples.reduce((a, s) => (s[k] > (a?.[k] ?? -1) ? s : a), null);
			return { path, samples, peakCpu: peak('cpu'), peakMain: peak('main'), peakMem: peak('memMB'), requests: tab.traceRequests || 0 };
		},
		// ---- Elements
		async snapshot({ all }) {
			const tab = await currentTab();
			return tab.evaluate(`(() => { const ONLY_VIEWPORT = ${!all}; ${SNAPSHOT_JS} })()`);
		},
		async dom({ target, depth = 2000 }) {
			const tab = await currentTab();
			return tab.evaluate(`(() => {
				const el = ${target};
				if (!el) throw new Error('no element');
				const r = el.getBoundingClientRect(), cs = getComputedStyle(el);
				const html = el.outerHTML;
				return { tag: el.tagName.toLowerCase(), box: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) },
					margin: cs.margin, padding: cs.padding, border: cs.borderWidth, display: cs.display, position: cs.position,
					html: html.length > ${depth} ? html.slice(0, ${depth}) + '…' : html };
			})()`);
		},
		async styles({ target, computed }) {
			const tab = await currentTab();
			const nodeId = await nodeFor(tab, target);
			await tab.send('CSS.enable');
			const m = await tab.send('CSS.getMatchedStylesForNode', { nodeId, includePseudo: false, includeInherited: false });
			if (m.error) throw new Error(m.error.message);
			const rules = (m.result.matchedCSSRules || []).map((x) => {
				const r = x.rule;
				const src = r.sourceURL ? `${r.sourceURL.split('/').pop().split('?')[0]}:${(r.sourceLine ?? 0) + 1}` : r.origin;
				const props = (r.style?.cssProperties || []).filter((p) => p.text && !p.disabled && p.status !== 'inactive').map((p) => `${p.name}: ${p.value}${p.priority ? ' !' + p.priority : ''}${p.parsedOk === false ? ' (invalid)' : ''}`);
				return { selector: r.selectorList?.text, origin: r.origin, source: src, media: (r.media || []).map((q) => q.text).join(' and ') || undefined, props };
			}).reverse(); // most specific / last first, like DevTools
			const inline = m.result.inlineStyle?.cssProperties?.filter((p) => p.text).map((p) => `${p.name}: ${p.value}`) || [];
			let comp;
			if (computed) {
				const c = await tab.send('CSS.getComputedStyleForNode', { nodeId });
				const want = computed === true ? null : new Set(String(computed).split(','));
				comp = Object.fromEntries((c.result?.computedStyle || []).filter((p) => (want ? want.has(p.name) : true)).map((p) => [p.name, p.value]));
			}
			return { inline, rules, computed: comp };
		},
		async a11y({ target }) {
			const tab = await currentTab();
			const nodeId = await nodeFor(tab, target);
			const r = await tab.send('DOM.getAccessibilityPropertiesForNode', { nodeId });
			if (r.error) throw new Error(r.error.message);
			const { childNodeIds, parentNodeId, nodeId: _n, controlledNodeIds, flowedNodeIds, ownedNodeIds, labelledByNodeIds, ...props } = r.result.properties;
			return props;
		},
		async highlight({ target, off }) {
			const tab = await currentTab();
			if (off) return (await tab.send('DOM.hideHighlight')).error ? 'failed' : 'hidden';
			const nodeId = await nodeFor(tab, target);
			const cfg = { showInfo: true, contentColor: { r: 111, g: 168, b: 220, a: 0.55 }, paddingColor: { r: 147, g: 196, b: 125, a: 0.55 }, borderColor: { r: 255, g: 229, b: 153, a: 0.66 }, marginColor: { r: 246, g: 178, b: 107, a: 0.66 } };
			const r = await tab.send('DOM.highlightNode', { nodeId, highlightConfig: cfg });
			if (r.error) throw new Error(r.error.message);
			return 'highlighted on the phone (ios highlight --off to clear)';
		},
		async pseudo({ target, classes }) {
			const tab = await currentTab();
			const nodeId = await nodeFor(tab, target);
			await tab.send('CSS.enable');
			const list = classes && classes !== 'off' ? classes.split(',') : [];
			const r = await tab.send('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: list });
			if (r.error) throw new Error(r.error.message);
			return { forced: list };
		},
		async layers() {
			const tab = await currentTab();
			await tab.send('LayerTree.enable');
			const doc = await tab.send('DOM.getDocument', { depth: 0 });
			const r = await tab.send('LayerTree.layersForNode', { nodeId: doc.result.root.nodeId });
			if (r.error) throw new Error(r.error.message);
			const out = [];
			for (const l of r.result.layers || []) {
				const why = await tab.send('LayerTree.reasonsForCompositingLayer', { layerId: l.layerId });
				const reasons = Object.entries(why.result?.compositingReasons || {}).filter(([, v]) => v).map(([k]) => k);
				let node = '';
				if (l.nodeId) {
					const d = await tab.send('DOM.describeNode', { nodeId: l.nodeId });
					const n = d.result?.node;
					if (n) node = (n.localName || n.nodeName) + (n.attributes ? (() => { const a = n.attributes; let id, cl; for (let i = 0; i < a.length; i += 2) { if (a[i] === 'id') id = a[i + 1]; if (a[i] === 'class') cl = a[i + 1]; } return (id ? '#' + id : '') + (cl ? '.' + String(cl).split(' ')[0] : ''); })() : '');
				}
				out.push({ layerId: l.layerId, node: node || (l.isGeneratedContent ? 'pseudo' : l.isAnonymous ? 'anonymous' : ''), size: `${Math.round(l.bounds.width)}×${Math.round(l.bounds.height)}`, memoryKB: Math.round((l.memory || 0) / 1024), paints: l.paintCount, reasons });
			}
			return out;
		},

		// ---- Application
		async cookies({ clear, values }) {
			const tab = await currentTab();
			const r = await tab.send('Page.getCookies');
			if (r.error) throw new Error(r.error.message);
			const list = r.result.cookies || [];
			if (clear) {
				for (const c of list.filter((c) => clear === true || c.name === clear)) await tab.send('Page.deleteCookie', { cookieName: c.name, url: tab.url });
				return { deleted: list.filter((c) => clear === true || c.name === clear).map((c) => c.name) };
			}
			return list.map((c) => ({ name: c.name, value: values ? (c.value.length > 60 ? c.value.slice(0, 60) + '…' : c.value) : `<${c.value.length} chars, --values to show>`, domain: c.domain, path: c.path, expires: c.session || !(c.expires > 0) ? 'session' : new Date(c.expires < 1e11 ? c.expires * 1000 : c.expires).toISOString().slice(0, 10), httpOnly: c.httpOnly, secure: c.secure, sameSite: c.sameSite }));
		},
		async storage({ kind = 'local', clear }) {
			const tab = await currentTab();
			const store = kind === 'session' ? 'sessionStorage' : 'localStorage';
			if (clear) return tab.evaluate(`(() => { const n = ${store}.length; ${store}.clear(); return { cleared: n }; })()`);
			return tab.evaluate(`Object.fromEntries(Object.keys(${store}).map((k) => { const v = ${store}.getItem(k); return [k, v.length > 200 ? v.slice(0, 200) + '…' : v]; }))`);
		},
		async idb() {
			const tab = await currentTab();
			await tab.send('IndexedDB.enable');
			const origin = new URL(tab.url).origin;
			const names = await tab.send('IndexedDB.requestDatabaseNames', { securityOrigin: origin });
			if (names.error) throw new Error(names.error.message);
			const out = [];
			for (const name of names.result.databaseNames || []) {
				const d = await tab.send('IndexedDB.requestDatabase', { securityOrigin: origin, databaseName: name });
				const db = d.result?.databaseWithObjectStores;
				out.push({ name, version: db?.version, stores: (db?.objectStores || []).map((o) => ({ name: o.name, keyPath: o.keyPath?.string ?? o.keyPath?.array, indexes: (o.indexes || []).map((i) => i.name) })) });
			}
			return { origin, databases: out };
		},

		// ---- Sources / debugger
		async scripts({ filter }) {
			const tab = await currentTab();
			await ensureDebugger(tab);
			let list = [...tab.scripts.values()].filter((sc) => sc.url);
			if (filter) list = list.filter((sc) => sc.url.includes(filter));
			return list.map((sc) => ({ id: sc.scriptId, url: sc.url, lines: sc.endLine + 1 }));
		},
		async source({ match }) {
			const tab = await currentTab();
			await ensureDebugger(tab);
			const sc = tab.scripts.get(match) || [...tab.scripts.values()].reverse().find((x) => x.url && x.url.includes(match));
			if (!sc) throw new Error(`no script matches "${match}" (see scripts)`);
			const r = await tab.send('Debugger.getScriptSource', { scriptId: sc.scriptId });
			if (r.error) throw new Error(r.error.message);
			return { url: sc.url, source: r.result.scriptSource };
		},
		async breakpoint({ action, match, line, condition }) {
			const tab = await currentTab();
			await ensureDebugger(tab);
			tab.breakpoints ||= new Map();
			if (action === 'clear') {
				for (const id of tab.breakpoints.keys()) await tab.send('Debugger.removeBreakpoint', { breakpointId: id });
				tab.breakpoints.clear();
				return 'all breakpoints removed';
			}
			if (action === 'list') return [...tab.breakpoints.entries()].map(([id, b]) => ({ id, ...b }));
			const r = await tab.send('Debugger.setBreakpointByUrl', { urlRegex: match.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), lineNumber: Number(line) - 1, ...(condition && { condition }) });
			if (r.error) throw new Error(r.error.message);
			tab.breakpoints.set(r.result.breakpointId, { match, line: Number(line), condition, resolved: (r.result.locations || []).length });
			return { id: r.result.breakpointId, resolvedLocations: (r.result.locations || []).length };
		},
		async pauseOn({ state }) {
			const tab = await currentTab();
			await ensureDebugger(tab);
			const r = await tab.send('Debugger.setPauseOnExceptions', { state });
			if (r.error) throw new Error(r.error.message);
			return { pauseOnExceptions: state };
		},
		async paused({ locals }) {
			const tab = await currentTab();
			if (!tab.pausedAt) return { paused: false };
			const p = tab.pausedAt;
			const frames = p.callFrames.map((f) => {
				const sc = tab.scripts.get(f.location.scriptId);
				return { fn: f.functionName || '(anonymous)', at: `${sc?.url ? sc.url.split('/').pop().split('?')[0] : f.location.scriptId}:${f.location.lineNumber + 1}:${(f.location.columnNumber ?? 0) + 1}` };
			});
			let scope;
			if (locals !== false) {
				const top = p.callFrames[0];
				const local = (top.scopeChain || []).find((s) => s.type === 'local') || top.scopeChain?.[0];
				if (local?.object?.objectId) {
					const props = await tab.send('Runtime.getProperties', { objectId: local.object.objectId, ownProperties: true });
					scope = Object.fromEntries((props.result?.result || []).slice(0, 40).map((v) => [v.name, v.value ? ('value' in v.value ? v.value.value : v.value.description || v.value.type) : '?']));
				}
			}
			let line;
			const sc = tab.scripts.get(p.callFrames[0].location.scriptId);
			if (sc) {
				const src = await tab.send('Debugger.getScriptSource', { scriptId: sc.scriptId });
				const lines = (src.result?.scriptSource || '').split('\n');
				const ln = p.callFrames[0].location.lineNumber, col = p.callFrames[0].location.columnNumber ?? 0;
				const text = lines[ln] || '';
				line = text.length > 200 ? text.slice(Math.max(0, col - 80), col + 120) : text;
			}
			return { paused: true, reason: p.reason, data: p.data, line, frames, scope };
		},
		async step({ how }) {
			const tab = await currentTab();
			await ensureDebugger(tab);
			const method = { over: 'Debugger.stepOver', into: 'Debugger.stepInto', out: 'Debugger.stepOut', resume: 'Debugger.resume', pause: 'Debugger.pause' }[how];
			if (!method) throw new Error('step over|into|out, resume, pause');
			const wasPaused = !!tab.pausedAt;
			const next = new Promise((res) => {
				const off = tab.on('Debugger.paused', () => { off(); res(true); });
				setTimeout(() => { off(); res(false); }, how === 'resume' ? 300 : 5000);
			});
			const r = await tab.send(method);
			if (r.error) throw new Error(r.error.message);
			const pausedAgain = await next;
			return { [how]: true, wasPaused, paused: pausedAgain || !!tab.pausedAt };
		},
		async frameEval({ js }) {
			const tab = await currentTab();
			if (!tab.pausedAt) throw new Error('not paused');
			const r = await tab.send('Debugger.evaluateOnCallFrame', { callFrameId: tab.pausedAt.callFrames[0].callFrameId, expression: js, returnByValue: true });
			if (r.error) throw new Error(r.error.message);
			if (r.result.wasThrown || r.result.exceptionDetails) throw new Error(r.result.result?.description || 'threw');
			return r.result.result?.value ?? r.result.result?.description;
		},

		// ---- Rendering / emulation
		async paintflash({ on }) {
			const tab = await currentTab();
			const r = await tab.send('Page.setShowPaintRects', { result: on });
			if (r.error) throw new Error(r.error.message);
			return { paintFlashing: on };
		},
		async ua({ value }) {
			const tab = await currentTab();
			const r = await tab.send('Page.overrideUserAgent', value ? { value } : {});
			if (r.error) throw new Error(r.error.message);
			return { userAgent: value || 'default', appliesFrom: 'next request / reload' };
		},
		async jsEnabled({ on }) {
			const tab = await currentTab();
			const r = await tab.send('Page.overrideSetting', on ? { setting: 'ScriptEnabled' } : { setting: 'ScriptEnabled', value: false });
			if (r.error) throw new Error(r.error.message);
			return { javascript: on ? 'default' : 'disabled', appliesFrom: 'next reload' };
		},

		// ---- Network extras
		async har() {
			const tab = await currentTab();
			const entries = [...tab.requests.values()].map((r) => ({
				startedDateTime: new Date(r.t).toISOString(),
				time: r.ms ?? 0,
				request: { method: r.method, url: r.url, httpVersion: r.protocol || 'unknown', headers: Object.entries(r.reqHeaders || {}).map(([name, value]) => ({ name, value: String(value) })), queryString: [...new URL(r.url).searchParams].map(([name, value]) => ({ name, value })), cookies: [], headersSize: -1, bodySize: r.postData ? r.postData.length : 0, ...(r.postData && { postData: { mimeType: (r.reqHeaders || {})['Content-Type'] || '', text: r.postData } }) },
				response: { status: r.status ?? 0, statusText: r.failed || '', httpVersion: r.protocol || 'unknown', headers: Object.entries(r.headers || {}).map(([name, value]) => ({ name, value: String(value) })), cookies: [], content: { size: r.bytes ?? 0, mimeType: r.mime || '' }, redirectURL: '', headersSize: -1, bodySize: r.bytes ?? -1 },
				cache: {},
				timings: { send: 0, wait: r.ms ?? 0, receive: 0 },
				_resourceType: r.type,
			}));
			return { log: { version: '1.2', creator: { name: 'iphone-webkit-inspector', version: PLUGIN_VERSION, comment: 'partial: redirect hops and per-phase timings are not captured; all time is under wait' }, pages: [{ startedDateTime: entries[0]?.startedDateTime || new Date().toISOString(), id: 'page_1', title: tab.url, pageTimings: {} }], entries } };
		},
		async websockets() {
			const tab = await currentTab();
			return tab.events
				.filter((e) => /^Network\.webSocket/.test(e.method))
				.map((e) => ({ t: new Date(e.t).toISOString().slice(11, 23), event: e.method.replace('Network.webSocket', ''), url: e.params.url, data: (e.params.response || e.params.request)?.payloadData?.slice(0, 200), opcode: (e.params.response || e.params.request)?.opcode }));
		},

		async perf() {
			const tab = await currentTab();
			return tab.evaluateAsync(PERF_JS);
		},
		async cdp({ method, params }) {
			const tab = await currentTab();
			return tab.send(method, params || {});
		},
		async stop() {
			setTimeout(shutdown, 50);
			return 'stopping';
		},
	};

	// Only this user can open the socket (it lives in a 0700 directory).
	const server = createServer(async (req, res) => {
		try {
			if (req.method !== 'POST') {
				res.writeHead(405).end();
				req.resume();
				return;
			}
			let body = '';
			for await (const c of req) {
				body += c;
				if (body.length > 20e6) throw new Error('request too large');
			}
			const cmd = req.url.slice(1);
			const fn = handlers[cmd];
			let out;
			try {
				if (!fn) throw new Error(`unknown command ${cmd}`);
				out = { ok: true, result: await fn(body ? JSON.parse(body) : {}) };
			} catch (e) {
				out = { ok: false, error: e.message };
			}
			res.setHeader('content-type', 'application/json');
			res.end(JSON.stringify(out));
		} catch (e) {
			log('request failed', e.message);
			if (!res.headersSent) res.writeHead(400);
			res.end();
		}
	});
	server.on('error', (e) => {
		// Socket taken (another daemon won the race): leave its pid/socket alone and exit.
		log('daemon could not listen', e.message);
		bridge.kill();
		process.exit(1);
	});
	// A socket file nobody answers on is left over from a crash; remove it before listening.
	const alive = await new Promise((res) => {
		const c = createConnection(SOCKET);
		c.on('connect', () => {
			c.destroy();
			res(true);
		});
		c.on('error', () => res(false));
	});
	if (alive) {
		log('another daemon is already running');
		bridge.kill();
		process.exit(1);
	}
	rmSync(SOCKET, { force: true });
	server.listen(SOCKET, () => {
		try {
			chmodSync(SOCKET, 0o600);
		} catch {}
		writeFileSync(PID_FILE, String(process.pid), { mode: 0o600 });
		log('daemon ready on', SOCKET);
	});

	refreshTabs().catch((e) => log('initial attach failed', e.message));
}

// ---------------------------------------------------------------- client

async function call(cmd, args = {}) {
	const text = await new Promise((res, rej) => {
		const body = JSON.stringify(args);
		const req = request({ socketPath: SOCKET, path: '/' + cmd, method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, (r) => {
			let out = '';
			r.setEncoding('utf8');
			r.on('data', (c) => (out += c));
			r.on('end', () => res(out));
			r.on('error', rej);
		});
		req.on('error', rej);
		req.end(body);
	});
	const d = JSON.parse(text);
	if (!d.ok) throw new Error(d.error);
	return d.result;
}

async function daemonUp() {
	try {
		await call('status');
		return true;
	} catch {
		return false;
	}
}

async function ensureDaemon() {
	if (await daemonUp()) return;
	ensureStateDir();
	// One starter at a time; a lock older than 2 minutes is from a crashed start and is taken over.
	let starter = false;
	try {
		openSync(LOCK_FILE, 'wx');
		starter = true;
	} catch {
		try {
			if (Date.now() - statSync(LOCK_FILE).mtimeMs > 120000) {
				writeFileSync(LOCK_FILE, '');
				starter = true;
			}
		} catch {}
	}
	if (starter) {
		const out = openSync(LOG_FILE, 'a', 0o600);
		try {
			chmodSync(LOG_FILE, 0o600);
		} catch {}
		const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '__daemon'], { detached: true, stdio: ['ignore', out, out] });
		child.unref();
	}
	const unlock = () => starter && rmSync(LOCK_FILE, { force: true });
	process.stderr.write('starting iPhone bridge');
	for (let i = 0; i < 180; i++) {
		await sleep(500);
		if (await daemonUp()) {
			process.stderr.write(' ok\n');
			unlock();
			return;
		}
		if (i % 4 === 0) process.stderr.write('.');
	}
	throw new Error(`daemon did not start; see ${LOG_FILE}`);
}

function run(cmd, args) {
	return new Promise((res) => {
		let out = '';
		const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
		p.stdout.on('data', (d) => (out += d));
		p.stderr.on('data', (d) => (out += d));
		p.on('error', () => res({ code: -1, out }));
		p.on('exit', (code) => res({ code, out }));
	});
}

async function devicectlJson(args) {
	const file = join(tmpdir(), `devicectl-${process.pid}-${Date.now()}.json`);
	await run('xcrun', ['devicectl', ...args, '--json-output', file]);
	try {
		return JSON.parse(readFileSync(file, 'utf8')).result;
	} catch {
		return null;
	} finally {
		rmSync(file, { force: true });
	}
}

// Walks the setup in order and stops at the first thing the user has to fix.
async function doctor(skipChrome) {
	let failed = false;
	const ok = (m) => console.log(`✓ ${m}`);
	const bad = (m, fix) => {
		failed = true;
		process.exitCode = 1;
		console.log(`✗ ${m}\n    → ${fix}`);
	};

	const sel = await run('xcode-select', ['-p']);
	if (!sel.out.includes('Xcode.app')) return bad(`developer dir is ${sel.out.trim()}`, 'sudo xcode-select -s /Applications/Xcode.app/Contents/Developer');
	ok('Xcode selected');
	if ((await run('xcodebuild', ['-checkFirstLaunchStatus'])).code !== 0) return bad('Xcode license / first launch not done', 'sudo xcodebuild -license accept && sudo xcodebuild -runFirstLaunch');
	ok('Xcode license and first launch');
	if ((await run('uvx', ['--version'])).code !== 0) return bad('uvx not found', 'brew install uv');
	ok('uvx available');

	const devices = (await devicectlJson(['list', 'devices']))?.devices || [];
	const dev = devices.find((d) => d.connectionProperties?.tunnelState === 'connected') || devices.find((d) => d.connectionProperties?.transportType === 'wired');
	if (!dev) return bad('no iPhone connected', 'plug the iPhone in by USB and tap "Trust" on the phone');
	const udid = dev.hardwareProperties?.udid || dev.identifier;
	ok(`iPhone: ${dev.deviceProperties?.name} (iOS ${dev.deviceProperties?.osVersionNumber})`);
	if (dev.deviceProperties?.developerModeStatus && dev.deviceProperties.developerModeStatus !== 'enabled') return bad('Developer Mode is off', 'iPhone Settings → Privacy & Security → Developer Mode → On (reboots)');
	ok('Developer Mode on');

	await ensureDaemon();
	ok('Web Inspector bridge running');

	const visibleUA = async () => {
		for (let i = 0; i < 12; i++) {
			await call('use', { reset: true }).catch(() => {});
			try {
				return await call('eval', { js: 'navigator.userAgent' });
			} catch {}
			await sleep(1000);
		}
		return null;
	};

	await run('xcrun', ['devicectl', 'device', 'process', 'launch', '--device', udid, 'com.apple.mobilesafari']);
	const sUA = await visibleUA();
	if (!sUA) bad('Safari tab not inspectable', 'unlock the iPhone; Settings → Apps → Safari → Advanced → Web Inspector On; keep a page open in Safari');
	else ok('Safari Web Inspector on (tab on screen answers)');

	if (!skipChrome) {
		const apps = (await devicectlJson(['device', 'info', 'apps', '--device', udid, '--include-all-apps']))?.apps || [];
		if (!apps.some((a) => a.bundleIdentifier === 'com.google.chrome.ios')) console.log('- Chrome not installed (optional)');
		else {
			await run('xcrun', ['devicectl', 'device', 'process', 'launch', '--device', udid, 'com.google.chrome.ios']);
			const cUA = await visibleUA();
			if (cUA?.includes('CriOS')) ok('Chrome Web Inspector on');
			else bad('Chrome tab not inspectable', 'Chrome → ⋯ → Settings → Content Settings → Web Inspector On, then: ios.mjs launch chrome --restart');
			await run('xcrun', ['devicectl', 'device', 'process', 'launch', '--device', udid, 'com.apple.mobilesafari']);
			await call('use', { reset: true }).catch(() => {});
		}
	}
	console.log('- Remote Automation is not needed (this tool uses Web Inspector + devicectl, not safaridriver)');
	console.log(failed ? '\nfix the ✗ items above and run doctor again' : '\nall good');
	if (failed) process.exitCode = 1;
}

const REPO = 'GUMBOKIM/iphone-webkit-inspector';
// Keep in sync with .claude-plugin/plugin.json.
const PLUGIN_VERSION = '0.6.0';

// Collects versions, the device model, doctor output and the daemon log tail into an issue body.
// Device and Mac names, UDIDs, home paths and visited URLs are redacted.
async function report({ title, what }) {
	const line = async (cmd, args) => (await run(cmd, args)).out.trim().split('\n')[0];
	const devices = (await devicectlJson(['list', 'devices']))?.devices || [];
	const dev = devices.find((d) => d.connectionProperties?.tunnelState === 'connected') || devices[0];
	let status = 'daemon not running';
	if (await daemonUp()) status = JSON.stringify(await call('status').catch((e) => e.message));
	const doc = (await run(process.execPath, [fileURLToPath(import.meta.url), 'doctor', '--no-chrome'])).out.trim();
	let log = '';
	try {
		log = readFileSync(LOG_FILE, 'utf8').split('\n').slice(-60).join('\n');
	} catch {}
	const names = devices.map((d) => d.deviceProperties?.name).filter(Boolean);
	const redact = (t) => {
		// URLs go first, so a later name substitution can't cut a URL short and leave its path behind.
		// Pages the user visited stay private: keep only the scheme.
		let out = String(t)
			.replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>)]+/gi, (u) => {
				try {
					const p = new URL(u);
					if (['127.0.0.1', 'localhost'].includes(p.hostname)) return `${p.protocol}//${p.host}/<path>`;
				} catch {}
				return u.split('://')[0] + '://<url>';
			})
			.replace(/\b(data|blob|javascript|about):[^\s"'<>)]+/gi, '$1:<redacted>')
			.replace(/PID%3A\d+%3A\d+|PID:\d+:\d+/g, '<tab>');
		out = out.replaceAll(homedir(), '~').replace(/\b[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}\b/gi, '<udid>').replace(/\b[0-9A-F]{8}-[0-9A-F]{16}\b/gi, '<udid>').replace(/\b[0-9a-f]{40}\b/gi, '<udid>');
		for (const n of names) out = out.replaceAll(n, '<device>');
		const host = hostname().split('.')[0];
		if (host && host.length > 3) out = out.replaceAll(host, '<mac>');
		return out;
	};
	const env = [
		`plugin: ${PLUGIN_VERSION}`,
		`macOS: ${await line('sw_vers', ['-productVersion'])}`,
		`Xcode: ${await line('xcodebuild', ['-version'])}`,
		`node: ${process.version}`,
		`uv: ${await line('uv', ['--version'])}`,
		`pymobiledevice3: ${PMD3.split('==')[1]}`,
		`device: ${dev ? `${dev.hardwareProperties?.marketingName || dev.hardwareProperties?.productType} / iOS ${dev.deviceProperties?.osVersionNumber} / ${dev.connectionProperties?.transportType}` : 'none found'}`,
		`daemon: ${status}`,
	].join('\n');
	const body = redact(`### What happened\n\n${what || '<!-- what you ran and what went wrong -->'}\n\n### Environment\n\n\`\`\`\n${env}\n\`\`\`\n\n### doctor\n\n\`\`\`\n${doc}\n\`\`\`\n\n### Daemon log (last 60 lines)\n\n\`\`\`\n${log || '(empty)'}\n\`\`\`\n`);
	const file = join(tmpdir(), `iphone-webkit-inspector-report-${Date.now()}.md`);
	writeFileSync(file, body);
	const t = redact(title || 'Bug: ');
	const short = body.length > 6000 ? body.slice(0, 6000) + '\n…(truncated, full report in the file)' : body;
	console.log(`report saved: ${file}\n`);
	console.log(`open to file an issue (review it first):\nhttps://github.com/${REPO}/issues/new?labels=bug&title=${encodeURIComponent(t)}&body=${encodeURIComponent(short)}`);
}

// DVT developer services (full-screen screenshot, display FPS). On iOS 17+ they need the developer
// tunnel; --native reuses the one macOS already keeps for Xcode, over Wi-Fi or USB.
function pmd3Dev(args, { onLine, timeoutMs } = {}) {
	return new Promise((res) => {
		let out = '';
		const p = spawn('uvx', ['--python', '3.12', '--from', PMD3, 'pymobiledevice3', 'developer', ...args, '--native'], { stdio: ['ignore', 'pipe', 'pipe'] });
		const take = (d) => {
			out += d;
			if (onLine) for (const l of String(d).split('\n')) if (l.trim()) onLine(l.trim());
		};
		p.stdout.on('data', take);
		p.stderr.on('data', (d) => (out += d));
		const timer = timeoutMs && setTimeout(() => p.kill('SIGINT'), timeoutMs);
		p.on('exit', (code) => {
			if (timer) clearTimeout(timer);
			res({ code, out });
		});
		p.on('error', () => res({ code: -1, out }));
	});
}

async function connectedUdid() {
	if (process.env.IOS_UDID) return process.env.IOS_UDID;
	const out = join(tmpdir(), `devicectl-${process.pid}.json`);
	await new Promise((r) => spawn('xcrun', ['devicectl', 'list', 'devices', '--json-output', out], { stdio: 'ignore' }).on('exit', r));
	const list = JSON.parse(readFileSync(out, 'utf8')).result?.devices || [];
	rmSync(out, { force: true });
	const dev = list.find((d) => d.connectionProperties?.tunnelState === 'connected') || list.find((d) => d.connectionProperties?.transportType === 'wired');
	if (!dev) throw new Error('no connected iPhone found (xcrun devicectl list devices)');
	return dev.hardwareProperties?.udid || dev.identifier;
}

const trunc = (s, n) => (s && s.length > n ? s.slice(0, n - 1) + '…' : s ?? '');

const HELP = `ios.mjs — inspect and drive Safari/Chrome on an iPhone (USB or Wi-Fi)

Element targets (<el>): CSS selector | text=<label> | @e12 (from snapshot) | x y

 setup
  start | stop | status        background bridge (auto-starts on first command)
  doctor                       check Xcode, the iPhone, and the Safari/Chrome inspector settings
  launch [safari|chrome|<bundle-id>] [url] [--restart]   bring an app up; with a url Safari opens it in a new tab,
                               or brings forward a tab that already shows that URL
  report [--title t] [--what text]   collect redacted diagnostics and print a prefilled GitHub issue link

 tabs and pages
  tabs                         list tabs (visible = on the iPhone screen)
  use <id|n|url-part>          pick the tab to work on: full id, its last number (19), or part of the URL
  open <url> | reload | close  navigate (waits for load, clears logs/net) | reload | close tab
  snapshot [--all]             elements you can act on, as @eN refs
  eval <js> [--gesture]        run JS; expression, or statements with return/await
  tap <el>                     touch + click as a user gesture; refuses if covered; "x y" = exact point
  type <el> <text>             set an input's value and fire input/change
  shot [path] [--device]       screenshot of the page; --device = whole screen incl. Safari's bars and keyboard
  record start [dir] | record stop      screen recording as JPEG frames named <n>-<ms>ms.jpg

 elements
  dom <el>                     outerHTML, box, margin/padding, display
  styles <el> [--computed [p1,p2]]      matched CSS rules with file:line, inline style, computed values
  a11y <el>                    accessibility role, label, states
  highlight <el> | highlight --off      draw the box model on the phone screen
  pseudo <el> hover,active,focus|off    force pseudo-classes
  listeners <el>               event listeners on the element and its ancestors
  layers                       composited layers: memory, paint count, why they exist

 console and network
  logs [--errors] [--clear]    console messages, exceptions, Safari warnings
  net [url-part] [--failed]    requests: id status type size time url
  req <id|url-part>            request + response headers, post data
  body <id|url-part> [--out f] response body
  har [out.har]                export recorded requests as HAR (no redirect hops or per-phase timings)
  ws                           WebSocket frames
  block <url-part>             fail matching requests
  mock <url-part> <status> <body|@file> [--type ct]   answer matching requests yourself
  mocks | unmock [url-part]    list | remove interception rules (all when no url-part)
  nocache [on|off]             disable the HTTP cache
  events [method-prefix] [--last n] [--clear]   raw CDP events received from the tab

 sources and debugger
  scripts [url-part]           loaded scripts
  source <id|url-part> [--line n] [--out f]   script source (or 11 lines around n)
  break <url-part> <line> [--if expr] | break list | break clear
  pause-on all|uncaught|none   pause on exceptions
  pause | resume | step [over|into|out]
  paused                       where it stopped: reason, line, stack, locals
  frame-eval <js>              evaluate in the paused frame

 application
  cookies [--values] [--clear [name]]   cookies for the page (values hidden unless --values)
  storage [local|session] [--clear]
  idb                          IndexedDB databases and object stores

 performance
  perf [url-part] [--slow] [--json]     Performance API: TTFB, DCL, load, FCP, CLS, resource waterfall
  trace start [--screenshots] | trace stop [out.json]   Chrome-format performance trace + summary
  profile start | profile stop [out.cpuprofile]         JS CPU profile + hottest functions
  fps [seconds]                display frame rate on the phone, one sample per second
  usage start | usage stop [out.json]   CPU (per thread) and memory by category every ~0.5s
  heap [out.heapsnapshot]      JS heap snapshot

 rendering and environment
  media dark|light|print|screen|reset   emulate prefers-color-scheme / media type
  paintflash on|off            flash repainted areas on the phone
  ua <string>|reset            override the User-Agent (from the next request)
  js on|off                    disable page JavaScript (from the next reload)
  inject <js|@file> | inject --clear   run a script in every new document before page scripts

  cdp <Method> [json-params]   any other CDP method (unknown ones are forwarded to WebKit's protocol)
`;

async function main() {
	const [cmd, ...rest] = process.argv.slice(2);
	if (cmd === '__daemon') return runDaemon();
	if (!cmd || cmd === 'help' || cmd === '-h') return console.log(HELP);

	// Everything after a bare `--` is positional, so text like `--example` can be typed or mocked.
	const dd = rest.indexOf('--');
	// --flag=value is the same as --flag value.
	const opts = (dd >= 0 ? rest.slice(0, dd) : rest).flatMap((a) => (/^--[a-z-]+=/.test(a) ? [a.slice(0, a.indexOf('=')), a.slice(a.indexOf('=') + 1)] : [a]));
	const tail = dd >= 0 ? rest.slice(dd + 1) : [];
	const flags = new Set(opts.filter((a) => a.startsWith('--')));
	const valueFlags = new Set(['--out', '--type', '--last', '--computed', '--line', '--if', '--title', '--what']);
	const pos = [...opts.filter((a, i) => !a.startsWith('--') && !valueFlags.has(opts[i - 1])), ...tail];
	const flagVal = (name) => {
		const i = opts.indexOf(name);
		return i >= 0 ? opts[i + 1] : undefined;
	};

	if (cmd === 'doctor') return doctor(flags.has('--no-chrome'));
	if (cmd === 'report') return report({ title: flagVal('--title'), what: flagVal('--what') });

	if (cmd === 'launch') {
		// Opens an app on the phone via Xcode's devicectl. --restart is needed after toggling Chrome's Web Inspector.
		const apps = { safari: 'com.apple.mobilesafari', chrome: 'com.google.chrome.ios' };
		if (/^[a-z]+:\/\//i.test(pos[0] || '')) pos.unshift('safari'); // `launch <url>` means Safari
		const bundle = apps[pos[0]] || pos[0] || apps.safari;
		const udid = await connectedUdid();
		const args = ['devicectl', 'device', 'process', 'launch', '--device', udid];
		if (flags.has('--restart')) args.push('--terminate-existing');
		if (pos[1]) args.push('--payload-url', pos[1]);
		args.push(bundle);
		const p = spawn('xcrun', args, { stdio: 'inherit' });
		await new Promise((r) => p.on('exit', r));
		// Follow the app that is now on screen instead of the previously picked tab.
		if (await daemonUp()) await call('use', { match: '' , reset: true }).catch(() => {});
		return;
	}

	if (cmd === 'stop') {
		if (await daemonUp()) await call('stop').catch(() => {});
		else if (existsSync(PID_FILE)) {
			try {
				const pid = Number(readFileSync(PID_FILE, 'utf8'));
				const cmdline = (await run('ps', ['-p', String(pid), '-o', 'command='])).out;
				if (cmdline.includes('ios.mjs') && cmdline.includes('__daemon')) process.kill(pid);
				rmSync(PID_FILE, { force: true });
			} catch {}
		}
		return console.log('stopped');
	}

	await ensureDaemon();

	switch (cmd) {
		case 'start':
		case 'status':
			return console.log(await call('status'));
		case 'tabs': {
			for (const t of await call('tabs')) console.log(`${t.current ? '*' : ' '} ${t.id}  ${t.visible ? 'visible' : t.visible === false ? 'hidden ' : '?      '}  ${trunc(t.url, 100)}`);
			return;
		}
		case 'use':
			return console.log(await call('use', { match: pos[0] }));
		case 'open':
			return console.log(await call('open', { url: pos[0] }));
		case 'reload':
			return console.log(await call('reload'));
		case 'eval': {
			const v = await call('eval', { js: pos.join(' '), gesture: flags.has('--gesture') });
			return console.log(typeof v === 'string' ? v : JSON.stringify(v, null, 2));
		}
		case 'logs': {
			const logs = await call('logs', { clear: flags.has('--clear'), level: flags.has('--errors') ? 'error' : undefined });
			for (const l of logs) console.log(`[${l.level}] ${l.kind !== 'console' ? `(${l.kind}) ` : ''}${l.text}${l.where ? `  @ ${trunc(l.where, 120)}` : ''}`);
			if (!logs.length) console.log('(no logs)');
			return;
		}
		case 'net': {
			const list = await call('net', { filter: pos[0], failed: flags.has('--failed') });
			for (const r of list) {
				const size = r.bytes == null ? '' : r.bytes > 1024 ? `${(r.bytes / 1024).toFixed(1)}k` : `${r.bytes}b`;
				console.log(`${r.id.padEnd(8)} ${String(r.failed ? 'FAIL' : r.status ?? '...').padEnd(4)} ${(r.type || '').padEnd(10)} ${size.padStart(7)} ${r.ms != null ? `${r.ms}ms`.padStart(7) : '       '}  ${trunc(r.url, 140)}${r.failed ? `  (${r.failed})` : ''}`);
			}
			console.log(`(${list.length} requests)`);
			return;
		}
		case 'req':
			return console.log(JSON.stringify(await call('req', { match: pos[0] }), null, 2));
		case 'body': {
			const b = await call('body', { match: pos[0] });
			const out = flagVal('--out');
			if (out) {
				writeFileSync(out, b.base64 ? Buffer.from(b.body, 'base64') : b.body);
				return console.log(`${b.url} (${b.status}, ${b.mime}) -> ${out}`);
			}
			console.error(`# ${b.url} (${b.status}, ${b.mime}${b.base64 ? ', base64' : ''})`);
			return console.log(b.body);
		}
		case 'shot': {
			const path = resolve(pos[0] || join(tmpdir(), `iphone-${Date.now()}.png`));
			if (flags.has('--device')) {
				// The whole screen as the user sees it: status bar, Safari's address bar and toolbar, keyboard.
				const r = await pmd3Dev(['dvt', 'screenshot', path], { timeoutMs: 60000 });
				if (!existsSync(path)) throw new Error(`device screenshot failed: ${r.out.trim().split('\n').pop()}`);
				return console.log(path);
			}
			return console.log((await call('shot', { path })).path);
		}
		case 'snapshot': {
			const r = await call('snapshot', { all: flags.has('--all') });
			console.log(`${r.title} — ${r.url}\nviewport ${r.viewport.join('×')}, scrollY ${r.scrollY}${flags.has('--all') ? '' : ' (visible part only; --all for the whole page)'}`);
			for (const it of r.items) console.log(`@${it.ref.padEnd(4)} ${it.role.padEnd(12)} ${JSON.stringify(it.name)}${it.state ? ' [' + it.state + ']' : ''}  ${it.box.join(',')}`);
			console.log(`(${r.items.length} elements; use @eN with tap/type/dom/styles/highlight)`);
			return;
		}
		case 'dom':
			return console.log(await call('dom', { target: targetJs(pos.join(' ')) }));
		case 'styles': {
			const comp = flagVal('--computed') ?? (flags.has('--computed') ? true : undefined);
			const r = await call('styles', { target: targetJs(pos.join(' ')), computed: comp });
			if (r.inline.length) console.log(`element.style {\n  ${r.inline.join(';\n  ')}\n}`);
			for (const rule of r.rules) {
				if (!rule.props.length) continue;
				console.log(`${rule.media ? '@media ' + rule.media + ' ' : ''}${rule.selector} {   /* ${rule.source} */\n  ${rule.props.join(';\n  ')}\n}`);
			}
			if (r.computed) console.log('computed:', r.computed);
			return;
		}
		case 'a11y':
			return console.log(await call('a11y', { target: targetJs(pos.join(' ')) }));
		case 'highlight':
			return console.log(await call('highlight', flags.has('--off') ? { off: true } : { target: targetJs(pos.join(' ')) }));
		case 'pseudo': {
			// pseudo <selector> hover,active,focus | pseudo <selector> off
			const classes = pos[pos.length - 1];
			return console.log(await call('pseudo', { target: targetJs(pos.slice(0, -1).join(' ')), classes }));
		}
		case 'layers': {
			const list = await call('layers');
			for (const l of list) console.log(`${String(l.memoryKB).padStart(7)}KB ${l.size.padStart(11)}  paints ${String(l.paints ?? '-').padStart(4)}  ${(l.node || '').padEnd(28)} ${l.reasons.join(', ')}`);
			console.log(`(${list.length} layers, ${list.reduce((a, l) => a + l.memoryKB, 0)}KB)`);
			return;
		}
		case 'cookies':
			return console.log(await call('cookies', flags.has('--clear') ? { clear: pos[0] || true } : { values: flags.has('--values') }));
		case 'storage':
			return console.log(await call('storage', { kind: pos[0] || 'local', clear: flags.has('--clear') }));
		case 'idb':
			return console.log(JSON.stringify(await call('idb'), null, 2));
		case 'scripts': {
			const list = await call('scripts', { filter: pos[0] });
			for (const sc of list) console.log(`${String(sc.id).padEnd(6)} ${String(sc.lines).padStart(6)} lines  ${trunc(sc.url, 130)}`);
			console.log(`(${list.length} scripts)`);
			return;
		}
		case 'source': {
			const r = await call('source', { match: pos[0] });
			const out = flagVal('--out');
			if (out) {
				writeFileSync(out, r.source);
				return console.log(`${r.url} -> ${out} (${r.source.length} chars)`);
			}
			const lineArg = flagVal('--line');
			if (lineArg) {
				const n = Number(lineArg), lines = r.source.split('\n');
				for (let i = Math.max(1, n - 5); i <= Math.min(lines.length, n + 5); i++) console.log(`${i === n ? '>' : ' '}${String(i).padStart(6)}  ${trunc(lines[i - 1], 200)}`);
				return;
			}
			console.error(`# ${r.url}`);
			return console.log(r.source);
		}
		case 'break': {
			if (pos[0] === 'list' || pos[0] === 'clear') return console.log(await call('breakpoint', { action: pos[0] }));
			return console.log(await call('breakpoint', { action: 'set', match: pos[0], line: pos[1], condition: flagVal('--if') }));
		}
		case 'pause-on':
			return console.log(await call('pauseOn', { state: pos[0] === 'all' ? 'all' : pos[0] === 'uncaught' ? 'uncaught' : pos[0] === 'none' || pos[0] === 'off' ? 'none' : 'all' }));
		case 'paused': {
			const r = await call('paused', {});
			if (!r.paused) return console.log('not paused');
			console.log(`paused (${r.reason})${r.data?.description ? ': ' + trunc(r.data.description, 160) : ''}`);
			if (r.line) console.log(`  > ${trunc(r.line.trim(), 200)}`);
			console.log('stack:');
			for (const f of r.frames.slice(0, 12)) console.log(`  ${f.fn}  ${f.at}`);
			if (r.scope) console.log('locals:', r.scope);
			return;
		}
		case 'step':
			return console.log(await call('step', { how: pos[0] || 'over' }));
		case 'resume':
			return console.log(await call('step', { how: 'resume' }));
		case 'pause':
			return console.log(await call('step', { how: 'pause' }));
		case 'frame-eval':
			return console.log(await call('frameEval', { js: pos.join(' ') }));
		case 'paintflash':
			return console.log(await call('paintflash', { on: pos[0] !== 'off' }));
		case 'ua':
			return console.log(await call('ua', { value: pos[0] === 'reset' ? undefined : pos.join(' ') || undefined }));
		case 'js':
			return console.log(await call('jsEnabled', { on: pos[0] !== 'off' }));
		case 'har': {
			const path = resolve(pos[0] || join(tmpdir(), `iphone-${Date.now()}.har`));
			const h = await call('har');
			writeFileSync(path, JSON.stringify(h, null, 1));
			return console.log(`${h.log.entries.length} entries -> ${path}  (open in Chrome DevTools Network → Import HAR)`);
		}
		case 'ws': {
			const list = await call('websockets');
			for (const w of list) console.log(`${w.t} ${w.event.padEnd(14)} ${w.url ? trunc(w.url, 80) : ''}${w.data ? ' ' + JSON.stringify(w.data) : ''}`);
			if (!list.length) console.log('(no WebSocket traffic recorded)');
			return;
		}
		case 'perf': {
			const p = await call('perf');
			if (flags.has('--json')) return console.log(JSON.stringify(p, null, 2));
			const n = p.nav || {};
			const kb = (b) => (b == null ? '' : b >= 1024 ? `${(b / 1024).toFixed(1)}k` : `${b}b`);
			console.log(p.url);
			console.log(`page   ${n.proto || '?'}  dns ${n.dns}ms  connect ${n.connect}ms  ttfb ${n.ttfb}ms  html ${n.html}ms  (${kb(n.transfer)} → ${kb(n.decoded)})`);
			console.log(`events domInteractive ${n.domInteractive}ms  DOMContentLoaded ${n.domContentLoaded}ms  load ${n.load}ms`);
			const l = p.paint.lcp;
			console.log(`paint  FCP ${p.paint.fcp ?? '-'}ms  LCP ${l ? `${l.ms}ms (${l.el || ''}${l.url ? ' ' + trunc(l.url, 60) : ''})` : '-'}  CLS ${p.paint.cls ?? '-'}`);
			let list = p.resources;
			if (pos[0]) list = list.filter((r) => r.url.includes(pos[0]));
			list.sort((a, b) => (flags.has('--slow') ? b.total - a.total : a.start - b.start));
			console.log(`\n${'start'.padStart(6)} ${'total'.padStart(6)} ${'ttfb'.padStart(5)} ${'dl'.padStart(5)} ${'size'.padStart(7)} proto  type        url`);
			for (const r of list) {
				const sameOrigin = new URL(r.url).origin === new URL(p.url).origin;
				const size = r.cached ? 'cache' : r.transfer === 0 && r.decoded === 0 ? (sameOrigin ? 'cache' : 'x-orig') : kb(r.transfer);
				console.log(`${String(r.start).padStart(6)} ${String(r.total).padStart(6)} ${String(r.ttfb ?? '-').padStart(5)} ${String(r.download ?? '-').padStart(5)} ${size.padStart(7)} ${(r.proto || '-').padEnd(6)} ${(r.type || '').padEnd(11)} ${trunc(r.url, 110)}`);
			}
			const total = p.resources.reduce((s, r) => s + (r.transfer || 0), 0);
			console.log(`(${p.resources.length} resources, ${kb(total)} transferred; "cache" = served from cache; "x-orig" = cross-origin without Timing-Allow-Origin, so size/phases are hidden; use \`net\` for those)`);
			return;
		}
		case 'tap': {
			// Synthetic touch → pointer → mouse → click sequence at the element's center (or at x,y).
			// Element targets tap the center and refuse if something else covers it; `x y` taps that exact point.
			const label = JSON.stringify(pos.join(' '));
			const xy = pos.length === 2 && pos.every((a) => /^-?\d+(\.\d+)?$/.test(a)) ? pos.map(Number) : null;
			const target = xy ? 'null' : targetJs(pos.join(' '));
			const js = `
				const at = ${JSON.stringify(xy)};
				const el = at ? document.elementFromPoint(at[0], at[1]) : ${target};
				if (!el) throw new Error('no element for ' + ${label});
				if (!at) el.scrollIntoView({ block: 'center' });
				const r = el.getBoundingClientRect(), x = at ? at[0] : r.left + r.width / 2, y = at ? at[1] : r.top + r.height / 2;
				const hit = at ? el : document.elementFromPoint(x, y) || el;
				if (hit !== el && !el.contains(hit)) return { tapped: false, covered: true, by: hit.tagName.toLowerCase() + (hit.id ? '#' + hit.id : '') + (typeof hit.className === 'string' && hit.className ? '.' + hit.className.trim().split(/\\s+/)[0] : ''), note: 'something covers the element; take a new snapshot' };
				const opt = { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, view: window };
				let touch = null;
				try { touch = new Touch({ identifier: Date.now(), target: hit, clientX: x, clientY: y }); } catch {}
				const fire = (type, Ctor, extra = {}) => { try { return hit.dispatchEvent(new Ctor(type, { ...opt, ...extra })); } catch { return true; } };
				fire('pointerdown', PointerEvent, { pointerType: 'touch', isPrimary: true });
				if (touch) fire('touchstart', TouchEvent, { touches: [touch], targetTouches: [touch], changedTouches: [touch] });
				fire('pointerup', PointerEvent, { pointerType: 'touch', isPrimary: true });
				const go = touch ? fire('touchend', TouchEvent, { touches: [], targetTouches: [], changedTouches: [touch] }) : true;
				if (go) { fire('mousedown', MouseEvent); fire('mouseup', MouseEvent); hit.click(); }
				return { tapped: hit.tagName.toLowerCase() + (hit.id ? '#' + hit.id : ''), text: (hit.innerText || hit.value || '').trim().slice(0, 60), x: Math.round(x), y: Math.round(y) };`;
			return console.log(await call('eval', { js, gesture: true }));
		}
		case 'close': {
			// Safari lets window.close() close tabs that were opened from a URL (launch/newtab), not ones the user opened.
			await call('eval', { js: 'setTimeout(() => window.close(), 0); return true' }).catch(() => {});
			await sleep(1500);
			await call('use', { reset: true }).catch(() => {});
			for (const t of await call('tabs')) console.log(`${t.current ? '*' : ' '} ${t.id}  ${t.visible ? 'visible' : t.visible === false ? 'hidden ' : '?      '}  ${trunc(t.url, 100)}`);
			return;
		}
		case 'type': {
			// Sets the value on the focused or given input and fires input/change so frameworks notice.
			const [sel, ...words] = pos;
			const js = `
				const el = ${targetJs(sel)};
				if (!el) throw new Error('no element ' + ${JSON.stringify(String(sel))});
				el.focus();
				const text = ${JSON.stringify(words.join(' '))};
				if (el.isContentEditable) el.textContent = text;
				else {
					const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
					Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, text);
				}
				el.dispatchEvent(new InputEvent('input', { bubbles: true, data: ${JSON.stringify(words.join(' '))}, inputType: 'insertText' }));
				el.dispatchEvent(new Event('change', { bubbles: true }));
				return el.isContentEditable ? el.textContent : el.value;`;
			return console.log(await call('eval', { js, gesture: true }));
		}
		case 'fps': {
			// Display frame rate from Core Animation, one sample per second, while the user or a script
			// interacts. 0 means nothing on screen changed in that second.
			const secs = Number(pos[0] || 5);
			const samples = [];
			await pmd3Dev(['dvt', 'fps'], {
				timeoutMs: (secs + 4) * 1000,
				onLine: (l) => {
					try {
						const j = JSON.parse(l);
						if (typeof j.fps === 'number' && samples.length < secs) {
							samples.push(j.fps);
							console.log(`${String(samples.length).padStart(3)}s  ${String(j.fps).padStart(3)} fps`);
						}
					} catch {}
				},
			});
			if (!samples.length) throw new Error('no FPS samples (is the phone unlocked and paired?)');
			const avg = Math.round(samples.reduce((a, b) => a + b, 0) / samples.length);
			console.log(`avg ${avg} fps, min ${Math.min(...samples)}, max ${Math.max(...samples)} over ${samples.length}s (0 = nothing on screen changed)`);
			return;
		}
		case 'trace': {
			if (pos[0] === 'start') return console.log(await call('traceStart', { screenshots: flags.has('--screenshots') }));
			if (pos[0] !== 'stop') return console.log('usage: trace start [--screenshots] | trace stop [out.json]');
			const r = await call('traceStop', { path: resolve(pos[1] || join(tmpdir(), `iphone-trace-${Date.now()}.json`)) });
			console.log(`${r.events} events over ${r.spanMs}ms${r.complete ? '' : ' (bridge never sent tracingComplete; data may be partial)'}`);
			if (Object.keys(r.marksFromTraceStart).length) console.log('marks (from trace start)  ' + Object.entries(r.marksFromTraceStart).map(([k, v]) => `${k} ${v}ms`).join('  '));
			console.log('\ntime by event (inclusive, all threads; nested events overlap):');
			for (const t of r.inclusiveMsByEvent) console.log(`  ${String(t.ms).padStart(6)}ms ${String(t.count).padStart(5)}×  ${t.name}`);
			if (r.longEvents.length) {
				console.log('\nlong events (≥50ms, may be nested inside each other):');
				for (const l of r.longEvents) console.log(`  @${String(l.at).padStart(7)}ms ${String(l.ms).padStart(5)}ms  ${l.name}  ${trunc(l.detail, 90)}`);
			}
			console.log(`\nfull trace → ${r.path}  (open in Chrome DevTools → Performance → Load profile, or ui.perfetto.dev)`);
			return;
		}
		case 'profile': {
			if (pos[0] === 'start') return console.log(await call('profileStart'));
			if (pos[0] !== 'stop') return console.log('usage: profile start | profile stop [out.cpuprofile]');
			const r = await call('profileStop', { path: resolve(pos[1] || join(tmpdir(), `iphone-${Date.now()}.cpuprofile`)) });
			console.log(`${r.durationMs}ms recorded, ${r.samples} samples (${r.busySamples} while running JS). Shares are of the JS samples.`);
			console.log('\nself:');
			for (const f of r.topSelf) console.log(`  ${String(f.pct).padStart(3)}%  ${String(f.samples).padStart(4)}  ${f.fn}`);
			console.log('\nincluding callees:');
			for (const f of r.topTotal) console.log(`  ${String(f.pct).padStart(3)}%  ${String(f.samples).padStart(4)}  ${f.fn}`);
			console.log(`\nprofile → ${r.path}  (open in Chrome DevTools or speedscope.app)`);
			return;
		}
		case 'heap':
			return console.log(await call('heap', { path: resolve(pos[0] || join(tmpdir(), `iphone-${Date.now()}.heapsnapshot`)) }));
		case 'block':
			return console.log(await call('intercept', { action: 'block', match: pos[0] }));
		case 'mock': {
			// mock <url-part> <status> <body | @file> [--type content/type]
			const typeArg = flagVal('--type');
			let body = pos.slice(2).join(' ');
			if (body.startsWith('@')) body = readFileSync(body.slice(1), 'utf8');
			const contentType = typeArg || (body.trim().startsWith('<') ? 'text/html' : 'application/json');
			return console.log(await call('intercept', { action: 'mock', match: pos[0], status: pos[1] || 200, body, contentType }));
		}
		case 'unmock':
			return console.log(await call('intercept', { action: 'clear', match: pos[0] }));
		case 'mocks':
			return console.log(await call('intercept', { action: 'list' }));
		case 'nocache':
			return console.log(await call('nocache', { on: pos[0] !== 'off' }));
		case 'media':
			return console.log(await call('media', { value: pos[0] || 'reset' }));
		case 'inject':
			if (flags.has('--clear')) return console.log(await call('inject', { clear: true }));
			return console.log(await call('inject', { source: pos[0]?.startsWith('@') ? readFileSync(pos[0].slice(1), 'utf8') : pos.join(' ') }));
		case 'listeners': {
			const list = await call('listeners', { target: targetJs(pos.join(' ')) });
			for (const l of list) console.log(`${l.type.padEnd(14)} on ${String(l.on).padEnd(8)} ${l.capture ? 'capture ' : ''}${l.passive ? 'passive ' : ''}${l.once ? 'once ' : ''}${l.attr ? 'attribute ' : ''} ${l.where || ''}`);
			if (!list.length) console.log('(no listeners)');
			return;
		}
		case 'events': {
			const list = await call('events', { filter: pos[0], clear: flags.has('--clear'), last: Number(flagVal('--last') || 200) });
			for (const e of list) console.log(`${new Date(e.t).toISOString().slice(11, 23)} ${e.method}  ${trunc(JSON.stringify(e.params), 200)}`);
			if (!list.length) console.log('(no events)');
			return;
		}
		case 'record': {
			if (pos[0] === 'start') return console.log(await call('screencastStart', { dir: resolve(pos[1] || join(tmpdir(), `iphone-cast-${Date.now()}`)) }));
			if (pos[0] === 'stop') return console.log(await call('screencastStop'));
			return console.log('usage: record start [dir] | record stop');
		}
		case 'usage': {
			if (pos[0] === 'start') return console.log(await call('usageStart'));
			if (pos[0] === 'stop') {
				const r = await call('usageStop', { path: resolve(pos[1] || join(tmpdir(), `iphone-usage-${Date.now()}.json`)) });
				console.log(`${'t(s)'.padStart(5)} ${'cpu%'.padStart(5)} ${'main%'.padStart(5)} ${'memMB'.padStart(6)}  js / jit / images / layers / page / other (MB)`);
				for (const s of r.samples) console.log(`${String(s.t).padStart(5)} ${String(s.cpu).padStart(5)} ${String(s.main).padStart(5)} ${String(s.memMB).padStart(6)}  ${[s.javascript, s.jit, s.images, s.layers, s.page, s.other].join(' / ')}`);
				if (!r.samples.length) return console.log(`no CPU/memory samples arrived; raw events → ${r.path}`);
				console.log(`peak cpu ${r.peakCpu?.cpu}% @${r.peakCpu?.t}s, main thread ${r.peakMain?.main}% @${r.peakMain?.t}s, memory ${r.peakMem?.memMB}MB @${r.peakMem?.t}s; ${r.requests} requests; raw events → ${r.path}`);
				return;
			}
			return console.log('usage: usage start | usage stop [out.json]');
		}
		case 'cdp':
			return console.log(JSON.stringify(await call('cdp', { method: pos[0], params: pos[1] ? JSON.parse(pos[1]) : {} }), null, 2));
		default:
			console.log(HELP);
			process.exitCode = 1;
	}
}

main().catch((e) => {
	console.error('error:', e.message);
	process.exit(1);
});
