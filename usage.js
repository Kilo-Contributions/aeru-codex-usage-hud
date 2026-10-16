'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const readline = require('readline');

// A deliberately conservative reference table, not subscription billing.
// Values are USD per one million tokens and can be adjusted as public pricing evolves.
const ESTIMATED_API_RATES_USD_PER_MILLION = Object.freeze({
  input: 2.0,
  cachedInput: 0.2,
  output: 8.0
});

function number(value) {
  return Number.isFinite(Number(value)) ? Number(value) : 0;
}

function addUsage(target, usage) {
  const input = number(usage.input_tokens ?? usage.inputTokens ?? usage.input);
  const output = number(usage.output_tokens ?? usage.outputTokens ?? usage.output);
  const cached = number(usage.cached_input_tokens ?? usage.cachedInputTokens ?? usage.cached);
  const total = number(usage.total_tokens ?? usage.totalTokens ?? usage.total) || input + output;
  target.input += input;
  target.output += output;
  target.cached += cached;
  target.total += total;
}

async function listJsonlFiles(folder) {
  const files = [];
  async function visit(current) {
    let entries;
    try { entries = await fsp.readdir(current, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) await visit(full);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith('.jsonl')) files.push(full);
    }
  }
  await visit(folder);
  return files;
}

function projectName(cwd, codexDir) {
  if (!cwd || typeof cwd !== 'string') return 'Unattributed';
  const normalized = path.normalize(cwd);
  const relative = path.relative(path.normalize(codexDir), normalized);
  if (relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))) return 'Codex workspace';
  const base = path.basename(normalized);
  return base && base !== '.' && base !== path.parse(normalized).root ? base : 'Unattributed';
}

function dateKey(timestamp) {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return null;
  return [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('-');
}

function emptyUsage() { return { total: 0, input: 0, output: 0, cached: 0 }; }

async function scanFile(file, codexDir, seenResponseIds, warnings) {
  const session = { usage: emptyUsage(), daily: new Map(), responseCount: 0, id: null, cwd: null, model: 'Unknown', lastTimestamp: null, nativeUsageEvents: 0, legacyUsageRecords: 0 };
  const bucket = () => ({ usage: emptyUsage(), daily: new Map(), responseCount: 0, lastTimestamp: null, ids: new Set() });
  const bins = { native: bucket(), legacy: bucket() };
  const stream = fs.createReadStream(file, { encoding: 'utf8' });
  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let lineNumber = 0;
  let previousNativeCumulative = null;
  try {
    for await (const line of lines) {
      lineNumber += 1;
      if (!line.trim()) continue;
      let record;
      try { record = JSON.parse(line); } catch { warnings.malformedLines += 1; continue; }
      const payload = record.payload || {};
      if (record.type === 'session_meta') {
        session.id = payload.session_id || payload.id || session.id;
        session.cwd = payload.cwd || session.cwd;
      }
      if (record.type === 'turn_context' && payload.model) session.model = String(payload.model);
      // Current Codex stores incremental usage in event_msg/token_count.info.last_token_usage.
      // Never add the cumulative total_token_usage on every event.
      const native = record.type === 'event_msg' && payload.type === 'token_count';
      const legacy = record.type === 'token_usage_record';
      if (!native && !legacy) continue;
      const info = payload.info && typeof payload.info === 'object' ? payload.info : {};
      const usage = native ? info.last_token_usage : (payload.usage || payload.turn_token_usage);
      if (!usage || typeof usage !== 'object' || Array.isArray(usage)) continue;
      const parsed = emptyUsage();
      addUsage(parsed, usage);
      if (!parsed.total && !parsed.input && !parsed.output) continue;
      // Native Codex may repeat a completed token snapshot with the exact same
      // cumulative counts. Only suppress such duplicates when BOTH normalized
      // incremental and cumulative fields agree, never merely same token size.
      const cumulative = native && info.total_token_usage && typeof info.total_token_usage === 'object'
        ? info.total_token_usage : null;
      const signature = cumulative ? JSON.stringify([
        parsed.input, parsed.output, parsed.cached, parsed.total,
        number(cumulative.input_tokens), number(cumulative.output_tokens),
        number(cumulative.cached_input_tokens), number(cumulative.total_tokens)
      ]) : null;
      if (signature && signature === previousNativeCumulative) continue;
      const responseId = payload.response_id || (native
        ? `${file}:${lineNumber}`
        : `${payload.session_id || session.id || file}:${payload.turn_id || record.ordinal}`);
      const bin = native ? bins.native : bins.legacy;
      if (seenResponseIds.has(responseId) || bin.ids.has(responseId)) continue;
      bin.ids.add(responseId);
      if (native) previousNativeCumulative = signature;
      addUsage(bin.usage, usage);
      const day = dateKey(record.timestamp || payload.timestamp);
      if (day) {
        if (!bin.daily.has(day)) bin.daily.set(day, emptyUsage());
        addUsage(bin.daily.get(day), usage);
      }
      bin.responseCount += 1;
      bin.lastTimestamp = record.timestamp || bin.lastTimestamp;
    }
  } catch (error) {
    warnings.unreadableFiles += 1;
    console.warn(`Warning: skipped unreadable history file (${path.basename(file)}): ${error.code || error.message}`);
    return null;
  }
  if (!session.id) session.id = path.basename(file);
  session.project = projectName(session.cwd, codexDir);
  // Both record formats may describe one response: choose one per file.
  // This favors undercounting uncertain mixed-only records over double billing.
  const picked = bins.native.responseCount ? bins.native : bins.legacy;
  session.mixedUsageRepresentations = !!(bins.native.responseCount && bins.legacy.responseCount);
  session.nativeUsageEvents = bins.native.responseCount;
  session.legacyUsageRecords = bins.native.responseCount ? 0 : bins.legacy.responseCount;
  session.usage = picked.usage;
  session.daily = picked.daily;
  session.responseCount = picked.responseCount;
  session.lastTimestamp = picked.lastTimestamp;
  for (const id of picked.ids) seenResponseIds.add(id);
  return session;
}

function buildWeek(daily, weekOffset = 0) {
  const output = [];
  const cursor = new Date();
  cursor.setHours(0, 0, 0, 0);
  cursor.setDate(cursor.getDate() - 6 - (weekOffset * 7));
  for (let offset = 0; offset < 7; offset += 1) {
    const day = new Date(cursor);
    day.setDate(cursor.getDate() + offset);
    const key = dateKey(day.toISOString());
    const values = daily.get(key) || emptyUsage();
    output.push({
      date: key,
      weekday: new Intl.DateTimeFormat(undefined, { weekday: 'short' }).format(day),
      tokens: values.total,
      input: values.input,
      output: values.output
    });
  }
  return output;
}

function buildWeekOptions(daily) {
  const firstDay = [...daily.keys()].sort()[0];
  if (!firstDay) return [{ offset: 0, startDate: dateKey(new Date()), endDate: dateKey(new Date()), totalTokens: 0 }];
  const current = new Date();
  current.setHours(0, 0, 0, 0);
  const earliest = new Date(`${firstDay}T00:00:00`);
  const maxOffset = Math.max(0, Math.floor((current.getTime() - earliest.getTime()) / (7 * 86400000)));
  const weeks = [];
  for (let offset = 0; offset <= maxOffset; offset += 1) {
    const days = buildWeek(daily, offset);
    const totalTokens = days.reduce((total, day) => total + day.tokens, 0);
    if (totalTokens || offset === 0) weeks.push({ offset, startDate: days[0].date, endDate: days.at(-1).date, totalTokens });
  }
  return weeks;
}

async function scanCodexUsage({ codexDir = path.join(process.env.USERPROFILE || process.env.HOME || '', '.codex'), weekOffset = 0 } = {}) {
  const started = Date.now();
  const warnings = { malformedLines: 0, unreadableFiles: 0 };
  const currentDir = path.join(codexDir, 'sessions');
  const archivedDir = path.join(codexDir, 'archived_sessions');
  const [currentFiles, archivedFiles] = await Promise.all([listJsonlFiles(currentDir), listJsonlFiles(archivedDir)]);
  const files = [...currentFiles, ...archivedFiles];
  const seenResponseIds = new Set();
  const seenSessionIds = new Set();
  const totals = emptyUsage();
  const daily = new Map();
  const projects = new Map();
  const models = new Map();
  const sessions = [];
  const usageEvidence = { nativeEvents: 0, legacyRecords: 0, mixedFiles: 0 };

  for (const file of files) {
    const session = await scanFile(file, codexDir, seenResponseIds, warnings);
    if (!session || seenSessionIds.has(session.id)) continue;
    seenSessionIds.add(session.id);
    sessions.push(session);
    usageEvidence.nativeEvents += session.nativeUsageEvents;
    usageEvidence.legacyRecords += session.legacyUsageRecords;
    if (session.mixedUsageRepresentations) usageEvidence.mixedFiles += 1;
    addUsage(totals, session.usage);
    for (const [day, value] of session.daily) {
      if (!daily.has(day)) daily.set(day, emptyUsage());
      addUsage(daily.get(day), value);
    }
    if (!projects.has(session.project)) projects.set(session.project, emptyUsage());
    addUsage(projects.get(session.project), session.usage);
    if (!models.has(session.model)) models.set(session.model, emptyUsage());
    addUsage(models.get(session.model), session.usage);
  }

  const firstDay = [...daily.keys()].sort()[0];
  const daySpan = firstDay ? Math.max(1, Math.floor((Date.now() - new Date(`${firstDay}T00:00:00`).getTime()) / 86400000) + 1) : 0;
  const estimatedCost = ((totals.input - totals.cached) * ESTIMATED_API_RATES_USD_PER_MILLION.input + totals.cached * ESTIMATED_API_RATES_USD_PER_MILLION.cachedInput + totals.output * ESTIMATED_API_RATES_USD_PER_MILLION.output) / 1000000;
  const sortedProjects = [...projects.entries()].sort((a, b) => b[1].total - a[1].total);
  const sortedModels = [...models.entries()].sort((a, b) => b[1].total - a[1].total);
  const highestDay = [...daily.entries()].sort((a, b) => b[1].total - a[1].total)[0];
  const highestSession = [...sessions].sort((a, b) => b.usage.total - a.usage.total)[0];

  const normalizedWeekOffset = Math.max(0, Math.floor(number(weekOffset)));
  const weeks = buildWeekOptions(daily);
  const selectedWeek = weeks.find((week) => week.offset === normalizedWeekOffset) || weeks.at(-1);

  return {
    generatedAt: new Date().toISOString(),
    source: { filesScanned: files.length, sessionsFound: sessions.length, archivedIncluded: archivedFiles.length > 0, scanDurationMs: Date.now() - started,
      usageEvidence, usageCoverage: usageEvidence.nativeEvents + usageEvidence.legacyRecords ? (usageEvidence.mixedFiles ? 'partial_mixed' : 'observed') : 'unavailable' },
    lifetime: {
      totalTokens: totals.total,
      inputTokens: totals.input,
      outputTokens: totals.output,
      cachedInputTokens: totals.cached,
      cacheHitRate: totals.input ? Math.min(100, (totals.cached / totals.input) * 100) : 0,
      estimatedCost: Math.max(0, estimatedCost),
      averageDailyTokens: daySpan ? totals.total / daySpan : 0
    },
    last7Days: buildWeek(daily, selectedWeek.offset),
    selectedWeek,
    availableWeeks: weeks,
    topProjects: sortedProjects.slice(0, 3).map(([name, value], index) => ({ rank: index + 1, name, tokens: value.total, percentage: totals.total ? (value.total / totals.total) * 100 : 0 })),
    models: sortedModels.map(([name, value]) => ({ name, tokens: value.total, percentage: totals.total ? (value.total / totals.total) * 100 : 0 })),
    highlights: {
      highestTokenDay: highestDay ? { date: highestDay[0], tokens: highestDay[1].total } : null,
      highestSingleSession: highestSession ? { project: highestSession.project, tokens: highestSession.usage.total } : null,
      mostUsedModel: sortedModels[0] ? { name: sortedModels[0][0], tokens: sortedModels[0][1].total } : null,
      mostUsedProject: sortedProjects[0] ? { name: sortedProjects[0][0], tokens: sortedProjects[0][1].total } : null
    },
    warnings
  };
}

module.exports = { scanCodexUsage, ESTIMATED_API_RATES_USD_PER_MILLION };
