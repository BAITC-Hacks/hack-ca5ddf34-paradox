const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');

const root = path.join(__dirname, '..');
const scriptNames = ['api.js', 'view-model.js', 'saved-store.js', 'app.js'];
const runBuild = (...args) => spawnSync(process.execPath, [path.join(root, 'build.mjs'), ...args], { encoding: 'utf8' });

test('a downloaded HTML contains all styles and executable scripts without sibling resources', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ekt-html-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const output = path.join(dir, 'preview.html');
  const result = runBuild('--output', output);
  assert.equal(result.status, 0, result.stderr);
  const html = fs.readFileSync(output, 'utf8');
  assert.deepEqual(fs.readdirSync(dir), ['preview.html']);
  assert.doesNotMatch(html, /<script\b[^>]*\bsrc\s*=/i);
  assert.doesNotMatch(html, /<link\b[^>]*\brel\s*=\s*["']stylesheet["']/i);
  const css = html.match(/<style\b[^>]*>([\s\S]*?)<\/style>/i)?.[1];
  assert.ok(css, 'The complete stylesheet must be embedded in the document head.');
  assert.doesNotMatch(css, /@import\s|url\(\s*["']?(?!data:|#)/i);
  assert.equal(css.trim(), fs.readFileSync(path.join(root, 'styles.css'), 'utf8').trim());
  assert.ok(html.indexOf('</style>') < html.indexOf('<body>'), 'Styles must load before the page is shown.');

  const scripts = [...html.matchAll(/<script\b[^>]*data-source="([^"]+)"[^>]*>([\s\S]*?)<\/script>/gi)];
  assert.deepEqual(scripts.map(match => match[1]), scriptNames, 'API and view adapters must be ready before the UI starts.');
  for (const [, filename, source] of scripts) {
    assert.equal(source.trim(), fs.readFileSync(path.join(root, filename), 'utf8').trim());
    assert.doesNotThrow(() => new vm.Script(source, { filename }), 'Embedded JavaScript must remain executable.');
  }
  assert.ok(html.indexOf('id="chatForm"') < html.indexOf('<script data-source="app.js"'), 'The chat must exist before the inline UI starts.');

  assert.equal(runBuild('--check', '--output', output).status, 0);
  assert.equal(runBuild('--output', output).status, 0);
  assert.equal(fs.readFileSync(output, 'utf8'), html, 'Repeated builds must be identical.');
  fs.writeFileSync(output, html + '\n<!-- stale -->');
  assert.equal(runBuild('--check', '--output', output).status, 1, 'Checking must detect a stale deliverable.');
});
