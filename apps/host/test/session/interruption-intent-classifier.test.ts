import { describe, expect, it } from 'vitest';
import { hasLexicalContent, parseInterruptionDecision } from '../../src/session/InterruptionIntentClassifier.js';

describe('interruption intent contract', () => {
  it.each([
    ['{"action":"resume","intent":"continue_previous","confidence":"high","reason":"Asked to carry on."}', 'resume'],
    ['{"action":"accept","intent":"correction","confidence":"medium","reason":"Corrects the premise."}', 'accept'],
  ])('accepts a strict bounded decision', (json, action) => expect(parseInterruptionDecision(json)?.action).toBe(action));

  it.each([
    '{"action":"accept","intent":"new_request","confidence":"low","reason":"Ambiguous.","extra":true}',
    '{"action":"accept","intent":"continue_previous","confidence":"high","reason":"Contradiction."}',
    'not json',
  ])('rejects invalid classifier output %s', json => expect(parseInterruptionDecision(json)).toBeUndefined());

  it.each([['', false], ['…', false], ['uh', true], ['¿podrías seguir?', true]])('uses only lexical preflight for %j', (text, expected) => expect(hasLexicalContent(text)).toBe(expected));
});
