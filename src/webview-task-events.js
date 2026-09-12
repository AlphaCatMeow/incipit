'use strict';

const HANDLERS = ['handleTaskStarted', 'handleTaskProgress', 'handleTaskNotification', 'handleTaskUpdated', 'handleBackgroundTasksChanged'];

/** Observe recognized task deliveries without changing the host's handler semantics. */
function patchTaskEvents(content) {
  const contacts = HANDLERS.map(name => {
    const expression = new RegExp('this\\.' + name + '\\(([\\w$]+)\\)', 'g');
    return { name, matches: [...content.matchAll(expression)] };
  });
  if (contacts.every(contact => contact.matches.length === 0)) return [content, 'Task activity events: not applicable (host has no task handlers)'];
  if (contacts.some((contact, index) => index < 3 ? contact.matches.length !== 1 : contact.matches.length > 1)) return [content, 'Task activity events: degraded (task handlers are not uniquely recognized)'];
  const present = contacts.filter(contact => contact.matches.length === 1);
  const first = present[0].matches[0].index, last = present[present.length - 1].matches[0].index;
  const sameMessage = present.every(contact => contact.matches[0][1] === present[0].matches[0][1]);
  if (!sameMessage || last < first || last - first > 4000) return [content, 'Task activity events: degraded (task delivery chain changed)'];
  const observerFor = message => `(()=>{try{globalThis.__incipitPublishTaskEvent?.(this,${message})}catch(_){}})()`;
  const stamped = present.map(contact => {
    const match = contact.matches[0], prefix = `(${observerFor(match[1])},`;
    return content.slice(Math.max(0, match.index - prefix.length), match.index) === prefix;
  });
  if (stamped.every(Boolean)) return [content, 'Task activity events: already patched'];
  if (stamped.some(Boolean)) return [content, 'Task activity events: degraded (partial task observer)'];
  let updated = content;
  for (const contact of [...present].reverse()) {
    const match = contact.matches[0], message = match[1];
    const observer = observerFor(message);
    updated = updated.slice(0, match.index) + `(${observer},${match[0]})` + updated.slice(match.index + match[0].length);
  }
  return [updated, 'Task activity events: patched'];
}

/** Buffer early deliveries until the lazily loaded activity renderer subscribes. */
function taskEventPreamble() {
  return 'globalThis.__incipitTaskEventBuffer=[];globalThis.__incipitPublishTaskEvent=function(session,message){try{' +
    'var signal=session&&session.sessionId;var id=signal&&(typeof signal.peek==="function"?signal.peek():signal.value);if(!id||!message)return;' +
    'var event={sessionId:id,message:message};var buffer=globalThis.__incipitTaskEventBuffer;' +
    'if(Array.isArray(buffer)){buffer.push(event);if(buffer.length>128)buffer.splice(0,buffer.length-128);}' +
    'window.dispatchEvent(new CustomEvent("incipit:taskEvent",{detail:event}));' +
    '}catch(_){}};\n';
}

module.exports = { patchTaskEvents, taskEventPreamble };
