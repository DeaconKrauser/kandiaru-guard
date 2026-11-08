// Kandiaru Guard: one script for every hook. Never throws: a broken guard must not break the session.
import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync, createReadStream } from 'node:fs';
import { homedir } from 'node:os';
import { join, isAbsolute, resolve } from 'node:path';
import { execFileSync, spawn } from 'node:child_process';

const RULES_URL = process.env.KANDIARU_GUARD_URL || 'https://kandiaru.inovacodeia.tech/guard/rules';
const HOME = homedir();
const STATE = join(HOME, '.kandiaru');
const CACHE = join(STATE, 'guard-rules.json');
const STATS = join(STATE, 'guard-stats.json');
const OVERRIDE_TTL_MS = 10 * 60 * 1000;
const INSTALL_LOCK = join(STATE, 'guard-install.lock');
const INSTALL_LOG = join(STATE, 'guard-install.log');
// The server may only ask for these commands; anything else is ignored.
const ALLOWED = [/^claude plugin marketplace add (?:[\w.-]+\/[\w.-]+|https:\/\/github\.com\/[\w.-]+\/[\w.-]+\.git)$/, /^claude plugin install [\w.-]+@[\w.-]+$/, /^claude mcp add -s local serena -- uvx --from git\+https:\/\/github\.com\/oraios\/serena serena start-mcp-server --context ide-assistant --project \{cwd\}$/];
const CODE_MARKERS = ['.git', 'package.json', 'pyproject.toml', 'go.mod', 'Cargo.toml'];
// "leia o arquivo inteiro", "log completo", "sem filtro", "full file"
const OVERRIDE = /\b(inteir[oa]|complet[oa]|sem filtro|full (file|log|output))\b/i;

const FALLBACK = {
  version: 0, read_max_lines: 300,
  rules: [
    'Código: use Serena (símbolos) ou leia trechos com offset/limit; arquivo acima de 300 linhas não é lido inteiro.',
    'Terminal: logs e consoles sempre filtrados (erro, padrão, tail curto), nunca despejados inteiros.',
    'Respostas: estilo caveman, curtas e diretas.',
    'Código novo: estilo Ponytail e Karpathy, o mínimo que resolve.',
  ],
  tools: [],
};

const readJson = (path, fallback) => { try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return fallback; } };
const saveJson = (path, value) => { try { mkdirSync(STATE, { recursive: true }); writeFileSync(path, JSON.stringify(value)); } catch {} };
const out = (value) => process.stdout.write(JSON.stringify(value));
const deny = (reason) => {
  const stats = readJson(STATS, { blocked: {} });
  const day = new Date().toISOString().slice(0, 10);
  stats.blocked[day] = (stats.blocked[day] || 0) + 1;
  saveJson(STATS, stats);
  out({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: `Kandiaru Guard: ${reason} Se o operador pedir explicitamente o conteúdo inteiro, ele pode liberar dizendo "inteiro" ou "completo".` } });
};

async function stdin() {
  let data = '';
  for await (const chunk of process.stdin) data += chunk;
  try { return JSON.parse(data || '{}'); } catch { return {}; }
}

async function rules() {
  try {
    const response = await fetch(RULES_URL, { signal: AbortSignal.timeout(3000), headers: { 'user-agent': 'kandiaru-guard/0.1' } });
    if (!response.ok) throw new Error(String(response.status));
    const value = await response.json();
    saveJson(CACHE, value);
    return value;
  } catch {
    return readJson(CACHE, FALLBACK);
  }
}

function installed(tool, cwd) {
  const detect = tool.detect || {};
  if (detect.bin) {
    try { execFileSync(process.platform === 'win32' ? 'where' : 'which', [detect.bin], { stdio: 'ignore' }); return true; } catch { return false; }
  }
  if (detect.plugin) {
    const plugins = readJson(join(HOME, '.claude', 'plugins', 'installed_plugins.json'), { plugins: {} }).plugins || {};
    return Object.keys(plugins).some((id) => id.split('@')[0] === detect.plugin);
  }
  if (detect.mcp) {
    const config = readJson(join(HOME, '.claude.json'), {});
    const servers = [config.mcpServers, config.projects?.[cwd]?.mcpServers, readJson(join(cwd, '.mcp.json'), {}).mcpServers];
    return servers.some((s) => s && Object.keys(s).some((name) => name.toLowerCase().includes(detect.mcp)));
  }
  return true;
}

function autoInstall(missing, cwd) {
  const lock = readJson(INSTALL_LOCK, null);
  if (lock && Date.now() - lock.at < 15 * 60 * 1000) return [];
  const steps = [];
  for (const tool of missing) {
    for (const argv of tool.install || []) {
      if (!Array.isArray(argv) || !ALLOWED.some((r) => r.test(argv.join(' ')))) continue;
      steps.push(argv.map((a) => (a === '{cwd}' ? cwd : a)));
    }
  }
  if (!steps.length) return [];
  saveJson(INSTALL_LOCK, { at: Date.now() });
  // One detached runner per session: installs keep going after the hook returns.
  const script = `const {execFileSync}=require('node:child_process');const fs=require('node:fs');for(const a of ${JSON.stringify(steps)}){try{fs.appendFileSync(${JSON.stringify(INSTALL_LOG)},new Date().toISOString()+' '+a.join(' ')+'\\n');execFileSync(a[0],a.slice(1),{stdio:'ignore',timeout:600000,shell:process.platform==='win32'});}catch(e){fs.appendFileSync(${JSON.stringify(INSTALL_LOG)},'  falhou: '+e.message+'\\n');}}try{fs.unlinkSync(${JSON.stringify(INSTALL_LOCK)})}catch{}`;
  try { spawn(process.execPath, ['-e', script], { detached: true, stdio: 'ignore', cwd }).unref(); } catch { return []; }
  return missing.map((t) => t.id);
}

async function session(input) {
  const value = await rules();
  const cwd = input.cwd || process.cwd();
  const isProject = CODE_MARKERS.some((m) => existsSync(join(cwd, m)));
  const missing = (value.tools || []).filter((tool) => (tool.scope !== 'project' || isProject) && !installed(tool, cwd));
  const lines = ['KANDIARU GUARD (regras obrigatórias do operador, servidas pelo Kandiaru):', ...value.rules.map((r) => '- ' + r),
    'Hooks bloqueiam leitura inteira de arquivos grandes e logs sem filtro. Se uma ação for negada, refaça do jeito econômico; não contorne.'];
  const installing = autoInstall(missing, cwd);
  if (installing.length) lines.push('Instalando em segundo plano: ' + installing.join(', ') + '. Avise o operador em uma linha que passam a valer na próxima sessão.');
  out({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: lines.join('\n') } });
}

function overrideFile(id) { return join(STATE, `guard-override-${String(id || 'default').replace(/[^\w-]/g, '')}`); }

function prompt(input) {
  if (OVERRIDE.test(input.prompt || '')) saveJson(overrideFile(input.session_id), { at: Date.now() });
}

function overridden(input) {
  const marker = readJson(overrideFile(input.session_id), null);
  return marker && Date.now() - marker.at < OVERRIDE_TTL_MS;
}

function countLines(path) {
  return new Promise((done) => {
    let lines = 0;
    try {
      if (statSync(path).size > 50 * 1024 * 1024) return done(Infinity);
      createReadStream(path).on('data', (b) => { for (const c of b) if (c === 10) lines++; }).on('end', () => done(lines)).on('error', () => done(0));
    } catch { done(0); }
  });
}

async function tool(input) {
  if (overridden(input)) return;
  const name = input.tool_name || '';
  const args = input.tool_input || {};
  const max = readJson(CACHE, FALLBACK).read_max_lines || 300;
  const cwd = input.cwd || process.cwd();

  if (name === 'Read') {
    if (args.offset !== undefined || args.limit !== undefined || !args.file_path) return;
    if (/\.(png|jpe?g|gif|webp|pdf|ipynb)$/i.test(args.file_path)) return;
    const lines = await countLines(args.file_path);
    if (lines > max) deny(`${args.file_path} tem ${lines === Infinity ? 'mais de 50 MB' : lines + ' linhas'} (limite ${max}). Use Serena para ir direto ao símbolo, ou Grep para achar a região e Read com offset/limit só nela.`);
    return;
  }

  if (/__read_console_messages$/.test(name)) {
    if (!args.onlyErrors && !args.pattern && !(args.limit && args.limit <= 20)) deny('console sem filtro. Use onlyErrors: true, um pattern, ou limit até 20.');
    return;
  }

  if (name === 'Bash') {
    const command = String(args.command || '');
    const filtered = /\|\s*(grep|rg|tail|head|wc|jq|awk|sed -n|cut|sort|uniq)\b/.test(command);
    if (/\bjournalctl\b/.test(command) && !/(\s-n\s*\d|--lines|-p\s|--priority|--since|-g\s|--grep)/.test(command) && !filtered)
      return deny('journalctl sem limite. Use -n 30, --since, -p err ou filtre com grep.');
    if (/\b(docker|podman|kubectl)\s+(compose\s+)?logs\b/.test(command) && !/--tail/.test(command) && !filtered)
      return deny('logs de container sem limite. Use --tail 50 ou filtre com grep.');
    const big = command.match(/\b(?:tail|head)\s+(?:-n\s*|-)(\d+)/);
    if (big && Number(big[1]) > 200 && !filtered) return deny(`${big[1]} linhas de saída. Peça até 200 ou filtre com grep.`);
    const cat = command.match(/^\s*cat\s+([^\s|;&<>]+)\s*$/);
    if (cat) {
      const path = isAbsolute(cat[1]) ? cat[1] : resolve(cwd, cat[1]);
      if (existsSync(path)) {
        const lines = await countLines(path);
        if (lines > max) return deny(`cat de ${lines} linhas. Use Read com offset/limit, Grep, ou head/tail curtos.`);
      }
    }
  }
}

const input = await stdin();
const mode = process.argv[2];
try {
  if (mode === 'session') await session(input);
  else if (mode === 'prompt') prompt(input);
  else if (mode === 'tool') await tool(input);
} catch {}
