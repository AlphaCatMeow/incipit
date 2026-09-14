'use strict';

// Regression coverage for the self-update loop reported as: every launch
// says an update is available, accepting it "succeeds or fails" but the
// next launch (even a fresh shell) says the exact same thing — forever.
//
// Root cause: `runNpmUpdate` built its `npm install -g` spec from a
// hardcoded, unscoped `incipit@<version>`. This fork publishes as the
// scoped `@alphacatmeow/incipit`; the unscoped `incipit` package is
// upstream's own, tops out around 0.2.x, and will never carry a version
// number this fork's own 1.3.x/1.4.x line reaches. So the auto-upgrade
// always resolved to a 404 ("No match found for version") and could
// never once succeed — not a flaky failure, a structural one. The
// version-check itself (reading `pkg.name` off this package's own
// package.json to hit the registry) was already correct, which is why
// every subsequent launch re-detected the same "outdated" state and
// prompted again, indefinitely.
//
// Two layers, matching this repo's established pattern for "a rename or
// refactor silently missed one spot" bugs (see rerun-handoff.test.js,
// inline-edit-contracts.test.js):
//   1. Behavioral: `buildUpdateSpec` — the pure function extracted from
//      `runNpmUpdate` specifically so this doesn't need to mock `spawn`
//      or the network — must always resolve to the scoped package name.
//   2. Static: the source must not contain the bare literal anywhere,
//      and the wiring that makes `buildUpdateSpec` receive a real name
//      at runtime (checkForUpdate returning it, the call site passing
//      it through) must still be in place.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const T = require('../src/menu').__test;

let passed = 0;
function ok(name) { console.log('  ok  ' + name); passed++; }

const EXPECTED_NAME = '@alphacatmeow/incipit';

// ---- Layer 1: buildUpdateSpec behavior ----

(function exactVersionUsesScopedName() {
  assert.strictEqual(
    T.buildUpdateSpec(EXPECTED_NAME, '1.3.5'),
    `${EXPECTED_NAME}@1.3.5`);
  ok('exact-version spec uses the scoped package name');
})();

(function malformedVersionFallsBackToLatestButStaysScoped() {
  for (const bad of [undefined, null, '', 'not-a-version', 'latest']) {
    assert.strictEqual(
      T.buildUpdateSpec(EXPECTED_NAME, bad),
      `${EXPECTED_NAME}@latest`,
      `malformed target version ${JSON.stringify(bad)} must still resolve to a scoped @latest`);
  }
  ok('malformed/missing version falls back to a scoped @latest');
})();

(function missingPackageNameDefaultsToScopedNotUpstream() {
  // If checkForUpdate() ever failed to pass a name through, the fallback
  // must be this fork's own scoped name — never silently upstream's.
  for (const missing of [undefined, null, '']) {
    const spec = T.buildUpdateSpec(missing, '1.3.5');
    assert.strictEqual(spec, `${EXPECTED_NAME}@1.3.5`);
  }
  ok('a missing package name defaults to the scoped fork package, not upstream');
})();

(function neverProducesTheHistoricalBugString() {
  // The exact string that caused the infinite loop, spelled out so this
  // test fails loudly and specifically if it ever comes back.
  const spec = T.buildUpdateSpec(EXPECTED_NAME, '1.3.5');
  assert.notStrictEqual(spec, 'incipit@1.3.5');
  assert.ok(!/^incipit@/.test(spec), 'spec must never start with the bare unscoped name');
  ok('buildUpdateSpec never reproduces the unscoped incipit@<version> bug string');
})();

// ---- Layer 2: static source invariants ----

const source = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'menu.js'), 'utf8');

(function sourceNeverHardcodesTheBareName() {
  // Matches a bare `incipit@` that isn't part of `@alphacatmeow/incipit@`.
  const bareNameRe = /(?<!\/)\bincipit@/g;
  const hits = source.match(bareNameRe) || [];
  assert.deepStrictEqual(hits, [],
    'src/menu.js must not hardcode the unscoped incipit@<version> package spec anywhere');
  ok('source contains no bare unscoped incipit@ literal');
})();

(function callSitePassesNameThrough() {
  assert.ok(/runNpmUpdate\(info && info\.name, info && info\.latest\)/.test(source),
    'the runNpmUpdate call site must pass info.name through — dropping it silently ' +
    'reintroduces the fallback-only path and, worse, a stale single-arg call site ' +
    'would shift positional arguments and pass the version string as the package name');
  ok('runNpmUpdate call site passes the checked package name through');
})();

(function checkForUpdateReturnsName() {
  const fn = source.slice(source.indexOf('async function checkForUpdate'));
  const body = fn.slice(0, fn.indexOf('\n}\n'));
  assert.ok(/\bname,/.test(body) || /name: pkg\.name/.test(body),
    'checkForUpdate must return the package name so callers can build an update spec ' +
    'without hardcoding it again');
  ok('checkForUpdate returns the package name alongside current/latest');
})();

console.log('self-update-package-name: ok (' + passed + ' checks)');
