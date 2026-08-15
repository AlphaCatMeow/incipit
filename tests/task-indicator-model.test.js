'use strict';

const assert = require('assert');

(async () => {
  const {
    findLatestTaskSnapshot,
    normalizeTaskSnapshot,
    normalizeTaskStatus,
    normalizeTaskText,
  } = await import('../data/legacy/task_indicator_model.js');

  assert.strictEqual(normalizeTaskStatus('pending'), 'pending');
  assert.strictEqual(normalizeTaskStatus('in_progress'), 'in_progress');
  assert.strictEqual(normalizeTaskStatus('completed'), 'completed');
  assert.strictEqual(normalizeTaskStatus('done'), 'completed');
  assert.strictEqual(normalizeTaskStatus('active'), 'in_progress');
  assert.strictEqual(normalizeTaskStatus('todo'), 'pending');
  assert.strictEqual(normalizeTaskStatus('nonsense'), 'pending');
  assert.strictEqual(normalizeTaskStatus(undefined), 'pending');

  assert.strictEqual(normalizeTaskText('  hello  '), 'hello');
  assert.strictEqual(normalizeTaskText(''), '');
  assert.strictEqual(normalizeTaskText(null), '');
  assert.strictEqual(normalizeTaskText(42), '');

  const emptySnapshot = normalizeTaskSnapshot([]);
  assert.deepStrictEqual(emptySnapshot, { items: [], total: 0, completed: 0, currentIndex: 0, state: 'empty' });
  assert.deepStrictEqual(normalizeTaskSnapshot(null), emptySnapshot);
  assert.deepStrictEqual(normalizeTaskSnapshot(undefined), emptySnapshot);

  const allPending = normalizeTaskSnapshot([
    { content: 'first', activeForm: 'Doing first', status: 'pending' },
    { content: 'second', activeForm: 'Doing second', status: 'pending' },
  ]);
  assert.strictEqual(allPending.total, 2);
  assert.strictEqual(allPending.completed, 0);
  assert.strictEqual(allPending.state, 'pending');
  assert.strictEqual(allPending.currentIndex, 1);
  assert.deepStrictEqual(allPending.items, [
    { text: 'first', status: 'pending' },
    { text: 'second', status: 'pending' },
  ]);

  const running = normalizeTaskSnapshot([
    { content: 'first', activeForm: 'Doing first', status: 'completed' },
    { content: 'second', activeForm: 'Doing second', status: 'in_progress' },
    { content: 'third', activeForm: 'Doing third', status: 'pending' },
  ]);
  assert.strictEqual(running.total, 3);
  assert.strictEqual(running.completed, 1);
  assert.strictEqual(running.state, 'running');
  assert.strictEqual(running.currentIndex, 2, 'currentIndex should point at the step being worked on');
  assert.strictEqual(running.items[1].text, 'Doing second', 'in_progress rows prefer activeForm over content');

  const completed = normalizeTaskSnapshot([
    { content: 'first', status: 'completed' },
    { content: 'second', status: 'completed' },
  ]);
  assert.strictEqual(completed.state, 'completed');
  assert.strictEqual(completed.completed, completed.total);
  assert.strictEqual(completed.currentIndex, completed.total, 'a fully completed snapshot must not overshoot currentIndex past total');

  const withBlanks = normalizeTaskSnapshot([
    { content: '', activeForm: '', status: 'pending' },
    { content: 'kept', status: 'pending' },
  ]);
  assert.strictEqual(withBlanks.total, 1, 'rows with no usable text must be dropped');
  assert.strictEqual(withBlanks.items[0].text, 'kept');

  const records = [
    { type: 'user', content: 'hello' },
    {
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: 'ok' },
          { type: 'tool_use', name: 'Read', input: { file_path: '/x' } },
        ],
      },
    },
    {
      type: 'assistant',
      message: {
        content: [
          { type: 'tool_use', name: 'TodoWrite', input: { todos: [
            { content: 'step one', activeForm: 'Doing step one', status: 'completed' },
            { content: 'step two', activeForm: 'Doing step two', status: 'in_progress' },
          ] } },
        ],
      },
    },
    { type: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: 'ok' }] },
  ];
  const found = findLatestTaskSnapshot(records);
  assert.ok(found, 'must find the TodoWrite snapshot embedded in an assistant record');
  assert.strictEqual(found.total, 2);
  assert.strictEqual(found.state, 'running');

  const later = records.concat([
    {
      type: 'assistant',
      message: {
        content: [
          { type: 'tool_use', name: 'TodoWrite', input: { todos: [
            { content: 'step one', status: 'completed' },
            { content: 'step two', status: 'completed' },
          ] } },
        ],
      },
    },
  ]);
  const latest = findLatestTaskSnapshot(later);
  assert.strictEqual(latest.state, 'completed', 'must pick the most recent TodoWrite call, not the first');

  // Real transcript records sometimes wrap a content block one level deep
  // (`{ content: { type: 'tool_use', ... } }`) instead of exposing `type`
  // directly on the block — see enhance_legacy.js's unwrapTranscriptContentBlock.
  // findLatestTaskSnapshot must see through that wrapper too.
  const wrapped = [
    {
      type: 'assistant',
      message: {
        content: [
          { content: { type: 'tool_use', name: 'TodoWrite', input: { todos: [
            { content: 'wrapped step', status: 'in_progress' },
          ] } } },
        ],
      },
    },
  ];
  const wrappedFound = findLatestTaskSnapshot(wrapped);
  assert.ok(wrappedFound, 'must find a TodoWrite block wrapped one level under `content`');
  assert.strictEqual(wrappedFound.total, 1);
  assert.strictEqual(wrappedFound.state, 'running');

  // A fresh user instruction after the last TodoWrite call must hide the
  // stale snapshot, so a new turn doesn't inherit the previous turn's pill.
  const turnOneWithTodo = [
    { type: 'user', content: 'do the first turn' },
    {
      type: 'assistant',
      message: { content: [
        { type: 'tool_use', name: 'TodoWrite', input: { todos: [
          { content: 'only step', status: 'completed' },
        ] } },
      ] },
    },
  ];
  const beforeNewInstruction = findLatestTaskSnapshot(turnOneWithTodo);
  assert.ok(beforeNewInstruction, 'must still see the snapshot before any new instruction arrives');
  assert.strictEqual(beforeNewInstruction.state, 'completed');

  const turnTwoStarted = turnOneWithTodo.concat([
    { type: 'user', content: 'now do a second, unrelated thing' },
  ]);
  assert.strictEqual(
    findLatestTaskSnapshot(turnTwoStarted),
    null,
    'a fresh user instruction after the last TodoWrite call must hide the stale snapshot',
  );

  const turnTwoRespondedWithoutTodo = turnTwoStarted.concat([
    { type: 'assistant', message: { content: [{ type: 'text', text: 'working on it' }] } },
  ]);
  assert.strictEqual(
    findLatestTaskSnapshot(turnTwoRespondedWithoutTodo),
    null,
    'must stay hidden through the new turn until a fresh TodoWrite call happens',
  );

  const turnTwoNewTodo = turnTwoRespondedWithoutTodo.concat([
    {
      type: 'assistant',
      message: { content: [
        { type: 'tool_use', name: 'TodoWrite', input: { todos: [
          { content: 'second turn step', status: 'in_progress' },
        ] } },
      ] },
    },
  ]);
  const afterFreshTodo = findLatestTaskSnapshot(turnTwoNewTodo);
  assert.ok(afterFreshTodo, 'a fresh TodoWrite call in the new turn must show again');
  assert.strictEqual(afterFreshTodo.total, 1);

  // A tool_result-only user record is a roundtrip, not a real instruction —
  // it must not be mistaken for a turn boundary.
  const roundtripOnly = turnOneWithTodo.concat([
    { type: 'user', content: [{ type: 'tool_result', tool_use_id: 'abc', content: 'ok' }] },
  ]);
  const stillVisible = findLatestTaskSnapshot(roundtripOnly);
  assert.ok(stillVisible, 'a tool_result roundtrip user record must not be mistaken for a new instruction');
  assert.strictEqual(stillVisible.state, 'completed');

  assert.strictEqual(findLatestTaskSnapshot([]), null);
  assert.strictEqual(findLatestTaskSnapshot([{ type: 'user', content: 'no tools here' }]), null);
  assert.strictEqual(findLatestTaskSnapshot(null), null);

  // Markdown task list detection
  const markdownPending = [
    { type: 'user', content: 'do these tasks' },
    {
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: 'Sure, here is the plan:\n\n- [ ] First task\n- [ ] Second task\n- [ ] Third task' },
        ],
      },
    },
  ];
  const mdPendingSnapshot = findLatestTaskSnapshot(markdownPending);
  assert.ok(mdPendingSnapshot, 'must detect markdown task list in assistant text');
  assert.strictEqual(mdPendingSnapshot.total, 3);
  assert.strictEqual(mdPendingSnapshot.completed, 0);
  assert.strictEqual(mdPendingSnapshot.state, 'pending');
  assert.strictEqual(mdPendingSnapshot.items[0].text, 'First task');

  const markdownMixed = [
    { type: 'user', content: 'update me' },
    {
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: 'Progress:\n- [x] Step one\n- [~] Step two (in progress)\n- [ ] Step three' },
        ],
      },
    },
  ];
  const mdMixedSnapshot = findLatestTaskSnapshot(markdownMixed);
  assert.strictEqual(mdMixedSnapshot.total, 3);
  assert.strictEqual(mdMixedSnapshot.completed, 1);
  assert.strictEqual(mdMixedSnapshot.state, 'running');
  assert.strictEqual(mdMixedSnapshot.items[0].status, 'completed');
  assert.strictEqual(mdMixedSnapshot.items[1].status, 'in_progress');
  assert.strictEqual(mdMixedSnapshot.items[2].status, 'pending');

  const markdownCompleted = [
    { type: 'assistant', message: { content: [
      { type: 'text', text: '- [x] All\n- [X] Done' },
    ] } },
  ];
  const mdCompletedSnapshot = findLatestTaskSnapshot(markdownCompleted);
  assert.strictEqual(mdCompletedSnapshot.state, 'completed');
  assert.strictEqual(mdCompletedSnapshot.completed, 2);

  const markdownWithProgress = [
    { type: 'assistant', message: { content: [
      { type: 'text', text: '- [x] Done\n- [>] Active now' },
    ] } },
  ];
  const mdProgressSnapshot = findLatestTaskSnapshot(markdownWithProgress);
  assert.strictEqual(mdProgressSnapshot.items[1].status, 'in_progress');
  assert.strictEqual(mdProgressSnapshot.state, 'running');

  // Markdown with no valid tasks should return null
  const noValidTasks = [
    { type: 'assistant', message: { content: [
      { type: 'text', text: 'Some text without tasks' },
    ] } },
  ];
  assert.strictEqual(findLatestTaskSnapshot(noValidTasks), null);

  // Fresh user instruction should hide markdown task list
  const mdThenNewInstruction = markdownMixed.concat([
    { type: 'user', content: 'new request' },
  ]);
  assert.strictEqual(
    findLatestTaskSnapshot(mdThenNewInstruction),
    null,
    'fresh user instruction must hide markdown task list from previous turn',
  );

  // TodoWrite should have priority over markdown
  const bothSources = [
    { type: 'assistant', message: { content: [
      { type: 'text', text: '- [ ] Markdown task' },
      { type: 'tool_use', name: 'TodoWrite', input: { todos: [
        { content: 'TodoWrite task', status: 'pending' },
      ] } },
    ] } },
  ];
  const prioritySnapshot = findLatestTaskSnapshot(bothSources);
  assert.strictEqual(prioritySnapshot.items[0].text, 'TodoWrite task', 'TodoWrite must take priority over markdown');

  console.log('task-indicator-model: checks PASSED');
})().catch(error => {
  console.error(error);
  process.exit(1);
});
