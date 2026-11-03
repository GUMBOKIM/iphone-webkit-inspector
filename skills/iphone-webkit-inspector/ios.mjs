#!/usr/bin/env node
// Inspect and drive Safari or Chrome on an iPhone over USB or Wi-Fi.
//
// A background daemon starts the pymobiledevice3 CDP bridge, holds one WebSocket per Safari tab
// (reconnecting to a tab tends to hang, so connections are kept open), and buffers console and
// network events. Every other command talks to that daemon over local HTTP.
//
// Usage: node ios.mjs <command> [args]   (run with no args for the list)

import { spawn } from 'node:child_process';
import { mkdirSync, openSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const BRIDGE_PORT = Number(process.env.IOS_BRIDGE_PORT || 9333);
const DAEMON_PORT = Number(process.env.IOS_DAEMON_PORT || 9334);
const STATE_DIR = join(homedir(), '.cache', 'iphone-webkit-inspector');
const LOG_FILE = join(STATE_DIR, 'daemon.log');
const PID_FILE = join(STATE_DIR, 'daemon.pid');
const MAX_EVENTS = 3000;
// Exact version the bridge was tested with; override with IOS_PMD3_VERSION.
const PMD3 = `pymobiledevice3==${process.env.IOS_PMD3_VERSION || '11.49.2'}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- daemon

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
			this.ws = new WebSocket(wsUrl);
			this.ws.onopen = () => res();
			this.ws.onerror = (e) => rej(new Error(`ws error on ${this.id}: ${e.message || 'unknown'}`));
			this.ws.onclose = () => {
				this.ws = null;
				for (const [, p] of this.pending) p({ error: { message: 'connection closed' } });
				this.pending.clear();
			};
			this.ws.onmessage = (m) => this.onMessage(JSON.parse(m.data));
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
		if (this.trace) this.trace.push({ t: Date.now(), method: d.method, params: p });
		// Big payload events (trace chunks, frames, heap chunks) go to listeners only, not the ring buffer.
		if (!/^(Tracing\.dataCollected|Page\.screencastFrame|HeapProfiler\.addHeapSnapshotChunk)$/.test(d.method)) {
			this.events.push({ t: Date.now(), method: d.method, params: p });
			if (this.events.length > MAX_EVENTS) this.events.splice(0, this.events.length - MAX_EVENTS);
		}
		for (const fn of this.listeners.get(d.method) || []) fn(p);
		switch (d.method) {
			case 'Fetch.requestPaused':
				this.onRequestPaused(p);
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
				if (r) Object.assign(r, { status: p.response.status, mime: p.response.mimeType, headers: p.response.headers, type: p.type || r.type });
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
	const t0 = Math.min(...timed.map((e) => e.ts));
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
	return { events: events.length, spanMs: timed.length ? ms(Math.max(...timed.map((e) => e.ts + (e.dur || 0))) - t0) : 0, marks, top, long };
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
	const busy = [...self].filter(([k]) => !idle.test(k)).reduce((a, [, c]) => a + c, 0) || 1;
	const fmt = (m) => [...m].sort((a, b) => b[1] - a[1]).filter(([k]) => !idle.test(k)).slice(0, 12).map(([fn, c]) => ({ fn, samples: c, pct: Math.round((c / busy) * 100) }));
	return { durationMs: Math.round((profile.endTime - profile.startTime) / 1000), samples: profile.samples?.length || 0, busySamples: busy, topSelf: fmt(self), topTotal: fmt(total) };
}

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
	const cls = await new Promise((res) => {
		let sum = 0;
		try {
			const po = new PerformanceObserver((l) => { for (const e of l.getEntries()) if (!e.hadRecentInput) sum += e.value; });
			po.observe({ type: 'layout-shift', buffered: true });
			setTimeout(() => { po.disconnect(); res(Math.round(sum * 1000) / 1000); }, 300);
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
	mkdirSync(STATE_DIR, { recursive: true });
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
	const bridge = spawn('uvx', pmd3('webinspector', 'cdp', '--port', String(BRIDGE_PORT), ...(transport === 'wifi' ? ['--native'] : [])), { stdio: ['ignore', 'inherit', 'inherit'] });
	bridge.on('exit', (code) => {
		log('bridge exited', code);
		process.exit(1);
	});
	const shutdown = () => {
		bridge.kill();
		rmSync(PID_FILE, { force: true });
		process.exit(0);
	};
	process.on('SIGTERM', shutdown);
	process.on('SIGINT', shutdown);

	for (let i = 0; ; i++) {
		try {
			await fetch(`http://127.0.0.1:${BRIDGE_PORT}/json`);
			break;
		} catch {
			if (i > 120) throw new Error('bridge did not start');
			await sleep(500);
		}
	}
	log('bridge up');

	const tabs = new Map();
	let current = null;

	async function refreshTabs() {
		const list = await (await fetch(`http://127.0.0.1:${BRIDGE_PORT}/json`)).json();
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
					await tab.connect(info.webSocketDebuggerUrl);
					await tab.enable();
					log('attached', info.id, info.url);
				} catch (e) {
					log('attach failed', info.id, e.message);
				}
			}),
		);
		for (const id of tabs.keys()) if (!seen.has(id)) tabs.delete(id);
		if (current && !tabs.has(current)) current = null;
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
		if (current && tabs.get(current)?.ws) return tabs.get(current);
		const states = await tabStates();
		const vis = states.find((s) => s.visible);
		if (!vis) throw new Error('No visible Safari tab. Unlock the iPhone and bring Safari (the tab to inspect) to the front, then retry. If it keeps failing, run `ios.mjs doctor`.');
		current = vis.id;
		return tabs.get(current);
	}

	const handlers = {
		async status() {
			return { bridge: BRIDGE_PORT, transport, tabs: tabs.size, current };
		},
		async tabs() {
			const states = await tabStates();
			return states.map((s) => ({ ...s, current: s.id === current }));
		},
		async use({ match, reset }) {
			if (reset) {
				current = null;
				return null;
			}
			const states = await tabStates();
			const hit = states.find((s) => s.id === match) || states.find((s) => s.url.includes(match));
			if (!hit) throw new Error(`no tab matches "${match}"`);
			current = hit.id;
			return hit;
		},
		async open({ url, timeout = 30000 }) {
			const tab = await currentTab();
			tab.logs = [];
			tab.requests.clear();
			const loaded = new Promise((r) => tab.loadWaiters.push(r));
			const r = await tab.send('Page.navigate', { url });
			if (r.error) throw new Error(r.error.message);
			const ok = await Promise.race([loaded.then(() => true), sleep(timeout).then(() => false)]);
			await sleep(800); // let trailing responses land so `net` right after shows statuses
			const info = await tab.evaluate('({url: location.href, title: document.title})');
			return { ...info, loaded: ok };
		},
		async reload({ timeout = 30000 }) {
			const tab = await currentTab();
			tab.logs = [];
			tab.requests.clear();
			const loaded = new Promise((r) => tab.loadWaiters.push(r));
			await tab.send('Page.reload', {});
			const ok = await Promise.race([loaded.then(() => true), sleep(timeout).then(() => false)]);
			return { url: tab.url, loaded: ok };
		},
		async eval({ js, gesture }) {
			const tab = await currentTab();
			// A bare expression is returned as-is; statements need an explicit `return`.
			const statements = /^\s*(return|const|let|var|if|for|while|await|try)\b|;\s*\S/.test(js);
			const body = statements ? js : `return (${js});`;
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
			const done = new Promise((res) => {
				const off = tab.on('Tracing.tracingComplete', () => {
					off();
					res(true);
				});
				setTimeout(() => res(false), 60000);
			});
			const r = await tab.send('Tracing.end');
			if (r.error) throw new Error(r.error.message);
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
		async listeners({ selector }) {
			const tab = await currentTab();
			// The bridge can't translate DOMDebugger.getEventListeners; WebKit's own DOM.getEventListenersForNode
			// works and also returns listeners on ancestors that the event would bubble through.
			const doc = await tab.send('DOM.getDocument', { depth: 0 });
			const q = await tab.send('DOM.querySelector', { nodeId: doc.result?.root?.nodeId, selector });
			const nodeId = q.result?.nodeId;
			if (!nodeId) throw new Error(`no element ${selector}`);
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
				writeFileSync(join(c.dir, `${String(c.n++).padStart(4, '0')}-${ms}ms.jpg`), Buffer.from(p.data, 'base64'));
				tab.send('Page.screencastFrameAck', { sessionId: p.sessionId });
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
			return { path, samples, peakCpu: peak('cpu'), peakMain: peak('main'), peakMem: peak('memMB'), requests: events.filter((e) => e.method === 'Network.requestWillBeSent').length };
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

	createServer(async (req, res) => {
		let body = '';
		for await (const c of req) body += c;
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
	}).listen(DAEMON_PORT, '127.0.0.1', () => {
		writeFileSync(PID_FILE, String(process.pid));
		log('daemon ready on', DAEMON_PORT);
	});

	refreshTabs().catch((e) => log('initial attach failed', e.message));
}

// ---------------------------------------------------------------- client

async function call(cmd, args = {}) {
	const r = await fetch(`http://127.0.0.1:${DAEMON_PORT}/${cmd}`, { method: 'POST', body: JSON.stringify(args) });
	const d = await r.json();
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
	mkdirSync(STATE_DIR, { recursive: true });
	const out = openSync(LOG_FILE, 'a');
	const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '__daemon'], { detached: true, stdio: ['ignore', out, out] });
	child.unref();
	process.stderr.write('starting iPhone bridge');
	for (let i = 0; i < 180; i++) {
		await sleep(500);
		if (await daemonUp()) {
			process.stderr.write(' ok\n');
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

 setup
  start | stop | status        background bridge (auto-starts on first command)
  doctor                       check Xcode, the iPhone, and the Safari/Chrome inspector settings
  launch [safari|chrome|<bundle-id>] [url] [--restart]   open an app (new tab when a url is given)

 tabs and pages
  tabs                         list tabs (visible = on the iPhone screen)
  use <id|url-part>            pick the tab to work on (default: the visible one)
  open <url> | reload | close  navigate (waits for load, clears logs/net) | reload | close tab
  eval <js> [--gesture]        run JS; expression, or statements with return/await
  tap <selector> | tap text=<label> | tap <x> <y>   touch + click, run as a user gesture
  type <selector> <text>       set an input's value and fire input/change
  shot [path]                  screenshot (PNG, device resolution)
  record start [dir] | record stop      screen recording as JPEG frames named <n>-<ms>ms.jpg

 console and network
  logs [--errors] [--clear]    console messages, exceptions, Safari warnings
  net [url-part] [--failed]    requests: id status type size time url
  req <id|url-part>            request + response headers, post data
  body <id|url-part> [--out f] response body
  block <url-part>             fail matching requests
  mock <url-part> <status> <body|@file> [--type ct]   answer matching requests yourself
  mocks | unmock [url-part]    list | remove interception rules (all when no url-part)
  nocache [on|off]             disable the HTTP cache
  events [method-prefix] [--last n] [--clear]   raw CDP events received from the tab

 performance
  perf [url-part] [--slow] [--json]     Performance API: TTFB, DCL, load, FCP, CLS, resource waterfall
  trace start [--screenshots] | trace stop [out.json]   full Chrome-format performance trace + summary
  profile start | profile stop [out.cpuprofile]         JS CPU profile + hottest functions
  usage start | usage stop [out.json]   CPU (per thread) and memory by category every ~0.5s
  heap [out.heapsnapshot]      JS heap snapshot

 page environment
  media dark|light|print|screen|reset   emulate prefers-color-scheme / media type
  inject <js|@file> | inject --clear   run a script in every new document before page scripts
  listeners <selector>         event listeners attached to an element

  cdp <Method> [json-params]   any other CDP method (unknown ones are forwarded to WebKit's protocol)
`;

async function main() {
	const [cmd, ...rest] = process.argv.slice(2);
	if (cmd === '__daemon') return runDaemon();
	if (!cmd || cmd === 'help' || cmd === '-h') return console.log(HELP);

	const flags = new Set(rest.filter((a) => a.startsWith('--')));
	const valueFlags = new Set(['--out', '--type', '--last']);
	const pos = rest.filter((a, i) => !a.startsWith('--') && !valueFlags.has(rest[i - 1]));
	const flagVal = (name) => {
		const i = rest.indexOf(name);
		return i >= 0 ? rest[i + 1] : undefined;
	};

	if (cmd === 'doctor') return doctor(flags.has('--no-chrome'));

	if (cmd === 'launch') {
		// Opens an app on the phone via Xcode's devicectl. --restart is needed after toggling Chrome's Web Inspector.
		const apps = { safari: 'com.apple.mobilesafari', chrome: 'com.google.chrome.ios' };
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
				process.kill(Number(readFileSync(PID_FILE, 'utf8')));
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
			return console.log((await call('shot', { path })).path);
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
			const sel = pos.join(' ');
			const target =
				pos.length === 2 && pos.every((v) => /^\d+$/.test(v))
					? `document.elementFromPoint(${pos[0]}, ${pos[1]})`
					: sel.startsWith('text=')
						? `[...document.querySelectorAll('button, a, [role=button], label, summary, input[type=button], input[type=submit], [onclick]')].find((e) => e.offsetParent !== null && (e.innerText || e.value || '').trim() === ${JSON.stringify(sel.slice(5))}) || [...document.querySelectorAll('button, a, [role=button], label, summary')].find((e) => e.offsetParent !== null && (e.innerText || '').includes(${JSON.stringify(sel.slice(5))}))`
						: `document.querySelector(${JSON.stringify(sel)})`;
			const js = `
				const el = ${target};
				if (!el) throw new Error('no element for ${pos.join(' ').replace(/'/g, '')}');
				el.scrollIntoView({ block: 'center' });
				const r = el.getBoundingClientRect(), x = r.left + r.width / 2, y = r.top + r.height / 2;
				const hit = document.elementFromPoint(x, y) || el;
				const opt = { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, view: window };
				let touch = null;
				try { touch = new Touch({ identifier: Date.now(), target: hit, clientX: x, clientY: y }); } catch {}
				const fire = (type, Ctor, extra = {}) => { try { return hit.dispatchEvent(new Ctor(type, { ...opt, ...extra })); } catch { return true; } };
				fire('pointerdown', PointerEvent, { pointerType: 'touch', isPrimary: true });
				if (touch) fire('touchstart', TouchEvent, { touches: [touch], targetTouches: [touch], changedTouches: [touch] });
				fire('pointerup', PointerEvent, { pointerType: 'touch', isPrimary: true });
				const go = touch ? fire('touchend', TouchEvent, { touches: [], targetTouches: [], changedTouches: [touch] }) : true;
				if (go) { fire('mousedown', MouseEvent); fire('mouseup', MouseEvent); hit.click(); }
				return { tapped: hit.tagName.toLowerCase() + (hit.id ? '#' + hit.id : ''), text: (hit.innerText || hit.value || '').trim().slice(0, 60), x: Math.round(x), y: Math.round(y), covered: hit !== el && !el.contains(hit) };`;
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
				const el = document.querySelector(${JSON.stringify(sel)});
				if (!el) throw new Error('no element ${sel.replace(/'/g, '')}');
				el.focus();
				const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
				Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(words.join(' '))});
				el.dispatchEvent(new InputEvent('input', { bubbles: true, data: ${JSON.stringify(words.join(' '))}, inputType: 'insertText' }));
				el.dispatchEvent(new Event('change', { bubbles: true }));
				return el.value;`;
			return console.log(await call('eval', { js, gesture: true }));
		}
		case 'trace': {
			if (pos[0] === 'start') return console.log(await call('traceStart', { screenshots: flags.has('--screenshots') }));
			if (pos[0] !== 'stop') return console.log('usage: trace start [--screenshots] | trace stop [out.json]');
			const r = await call('traceStop', { path: resolve(pos[1] || join(tmpdir(), `iphone-trace-${Date.now()}.json`)) });
			console.log(`${r.events} events over ${r.spanMs}ms${r.complete ? '' : ' (bridge never sent tracingComplete; data may be partial)'}`);
			if (Object.keys(r.marks).length) console.log('marks  ' + Object.entries(r.marks).map(([k, v]) => `${k} ${v}ms`).join('  '));
			console.log('\nmain-thread time by event:');
			for (const t of r.top) console.log(`  ${String(t.ms).padStart(6)}ms ${String(t.count).padStart(5)}×  ${t.name}`);
			if (r.long.length) {
				console.log('\nlong tasks (≥50ms):');
				for (const l of r.long) console.log(`  @${String(l.at).padStart(7)}ms ${String(l.ms).padStart(5)}ms  ${l.name}  ${trunc(l.detail, 90)}`);
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
			let body = pos.slice(2).filter((a) => a !== typeArg).join(' ');
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
			const list = await call('listeners', { selector: pos.join(' ') });
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
