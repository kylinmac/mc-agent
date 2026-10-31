import test from 'node:test';
import assert from 'node:assert/strict';
import { noticeCardData, noticePreview } from '../src/features/chat/transcript/notice-card-model.ts';
const msg = (content, kind) => ({ role: 'user', content, sessionMessage: kind ? { kind } : undefined });
test('agent kinds and host completion envelopes retain readable results and errors', () => {
  for (const kind of ['task', 'message', 'completion']) assert.equal(noticeCardData(msg('**result**', kind)).body, '**result**');
  const data = noticeCardData(msg(JSON.stringify({ messageId: 'a', result: '## Done\n\n| A | B |\n|---|---|\n| 1 | 2 |', error: 'failure', status: 'failed' }), 'completion'));
  assert.equal(data.status, 'failed'); assert.equal(data.error, 'failure'); assert.match(data.body, /## Done\n/);
  assert.equal(noticePreview(data), 'failure');
  for (const value of ['{broken', '{"other":"data"}', 'null', '[]']) assert.equal(noticeCardData(msg(value, 'completion')).body, value);
});
const start = '[Automatic notice, not a message from the user] Background command(s) you started have ended:\n';
const end = '\nRead the full output with BashOutput if you need it, then carry on with the task. If nothing is left to do, reply briefly.';
test('legacy background notices parse all commands, preserve logs and reject partial matches', () => {
  const block = '- `echo ok` exited with code 0 (backgroundId a).\nLast output:\n```\n**literal**\n```\n- `exit 2` failed (exit code 2) (backgroundId b).\nNo output.';
  const data = noticeCardData(msg(start + block + end));
  assert.equal(data.commands.length, 2); assert.equal(data.commands[0].failed, false); assert.equal(data.commands[1].failed, true); assert.equal(data.commands[0].output, '**literal**');
  for (const text of [block, start + block, 'hello ' + start + block + end, start + block + '\nextra' + end]) assert.equal(noticeCardData(msg(text)), null);
  assert.equal(noticeCardData({ role: 'assistant', content: start + block + end }), null);
});
