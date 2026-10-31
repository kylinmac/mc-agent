import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
test('both context indicators use current runtime breakdown, not previous request occupancy', () => {
  const composer = readFileSync(new URL('../src/components/Composer.tsx', import.meta.url), 'utf8');
  const panel = readFileSync(new URL('../src/features/session-info/SessionInfo.tsx', import.meta.url), 'utf8');
  const inspector = readFileSync(new URL('../src/components/ContextUsageInspector.tsx', import.meta.url), 'utf8');
  assert.match(composer, /useSessionContextBreakdown\(activeSessionId\)/);
  assert.match(panel, /useSessionContextBreakdown\(sessionId\)/);
  assert.match(inspector, /contextUsageFromBreakdown\(contextSnapshot\)/);
});
